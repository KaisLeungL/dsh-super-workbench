import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { StewardStore } from '../../src/storage/store.js';
import { ManagerSession, ROUTER_PRESET, type ManagerHost } from '../../src/sessions/manager.js';
import { InstallationOperation } from '../../src/sessions/installation.js';

const root = process.env.F84_TEST_ROOT ?? process.env.B03_RUN_DIR;
assert.ok(root && (root.includes('/.superagent-product-lab/b03/runs/') || root.includes('/.superagent-product-lab/b04-f8-product/')), '仅在本轮独占目录运行');
const operation = (store: StewardStore) => new InstallationOperation(store, new AbortController().signal, () => {});
function fixture(t: TestContext) {
  const path = resolve(root!, randomUUID() + '.sqlite');
  const identity = { instanceId: randomUUID(), domainId: 'component-domain' };
  const store = StewardStore.initializeFresh(path, identity);
  t.after(() => { try { store.close(); } catch {} });
  const sessions = new Map<string, { id: string }>(), origins = new Map<string, { id: string }>();
  let creates = 0, pins = 0, setups = 0;
  const host: ManagerHost<{ id: string }> = {
    identity, assertAvailable() {}, owned: id => origins.get(id),
    async create(request) {
      creates++; assert.equal(store.manager().bindingState, 'unknown');
      const agent = { id: request.sessionId }; sessions.set(agent.id, agent); origins.set(agent.id, agent); return agent;
    },
    async passive(id) {
      assert.ok(sessions.has(id), '会话夹具尚未存在');
      return { sessionId: id, workspaceId: 'W', preset: ROUTER_PRESET, nativeLogRef: 'component-native-log:' + id };
    },
    async resolve(id) { assert.ok(sessions.has(id)); return sessions.get(id)!; },
    async prepare(_agent, _versions, op) { setups++; return op.stage({ ready: false }, () => {}); },
    assertReady(agent, observed) { assert.equal(agent.id, observed.sessionId); assert.equal(origins.get(agent.id), agent); },
    async pinSession() { pins++; },
  };
  return { path, identity, store, sessions, host, manager: new ManagerSession(store, host, 'W'), counts: () => ({ creates, pins, setups }) };
}
test('并发ensure拒共享安装操作，create前unknown已提交', async t => {
  const f = fixture(t), first = f.manager.ensure(operation(f.store));
  await assert.rejects(f.manager.ensure(operation(f.store)), { code: 'MANAGER_BUSY' });
  await assert.rejects(f.manager.ensure(operation(f.store)), { code: 'MANAGER_BUSY' });
  await first; assert.deepEqual(f.counts(), { creates: 1, pins: 1, setups: 1 }); assert.equal(f.store.manager().bindingState, 'bound');
});
test('不同返回ID拒绝，重试保留原unknown不再create', async t => {
  const f = fixture(t); let calls = 0;
  f.host.create = async () => { calls++; return { id: 'unexpected' }; };
  await assert.rejects(f.manager.ensure(operation(f.store)), { code: 'MANAGER_ORIGIN_REQUIRED' });
  const id = f.store.manager().sessionId; assert.equal(f.store.manager().bindingState, 'unknown');
  await assert.rejects(f.manager.ensure(operation(f.store)));
  assert.equal(f.store.manager().sessionId, id); assert.equal(calls, 1);
});
test('创建异常保留unknown；暂时查不到不能补建', async t => {
  const f = fixture(t); let calls = 0;
  f.host.create = async () => { calls++; throw Error('create-outcome-unknown'); };
  await assert.rejects(f.manager.ensure(operation(f.store)), /create-outcome-unknown/);
  await assert.rejects(f.manager.ensure(operation(f.store)));
  assert.equal(calls, 1); assert.equal(f.store.manager().bindingState, 'unknown');
});
test('create后bind前崩溃没有本进程anchor，保留原ID并拒冷采纳', async t => {
  const f = fixture(t), reserved = f.store.reserveManager(0, 'session-crash-after-create', 'W', ROUTER_PRESET);
  f.store.beginManagerCreate(reserved.revision); f.sessions.set(reserved.sessionId!, { id: reserved.sessionId! });
  await assert.rejects(f.manager.ensure(operation(f.store)), { code: 'MANAGER_ORIGIN_REQUIRED' });
  assert.equal(f.store.manager().sessionId, reserved.sessionId); assert.equal(f.store.manager().bindingState, 'unknown');
  assert.deepEqual(f.counts(), { creates: 0, pins: 0, setups: 0 });
});
test('旧预留不属于本次操作，保留同一ID且拒补建', async t => {
  const f = fixture(t); f.store.reserveManager(0, 'session-reserved-only', 'W', ROUTER_PRESET);
  await assert.rejects(f.manager.ensure(operation(f.store)), { code: 'MANAGER_ORIGIN_REQUIRED' });
  assert.equal(f.store.manager().sessionId, 'session-reserved-only'); assert.equal(f.counts().creates, 0);
});
test('冷恢复无原anchor继续拒绝，不重建或抢回Pin', async t => {
  const f = fixture(t); await f.manager.ensure(operation(f.store)); const id = f.store.manager().sessionId; f.store.close();
  const cold = StewardStore.openExisting(f.path, f.identity); t.after(() => cold.close());
  const coldHost = { ...f.host, owned: () => undefined };
  await assert.rejects(new ManagerSession(cold, coldHost, 'W').ensure(operation(cold)), { code: 'MANAGER_RECOVERY_REQUIRED' });
  cold.recover();
  await assert.rejects(new ManagerSession(cold, coldHost, 'W').ensure(operation(cold)), { code: 'MANAGER_ORIGIN_REQUIRED' });
  assert.equal(cold.manager().sessionId, id); assert.equal(f.counts().creates, 1); assert.equal(f.counts().pins, 1);
});
test('任一await期间停止拒绝后续绑定，unknown保留', async t => {
  const f = fixture(t), original = f.host.passive;
  f.host.passive = async (id, signal) => { const result = await original(id, signal); f.store.stop(f.store.manager().revision, 'human-stop'); return result; };
  await assert.rejects(f.manager.ensure(operation(f.store)), { code: 'INSTALLATION_CHANGED' });
  assert.equal(f.store.manager().bindingState, 'unknown'); assert.equal(f.counts().setups, 0); assert.equal(f.counts().pins, 0);
});
test('初始化失败不标bound，不应用Pin', async t => {
  const f = fixture(t); f.host.prepare = async () => { throw Error('setup-denied'); };
  await assert.rejects(f.manager.ensure(operation(f.store)), /setup-denied/);
  assert.equal(f.store.manager().bindingState, 'unknown'); assert.equal(f.counts().pins, 0);
});
test('错误实例或workspace不替换持久身份', async t => {
  const f = fixture(t);
  assert.throws(() => new ManagerSession(f.store, { ...f.host, identity: { ...f.identity, domainId: 'foreign' } }, 'W'), { code: 'MANAGER_DOMAIN_MISMATCH' });
  f.store.reserveManager(0, 'session-owned', 'other-workspace', ROUTER_PRESET);
  await assert.rejects(f.manager.ensure(operation(f.store)), { code: 'MANAGER_BINDING_MISMATCH' }); assert.equal(f.counts().creates, 0);
});
