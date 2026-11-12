import { mandateExpired } from '../storage/types.js';
import { fingerprint, type StewardStore } from '../storage/store.js';
import type { Identity } from '../storage/types.js';
import type { CurrentReadScope, ReadBranch, ReadLease } from '../app/projections/types.js';
import { ROUTER_PRESET } from '../sessions/manager.js';

export const WORKER_PRESET = 'workspace-superagent-worker';
export const READ_TOOLS = Object.freeze(['steward_list_tasks', 'steward_read_task', 'steward_read_execution']);
export const CONTEXT_TOOLS = ['dsh_context_catalog', 'dsh_context_query'] as const;
export class CallerDenied extends Error {
  constructor(readonly code: string, message = '当前调用者没有此项权限。') { super(message); this.name = 'CallerDenied'; }
}
export interface CallerAgent { readonly id: string }
export interface Invocation<A extends CallerAgent> { readonly agent?: A; readonly parent?: unknown; readonly signal: AbortSignal }
export interface HostPolicy {
  readonly revision: string; readonly backend: 'native'; readonly resources: readonly string[];
  readonly tools: readonly string[]; readonly actions: readonly string[]; readonly audiences: readonly string[];
  readonly maxTokens: number;
  readonly allBoardProjects?: true;
}
export interface NativeTask {
  readonly id: string; readonly workspaceId?: string; readonly projectId?: string | null; readonly status: string;
  readonly taskKind?: string; readonly permission?: string; readonly mode?: string; readonly model?: string; readonly reasoningEffort?: string;
  readonly goalRun?: boolean; readonly teamRun?: boolean; readonly handover?: unknown; readonly parentId?: string | null;
  readonly archivedAt?: number; readonly integrations?: Readonly<Record<string, unknown>>;
  readonly executions: readonly { readonly id: string; readonly sessionId?: string; readonly projectId?: string | null; readonly endedAt?: number; readonly result?: string; readonly external?: boolean; readonly ownResult?: string; readonly cancellation?: unknown }[];
}
/** 仅由原生准入回调产生；检查函数闭包须重新读当前卡与已准入输入，不可从模型参数生成。 */
export interface WorkerAdmission {
  readonly taskId: string; readonly executionId: string; readonly sessionId: string; readonly revision: string;
  assertCurrent(): void;
}
/** Host 私有闭包。没有 model-facing grant/setter；实现须读取原生 registry/TaskBoard/当前宿主政策。 */
export interface CallerHost<A extends CallerAgent> {
  readonly identity: Identity;
  agent(id: string): A | undefined;
  isRuntimeRoot(agent: A): boolean;
  hasForegroundInput?(agent: A): boolean;
  preset(agent: A): string | undefined;
  workspace(agent: A): string | null;
  policy(agent: A): HostPolicy;
  admission(agent: A): WorkerAdmission | undefined;
  task(id: string): NativeTask | undefined;
  defaultPermission(): string | undefined;
  assertAvailable(): void;
  now(): number;
}
export interface CallerLease extends ReadLease {
  readonly role: 'router' | 'worker'; readonly tools: readonly string[]; readonly actions: readonly string[];
  readonly foreground: boolean;
  readonly audiences: readonly string[]; readonly maxTokens: number;
  readonly taskId?: string; readonly executionId?: string;
  require(tool: string, action: string, target?: { taskId?: string; executionId?: string; audience?: string }): void;
}
const deny = (condition: unknown, code: string): void => { if (!condition) throw new CallerDenied(code); };
const intersect = (first: readonly string[], ...rest: readonly (readonly string[])[]): readonly string[] => Object.freeze([...new Set(first)].filter(v => rest.every(values => values.includes(v))).sort());
const validStrings = (value: readonly string[]): boolean => Array.isArray(value) && value.every(v => typeof v === 'string' && v.length > 0);
export function assertSupportedLaunch(task: NativeTask, preset: string | undefined, defaultPermission: string | undefined): void {
  deny(preset === WORKER_PRESET && task.mode === WORKER_PRESET, 'UNSUPPORTED_PRESET');
  deny(task.taskKind !== 'inspection' && !task.goalRun && !task.teamRun && !task.handover && !task.parentId && !task.archivedAt && Object.keys(task.integrations ?? {}).length === 0, 'UNSUPPORTED_EXECUTION_SHAPE');
  deny(['read-only', 'workspace-write', 'danger-full-access'].includes(task.permission ?? defaultPermission ?? ''), 'UNKNOWN_CARD_PERMISSION');
}
export class CallerAuthority<A extends CallerAgent> {
  readonly #identity: Readonly<Identity>;
  constructor(readonly store: StewardStore, readonly host: CallerHost<A>) {
    this.#identity = Object.freeze({ ...store.identity });
    deny(store.identity.instanceId === host.identity.instanceId && store.identity.domainId === host.identity.domainId, 'HOST_DOMAIN_MISMATCH');
  }
  /** 每次工具调用新建；返回的 provider 永远绑定该次真实 Agent 和 signal。 */
  provider(exec: Invocation<A>): CurrentReadScope { return () => this.capture(exec); }
  capture(exec: Invocation<A>): CallerLease {
    exec.signal.throwIfAborted(); this.host.assertAvailable();
    deny(this.host.identity.instanceId === this.#identity.instanceId && this.host.identity.domainId === this.#identity.domainId && this.store.identity.instanceId === this.#identity.instanceId && this.store.identity.domainId === this.#identity.domainId, 'HOST_DOMAIN_MISMATCH');
    const agent = exec.agent;
    deny(agent && this.host.agent(agent.id) === agent, 'CALLER_NOT_CURRENT');
    deny(exec.parent === undefined && this.host.isRuntimeRoot(agent!), 'INDIRECT_CALL_DENIED');
    const source = this.store.readAuthorizationSnapshot();
    const foreground = this.host.preset(agent!) === ROUTER_PRESET && this.host.hasForegroundInput?.(agent!) === true;
    // 受管 Worker 的执行在看板侧异步启动，主理轮次结束后 manager 处于 paused 属正常；它的授权由准入绑定与执行归属约束。
    deny(!this.store.diagnostics().recoveryPending && this.store.diagnostics().healthy &&
      (source.lifecycle === 'running' || (source.lifecycle === 'paused' && (foreground || this.host.preset(agent!) === WORKER_PRESET))), 'NOT_RUNNING');
    deny(!mandateExpired(source.policy.mandate.expiresAt, this.host.now()), 'MANDATE_EXPIRED');
    const hostPolicy = this.host.policy(agent!);
    deny(hostPolicy.backend === 'native' && hostPolicy.revision && Number.isSafeInteger(hostPolicy.maxTokens) && hostPolicy.maxTokens > 0 && [hostPolicy.resources, hostPolicy.tools, hostPolicy.actions, hostPolicy.audiences].every(validStrings), 'HOST_POLICY_UNAVAILABLE');
    const manager = this.store.manager(), preset = this.host.preset(agent!), workspace = this.host.workspace(agent!);
    deny(fingerprint(manager.versions) === fingerprint(source.versions) && manager.lifecycle === source.lifecycle, 'SCOPE_CHANGED');
    let role: 'router' | 'worker', task: NativeTask | undefined, admission: WorkerAdmission | undefined;
    if (preset === ROUTER_PRESET) {
      deny(manager.bindingState === 'bound' && manager.sessionId === agent!.id && manager.workspaceId === workspace && manager.preset === preset, 'ROUTER_BINDING_MISMATCH');
      role = 'router';
    } else {
      deny(preset === WORKER_PRESET, 'PRESET_DENIED');
      admission = this.host.admission(agent!);
      deny(admission && admission.sessionId === agent!.id, 'ADMISSION_REQUIRED'); admission!.assertCurrent();
      task = this.host.task(admission!.taskId); deny(task, 'TASK_MISSING');
      assertSupportedLaunch(task!, preset, this.host.defaultPermission());
      const open = task!.executions.filter(e => e.endedAt === undefined && !e.external);
      const current = open[0];
      deny(task!.status === 'running' && open.length === 1 && current!.id === admission!.executionId && current!.sessionId === agent!.id && !current!.cancellation && !current!.ownResult && !current!.result && task!.workspaceId === workspace, 'EXECUTION_NOT_CURRENT');
      role = 'worker';
    }
    const resources = source.resources.filter(r => hostPolicy.resources.includes(r.id));
    const branches: readonly ReadBranch[] = Object.freeze(resources.flatMap(resource => {
      if (role === 'worker' && resource.workspaceId !== task!.workspaceId) return [];
      const project = resource.repositoryId === undefined ? resource.workspaceId : resource.repositoryId;
      if (role === 'worker') {
        const execution = task!.executions.find(e => e.id === admission!.executionId)!;
        deny(execution.projectId !== undefined, 'EXECUTION_PROJECT_UNKNOWN');
        const actualProject = execution.projectId;
        if (actualProject !== project) return [];
      }
      return [Object.freeze({ workspaceId: resource.workspaceId, projectIds: Object.freeze([project]), ...(role === 'worker' ? { taskIds: Object.freeze([task!.id]) } : {}) })];
    }));
    const actions = intersect(source.policy.mandate.actions, hostPolicy.actions, task && (task.permission ?? this.host.defaultPermission()) === 'read-only' ? ['read'] : source.policy.mandate.actions);
    const eligible = role === 'router' && foreground ? [...READ_TOOLS, ...CONTEXT_TOOLS] : READ_TOOLS;
    const tools = intersect(eligible, hostPolicy.tools, actions.includes('read') ? eligible : []);
    const audiences = intersect(source.policy.audiences, hostPolicy.audiences);
    deny(branches.length > 0, 'NO_AUTHORIZED_RESOURCE');
    const allBoardProjects = role === 'router' && foreground && actions.includes('read') && hostPolicy.allBoardProjects === true;
    const captured = { identity: { ...this.store.identity }, agentId: agent!.id, role, preset, workspace, foreground, managerRevision: manager.revision,
      source, hostPolicy: { revision: hostPolicy.revision, backend: hostPolicy.backend, resources: [...hostPolicy.resources], tools: [...hostPolicy.tools], actions: [...hostPolicy.actions], audiences: [...hostPolicy.audiences], maxTokens: hostPolicy.maxTokens },
      task: task ? JSON.parse(JSON.stringify(task)) as NativeTask : undefined, admission: admission ? { taskId: admission.taskId, executionId: admission.executionId, sessionId: admission.sessionId, revision: admission.revision } : undefined, branches, allBoardProjects };
    const binding = fingerprint(captured);
    const assertCurrent = () => {
      exec.signal.throwIfAborted();
      const current = this.captureCurrent(exec, agent!);
      deny(current === binding, 'SCOPE_CHANGED');
    };
    const lease: CallerLease = Object.freeze({
      fingerprint: binding, policyRevision: String(source.versions.policyVersion), scopeRevision: fingerprint(source.versions),
      branches, role, foreground, tools, actions, audiences, maxTokens: hostPolicy.maxTokens,
      ...(allBoardProjects ? { allBoardProjects: true as const } : {}),
      ...(admission ? { taskId: admission.taskId, executionId: admission.executionId } : {}),
      assertCurrent,
      require: (tool: string, action: string, target?: { taskId?: string; executionId?: string; audience?: string }) => {
        assertCurrent(); deny(tools.includes(tool) && actions.includes(action), 'CAPABILITY_DENIED');
        if (target?.audience !== undefined) deny(audiences.includes(target.audience), 'AUDIENCE_DENIED');
        if (role === 'worker') {
          deny(target?.taskId === undefined || target.taskId === admission!.taskId, 'CROSS_TASK_DENIED');
          deny(target?.executionId === undefined || target.executionId === admission!.executionId, 'CROSS_EXECUTION_DENIED');
        }
      },
    });
    return lease;
  }
  private captureCurrent(exec: Invocation<A>, original: A): string {
    deny(this.host.agent(original.id) === original, 'CALLER_NOT_CURRENT');
    // capture 不执行 assertCurrent；这里重新构造全部可信来源，不复用旧 lease 续权。
    return this.capture(exec).fingerprint;
  }
}
