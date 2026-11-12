import { fingerprint, type StewardStore } from '../storage/store.js';

export type ManagerSnapshot = ReturnType<StewardStore['manager']>;
export class InstallationError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'InstallationError'; }
}
export interface Publication { ready: boolean }
export interface StagedInstallation { readonly kind: 'paused-installation' }
interface Stage {
  operation: InstallationOperation; publication: Publication; check(): void; prepareFacts(): void; assertFacts(): void; consumed: boolean;
}
const stages = new WeakMap<StagedInstallation, Stage>();
/** 只由可信人工控制调用创建；不是 running lease，不接受外部 revision 采纳。 */
export class InstallationOperation {
  #expected: ManagerSnapshot;
  #revoked = false;
  #committed = false;
  #failureCleanup: (() => Promise<void>)[] = [];
  #cancelled?: Promise<void>;
  #stages = new Set<Stage>();
  readonly #identity: string;
  readonly #trace: { transition: string; snapshot: ManagerSnapshot }[] = [];
  constructor(readonly store: StewardStore, readonly signal: AbortSignal, readonly guard: () => void) {
    this.#identity = fingerprint(store.identity);
    this.#expected = store.manager();
    this.#trace.push({ transition: 'capture', snapshot: this.snapshot });
    this.check();
  }
  get snapshot(): ManagerSnapshot { return structuredClone(this.#expected); }
  get trace(): readonly { transition: string; snapshot: ManagerSnapshot }[] { return structuredClone(this.#trace); }
  #exact(): void {
    this.signal.throwIfAborted();
    if (this.#revoked || fingerprint(this.store.identity) !== this.#identity ||
        fingerprint(this.store.manager()) !== fingerprint(this.#expected)) throw new InstallationError('INSTALLATION_CHANGED');
  }
  check(): void { this.#exact(); this.guard(); this.#exact(); }
  #advance(transition: string, expected: ManagerSnapshot, write: () => ManagerSnapshot): void {
    this.check();
    const result = write();
    if (fingerprint(result) !== fingerprint(expected)) { this.revoke(); throw new InstallationError('INSTALLATION_CAS_RESULT'); }
    this.#expected = expected;
    this.#trace.push({ transition, snapshot: this.snapshot });
    this.check();
  }
  reopen(proof: string): void {
    const m = this.snapshot;
    this.#advance('reopen', { ...m, revision: m.revision + 1, lifecycle: 'paused', versions: { ...m.versions, scopeVersion: m.versions.scopeVersion + 1 } },
      () => this.store.reopenScope(m.revision, m.versions.scopeVersion, proof));
  }
  reserve(sessionId: string, workspaceId: string, preset: string): void {
    const m = this.snapshot;
    this.#advance('reserve', { ...m, revision: m.revision + 1, sessionId, workspaceId, preset, bindingState: 'reserved' },
      () => this.store.reserveManager(m.revision, sessionId, workspaceId, preset));
  }
  beginCreate(): void {
    const m = this.snapshot;
    this.#advance('unknown', { ...m, revision: m.revision + 1, bindingState: 'unknown' },
      () => this.store.beginManagerCreate(m.revision));
  }
  bind(observation: { sessionId: string; workspaceId: string; preset: string; nativeLogRef: string; nativeIdentity?: string }): void {
    const m = this.snapshot;
    this.#advance('bind', { ...m, revision: m.revision + 1, bindingState: 'bound' },
      () => this.store.bindManager(m.revision, observation));
  }
  stage(publication: Publication, check: () => void, assertFacts: () => void = () => {}, prepareFacts: () => void = () => {}): StagedInstallation {
    this.check(); publication.ready = false; check(); this.check();
    const token: StagedInstallation = Object.freeze({ kind: 'paused-installation' });
    const stage: Stage = { operation: this, publication, check, prepareFacts, assertFacts, consumed: false };
    stages.set(token, stage); this.#stages.add(stage); return token;
  }
  preflight(token: StagedInstallation): void {
    const stage = stages.get(token);
    if (!stage || stage.operation !== this || stage.consumed) throw new InstallationError('INSTALLATION_CAPSULE_REQUIRED');
    this.check(); stage.check(); this.check();
    stage.prepareFacts();
  }
  /** preflight 完成后调用；此同步段没有扩展回调或 await。 */
  commit(token: StagedInstallation, mode: 'running' | 'paused' = 'running'): ManagerSnapshot {
    const stage = stages.get(token);
    if (!stage || stage.operation !== this || stage.consumed) throw new InstallationError('INSTALLATION_CAPSULE_REQUIRED');
    // 仅可信 runtime 的纯事实读回；不能包含 caller、政策提供器或 operation.check。
    stage.assertFacts(); this.#exact();
    const m = this.#expected;
    if (m.lifecycle !== 'paused' || m.bindingState !== 'bound') throw new InstallationError('INSTALLATION_NOT_BOUND');
    const result = mode === 'running' ? this.store.recordLifecycle(m.revision, mode, m.pin) : this.snapshot;
    if (mode === 'running') this.#expected = { ...m, lifecycle: mode, revision: m.revision + 1 };
    this.#committed = true;
    stage.consumed = true; stage.publication.ready = true;
    this.#trace.push({ transition: mode, snapshot: this.snapshot });
    return result;
  }
  onFailure(clean: () => Promise<void>): void { this.check(); this.#failureCleanup.push(clean); }
  cancel(): Promise<void> {
    this.revoke();
    return this.#cancelled ??= Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      if (!this.#committed) for (const clean of this.#failureCleanup.reverse()) {
        try { await clean(); } catch (error) { failures.push(error); }
      }
      this.#failureCleanup = [];
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'INSTALLATION_CLEANUP_FAILED');
    });
  }
  revoke(): void { this.#revoked = true; for (const stage of this.#stages) stage.publication.ready = false; }
  /** 仅对本操作精确提交结果补偿；不重读采纳他人合法状态。 */
  compensate(committed: ManagerSnapshot): void {
    this.revoke();
    if (fingerprint(this.store.manager()) === fingerprint(committed)) this.store.recordLifecycle(committed.revision, 'paused', committed.pin);
  }
}
