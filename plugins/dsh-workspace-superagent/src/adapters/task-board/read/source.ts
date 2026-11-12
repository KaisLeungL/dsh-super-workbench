import { randomUUID } from 'node:crypto';
import { BoardReadError, type BoardCapture, type BoardLocation, type BoardReadSource, type BoardStatus, type BoardTombstone, type CapturedExecution, type CapturedTask } from '../../../app/projections/types.js';

/** 结构类型只要求公开读取与自有监听生命周期，不接收 apply/runner。 */
export interface NativeBoardReadFace {
  snapshot(): unknown;
  subscribe(listener: () => void): () => void;
  isExtensionEnabled(id: string): boolean;
  registerExtension(extension: {
    readonly id: string; readonly apiVersion: number;
    start?(host: { events: { onTaskDeleted(listener: (event: { taskId: string }) => void): () => void } }): void;
    stop?(): void;
  }): () => void;
}
const statuses = new Set<BoardStatus>(['backlog', 'todo', 'running', 'needs_input', 'review', 'done', 'failed']);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoardReadError('source_invalid', '看板返回了无效记录。');
  return value as Record<string, unknown>;
};
const text = (value: unknown, required = false): string => {
  if (typeof value === 'string' && (!required || value.length > 0)) return value;
  if (!required && value === undefined) return '';
  throw new BoardReadError('source_invalid', '看板记录缺少必要文本。');
};
const id = (value: unknown): string => {
  const result = text(value, true);
  if (result.length > 512) throw new BoardReadError('source_invalid', '看板标识过长。');
  return result;
};
const instant = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new BoardReadError('source_invalid', '看板记录时间无效。');
  return value;
};
function location(raw: Record<string, unknown>): BoardLocation {
  const workspaceId = raw.workspaceId === undefined ? null : id(raw.workspaceId);
  const resolvedProjectId = raw.projectId === undefined ? workspaceId : raw.projectId === null ? null : id(raw.projectId);
  return Object.freeze({ id: id(raw.id), workspaceId, resolvedProjectId, ...(raw.hidden === true ? { hidden: true as const } : {}) });
}
function task(value: unknown): CapturedTask {
  const raw = object(value), at = location(raw);
  if (!statuses.has(raw.status as BoardStatus) || !Array.isArray(raw.executions)) throw new BoardReadError('source_invalid', '看板状态或执行列表无效。');
  const executions = raw.executions.slice(-20).map(value => {
    const execution = object(value);
    const result = execution.result ?? null;
    if (result !== null && !['succeeded', 'failed', 'cancelled'].includes(String(result))) throw new BoardReadError('source_invalid', '看板执行结果无效。');
    const summary = execution.summary === undefined ? undefined : object(execution.summary);
    return Object.freeze({
      id: id(execution.id), sessionId: execution.sessionId === undefined ? null : id(execution.sessionId),
      resolvedProjectId: execution.projectId === undefined || execution.projectId === null ? null : id(execution.projectId),
      projectKnown: execution.projectId !== undefined,
      startedAt: instant(execution.startedAt), endedAt: execution.endedAt === undefined ? null : instant(execution.endedAt),
      result: result as CapturedExecution['result'], external: execution.external === true,
      summary: summary === undefined ? '' : text(summary.text),
      summarySeq: summary === undefined ? null : instant(summary.seq),
    });
  });
  return Object.freeze({
    ...at, title: text(raw.title), description: text(raw.description), status: raw.status as BoardStatus,
    updatedAt: instant(raw.updatedAt), archivedAt: raw.archivedAt === undefined ? null : instant(raw.archivedAt),
    parentId: raw.parentId === undefined ? null : id(raw.parentId), executions: Object.freeze(executions),
  });
}

/** Host 内部全量读取。仅白名单进入 capture，原 prompt/integrations/timeline/path 不留存。 */
export class TaskBoardReadAdapter implements BoardReadSource {
  #face?: NativeBoardReadFace;
  #active = false;
  #generation = 0;
  #epoch = randomUUID();
  #disposers: (() => void)[] = [];
  #eventDispose?: () => void;
  #listeners = new Set<() => void>();
  #locations = new Map<string, BoardLocation>();
  #deleted = new Map<string, BoardTombstone>();
  #locationRevision?: number;
  #pendingDeleted = new Map<string, BoardLocation>();
  constructor(private readonly resolveFace: () => NativeBoardReadFace | undefined, readonly extensionId = 'workspace-superagent-read') {}

