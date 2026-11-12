import { mandateExpired } from '../../storage/types.js';
import { ActionService } from '../../actions/service.js';
import { canonical } from '../../sessions/origin.js';
import { randomUUID } from 'node:crypto';
import { StableSessionOwner } from '../../sessions/origin.js';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { createRuntime, type NativeBoard, type RuntimeConfig, type RuntimeContext } from '../../sessions/runtime.js';
import type { ContextAccess, ContextService } from '../../tools/context.js';
import { fingerprint, type StewardStore } from '../../storage/store.js';
import { LifecycleCoordinator, type Dependency } from './coordinator.js';
import { EvalDeadlines } from './evals.js';
import { JobSupervisor } from './jobs.js';
import { capacityBlocks, unavailableHealth, type HealthView } from '../health/view.js';
import { healthRoutes, type HealthConnection, type HealthControl, type HealthWebServer } from '../health/http.js';
import { createDailyMotto, type MottoLlm } from '../health/daily-motto.js';
import { PersonalService } from '../personal/service.js';
import { DelegationService } from '../delegation/service.js';
import { delegationActivities } from '../delegation/activity.js';
import type { BoardLaunchFace } from '../delegation/launch.js';
import { delegationTargetRejection } from '../delegation/guard.js';
import type { CapturedTask } from '../projections/types.js';
export interface HostAssembly { readonly store: StewardStore; readonly runtimeConfig: RuntimeConfig; readonly workspaceName?: string; readonly mottoPath?: string; readonly contextGrants?: ContextAccess['grants']; readiness?(): string | null }
/** 只改变原可信policy的修订身份；既有权限/预算每次仍由原来源决定。 */
export function bindLifecyclePolicy(
  current: RuntimeConfig['currentPolicy'],
  coordinator: () => Pick<LifecycleCoordinator, 'generation'> | undefined,
): RuntimeConfig['currentPolicy'] {
  const nonce = randomUUID();
  return agent => {
    const lifecycle = coordinator();
    if (!lifecycle) throw Error('LIFECYCLE_NOT_READY');
    const policy = current(agent);
    return { ...policy, revision: fingerprint({ trustedRevision: policy.revision, lifecycleInstance: nonce, generation: lifecycle.generation }) };
  };
}
/** 只使用可信Host提供的已打开存储；请求不能指定路径、SQL或配置。 */
export function installHealthHost(ctx: Context): void {
  const owner = new StableSessionOwner(ctx as unknown as RuntimeContext);
  ctx.effect(() => () => owner.dispose());
  let active: HealthControl | undefined, lastStore: StewardStore | undefined;
  let failure = '未提供可信Host装配；保留原骨架与会话，不自动创建数据库。';
  const fallback: HealthControl = {
    read() {
      const view = unavailableHealth(failure);
      if (lastStore) {
        try { view.summary = lastStore.readHealthSummary(Date.now()); view.sampledAt = view.summary.sampledAt; view.available = true; }
        catch { /* 已关闭的拥有方存储不另开、不补空。 */ }
      }
      return view;
    },
    revision() { throw Error('HOST_UNAVAILABLE'); }, execute() { throw Error('HOST_UNAVAILABLE'); },
  };
  const routes = healthRoutes(() => ctx.get('connection') as unknown as HealthConnection | undefined, () => active ?? fallback,
    () => ctx.get('webServer') as unknown as HealthWebServer | undefined);
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workspace-superagent/health',
    methods: ['GET'], requestBody: 'buffered', fetch: routes.read }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workspace-superagent/control',
    methods: ['POST'], requestBody: 'buffered', fetch: routes.control }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workspace-superagent/chat',
    methods: ['POST'], requestBody: 'buffered', fetch: routes.chat }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workspace-superagent/actions',
    methods: ['POST'], requestBody: 'buffered', fetch: routes.actions }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workspace-superagent/personal',
    methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: request => request.method === 'GET' ? routes.personalRead(request) : routes.personalWrite(request) }));
  const stores = new Set<StewardStore>();
  ctx.effect(() => () => {
    for (const store of stores) {
      try { const manager = store.manager(); if (manager.lifecycle === 'running') store.recordLifecycle(manager.revision, 'paused', manager.pin); }
      catch { failure = '暂停持久化未确认；禁止重新准入，保留未决状态。'; }
    }
    stores.clear();
  });
  const required = ['workspaceSuperagentHostConfig', 'agents', 'sessionController', 'sessionPersistence', 'sessions', 'webServer', 'workspaceRegistry', 'agentLoop', 'agentPresets', 'workspaceController'];
  ctx.inject(required, scoped => {
    const assembly = scoped.get('workspaceSuperagentHostConfig') as HostAssembly | undefined;
    if (!assembly || typeof assembly.store?.readHealthSummary !== 'function') { failure = '可信存储或健康摘要能力未提供。'; return; }
    const store = assembly.store; lastStore = store; stores.add(store);
    if ((scoped.get('agentLoop') as { inputAdmissionVersion?: number } | undefined)?.inputAdmissionVersion !== 4) {
      failure = '输入准入能力4未提供；旧能力3不作为当前候选生效。'; return;
    }
    if (store.diagnostics().recoveryPending) store.recover();
    let coordinator: LifecycleCoordinator | undefined;
    const workspaceId = assembly.runtimeConfig.workspaceId;
    const registry = scoped.get('workspaceRegistry') as { get(id: string): { path: string } | undefined };
    const workspace = registry.get(workspaceId);
    if (!workspace) { failure = '当前主理工作区不可用。'; return; }
    let runtime: ReturnType<typeof createRuntime>;
    let board: NativeBoard | undefined;
    scoped.inject(['taskBoard'], boardCtx => {
      board = boardCtx.get('taskBoard') as NativeBoard;
      runtime?.refreshBoard();
      boardCtx.effect(() => () => { board = undefined; runtime?.refreshBoard(); });
    });
    let contextService: ContextService | undefined;
    scoped.inject(['workspaceContext'], contextCtx => {
      contextService = contextCtx.get('workspaceContext') as ContextService;
      contextCtx.effect(() => () => { contextService = undefined; });
    });
    let schedule: unknown;
    scoped.inject(['schedule'], scheduleCtx => {
      schedule = scheduleCtx.get('schedule');
      scheduleCtx.effect(() => () => { schedule = undefined; });
    });
    const drafts = new ActionService(store.path + '.actions.sqlite', {
      workspaceId, workspacePath: workspace.path, board: () => board, schedule: () => schedule,
      model: () => assembly.runtimeConfig.model,
      check() {
        const manager = store.manager(), scope = store.readAuthorizationSnapshot();
        if (assembly.readiness?.() || manager.lifecycle === 'stopped' || manager.workspaceId !== workspaceId ||
            canonical(registry.get(workspaceId)) !== canonical(workspace) ||
            !scope.resources.some(r => scope.policy.resources.includes(r.id) && r.workspaceId === workspaceId && r.repositoryId === workspaceId) ||
            !scope.policy.mandate.actions.includes('read') ||
            mandateExpired(scope.policy.mandate.expiresAt, Date.now())) throw Error('DRAFT_SCOPE_CHANGED');
      },
    });
    scoped.effect(() => () => drafts.close());
    const scopeError = () => { throw Error('DELEGATION_SCOPE_CHANGED'); };
    const assertScope = () => {
      const manager = store.manager(), scope = store.readAuthorizationSnapshot();
      if (manager.workspaceId !== workspaceId || canonical(registry.get(workspaceId)) !== canonical(workspace) ||
          !scope.resources.some(r => scope.policy.resources.includes(r.id) && r.workspaceId === workspaceId && r.repositoryId === workspaceId) ||
          !scope.policy.mandate.actions.includes('read') || mandateExpired(scope.policy.mandate.expiresAt, Date.now())) scopeError();
    };
    const boardLaunchFace = (): BoardLaunchFace | undefined => {
      const face = board as {
        durableLaunchReceiptVersion?: unknown;
        startWithReceipt?(request: { operationId: string; taskId: string; workspaceId: string; initiator: string }): unknown;
        readLaunchReceipt?(request: { operationId: string; taskId: string }): unknown;
      } | undefined;
      if (!face || !runtime.source.isAvailable() || face.durableLaunchReceiptVersion !== 1 ||
          typeof face.startWithReceipt !== 'function' || typeof face.readLaunchReceipt !== 'function') return undefined;
      const start = face.startWithReceipt.bind(face), read = face.readLaunchReceipt.bind(face);
      return {
        durableLaunchReceiptVersion: 1,
        async startWithReceipt(request) {
          // 只派发显式只读的看板卡：主理不能把宽权限卡交给 Worker，也不改写原卡配置。
          if (canonical(board) !== canonical(face) || !runtime.source.isAvailable()) {
            return { state: 'rejected', operationId: request.operationId, taskId: request.taskId, reason: 'BOARD_UNAVAILABLE' };
          }
          const snapshot = (face as NativeBoard).snapshot();
          const rejection = delegationTargetRejection(snapshot, request);
          if (rejection) return rejection;
          return await start({ operationId: request.operationId, taskId: request.taskId, workspaceId: request.workspaceId, initiator: request.routerSessionId }) as Awaited<ReturnType<BoardLaunchFace['startWithReceipt']>>;
        },
        async readLaunchReceipt(request) {
          return await read({ operationId: request.operationId, taskId: request.taskId }) as Awaited<ReturnType<BoardLaunchFace['readLaunchReceipt']>>;
        },
      };
    };
    const delegation = new DelegationService(store.path + '.delegation.sqlite', {
      workspaceId,
      assertScope,
      assertCurrent(sessionId) {
        const manager = store.manager();
        if (manager.bindingState !== 'bound' || manager.sessionId !== sessionId || manager.workspaceId !== workspaceId) scopeError();
        assertScope();
      },
      board: boardLaunchFace,
    });
    scoped.effect(() => () => delegation.close());
    const personalActivities = async (sessionId: string) => {
      const records = delegation.list(sessionId);
      const unresolved = records.filter(record => record.state === 'unknown');
      if (unresolved.length) {
        // 只对已登记但结果未知的原操作读回执；超时保留 unknown，不重发启动。
        await Promise.race([
          Promise.all(unresolved.map(record => delegation.reconcile(sessionId, record.operationId, record.taskId).catch(() => undefined))),
          new Promise(resolve => setTimeout(resolve, 2000)),
        ]);
      }
      const latest = delegation.list(sessionId);
      let tasks: readonly CapturedTask[] = [];
      try { tasks = runtime.source.capture().tasks; } catch { /* 回执本身仍可展示。 */ }
      return { available: true, items: delegationActivities(latest, tasks) };
    };
    const runtimeConfig: RuntimeConfig = { ...assembly.runtimeConfig, actionDrafts: drafts, board: () => board,
      ...(assembly.contextGrants && { context: { grants: assembly.contextGrants, service: () => contextService } }),
      delegation: { start: (sessionId: string, operationId: string, taskId: string) => delegation.start(sessionId, operationId, taskId) },
      currentPolicy: bindLifecyclePolicy(agent => assembly.runtimeConfig.currentPolicy(agent), () => coordinator) };
    try { runtime = createRuntime(scoped as unknown as RuntimeContext, store, runtimeConfig, owner); }
    catch { failure = '原生运行时装配失败，保持不可用。'; return; }
    const personal = new PersonalService(store.path + '.personal.sqlite', {
      workspaceId,
      sessionId: () => {
        const manager = store.manager();
        return manager.bindingState === 'bound' ? manager.sessionId : null;
      },
      assertCurrent() {
        const manager = store.manager(), scope = store.readAuthorizationSnapshot();
        if (mandateExpired(scope.policy.mandate.expiresAt, Date.now())) throw Error('PERSONAL_AUTH_EXPIRED');
        if (manager.workspaceId !== workspaceId || canonical(registry.get(workspaceId)) !== canonical(workspace) ||
            !scope.resources.some(r => scope.policy.resources.includes(r.id) && r.workspaceId === workspaceId && r.repositoryId === workspaceId) ||
            !scope.policy.mandate.actions.includes('read')) throw Error('PERSONAL_SCOPE_CHANGED');
      },
      tasks: () => runtime.source.capture().tasks,
      schedule: () => schedule as { view(request: { id: string }): Promise<never> } | undefined,
      scheduleIds: session => drafts.ownedScheduleIds(session),
      activities: personalActivities,
    });
    scoped.effect(() => () => personal.close());
    let componentFault: string | null = null;
    const fault = (_error: unknown) => { componentFault = '存在未决组件故障，请核对原件和持久状态。'; };
    const evals = new EvalDeadlines(store, () => { if (!coordinator) throw Error('LIFECYCLE_NOT_READY'); return coordinator.lease(); }, fault);
    const jobs = new JobSupervisor(store, () => { if (!coordinator) throw Error('LIFECYCLE_NOT_READY'); return coordinator.lease(); }, () => {}, fault);
    const dependencies: Dependency[] = required.map(name => ({
      name, current: () => scoped.get(name),
      accepts: value => !!value && (name !== 'agentLoop' || (value as { inputAdmissionVersion?: number }).inputAdmissionVersion === 4),
    }));
    const safeCapacity = () => {
      if (componentFault || capacityBlocks(store.readHealthSummary(Date.now())).length) throw Error('CAPACITY_OR_COMPONENT_UNAVAILABLE');
    };
    const lifecycle = new LifecycleCoordinator(store, dependencies,
      { pause: () => evals.pause(), resume: () => evals.resume(),
        cancel: reason => jobs.cancelAll(reason), dispose() { evals.dispose(); jobs.dispose(); } },
      async operation => { operation.check(); const staged = await runtime.manager.ensure(operation); operation.check(); return staged; },
      () => runtime.dispose(), safeCapacity);
    coordinator = lifecycle;
    try { lifecycle.initialize(); }
    catch { lifecycle.dispose(); failure = '生命周期初始化失败，保持关闭准入。'; return; }
    const chat = () => {
      const manager = store.manager(), agent = manager.sessionId && owner.owned(store, manager.sessionId);
      const reason = assembly.readiness?.() ?? componentFault;
      return { sessionId: manager.bindingState === 'bound' ? manager.sessionId : null,
        ready: !!agent && manager.lifecycle !== 'stopped' && !reason && lifecycle.checkDependencies() && runtime.isPublished(agent),
        reason, workspace: assembly.workspaceName ?? '', model: runtime.routerModel() };
    };
    const read = (): HealthView => {
      const automation = lifecycle.status(), summary = store.readHealthSummary(Date.now());
      const readiness = assembly.readiness?.() ?? null;
      const grants = assembly.contextGrants;
      const contextSources = grants && (contextService?.status(grants) ?? Object.keys(grants).map(id => ({ id, available: false })));
      return { ...unavailableHealth('', summary.sampledAt), available: true, reason: componentFault ?? readiness,
        summary, automation, dependencies: lifecycle.dependencyStatus(), contextSources,
        handles: { evalTimers: evals.handles(), jobs: jobs.handles() },
        capacityBlocks: [...capacityBlocks(summary), ...(componentFault ? [componentFault] : [])],
        control: { enabled: true, reason: readiness }, chat: chat() };
    };
    const assertChatCurrent = (sessionId: string, caller: Parameters<NonNullable<HealthControl['send']>>[3]) => {
      caller.assertCurrent();
      const state = chat();
      if (state.sessionId !== sessionId) throw Error('CHAT_SESSION_CHANGED');
      if (!state.ready) throw Error('CHAT_NOT_CONNECTED');
      safeCapacity();
    };
    const mottoLifetime = new AbortController();
    const dailyMotto = assembly.mottoPath && createDailyMotto(assembly.mottoPath, mottoLifetime.signal);
    const control: HealthControl = { read, revision: () => store.manager().revision,
      async dailyMotto() {
        return dailyMotto && chat().ready ? dailyMotto(scoped.get('llm') as MottoLlm | undefined, runtime.routerModel()) : null;
      },
      execute(action, revision, proofRef, caller) {
        caller.assertCurrent();
        if (store.manager().revision !== revision) throw Error('REVISION_CONFLICT');
        if (action === 'resume' && assembly.readiness?.()) throw Error('HOST_MODEL_OR_MANDATE_REQUIRED');
        if (action === 'pause') lifecycle.pause();
        else if (action === 'stop') lifecycle.stop();
        else return lifecycle.resume(revision, proofRef, caller);
      },
      connect(revision, proofRef, caller) {
        caller.assertCurrent();
        if (store.manager().revision !== revision) throw Error('REVISION_CONFLICT');
        const state = chat();
        if (state.reason) throw Error('HOST_MODEL_OR_MANDATE_REQUIRED');
        if (!state.ready) return lifecycle.connect(revision, proofRef, caller);
      },
      async send(sessionId, requestId, text, caller) {
        assertChatCurrent(sessionId, caller);
        await runtime.submitRouterInput(text, caller.signal, { requestId, assertCurrent: () => assertChatCurrent(sessionId, caller) });
      },
      async sendContent(sessionId, requestId, content, caller) {
        assertChatCurrent(sessionId, caller);
        await runtime.submitRouterInput(content, caller.signal, { requestId, assertCurrent: () => assertChatCurrent(sessionId, caller) });
      },
      async actions(sessionId, value, caller) {
        const assertCurrent = () => assertChatCurrent(sessionId,caller);
        assertCurrent();
        return await drafts.handle(sessionId,value,assertCurrent);
      },
      async personalRead(caller) {
        caller.assertCurrent();
        const session = store.manager().sessionId;
        if (!session) throw Error('CHAT_SESSION_CHANGED');
        const result = await personal.read(session);
        caller.assertCurrent();
        return result;
      },
      async personalWrite(sessionId, value, caller) {
        caller.assertCurrent();
        const result = await personal.mutate(sessionId,value);
        caller.assertCurrent();
        return result;
      },
      async selectModel(sessionId, model, caller) {
        assertChatCurrent(sessionId, caller);
        await runtime.selectRouterModel(model, caller.signal, () => assertChatCurrent(sessionId, caller));
      } };
    active = control;
    // Host私有服务，未注册模型工具或外部任意计算入口。
    scoped.provide('workspaceSuperagentLifecycle', { coordinator: lifecycle, jobs, evals });
    scoped.effect(() => async () => {
      mottoLifetime.abort();
      if (active === control) active = undefined;
      try { await lifecycle.dispose('detach'); }
      finally { coordinator = undefined; failure = '依赖已卸载或替换；保留持久状态，需要人工恢复。'; }
    });
  });
}
