import { fingerprint, type StewardStore } from '../storage/store.js';
import { CallerDenied, WORKER_PRESET, assertSupportedLaunch, type CallerAgent, type NativeTask, type WorkerAdmission } from '../tools/authority.js';

export interface AdmittedMessage { readonly id: string; readonly source?: { readonly rpcId?: string } }
export interface AdmissionAgent extends CallerAgent {
  readonly inputAdmissionVersion?: number;
  requireInputAdmission?(): void;
  readonly inbox: { readonly nextTurn: readonly AdmittedMessage[]; readonly nextStep: readonly AdmittedMessage[] };
  runMaintenance<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
export interface AdmissionRequest {
  readonly taskId: string; readonly executionId: string; readonly generation: number; readonly sessionId: string;
  readonly task: NativeTask; readonly isCurrent: () => boolean;
}
export interface AdmissionFace<A extends AdmissionAgent> {
  availableVersion(): number | undefined;
  agent(id: string): A | undefined;
  resolve(id: string): Promise<A>;
  preset(agent: A): string | undefined;
  task(id: string): NativeTask | undefined;
  defaultPermission(): string | undefined;
  assertLaunchPolicy(task: NativeTask): void;
}
interface Binding<A> {
  agent: A; request: AdmissionRequest; requestId: string; sourceFingerprint: string;
  taskFingerprint: string; revoked: boolean; messageIds?: ReadonlySet<string>;
}
/** 仅保存本 Host 生命周期的精确准入能力；冷启动为空，不从 mandate 恢复动态授权。 */
export class ExecutionAdmission<A extends AdmissionAgent> {
  readonly #scoped = new WeakSet<A>();
  readonly #bindings = new WeakMap<A, Binding<A>>();
  readonly #revoked = new Set<string>();
  constructor(readonly store: StewardStore, readonly face: AdmissionFace<A>) {}
  assertAvailable(): void {
    if (this.face.availableVersion() !== 4) throw new CallerDenied('PRECLAIM_CAPABILITY_REQUIRED', '当前宿主缺少输入准入接缝，不能创建或恢复受管执行。');
  }
  assertLaunch(task: NativeTask, preset: string | undefined): void {
    this.assertAvailable(); assertSupportedLaunch(task, preset, this.face.defaultPermission()); this.#source(); this.face.assertLaunchPolicy(task);
  }
  markScoped(agent: A): void {
    this.assertAvailable();
    if (agent.inputAdmissionVersion !== 4 || typeof agent.requireInputAdmission !== 'function') throw new CallerDenied('PRECLAIM_CAPABILITY_REQUIRED');
    agent.requireInputAdmission();
    if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new CallerDenied('PENDING_RESTORE', '原会话还有未准入输入，拒绝恢复执行。');
    this.#scoped.add(agent);
  }
  revoke(request: { taskId: string; executionId: string; sessionId?: string }): void {
    this.#revoked.add(JSON.stringify([request.taskId, request.executionId]));
    if (request.sessionId) {
      const agent = this.face.agent(request.sessionId), binding = agent && this.#bindings.get(agent);
      if (binding && binding.request.taskId === request.taskId && binding.request.executionId === request.executionId) binding.revoked = true;
    }
  }
  /** 主理一轮结束后 manager 会暂停；派工的执行在那一轮之后异步启动，因此准入只要求主理仍绑定且授权来源健康，生命周期只需不是 stopped。 */
  #source(): string {
    const source = this.store.readAuthorizationSnapshot(), diagnostics = this.store.diagnostics(), manager = this.store.manager();
    if (diagnostics.recoveryPending || !diagnostics.healthy || source.lifecycle === 'stopped' || manager.bindingState !== 'bound') throw new CallerDenied('NOT_RUNNING');
    // 指纹不含 lifecycle：主理暂停/恢复不应撤销已经准入的 Worker；授权来源、策略和范围变化仍会撤销。
    return fingerprint({ versions: source.versions, policy: source.policy, resources: source.resources });
  }
  #task(id: string): NativeTask {
    const task = this.face.task(id); if (!task) throw new CallerDenied('TASK_MISSING'); return task;
  }
  #assert(binding: Binding<A>): void {
    if (binding.revoked || this.#revoked.has(JSON.stringify([binding.request.taskId, binding.request.executionId])) || this.face.agent(binding.agent.id) !== binding.agent || !binding.request.isCurrent() ||
      this.#source() !== binding.sourceFingerprint || fingerprint(this.#task(binding.request.taskId)) !== binding.taskFingerprint) throw new CallerDenied('ADMISSION_REVOKED');
  }
  current(agent: A): WorkerAdmission | undefined {
    const binding = this.#bindings.get(agent);
    if (!binding) return undefined;
    this.#assert(binding);
    return Object.freeze({ taskId: binding.request.taskId, executionId: binding.request.executionId, sessionId: agent.id,
      revision: fingerprint({ source: binding.sourceFingerprint, task: binding.taskFingerprint, requestId: binding.requestId }),
      assertCurrent: () => this.#assert(binding) });
  }
  async admit(request: AdmissionRequest, run: (setup?: (requestId: string) => Promise<void>) => Promise<void>): Promise<void> {
    this.assertLaunch(request.task, WORKER_PRESET);
    const source = this.#source(), task = this.#task(request.taskId), taskFingerprint = fingerprint(task);
    const assertRequest = () => {
      if (!request.isCurrent() || this.#revoked.has(JSON.stringify([request.taskId, request.executionId])) || this.#source() !== source || fingerprint(this.#task(request.taskId)) !== taskFingerprint) throw new CallerDenied('STALE_EXECUTION');
    };
    assertRequest();
    let agent = this.face.agent(request.sessionId);
    if (!agent) agent = await this.face.resolve(request.sessionId);
    assertRequest();
    if (this.face.agent(agent.id) !== agent || this.face.preset(agent) !== WORKER_PRESET || !this.#scoped.has(agent)) throw new CallerDenied('UNMANAGED_SESSION');
    const current = task.executions.filter(e => e.endedAt === undefined && !e.external);
    if (task.status !== 'running' || current.length !== 1 || current[0]!.id !== request.executionId || current[0]!.sessionId !== request.sessionId || request.sessionId !== agent.id || current[0]!.cancellation || current[0]!.ownResult || current[0]!.result) throw new CallerDenied('EXECUTION_NOT_CURRENT');
    if (!Number.isSafeInteger(request.generation) || request.generation < 1 || task.executions.findIndex(entry => entry.id === request.executionId) + 1 !== request.generation) throw new CallerDenied('EXECUTION_GENERATION_UNKNOWN');
    this.store.registerExecution(request.taskId, request.executionId, request.generation);
    const exact = agent;
    await exact.runMaintenance(async signal => {
      const assertEmpty = () => {
        signal.throwIfAborted(); assertRequest();
        if (exact.inbox.nextTurn.length || exact.inbox.nextStep.length) throw new CallerDenied('PENDING_INPUT');
      };
      assertEmpty(); this.#bindings.delete(exact);
      try {
        await run(async requestId => {
          assertEmpty(); if (!requestId) throw new CallerDenied('INPUT_ID_REQUIRED');
          this.#bindings.set(exact, { agent: exact, request, requestId, sourceFingerprint: source, taskFingerprint, revoked: false });
        });
        signal.throwIfAborted(); assertRequest();
      } catch (error) { this.#bindings.delete(exact); throw error; }
    });
    assertRequest();
  }
  checkClaim(payload: { agent: A; messages: readonly AdmittedMessage[]; nextTurn: readonly AdmittedMessage[]; nextStep: readonly AdmittedMessage[]; signal: AbortSignal }): { kind: 'reject' } | { kind: 'claim'; validate: () => boolean } {
    const binding = this.#bindings.get(payload.agent);
    const validate = () => {
      try {
        payload.signal.throwIfAborted();
        if (!binding) return false; this.#assert(binding);
        if ([...payload.messages, ...payload.nextTurn, ...payload.nextStep].some(m => m.source?.rpcId !== binding.requestId)) return false;
        if (binding.messageIds && payload.messages.some(m => !binding.messageIds!.has(m.id))) return false;
        return true;
      } catch { return false; }
    };
    if (!validate()) return { kind: 'reject' };
    if (!binding!.messageIds) binding!.messageIds = new Set(payload.messages.map(m => m.id));
    return { kind: 'claim', validate };
  }
  checkStep(agent: A, messages: readonly AdmittedMessage[], signal: AbortSignal): void {
    signal.throwIfAborted(); const binding = this.#bindings.get(agent);
    if (!binding) throw new CallerDenied('ADMISSION_REQUIRED'); this.#assert(binding);
    if (messages.some(m => m.source?.rpcId !== binding.requestId || !binding.messageIds?.has(m.id))) throw new CallerDenied('INPUT_NOT_ADMITTED');
  }
}
