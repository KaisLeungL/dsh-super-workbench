import type { StewardStore } from '../../storage/store.js';
import { InstallationOperation, type StagedInstallation, type ManagerSnapshot } from '../../sessions/installation.js';

export class LifecycleError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'LifecycleError'; }
}
export interface Dependency {
  readonly name: string;
  /** 仅由可信 Host 读取；缺失返回 undefined。 */
  current(): unknown;
  accepts(value: unknown): boolean;
}
export interface LifecycleResources {
  pause(): void;
  resume(): void;
  cancel(reason: string): void;
  dispose(): void;
}
export interface LifecycleLease {
  readonly signal: AbortSignal;
  assertCurrent(): void;
  /** 同步认领事务内只核代次、依赖与政策；容量由事务前后检查。 */
  assertCurrentInTransaction?(): void;
}
const original = (value: unknown): unknown =>
  value && (typeof value === 'object' || typeof value === 'function')
    ? Reflect.get(value, Symbol.for('cordis.original')) ?? value : value;

/** Host 私有协调器。持久生命周期只来自 store，不注册模型工具。 */
export class LifecycleCoordinator {
  #generation = 0;
  #abort = new AbortController();
  #blocked = true;
  #disposed = false;
  #reason = '尚未初始化';
  #identities = new Map<string, unknown>();
  #operation?: Promise<void>;
  #installation?: InstallationOperation;
  #disposeDone?: Promise<void>;
  readonly #listeners = new Set<() => void>();
  constructor(
    readonly store: StewardStore,
    readonly dependencies: readonly Dependency[],
    readonly resources: LifecycleResources,
    readonly ensureManager: (operation: InstallationOperation) => Promise<StagedInstallation>,
    readonly disposeRuntime: () => void | Promise<void>,
    readonly assertAdmission: () => void = () => {},
  ) {}
  initialize(): void {
    if (this.#disposed) throw new LifecycleError('DISPOSED');
    this.#invalidate('冷启动默认暂停');
    if (this.store.diagnostics().recoveryPending) this.store.recover();
    else if (this.store.manager().lifecycle === 'running') {
      const manager = this.store.manager();
      this.store.recordLifecycle(manager.revision, 'paused', manager.pin);
    }
    this.resources.pause(); this.#publish();
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  }
  #publish(): void { for (const listener of this.#listeners) { try { listener(); } catch {} } }
  #invalidate(reason: string): void {
    this.#installation?.revoke(); this.#installation = undefined;
    this.#blocked = true; this.#reason = reason; this.#generation++;
    this.#abort.abort(new LifecycleError('STALE_LIFECYCLE'));
    this.#abort = new AbortController();
  }
  dependencyStatus(): { name: string; available: boolean; changed: boolean }[] {
    return this.dependencies.map(dependency => {
      const value = dependency.current();
      return { name: dependency.name, available: dependency.accepts(value),
        changed: this.#identities.has(dependency.name) && this.#identities.get(dependency.name) !== original(value) };
    });
  }
  /** 依赖事件应同步调用；所有操作/await 后也再次核对。重绑只允许读取，不恢复运行。 */
  checkDependencies(): boolean {
    const states = this.dependencyStatus();
    if (states.some(state => !state.available || state.changed)) {
      if (!this.#blocked) this.pause('依赖断连或换代');
      return false;
    }
    return true;
  }
  #captureDependencies(): void {
    const identities = new Map<string, unknown>();
    for (const dependency of this.dependencies) {
      const value = dependency.current();
      if (!dependency.accepts(value)) throw new LifecycleError('DEPENDENCY_UNAVAILABLE');
      identities.set(dependency.name, original(value));
    }
    this.#identities = identities;
  }
  lease(): LifecycleLease {
    if (this.#disposed || this.#blocked || !this.checkDependencies() ||
        this.store.manager().lifecycle !== 'running') throw new LifecycleError('AUTOMATION_PAUSED');
    const generation = this.#generation, signal = this.#abort.signal;
    const versions = JSON.stringify(this.store.manager().versions);
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (this.#disposed || this.#blocked || generation !== this.#generation ||
          !this.checkDependencies() || this.store.manager().lifecycle !== 'running' ||
          JSON.stringify(this.store.manager().versions) !== versions) throw new LifecycleError('STALE_LIFECYCLE');
    };
    this.assertAdmission(); assertCurrent();
    return { signal, assertCurrent: () => { assertCurrent(); this.assertAdmission(); },
      assertCurrentInTransaction: assertCurrent };
  }
  /** 调用方必须是受信人工控制入口，proofRef 不由模型授权。 */
  resume(expectedRevision: number, proofRef: string, caller?: { signal: AbortSignal; assertCurrent(): void }): Promise<void> {
    return this.#connect(expectedRevision, proofRef, 'running', caller);
  }
  connect(expectedRevision: number, proofRef: string, caller: { signal: AbortSignal; assertCurrent(): void }): Promise<void> {
    return this.#connect(expectedRevision, proofRef, 'paused', caller);
  }
  #connect(expectedRevision: number, proofRef: string, mode: 'running' | 'paused', caller?: { signal: AbortSignal; assertCurrent(): void }): Promise<void> {
    if (this.#disposed || !proofRef) return Promise.reject(new LifecycleError('TRUSTED_RESUME_REQUIRED'));
    if (this.#operation) return Promise.reject(new LifecycleError('CONTROL_BUSY'));
    const operation = Promise.resolve().then(() => this.#resume(expectedRevision, proofRef, mode, caller));
    this.#operation = operation;
    void operation.finally(() => { if (this.#operation === operation) this.#operation = undefined; }).catch(() => {});
    return operation;
  }
  async #resume(expectedRevision: number, proofRef: string, mode: 'running' | 'paused', caller?: { signal: AbortSignal; assertCurrent(): void }): Promise<void> {
    const initial = JSON.stringify(this.store.manager());
    caller?.assertCurrent(); this.assertAdmission();
    if (JSON.stringify(this.store.manager()) !== initial || this.store.manager().revision !== expectedRevision) throw new LifecycleError('REVISION_CONFLICT');
    this.#invalidate('正在核对恢复条件'); this.#captureDependencies();
    if (JSON.stringify(this.store.manager()) !== initial) throw new LifecycleError('REVISION_CONFLICT');
    const generation = this.#generation;
    const signal = caller ? AbortSignal.any([this.#abort.signal, caller.signal]) : this.#abort.signal;
    const guard = () => {
      signal.throwIfAborted();
      caller?.assertCurrent(); this.assertAdmission();
      if (this.#disposed || generation !== this.#generation || !this.checkDependencies()) throw new LifecycleError('STALE_LIFECYCLE');
    };
    const operation = new InstallationOperation(this.store, signal, guard);
    this.#installation = operation;
    let committed: ManagerSnapshot | undefined;
    try {
      if (operation.snapshot.lifecycle === 'stopped') operation.reopen(proofRef);
      const capsule = await this.ensureManager(operation);
      operation.preflight(capsule);
      // 从私有完整末尾到本地发布，没有 await、authority/lease 或扩展 setter。
      committed = operation.commit(capsule, mode);
      if (mode === 'running') {
        this.#blocked = false; this.#reason = '受信人工恢复';
        this.resources.resume();
      } else this.#reason = '手动对话已连接，后台自动化保持暂停';
      operation.check();
      this.#publish(); operation.check();
    } catch (error) {
      this.#invalidate('恢复失败，保持暂停');
      const failures: unknown[] = [error];
      if (committed && mode === 'running') { try { operation.compensate(committed); } catch (failure) { failures.push(failure); } }
      try { this.resources.pause(); } catch (failure) { failures.push(failure); }
      try { await operation.cancel(); } catch (failure) { failures.push(failure); }
      this.#publish();
      if (failures.length === 1) throw error;
      throw new AggregateError(failures, 'LIFECYCLE_RESUME_FAILED');
    } finally {
      if (this.#installation === operation) this.#installation = undefined;
    }
  }
  pause(reason = '受信人工暂停'): void {
    if (this.#disposed) throw new LifecycleError('DISPOSED');
    this.#invalidate(reason);
    // 先同步拒新操作，再写持久状态；持久失败也不重新开放准入。
    try {
      const manager = this.store.manager();
      if (manager.lifecycle === 'running') this.store.recordLifecycle(manager.revision, 'paused', manager.pin);
    } finally {
      try { this.resources.pause(); }
      finally { this.resources.cancel(reason); this.#publish(); }
    }
  }
  stop(reason = '受信人工停止'): void {
    if (this.#disposed) return;
    this.#invalidate(reason);
    try {
      const manager = this.store.manager();
      if (manager.lifecycle !== 'stopped') this.store.stop(manager.revision, reason);
    } finally {
      this.resources.cancel(reason); this.resources.pause(); this.#publish();
    }
  }
  get generation(): number { return this.#generation; }
  dispose(mode: 'stop' | 'detach' = 'stop'): Promise<void> {
    if (this.#disposeDone) return this.#disposeDone;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.#disposeDone = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    const failures: unknown[] = []; let resourceCleanup: void | Promise<void> = undefined;
    try { if (mode === 'detach') this.pause('依赖断连或换代'); else this.stop('插件停用'); }
    catch (error) { failures.push(error); }
    this.#disposed = true;
    try { resourceCleanup = this.resources.dispose(); } catch (error) { failures.push(error); }
    void Promise.resolve().then(async () => {
      try { await resourceCleanup; } catch (error) { failures.push(error); }
      try { await this.disposeRuntime(); } catch (error) { failures.push(error); }
      this.#listeners.clear(); this.#identities.clear();
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'LIFECYCLE_CLEANUP_FAILED');
    }).then(resolve, reject);
    return this.#disposeDone;
  }
  status(): { accepting: boolean; generation: number; reason: string; disposed: boolean } {
    this.checkDependencies();
    return { accepting: !this.#blocked && !this.#disposed && this.store.manager().lifecycle === 'running',
      generation: this.#generation, reason: this.#reason, disposed: this.#disposed };
  }
}
