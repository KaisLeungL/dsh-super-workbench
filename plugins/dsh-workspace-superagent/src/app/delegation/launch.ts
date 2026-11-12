import { DatabaseSync } from 'node:sqlite';

/** 由可信 Host 创建，不从模型或浏览器参数接受工作区、会话及来源。 */
export interface DelegationRequest {
  operationId: string;
  workspaceId: string;
  routerSessionId: string;
  taskId: string;
}

/** 该回执必须与看板启动在同一次持久提交中写入。 */
export type BoardLaunchReceipt =
  | { state: 'accepted'; operationId: string; taskId: string; executionId: string; sessionId?: string }
  | { state: 'rejected'; operationId: string; taskId: string; reason: string }
  | { state: 'unknown'; operationId: string; taskId: string };

/**
 * 未来看板 Host 的窄接口。普通 taskBoard.apply 只返回当前快照，
 * 重试时不能从中证明 requestId 对应哪次执行，不能实现此契约。
 */
export interface BoardLaunchFace {
  readonly durableLaunchReceiptVersion: 1;
  startWithReceipt(request: DelegationRequest): Promise<BoardLaunchReceipt>;
  readLaunchReceipt(request: DelegationRequest): Promise<BoardLaunchReceipt>;
}

export interface DelegationRecord extends DelegationRequest {
  state: 'reserved' | 'unknown' | 'accepted' | 'rejected';
  executionId?: string;
  sessionId?: string;
  reason?: string;
  createdAt: number;
  updatedAt: number;
}

interface Binding {
  workspaceId: string;
  routerSessionId: string;
  /** 检查所有者、当前绑定与工作区读取授权。 */
  assertScope(): void;
  /** 同步检查真实 caller、当前绑定、授权及卡片准入。 */
  assertCurrent(request: DelegationRequest): void;
  board(): BoardLaunchFace | undefined;
  now?(): number;
}

type Row = {
  operation_id: string;
  workspace_id: string;
  router_session_id: string;
  task_id: string;
  state: DelegationRecord['state'];
  execution_id: string | null;
  session_id: string | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
};

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 512;
}

