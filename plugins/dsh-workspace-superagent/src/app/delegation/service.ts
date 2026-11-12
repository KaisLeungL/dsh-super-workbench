import { DelegationLaunch, type BoardLaunchFace, type DelegationRecord } from './launch.js';

/** 由可信 Host 提供；模型与浏览器不能改写工作区、会话或看板来源。 */
export interface DelegationScope {
  readonly workspaceId: string;
  /** 所有者、绑定和读取授权仍有效时返回；否则抛错。 */
  assertScope(): void;
  /** 当前 manager 仍绑定该会话，且组件可用。 */
  assertCurrent(sessionId: string): void;
  /** 只有带持久回执能力的看板 Host 才可委派。 */
  board(): BoardLaunchFace | undefined;
  now?(): number;
}

/**
 * 每个主理会话一个持久协调实例。
 *
 * `DelegationLaunch` 的绑定固定了 routerSessionId，所以按会话创建；它们共享
 * 同一个 sqlite 文件（单进程内多个连接由 busy_timeout 协调），关闭时统一释放。
 */
export class DelegationService {
  readonly #launches = new Map<string, DelegationLaunch>();
  readonly #path: string;
  readonly #scope: DelegationScope;

  constructor(path: string, scope: DelegationScope) {
    this.#path = path;
    this.#scope = scope;
  }

  #launch(sessionId: string): DelegationLaunch {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') throw Error('DELEGATION_SCOPE_CHANGED');
    const existing = this.#launches.get(sessionId);
    if (existing) return existing;
    const launch = new DelegationLaunch(this.#path, {
      workspaceId: this.#scope.workspaceId,
      routerSessionId: sessionId,
      assertScope: () => this.#scope.assertScope(),
      assertCurrent: () => this.#scope.assertCurrent(sessionId),
      board: () => this.#scope.board(),
      ...(this.#scope.now ? { now: () => this.#scope.now!() } : {}),
    });
    this.#launches.set(sessionId, launch);
    return launch;
  }

  /** 启动一次真实委派；重复 operationId 返回同一持久结果，绝不二次启动。 */
  async start(sessionId: string, operationId: string, taskId: string): Promise<DelegationRecord> {
    return this.#launch(sessionId).start({ operationId, workspaceId: this.#scope.workspaceId, routerSessionId: sessionId, taskId });
  }

  /** 仅为启动结果未知的原操作读取看板回执；不重新发起。 */
  async reconcile(sessionId: string, operationId: string, taskId: string): Promise<DelegationRecord> {
    return this.#launch(sessionId).reconcile({ operationId, workspaceId: this.#scope.workspaceId, routerSessionId: sessionId, taskId });
  }

  list(sessionId: string): DelegationRecord[] {
    return this.#launch(sessionId).list();
  }

  close(): void {
    for (const launch of this.#launches.values()) {
      try { launch.close(); } catch { /* 关闭已释放的连接不改变宿主结论。 */ }
    }
    this.#launches.clear();
  }
}