  bind(): void {
    const face = this.resolveFace();
    if (face && this.#face === face && this.isAvailable()) return;
    this.unbind();
    if (!face) return;
    const generation = this.#generation, epoch = () => generation === this.#generation && this.#face === face;
    this.#face = face;
    try {
      // 先装失效订阅，之后 capture；失效通知不被当作数据载荷。
      this.#disposers.push(face.subscribe(() => { if (epoch()) { this.#refreshLocations(); this.#invalidate(); } }));
      this.#disposers.push(face.registerExtension({
        id: this.extensionId, apiVersion: 1,
        start: host => {
          if (!epoch()) return;
          this.#eventDispose?.();
          this.#epoch = randomUUID(); this.#active = true;
          this.#eventDispose = host.events.onTaskDeleted(({ taskId }) => {
            if (!epoch() || !this.#active) return;
            // 原生事件只有 ID。先同步回读当前修订，绝不拿未复核的旧项目位置造墓碑。
            this.#refreshLocations();
            const previous = this.#pendingDeleted.get(taskId);
            if (previous) {
              this.#deleted.set(taskId, Object.freeze({ ...previous, deletedAt: Date.now() }));
              if (this.#deleted.size > 256) this.#deleted.delete(this.#deleted.keys().next().value!);
              this.#pendingDeleted.delete(taskId);
            }
            this.#invalidate();
          });
          this.#invalidate();
        },
        stop: () => {
          if (!epoch()) return;
          this.#active = false; this.#eventDispose?.(); this.#eventDispose = undefined;
          this.#locations.clear(); this.#deleted.clear(); this.#pendingDeleted.clear(); this.#locationRevision = undefined; this.#invalidate();
        },
      }));
    } catch (error) { this.unbind(); throw error; }
    this.#invalidate();
  }

  isAvailable(): boolean {
    try {
      return this.#active && this.#face !== undefined && this.resolveFace() === this.#face && this.#face.isExtensionEnabled(this.extensionId) === true;
    } catch { return false; }
  }
  activeEpoch(): string | undefined { return this.isAvailable() ? this.#epoch : undefined; }
  capture(): BoardCapture {
    if (!this.isAvailable()) throw new BoardReadError('unavailable', '看板连接不可用，请等待重新绑定。');
    const face = this.#face!, generation = this.#generation, epoch = this.#epoch;
    const snapshot = object(face.snapshot());
    if (!Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 0 || !Array.isArray(snapshot.tasks)) throw new BoardReadError('source_invalid', '看板快照缺少有效修订。');
    const tasks = snapshot.tasks.map(task);
    const locations = new Map<string, BoardLocation>();
    for (const row of tasks) {
      if (locations.has(row.id)) throw new BoardReadError('source_invalid', '看板任务标识重复。');
      locations.set(row.id, Object.freeze({ id: row.id, workspaceId: row.workspaceId, resolvedProjectId: row.resolvedProjectId, ...(row.hidden ? { hidden: true as const } : {}) }));
    }
    if (!this.isAvailable() || generation !== this.#generation || epoch !== this.#epoch) throw new BoardReadError('unavailable', '看板绑定已经变化，请重新读取。');
    if (this.#locationRevision !== snapshot.revision) this.#pendingDeleted.clear();
    this.#locationRevision = snapshot.revision as number; this.#locations = locations;
    for (const row of tasks) this.#deleted.delete(row.id);
    return Object.freeze({ sourceEpoch: epoch, boardRevision: String(snapshot.revision), asOf: Date.now(), tasks: Object.freeze(tasks), tombstones: Object.freeze([...this.#deleted.values()]) });
  }
  watchInvalidate(listener: () => void): () => void {
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  }
  unbind(): void {
    this.#generation++; this.#active = false; this.#face = undefined;
    this.#eventDispose?.(); this.#eventDispose = undefined;
    const disposers = this.#disposers.splice(0);
    for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* 继续释放其余自有监听。 */ } }
    this.#locations.clear(); this.#deleted.clear(); this.#pendingDeleted.clear(); this.#locationRevision = undefined; this.#epoch = randomUUID(); this.#invalidate();
  }
  dispose(): void { this.unbind(); this.#listeners.clear(); }
  #refreshLocations(): void {
    try {
      if (!this.isAvailable()) throw Error('disconnected');
      const snapshot = object(this.#face!.snapshot());
      if (!Number.isSafeInteger(snapshot.revision) || !Array.isArray(snapshot.tasks)) throw Error('snapshot');
      if (snapshot.revision === this.#locationRevision) return;
      const current = new Map(snapshot.tasks.map(row => { const at = location(object(row)); return [at.id, at] as const; }));
      this.#pendingDeleted.clear();
      // 只在相邻修订保留“刚消失”位置；跳修订无法证明中途未改范围。
      if (snapshot.revision === (this.#locationRevision ?? -2) + 1) {
        for (const [key, at] of this.#locations) if (!current.has(key)) this.#pendingDeleted.set(key, at);
      }
      this.#locations = current; this.#locationRevision = snapshot.revision as number;
    } catch {
      this.#locations.clear(); this.#pendingDeleted.clear(); this.#locationRevision = undefined;
    }
  }
  #invalidate(): void { for (const listener of this.#listeners) { try { listener(); } catch { /* 不阻断原看板通知。 */ } } }
}