function toRecord(row: Row): DelegationRecord {
  return {
    operationId: row.operation_id,
    workspaceId: row.workspace_id,
    routerSessionId: row.router_session_id,
    taskId: row.task_id,
    state: row.state,
    ...(row.execution_id === null ? {} : { executionId: row.execution_id }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 单次请求的持久协调层。可恢复 unknown，但不猜测执行，也不重新发起未知请求。
 * 只有具有 durableLaunchReceiptVersion=1 的看板 Host 才能接受启动。
 */
export class DelegationLaunch {
  readonly #db: DatabaseSync;

  constructor(path: string, private readonly binding: Binding) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS delegation_launch (
        operation_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        router_session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('reserved','unknown','accepted','rejected')),
        execution_id TEXT,
        session_id TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS delegation_launch_scope
        ON delegation_launch(workspace_id,router_session_id,updated_at);
    `);
  }

  close(): void { this.#db.close(); }

  #now(): number { return this.binding.now?.() ?? Date.now(); }

  #check(request: DelegationRequest): void {
    if (![request.operationId, request.workspaceId, request.routerSessionId, request.taskId].every(nonempty) ||
        request.workspaceId !== this.binding.workspaceId || request.routerSessionId !== this.binding.routerSessionId) {
      throw Error('DELEGATION_SCOPE_CHANGED');
    }
    this.binding.assertScope();
    this.binding.assertCurrent(request);
  }

  #row(operationId: string): Row | undefined {
    return this.#db.prepare('SELECT * FROM delegation_launch WHERE operation_id=?').get(operationId) as Row | undefined;
  }

  #owned(request: DelegationRequest): Row {
    const row = this.#row(request.operationId);
    if (!row) throw Error('DELEGATION_NOT_FOUND');
    if (row.workspace_id !== request.workspaceId || row.router_session_id !== request.routerSessionId || row.task_id !== request.taskId) {
      throw Error('DELEGATION_OPERATION_CONFLICT');
    }
    return row;
  }

  #face(): BoardLaunchFace {
    const face = this.binding.board();
    if (!face || face.durableLaunchReceiptVersion !== 1 ||
        typeof face.startWithReceipt !== 'function' || typeof face.readLaunchReceipt !== 'function') {
      throw Error('DELEGATION_RECEIPT_UNAVAILABLE');
    }
    return face;
  }

  #applyReceipt(request: DelegationRequest, receipt: BoardLaunchReceipt): void {
    if (!receipt || receipt.operationId !== request.operationId || receipt.taskId !== request.taskId ||
        !['accepted', 'rejected', 'unknown'].includes(receipt.state)) throw Error('DELEGATION_RECEIPT_INVALID');
    if (receipt.state === 'unknown') return;
    if (receipt.state === 'accepted' && (!nonempty(receipt.executionId) ||
        (receipt.sessionId !== undefined && !nonempty(receipt.sessionId)))) throw Error('DELEGATION_RECEIPT_INVALID');
    if (receipt.state === 'rejected' && !nonempty(receipt.reason)) throw Error('DELEGATION_RECEIPT_INVALID');
    const executionId = receipt.state === 'accepted' ? receipt.executionId : null;
    const sessionId = receipt.state === 'accepted' ? receipt.sessionId ?? null : null;
    const reason = receipt.state === 'rejected' ? receipt.reason : null;
    const changed = this.#db.prepare(`UPDATE delegation_launch SET state=?,execution_id=?,session_id=?,reason=?,updated_at=?
      WHERE operation_id=? AND state='unknown'`).run(receipt.state, executionId, sessionId, reason, this.#now(), request.operationId).changes;
    if (changed === 1) return;
    const row = this.#owned(request);
    if (row.state === 'accepted' || row.state === 'rejected') {
      if (row.state !== receipt.state || row.execution_id !== executionId || row.reason !== reason) {
        throw Error('DELEGATION_RECEIPT_CONFLICT');
      }
      if (row.session_id !== null && sessionId !== null && row.session_id !== sessionId) {
        throw Error('DELEGATION_RECEIPT_CONFLICT');
      }
      return;
    }
    throw Error('DELEGATION_STATE_CONFLICT');
  }

  /** 已有 operationId 的新参数冲突时拒绝，避免把两次业务操作合并。 */
  async start(request: DelegationRequest): Promise<DelegationRecord> {
    this.#check(request);
    const face = this.#face();
    const now = this.#now();
    this.#db.prepare(`INSERT OR IGNORE INTO delegation_launch
      (operation_id,workspace_id,router_session_id,task_id,state,created_at,updated_at)
      VALUES(?,?,?,?,'reserved',?,?)`).run(request.operationId, request.workspaceId, request.routerSessionId, request.taskId, now, now);
    const row = this.#owned(request);
    if (row.state === 'accepted' || row.state === 'rejected') return toRecord(row);
    this.#check(request);
    // 先置 unknown，再调用 Host；崩溃落在任一边界时都只读核实。
    const claimed = this.#db.prepare(`UPDATE delegation_launch SET state='unknown',updated_at=?
      WHERE operation_id=? AND state='reserved'`).run(now, request.operationId).changes === 1;
    if (!claimed) return this.reconcile(request);
    let receipt: BoardLaunchReceipt | undefined;
    try {
      this.#check(request);
      receipt = await face.startWithReceipt(request);
    } catch {
      // 宿主可能已持久提交；不能依据异常发起第二次启动。
    }
    if (receipt) this.#applyReceipt(request, receipt);
    this.#check(request);
    return toRecord(this.#owned(request));
  }

  /** 仅使用看板的同操作持久回执恢复；找不到回执保留 unknown。 */
  async reconcile(request: DelegationRequest): Promise<DelegationRecord> {
    this.#check(request);
    const row = this.#owned(request);
    if (row.state !== 'unknown') return toRecord(row);
    const face = this.#face();
    let receipt: BoardLaunchReceipt | undefined;
    try { receipt = await face.readLaunchReceipt(request); }
    catch { /* 查询异常或暂不可证时保持 unknown。 */ }
    if (receipt) this.#applyReceipt(request, receipt);
    this.#check(request);
    return toRecord(this.#owned(request));
  }

  list(): DelegationRecord[] {
    this.binding.assertScope();
    return (this.#db.prepare(`SELECT * FROM delegation_launch WHERE workspace_id=? AND router_session_id=?
      ORDER BY updated_at DESC,operation_id DESC`).all(this.binding.workspaceId, this.binding.routerSessionId) as Row[]).map(toRecord);
  }
}
