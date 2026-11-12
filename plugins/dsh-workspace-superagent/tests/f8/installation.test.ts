import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StewardStore } from '../../src/storage/store.js';
import { ManagerSession, type ManagerHost } from '../../src/sessions/manager.js';
import { InstallationOperation } from '../../src/sessions/installation.js';
import { LifecycleCoordinator } from '../../src/app/lifecycle/coordinator.js';
import { StableSessionOwner } from '../../src/sessions/origin.js';
import type { NativeAgent } from '../../src/sessions/runtime.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(ok => { resolve = ok; }); return { promise, resolve }; }
function fixture(t: TestContext) {
  const dir = process.env.F84_TEST_ROOT;
  assert.ok(dir && dir.includes('/.superagent-product-lab/b04-f8-product/'));
  mkdirSync(dir, { recursive: true });
  const store = StewardStore.initializeFresh(resolve(dir, randomUUID() + '.sqlite'), { instanceId: randomUUID(), domainId: 'f84-component' });
  t.after(() => store.close());
  const calls = { create: 0, passive: 0, resolve: 0, prepare: 0, pin: 0, resume: 0 };
  let owned: { id: string } | undefined, prepareGate: (() => Promise<void>) | undefined;
  let stageCheck = () => {}, handoff = () => {}, admission = () => {}, resourceResume = () => {};
  const publication = { ready: false };
  const host: ManagerHost<{ id: string }> = {
    identity: store.identity, assertAvailable() {}, owned: id => owned?.id === id ? owned : undefined,
    async create(request) { calls.create++; owned = { id: request.sessionId }; return owned; },
    async passive(id) { calls.passive++; return { sessionId: id, workspaceId: 'W', preset: 'workspace-superagent-router', nativeLogRef: 'component-fixture:' + id }; },
    async resolve() { calls.resolve++; return owned!; },
    async prepare(_agent, _versions, operation) { calls.prepare++; if (prepareGate) await prepareGate(); return operation.stage(publication, () => stageCheck()); },
    assertReady() {}, async pinSession() { calls.pin++; },
  };
  const manager = new ManagerSession(store, host, 'W');
  let dependency: object = {};
  const coordinator = new LifecycleCoordinator(store, [{ name: 'fixture', current: () => dependency, accepts: value => !!value }],
    { pause() {}, cancel() {}, dispose() {}, resume() { calls.resume++; resourceResume(); } },
    async operation => { const capsule = await manager.ensure(operation); handoff(); return capsule; }, () => {}, () => admission());
  coordinator.initialize();
  return { store, manager, host, coordinator, calls, publication,
    gate: (value: () => Promise<void>) => { prepareGate = value; }, check: (value: () => void) => { stageCheck = value; },
    handoff: (value: () => void) => { handoff = value; }, admission: (value: () => void) => { admission = value; },
    resume: (value: () => void) => { resourceResume = value; }, replaceDependency: () => { dependency = {}; } };
}
test('合法 paused capsule 完成本人 CAS 与同步 publication', async t => {
  const f = fixture(t);
  await f.coordinator.resume(f.store.manager().revision, 'trusted-component');
  assert.equal(f.store.manager().lifecycle, 'running'); assert.equal(f.publication.ready, true);
  assert.equal(f.coordinator.status().accepting, true);
  assert.deepEqual(f.calls, { create: 1, passive: 1, resolve: 1, prepare: 1, pin: 1, resume: 1 });
});
test('前置 admission 同步重入被 busy 占位拒绝，合法外层仍成功', async t => {
  const f = fixture(t); let nested: Promise<void> | undefined, entered = false;
  f.admission(() => { if (!entered) { entered = true; nested = f.coordinator.resume(f.store.manager().revision, 'nested'); void nested.catch(() => {}); } });
  await f.coordinator.resume(f.store.manager().revision, 'trusted');
  await assert.rejects(nested!, /CONTROL_BUSY/);
  assert.equal(f.publication.ready, true); assert.equal(f.calls.create, 1); assert.equal(f.calls.resume, 1);
});
test('最后 admission 回调 pin-only CAS 不可被采纳，signal 未 abort', async t => {
  const f = fixture(t); let armed = false, external: unknown; const signal = new AbortController().signal;
  f.handoff(() => { armed = true; });
  f.admission(() => { if (armed) { armed = false; const m = f.store.manager(); external = f.store.recordLifecycle(m.revision, 'paused', false); } });
  await assert.rejects(f.coordinator.resume(f.store.manager().revision, 'trusted', { signal, assertCurrent() {} }), /INSTALLATION_CHANGED/);
  assert.deepEqual(f.store.manager(), external); assert.equal(signal.aborted, false);
  assert.equal(f.publication.ready, false); assert.equal(f.calls.prepare, 1); assert.equal(f.calls.resume, 0);
});
test('合法 capsule 最后检查回调的独立 Manager CAS 拒绝', async t => {
  const f = fixture(t); let checks = 0, external: unknown;
  f.check(() => { if (++checks === 2) { const m = f.store.manager(); external = f.store.recordLifecycle(m.revision, 'paused', !m.pin); } });
  await assert.rejects(f.coordinator.resume(f.store.manager().revision, 'trusted'), /INSTALLATION_CHANGED/);
  assert.equal(checks, 2); assert.deepEqual(f.store.manager(), external); assert.equal(f.calls.resume, 0);
});
test('ensure await 交接期间另一 Manager 更新不采纳', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  f.gate(async () => { entered.resolve(); await release.promise; });
  const pending = f.coordinator.resume(f.store.manager().revision, 'trusted'); await entered.promise;
  const m = f.store.manager(), external = f.store.recordLifecycle(m.revision, 'paused', false); release.resolve();
  await assert.rejects(pending, /INSTALLATION_CHANGED/); assert.deepEqual(f.store.manager(), external); assert.equal(f.publication.ready, false);
});
test('另一 operation 不共享 pending Promise', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  f.gate(async () => { entered.resolve(); await release.promise; });
  const pending = f.coordinator.resume(f.store.manager().revision, 'trusted'); await entered.promise;
  const other = new InstallationOperation(f.store, new AbortController().signal, () => {});
  await assert.rejects(f.manager.ensure(other), /MANAGER_BUSY/); release.resolve(); await pending; assert.equal(f.calls.create, 1);
});
for (const label of ['unknown', '外来 live', '外来 blank']) test(label + ' 无原 anchor 不 create/resolve 补采纳', async t => {
  const f = fixture(t); let m = f.store.manager();
  m = f.store.reserveManager(m.revision, 'foreign', 'W', 'workspace-superagent-router'); f.store.beginManagerCreate(m.revision);
  const operation = new InstallationOperation(f.store, new AbortController().signal, () => {});
  await assert.rejects(f.manager.ensure(operation), /MANAGER_ORIGIN_REQUIRED/);
  assert.equal(f.calls.create, 0); assert.equal(f.calls.passive, 0); assert.equal(f.calls.resolve, 0);
});
test('本人提交未变时资源恢复抛错只补偿本人结果', async t => {
  const f = fixture(t); f.resume(() => { assert.equal(f.publication.ready, true); throw Error('RESOURCE_FAILURE'); });
  await assert.rejects(f.coordinator.resume(f.store.manager().revision, 'trusted'), /RESOURCE_FAILURE/);
  assert.equal(f.calls.resume, 1); assert.equal(f.store.manager().lifecycle, 'paused'); assert.equal(f.publication.ready, false);
});
test('资源回调外部 CAS 后抛错不得覆盖外部 running/pin', async t => {
  const f = fixture(t); let external: unknown;
  f.resume(() => { const m = f.store.manager(); external = f.store.recordLifecycle(m.revision, 'running', false); throw Error('RESOURCE_FAILURE'); });
  await assert.rejects(f.coordinator.resume(f.store.manager().revision, 'trusted'), /RESOURCE_FAILURE/);
  assert.equal(f.calls.resume, 1); assert.deepEqual(f.store.manager(), external);
  assert.equal(f.publication.ready, false); assert.equal(f.coordinator.status().accepting, false);
});
test('依赖身份独立更换且 signal 未 abort 必须拒绝', async t => {
  const f = fixture(t), signal = new AbortController().signal;
  f.handoff(() => f.replaceDependency());
  await assert.rejects(f.coordinator.resume(f.store.manager().revision, 'trusted', { signal, assertCurrent() {} }), /STALE_LIFECYCLE/);
  assert.equal(signal.aborted, false); assert.equal(f.calls.prepare, 1); assert.equal(f.publication.ready, false);
});
test('旧 attachment 异步首次清理 Promise 同一事实，结清前不装新代', async () => {
  const owner = new StableSessionOwner({ get() {} }), agent = { id: 'component' } as unknown as NativeAgent;
  const entered = deferred(), release = deferred(); let cleaned = false, installed = false, closed = false;
  await owner.replaceAttachment(agent, () => { closed = true; }, async () => { entered.resolve(); await release.promise; cleaned = true; });
  const first = owner.retire(agent); assert.equal(first, owner.retire(agent)); assert.equal(closed, true);
  await entered.promise;
  const next = owner.replaceAttachment(agent, () => {}, async () => {}).then(() => { installed = true; });
  await Promise.resolve(); assert.equal(installed, false);
  release.resolve(); await first; await next; assert.equal(cleaned, true); assert.equal(installed, true);
});
for (const failCleanup of [false, true]) test('稳定 owner 释放原 Handle：附件清理' + (failCleanup ? '失败仍尽力释放' : '正常对照'), async t => {
  const f = fixture(t), registered = new Map<string, NativeAgent>(), sessions = new Map();
  let listener: ((event: unknown) => unknown) | undefined, disposals = 0, cleanups = 0, closed = 0;
  const context = { on(_name: string, callback: (event: unknown) => unknown) { listener = callback; return () => { listener = undefined; }; } };
  const factory = {
    get: (id: string) => registered.get(id), roots: () => [...registered.values()],
    async create(request: { sessionId: string; setup(context: unknown, agent: NativeAgent): Promise<void> }) {
      const agent = { id: request.sessionId, ctx: context, session: { id: request.sessionId, header: {} },
        inputAdmissionVersion: 4, requireInputAdmission() {} } as unknown as NativeAgent;
      await request.setup(context, agent); registered.set(agent.id, agent); sessions.set(agent.id, agent.session);
      listener!({ agent, source: 'startup' });
      return { agent, async dispose() { disposals++; registered.delete(agent.id); sessions.delete(agent.id); } };
    },
  };
  const services = { agents: factory, sessions: { get: (id: string) => sessions.get(id) }, agentPresets: { async mount() {} } };
  const owner = new StableSessionOwner({ get: name => services[name as keyof typeof services] });
  const operation = new InstallationOperation(f.store, new AbortController().signal, () => {});
  operation.reserve('owned', 'W', 'workspace-superagent-router'); operation.beginCreate();
  const agent = await owner.create(f.store, { sessionId: 'owned', workspace: { id: 'W', path: '/component-fixture', sessionIds: [], async attachSession() {} },
    preset: 'workspace-superagent-router', route: { provider: 'fixture', model: 'fixture', maxTokens: 1 } }, operation);
  await owner.replaceAttachment(agent, () => { closed++; }, async () => { cleanups++; if (failCleanup) throw Error('ATTACHMENT_FAILURE'); });
  const first = owner.release(f.store); assert.equal(first, owner.release(f.store)); assert.equal(owner.owned(f.store, agent.id), undefined);
  if (failCleanup) await assert.rejects(first, /ATTACHMENT_FAILURE/); else await first;
  assert.equal(disposals, 1); assert.equal(cleanups, 1); assert.equal(closed, 1);
  assert.equal(registered.size, 0); assert.equal(sessions.size, 0);
});
