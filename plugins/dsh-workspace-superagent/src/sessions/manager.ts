import { randomUUID } from 'node:crypto';
import type { StewardStore } from '../storage/store.js';
import type { Identity, Versions } from '../storage/types.js';
import { InstallationOperation, type StagedInstallation } from './installation.js';

export const ROUTER_PRESET = 'workspace-superagent-router';
export class SessionBindingError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = 'SessionBindingError'; }
}
export interface ManagerAgent { readonly id: string }
export interface ManagerObservation {
  readonly sessionId: string; readonly workspaceId: string; readonly preset: string;
  readonly nativeLogRef: string;
  readonly nativeIdentity?: string;
}
/** 稳定 origin 由 Host 持有；运行 attachment 每次重新安装。 */
export interface ManagerHost<A extends ManagerAgent> {
  readonly identity: Identity;
  assertAvailable(): void;
  create(request: { sessionId: string; workspaceId: string; agentPreset: string }, operation: InstallationOperation): Promise<A>;
  owned(sessionId: string): A | undefined;
  restore?(sessionId: string, operation: InstallationOperation): Promise<A>;
  passive(sessionId: string, signal: AbortSignal): Promise<ManagerObservation>;
  resolve(sessionId: string): Promise<A>;
  prepare(agent: A, versions: Readonly<Versions>, operation: InstallationOperation): Promise<StagedInstallation>;
  assertReady(agent: A, observed: ManagerObservation): void;
  pinSession(sessionId: string): Promise<void>;
}
export class ManagerSession<A extends ManagerAgent> {
  #pending = false;
  constructor(readonly store: StewardStore, readonly host: ManagerHost<A>, readonly workspaceId: string) {
    if (!workspaceId || store.identity.instanceId !== host.identity.instanceId || store.identity.domainId !== host.identity.domainId) {
      throw new SessionBindingError('MANAGER_DOMAIN_MISMATCH');
    }
  }
  async ensure(operation: InstallationOperation): Promise<StagedInstallation> {
    if (!(operation instanceof InstallationOperation) || operation.store !== this.store) throw new SessionBindingError('INSTALLATION_REQUIRED');
    if (this.#pending) throw new SessionBindingError('MANAGER_BUSY');
    this.#pending = true;
    try { return await this.#ensure(operation); } finally { this.#pending = false; }
  }
  async #ensure(operation: InstallationOperation): Promise<StagedInstallation> {
    const check = () => { operation.check(); this.host.assertAvailable(); operation.check(); };
    check();
    if (this.store.diagnostics().recoveryPending) throw new SessionBindingError('MANAGER_RECOVERY_REQUIRED');
    let manager = operation.snapshot;
    if (manager.lifecycle !== 'paused') throw new SessionBindingError('MANAGER_NOT_PAUSED');
    const fresh = manager.bindingState === 'none';
    if (fresh) {
      operation.reserve('session-superagent-' + randomUUID(), this.workspaceId, ROUTER_PRESET);
      operation.beginCreate();
      manager = operation.snapshot;
    }
    if (!manager.sessionId || manager.workspaceId !== this.workspaceId || manager.preset !== ROUTER_PRESET) throw new SessionBindingError('MANAGER_BINDING_MISMATCH');
    const id = manager.sessionId;
    // 仅已绑定身份可走持久化恢复，未决创建不能重新创建或采纳。
    const agent = fresh
      ? await this.host.create({ sessionId: id, workspaceId: this.workspaceId, agentPreset: ROUTER_PRESET }, operation)
      : manager.bindingState === 'bound' ? this.host.owned(id) ?? await this.host.restore?.(id, operation) : undefined;
    check();
    if (!agent || agent.id !== id || this.host.owned(id) !== agent || (!fresh && manager.bindingState !== 'bound')) throw new SessionBindingError('MANAGER_ORIGIN_REQUIRED');
    const observed = await this.host.passive(id, operation.signal); check();
    if (observed.sessionId !== id || observed.workspaceId !== this.workspaceId || observed.preset !== ROUTER_PRESET || !observed.nativeLogRef) throw new SessionBindingError('MANAGER_OBSERVATION_MISMATCH');
    if (await this.host.resolve(id) !== agent) throw new SessionBindingError('MANAGER_AGENT_MISMATCH');
    check(); this.host.assertReady(agent, observed); check();
    const staged = await this.host.prepare(agent, Object.freeze({ ...operation.snapshot.versions }), operation);
    check(); this.host.assertReady(agent, observed); check();
    if (fresh && operation.snapshot.pin) { await this.host.pinSession(id); check(); }
    if (fresh) operation.bind(observed);
    return staged;
  }
}
