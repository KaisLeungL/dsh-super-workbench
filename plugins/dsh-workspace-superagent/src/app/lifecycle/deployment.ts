import { mandateExpired } from '../../storage/types.js';
import { openSync, closeSync, fstatSync, lstatSync, unlinkSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { StewardStore, fingerprint } from '../../storage/store.js';
import type { Identity } from '../../storage/types.js';
import type { HostAssembly } from './host.js';
import { createPublicReplay } from '../../sessions/public-replay.js';
import { CONTEXT_TOOLS, READ_TOOLS } from '../../tools/authority.js';
import { BOARD_CONTEXT } from '../../tools/context.js';
import { DEFAULT_CHAT_MODEL, nativeChatModel } from '../health/chat-input.js';

export interface DeploymentConfig {
  readonly databasePath: string;
  readonly workspacePath: string;
  readonly identity: Identity;
  /** 主理专用原生模型；省略时使用主理默认值。 */
  readonly model?: Selection;
  /** 当前工作区获准调用的额外只读能力及其 Cordis 模块名。 */
  readonly contextSources?: Readonly<Record<string, string>>;
  readonly boardReadScope?: 'workspace' | 'all-projects';
  /** 明确安装时的一次性只读授权；初始化标记保留后绝不重建丢失数据库。 */
  readonly firstInstall?: { readonly expiresAt: number; readonly proofRef: string };
}
type Selection = HostAssembly['runtimeConfig']['model'];
interface WorkspaceSource { resolveByPath(path: string): Promise<{ id: string; path: string; title?: string } | undefined> }
interface Sessions { readonly messageProjections: Parameters<typeof createPublicReplay>[0] }

/** 路径和身份仅来自可信安装配置；首次建库须明确授权，不迁移、重置或续权。 */
export async function mountDeployment(ctx: Context, config: DeploymentConfig, installCore: (ctx: Context) => void): Promise<void> {
  if (!config || !isAbsolute(config.databasePath) || !isAbsolute(config.workspacePath) ||
      !config.identity?.instanceId || !config.identity.domainId) throw Error('DEPLOYMENT_CONFIG_REQUIRED');
  const extras = config.contextSources ?? {};
  if (typeof extras !== 'object' || Array.isArray(extras) || Object.keys(extras).length > 15 ||
      Object.entries(extras).some(([id, name]) => id.length > 100 || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(id) ||
        typeof name !== 'string' || !name || name.length > 240)) throw Error('CONTEXT_SOURCES_INVALID');
  const contextGrants = Object.freeze({ ...BOARD_CONTEXT, ...extras });
  if (config.boardReadScope !== undefined && config.boardReadScope !== 'workspace' && config.boardReadScope !== 'all-projects') throw Error('BOARD_READ_SCOPE_INVALID');
  const workspacePath = realpathSync(config.workspacePath);
  if (workspacePath !== config.workspacePath || realpathSync(dirname(config.databasePath)) !== dirname(config.databasePath)) throw Error('CANONICAL_DEPLOYMENT_REQUIRED');
  const nested = relative(workspacePath, config.databasePath);
  if (nested === '' || (!nested.startsWith('..' + sep) && nested !== '..' && !isAbsolute(nested))) throw Error('PRIVATE_DATABASE_REQUIRED');
  const workspaces = ctx.get('workspaceRegistry') as unknown as WorkspaceSource | undefined;
  const sessions = ctx.get('sessions') as unknown as Sessions | undefined;
  if (!workspaces || !sessions) throw Error('DEPLOYMENT_SERVICES_REQUIRED');
  const alive = new AbortController();
  ctx.effect(() => () => alive.abort());
  const workspace = await workspaces.resolveByPath(workspacePath);
  alive.signal.throwIfAborted();
  if (!workspace || workspace.path !== workspacePath) throw Error('REGISTERED_WORKSPACE_REQUIRED');
  const configured = config.model ?? DEFAULT_CHAT_MODEL;
  const model = Object.freeze({
    ...configured,
    ...(configured.provider === DEFAULT_CHAT_MODEL.provider && configured.model === DEFAULT_CHAT_MODEL.model && configured.reasoningEffort === undefined
      ? { reasoningEffort: DEFAULT_CHAT_MODEL.reasoningEffort } : {}),
  });
  if (!model.provider || !model.model) throw Error('NATIVE_DEFAULT_MODEL_REQUIRED');
  // 单写者锁绝不根据PID猜测清理旧锁；异常退出后的恢复由运维核对。
  const lockPath = config.databasePath + '.owner', lock = openSync(lockPath, 'wx', 0o600), lockIdentity = fstatSync(lock);
  let store: StewardStore | undefined, child: ReturnType<Context['plugin']> | undefined, closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    if (child) await child.dispose();
    store?.close();
    const current = lstatSync(lockPath);
    if (current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino || current.isSymbolicLink()) {
      closeSync(lock); throw Error('DEPLOYMENT_LOCK_CHANGED');
    }
    closeSync(lock); unlinkSync(lockPath);
  })();
  ctx.effect(() => close);
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: randomUUID(), identity: config.identity }) + '\n');
    if (!existsSync(config.databasePath) && config.firstInstall) {
      const grant = config.firstInstall;
      if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now() || !grant.proofRef) throw Error('INSTALLATION_MANDATE_REQUIRED');
      // 标记先以wx落盘；中断、丢库或部分建库均保留原件，下一次不能回退fresh。
      writeFileSync(config.databasePath + '.initialized', JSON.stringify({ identity: config.identity, proofRef: grant.proofRef }) + '\n', { flag: 'wx', mode: 0o600 });
      store = StewardStore.initializeFresh(config.databasePath, config.identity);
      store.registerResource('workspace-board', { workspaceId: workspace.id, repositoryId: workspace.id });
      store.appendPolicy(0, { resources: ['workspace-board'], audiences: [], mandate: { actions: ['read'], expiresAt: grant.expiresAt }, proofRef: grant.proofRef });
    } else store = StewardStore.openExisting(config.databasePath, config.identity);
    const ownedStore = store;
    const readiness = () => {
      if (!nativeChatModel(model.provider)) return '请为主理配置 DSH 原生模型。';
      if (mandateExpired(ownedStore.readAuthorizationSnapshot().policy.mandate.expiresAt, Date.now())) return '当前只读授权已到期；请先更新主理授权。';
      return null;
    };
    const assembly: HostAssembly = { store, readiness, contextGrants, mottoPath: config.databasePath + '.daily-motto.json', workspaceName: workspace.title || basename(workspacePath), runtimeConfig: {
      identity: Object.freeze({ ...config.identity }), workspaceId: workspace.id, model,
      currentPolicy() {
        const blocked = readiness();
        if (blocked) throw Error('NATIVE_MODEL_OR_MANDATE_REQUIRED');
        const source = ownedStore.readAuthorizationSnapshot();
        const binding = source.resources.find(r => r.id === 'workspace-board' && r.workspaceId === workspace.id && r.repositoryId === workspace.id);
        return { revision: fingerprint({ model, versions: source.versions, workspaceId: workspace.id, contextGrants, boardReadScope: config.boardReadScope }),
          backend: 'native', resources: binding ? ['workspace-board'] : [], tools: [...READ_TOOLS, ...CONTEXT_TOOLS],
          ...(binding && config.boardReadScope === 'all-projects' ? { allBoardProjects: true as const } : {}),
          actions: ['read'], audiences: [], maxTokens: 1000 };
      },
      defaultPermission: () => 'read-only', auditReplay: createPublicReplay(sessions.messageProjections),
    } };
    child = ctx.plugin({ name: 'workspace-superagent-deployment-core', apply(local: Context) {
      local.provide('workspaceSuperagentHostConfig', assembly); installCore(local);
    } });
    await child;
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'DEPLOYMENT_SETUP_FAILED'); }
    throw error;
  }
}
