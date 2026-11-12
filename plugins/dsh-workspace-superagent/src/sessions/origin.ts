import { randomUUID } from 'node:crypto';
import { fingerprint, type StewardStore } from '../storage/store.js';
import type { NativeAgent, RuntimeContext } from './runtime.js';
import type { InstallationOperation } from './installation.js';

export const canonical = (value: unknown): unknown => value && (typeof value === 'object' || typeof value === 'function')
  ? Reflect.get(value, Symbol.for('cordis.original')) ?? value : value;
interface Handle { readonly agent: NativeAgent; dispose(): void | Promise<void> }
type Route = { provider: string; model: string; reasoningEffort?: string; maxTokens: number };
type Setup = (ctx: RuntimeContext, agent: NativeAgent) => Promise<void>;
interface Factory {
  get(id: string): NativeAgent | undefined; roots?(): NativeAgent[]; list?(): NativeAgent[];
  create(options: { sessionId: string; meta: { cwd: string; agentPreset: string };
    agentOptions: Route; signal: AbortSignal; setup: Setup }): Promise<Handle>;
  resume(options: { resumeSessionId: string; agentOptions: Route; signal: AbortSignal; setup: Setup }): Promise<Handle>;
}
/** Both public registry shapes still require the exact, top-level native session. */
export function isNativeRoot(agents: Pick<Factory, 'get' | 'roots' | 'list'>, agent: NativeAgent): boolean {
  const header = agent.session.header;
  if (header.parentSession || header.origin || header.delegationDepth || canonical(agents.get(agent.id)) !== canonical(agent)) return false;
  const roster = typeof agents.roots === 'function' ? agents.roots() : agents.list?.();
  return roster?.some(value => canonical(value) === canonical(agent)) === true;
}
export function nativeSessionIdentity(header: Readonly<Record<string, unknown>>, inheritedEventCount: number): string {
  return fingerprint({ header: { ...header, delegationDepth: header.delegationDepth ?? 0 }, inheritedEventCount });
}
interface SessionRegistry { get(id: string): NativeAgent['session'] | undefined }
export interface NativeWorkspace {
  readonly id: string; readonly path: string; readonly sessionIds: readonly string[];
  attachSession(id: string): Promise<void>;
}
interface Origin {
  readonly handle: Handle; readonly agent: NativeAgent; readonly context: unknown; readonly session: unknown;
  readonly header: string; readonly nonce: string; readonly storeIdentity: string;
  firstDispose?: Promise<void>;
}
interface Retirement { close(): void; clean(): Promise<void>; done?: Promise<void> }
/** 位于 runtime inject 之外；不保存政策、lease 或安装权限。 */
export class StableSessionOwner {
  #origins = new Map<StewardStore, Origin>();
  #creating = new Set<Promise<unknown>>();
  #staging = new WeakMap<NativeAgent, StewardStore>();
  #retirements = new Map<NativeAgent, Retirement>();
  #disposed = false;
  constructor(readonly ctx: Pick<RuntimeContext, 'get'>) {}
  isStaging(store: StewardStore, agent: NativeAgent): boolean {
    return !this.#disposed && this.#staging.get(canonical(agent) as NativeAgent) === store;
  }
  owned(store: StewardStore, id: string): NativeAgent | undefined {
    const origin = this.#origins.get(store);
    return !this.#disposed && origin?.agent.id === id && !origin.firstDispose &&
      origin.storeIdentity === fingerprint(store.identity) ? origin.agent : undefined;
  }
  assertOwn(store: StewardStore, agent: NativeAgent): void {
    const origin = this.#origins.get(store), agents = this.ctx.get('agents') as Factory | undefined;
    const sessions = this.ctx.get('sessions') as SessionRegistry | undefined;
    if (this.owned(store, agent.id) !== agent || !origin ||
        canonical(agents?.get(agent.id)) !== canonical(agent) || canonical(sessions?.get(agent.id)) !== origin.session ||
        canonical(agent.ctx) !== origin.context || canonical(agent.session) !== origin.session ||
        fingerprint(agent.session.header) !== origin.header) throw Error('FRESH_ORIGIN_REQUIRED');
  }
  create(store: StewardStore, request: { sessionId: string; workspace: NativeWorkspace; preset: string;
    route: Route; restoreIdentity?: string },
    operation: InstallationOperation): Promise<NativeAgent> {
    if (this.#disposed || this.#origins.has(store)) return Promise.reject(Error('FRESH_ORIGIN_REQUIRED'));
    const pending = this.#create(store, request, operation); this.#creating.add(pending);
    void pending.finally(() => this.#creating.delete(pending)).catch(() => {}); return pending;
  }
  async #create(store: StewardStore, request: { sessionId: string; workspace: NativeWorkspace; preset: string;
    route: Route; restoreIdentity?: string },
    operation: InstallationOperation): Promise<NativeAgent> {
    const agents = this.ctx.get('agents') as Factory, sessions = this.ctx.get('sessions') as SessionRegistry;
    const presets = this.ctx.get('agentPresets') as { mount(ctx: RuntimeContext, preset: string): Promise<unknown> };
    let provisional: { agent: NativeAgent; context: unknown; session: unknown; created: boolean } | undefined;
    let handle: Handle | undefined, releaseCreated: (() => unknown) | undefined;
    const current = () => {
      operation.check();
      if (this.#disposed || canonical(this.ctx.get('agents')) !== canonical(agents) ||
          canonical(this.ctx.get('sessions')) !== canonical(sessions) ||
          canonical(this.ctx.get('agentPresets')) !== canonical(presets)) throw Error('CREATION_SERVICE_CHANGED');
    };
    try {
      current();
      const setup: Setup = async (context, agent) => {
          current();
          if (provisional || agent.id !== request.sessionId || agents.get(agent.id)) throw Error('FRESH_SETUP_REQUIRED');
          if (request.restoreIdentity && (agent.session.header.agentPreset !== request.preset ||
              nativeSessionIdentity(agent.session.header, agent.session.inheritedEventCount) !== request.restoreIdentity ||
              agent.inbox.nextTurn.length || agent.inbox.nextStep.length)) throw Error('RESTORE_IDENTITY_OR_INBOX_MISMATCH');
          provisional = { agent, context: canonical(context), session: canonical(agent.session), created: false };
          releaseCreated = context.on('agent/created', raw => {
            const event = raw as { agent: NativeAgent; source: string };
            current();
            if (!provisional || event.source !== (request.restoreIdentity ? 'resume' : 'startup') || canonical(event.agent) !== canonical(agent) ||
                canonical(agent.ctx) !== provisional.context || canonical(sessions.get(agent.id)) !== provisional.session ||
                !isNativeRoot(agents,agent) ||
                agent.inputAdmissionVersion !== 4 || typeof agent.requireInputAdmission !== 'function') throw Error('FRESH_CREATED_REQUIRED');
            agent.requireInputAdmission(); provisional.created = true;
          });
          await presets.mount(context, request.preset); current();
          this.#staging.set(canonical(agent) as NativeAgent, store);
      };
      handle = request.restoreIdentity
        ? await agents.resume({ resumeSessionId: request.sessionId, agentOptions: request.route, signal: operation.signal, setup })
        : await agents.create({ sessionId: request.sessionId, meta: { cwd: request.workspace.path, agentPreset: request.preset },
            agentOptions: request.route, signal: operation.signal, setup });
      current();
      if (!provisional?.created || canonical(handle.agent) !== canonical(provisional.agent) ||
          canonical(handle.agent.ctx) !== provisional.context || canonical(handle.agent.session) !== provisional.session) throw Error('FRESH_HANDLE_REQUIRED');
      const agent = handle.agent;
      this.#origins.set(store, { handle, agent, context: provisional.context, session: provisional.session,
        header: fingerprint(agent.session.header), nonce: randomUUID(), storeIdentity: fingerprint(store.identity) });
      this.assertOwn(store, agent); return agent;
    } catch (error) {
      operation.revoke();
      if (handle) await handle.dispose();
      throw error;
    } finally {
      if (provisional) this.#staging.delete(canonical(provisional.agent) as NativeAgent);
      releaseCreated?.();
    }
  }
  async replaceAttachment(agent: NativeAgent, close: () => void, clean: () => Promise<void>): Promise<void> {
    await this.retire(agent);
    if (this.#disposed) throw Error('OWNER_DISPOSED');
    this.#retirements.set(agent, { close, clean });
  }
  retire(agent: NativeAgent): Promise<void> {
    const attachment = this.#retirements.get(agent);
    if (!attachment) return Promise.resolve();
    if (!attachment.done) {
      // 先保存同一个 Promise，重入、双 owner 和 single-shot 返回值均不能换掉它。
      let resolve!: () => void, reject!: (error: unknown) => void;
      attachment.done = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
      attachment.close();
      void Promise.resolve().then(() => attachment.clean()).then(resolve, reject);
    }
    return attachment.done;
  }
  release(store: StewardStore): Promise<void> {
    const origin = this.#origins.get(store);
    if (!origin) return Promise.resolve();
    if (!origin.firstDispose) {
      origin.firstDispose = Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        try { await this.retire(origin.agent); } catch (error) { failures.push(error); }
        try { await origin.handle.dispose(); } catch (error) { failures.push(error); }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'OWNED_SESSION_CLEANUP_FAILED');
        if (this.#origins.get(store) === origin) this.#origins.delete(store);
      });
    }
    return origin.firstDispose;
  }
  async dispose(): Promise<void> {
    this.#disposed = true;
    await Promise.allSettled([...this.#creating]);
    await Promise.all([...this.#origins.keys()].map(store => this.release(store)));
  }
}
