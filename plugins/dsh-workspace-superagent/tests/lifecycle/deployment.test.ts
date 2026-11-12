import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, existsSync, rmSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { mountDeployment } from '../../src/app/lifecycle/deployment.js';
import type { HostAssembly } from '../../src/app/lifecycle/host.js';

function world(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wsa-deployment-')));
  const workspace = join(root, 'workspace'), privateDir = join(root, 'private');
  mkdirSync(workspace); mkdirSync(privateDir);
  const config = { databasePath: join(privateDir, 'manager.sqlite'), workspacePath: workspace,
    identity: { instanceId: 'test-instance', domainId: 'test-domain' },
    firstInstall: { expiresAt: Date.now() + 60_000, proofRef: 'explicit-test-installation' } };
  let selection = { provider: 'local-controlled', model: 'bounded' };
  const models = { currentSelection: () => ({ ...selection }) };
  const source = { resolveByPath: async () => ({ id: 'workspace-1', path: workspace }) };
  const values = new Map<string, unknown>([['workspaceRegistry', source], ['agentDefaultModel', models], ['sessions', { messageProjections: [] }]]);
  const contexts: { ctx: Context; assembly(): HostAssembly; dispose(): Promise<void> }[] = [];
  function context(disposeChild: () => Promise<void> = async () => {}): (typeof contexts)[number] {
    const effects: (() => void | Promise<void>)[] = [];
    let assembly: HostAssembly | undefined;
    const local = { get: (name: string) => values.get(name), provide(name: string, value: unknown) { values.set(name, value); } };
    const ctx = { ...local,
      effect(callback: () => (() => void | Promise<void>)) { effects.push(callback()); },
      plugin(plugin: { apply(ctx: unknown): void }) {
        plugin.apply({ ...local, provide(name: string, value: unknown) { if (name === 'workspaceSuperagentHostConfig') assembly = value as HostAssembly; } });
        return Object.assign(Promise.resolve(), { dispose: disposeChild });
      },
    } as unknown as Context;
    const item = { ctx, assembly: () => { assert.ok(assembly); return assembly; },
      async dispose() { for (const effect of [...effects].reverse()) await effect(); } };
    contexts.push(item); return item;
  }
  t.after(async () => {
    for (const item of contexts.reverse()) await item.dispose();
    assert.ok(root.startsWith(realpathSync(tmpdir()) + '/wsa-deployment-'));
    rmSync(root, { recursive: true, force: true });
  });
  return { config, context, source, setModel: (model: string) => { selection = { ...selection, model }; }, setProvider: (provider: string) => { selection = { ...selection, provider }; } };
}

test('首次明确安装只创建当前工作区只读授权，保持暂停；重复打开不续权', async t => {
  const w = world(t), first = w.context();
  await mountDeployment(first.ctx, w.config, () => {});
  const assembly = first.assembly(), snapshot = assembly.store.readAuthorizationSnapshot();
  assert.equal(assembly.store.manager().lifecycle, 'paused');
  assert.equal(assembly.store.manager().sessionId, null);
  assert.deepEqual(snapshot.policy.mandate.actions, ['read']);
  assert.deepEqual(snapshot.policy.audiences, []);
  assert.deepEqual(assembly.runtimeConfig.currentPolicy(undefined).resources, ['workspace-board']);
  assert.equal(assembly.runtimeConfig.currentPolicy(undefined).maxTokens, 1000);
  await first.dispose();
  const again = w.context();
  await mountDeployment(again.ctx, { ...w.config, firstInstall: { expiresAt: Date.now() + 3600_000, proofRef: 'must-not-renew' } }, () => {});
  assert.deepEqual(again.assembly().store.readAuthorizationSnapshot().policy, snapshot.policy);
});

test('丢库时保留初始化原件，禁止静默回退fresh', async t => {
  const w = world(t), first = w.context();
  await mountDeployment(first.ctx, w.config, () => {}); await first.dispose();
  const marker = readFileSync(w.config.databasePath + '.initialized');
  unlinkSync(w.config.databasePath);
  const again = w.context();
  await assert.rejects(mountDeployment(again.ctx, w.config, () => {}), /EEXIST/);
  assert.equal(existsSync(w.config.databasePath), false);
  assert.deepEqual(readFileSync(w.config.databasePath + '.initialized'), marker);
});

test('同库第二写者拒绝，原锁和数据库保持可用', async t => {
  const w = world(t), first = w.context();
  await mountDeployment(first.ctx, w.config, () => {});
  const lock = readFileSync(w.config.databasePath + '.owner');
  await assert.rejects(mountDeployment(w.context().ctx, w.config, () => {}), /EEXIST/);
  assert.deepEqual(readFileSync(w.config.databasePath + '.owner'), lock);
  assert.equal(first.assembly().store.manager().sessionId, null);
});

test('身份不符拒绝打开，不修改旧库和授权', async t => {
  const w = world(t), first = w.context();
  await mountDeployment(first.ctx, w.config, () => {}); await first.dispose();
  const before = readFileSync(w.config.databasePath);
  await assert.rejects(mountDeployment(w.context().ctx, { ...w.config, identity: { instanceId: 'foreign', domainId: 'test-domain' } }, () => {}));
  assert.deepEqual(readFileSync(w.config.databasePath), before);
  assert.equal(existsSync(w.config.databasePath + '.owner'), false);
});

test('未授权首次安装和工作区内数据库均拒绝', async t => {
  const w = world(t);
  await assert.rejects(mountDeployment(w.context().ctx, { ...w.config, firstInstall: undefined }, () => {}));
  assert.equal(existsSync(w.config.databasePath), false);
  await assert.rejects(mountDeployment(w.context().ctx, { ...w.config, databasePath: join(w.config.workspacePath, 'manager.sqlite') }, () => {}), /PRIVATE_DATABASE_REQUIRED/);
  assert.equal(existsSync(join(w.config.workspacePath, 'manager.sqlite')), false);
});

test('主理默认使用 Flash 高档且独立于全局模型，撤销的策略重装后仍失效', async t => {
  const w = world(t), first = w.context();
  await mountDeployment(first.ctx, w.config, () => {});
  const assembly = first.assembly();
  assert.deepEqual(assembly.runtimeConfig.model, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' });
  const policy = assembly.runtimeConfig.currentPolicy(undefined);
  w.setProvider('acp-codex');
  w.setModel('different');
  assert.deepEqual(assembly.runtimeConfig.currentPolicy(undefined), policy);
  assembly.store.appendPolicy(1, { resources: [], audiences: [], mandate: { actions: [], expiresAt: 0 }, proofRef: 'revoke' });
  await first.dispose();
  const again = w.context(); await mountDeployment(again.ctx, w.config, () => {});
  assert.throws(() => again.assembly().runtimeConfig.currentPolicy(undefined), /NATIVE_MODEL_OR_MANDATE_REQUIRED/);
  assert.deepEqual(again.assembly().store.readAuthorizationSnapshot().policy.mandate.actions, []);
});

test('主理专用模型配置拒绝 ACP 路由', async t => {
  const w = world(t), first = w.context();
  await mountDeployment(first.ctx, { ...w.config, model: { provider: 'acp-codex', model: 'codex' } }, () => {});
  assert.match(first.assembly().readiness!()!, /原生模型/);
  assert.equal(first.assembly().store.manager().sessionId, null);
  assert.equal(first.assembly().store.manager().lifecycle, 'paused');
  assert.throws(() => first.assembly().runtimeConfig.currentPolicy(undefined), /NATIVE_MODEL_OR_MANDATE_REQUIRED/);
});

test('主理专用原生模型不改全局ACP设置，也不继承它的后续变化', async t => {
  const w = world(t), first = w.context(); w.setProvider('acp-codex');
  const model = { provider: 'local-controlled', model: 'bounded' };
  await mountDeployment(first.ctx, { ...w.config, model }, () => {});
  assert.equal(first.assembly().readiness!(), null);
  assert.deepEqual(first.assembly().runtimeConfig.model, model);
  w.setModel('another-acp-model');
  assert.equal(first.assembly().readiness!(), null);
  assert.deepEqual(first.assembly().runtimeConfig.currentPolicy(undefined).actions, ['read']);
});

test('等待子运行时完成清理后才关闭存储和释放锁', async t => {
  const w = world(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = w.context(() => gate);
  await mountDeployment(first.ctx, w.config, () => {});
  const assembly = first.assembly(), pending = first.dispose();
  try {
    assert.equal(assembly.store.manager().lifecycle, 'paused');
    assert.equal(existsSync(w.config.databasePath + '.owner'), true);
  } finally { release(); }
  await pending;
  assert.throws(() => assembly.store.manager());
  assert.equal(existsSync(w.config.databasePath + '.owner'), false);
});

test('工作区解析期间卸载不再创建锁、数据库或子运行时', async t => {
  const w = world(t), first = w.context();
  let release!: (value: { id: string; path: string }) => void;
  w.source.resolveByPath = () => new Promise(resolve => { release = resolve; });
  const pending = mountDeployment(first.ctx, w.config, () => { throw Error('must-not-mount'); });
  await first.dispose(); release({ id: 'workspace-1', path: w.config.workspacePath });
  await assert.rejects(pending);
  assert.equal(existsSync(w.config.databasePath), false);
  assert.equal(existsSync(w.config.databasePath + '.owner'), false);
});
