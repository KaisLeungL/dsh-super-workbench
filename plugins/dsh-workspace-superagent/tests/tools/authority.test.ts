import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { StewardStore } from '../../src/storage/store.js';
import { CallerAuthority, CONTEXT_TOOLS, READ_TOOLS, WORKER_PRESET, assertSupportedLaunch, type CallerHost, type HostPolicy, type NativeTask } from '../../src/tools/authority.js';
import { ROUTER_PRESET } from '../../src/sessions/manager.js';
import { commitLiveEvidence } from '../audit/live-evidence.js';
const root = process.env.B03_RUN_DIR;
assert.ok(root?.includes('/.superagent-product-lab/b03/runs/'), '仅在本轮独占目录运行');
function fixture(t: TestContext) {
  const identity = { instanceId: randomUUID(), domainId: 'caller-component' };
  const store = StewardStore.initializeFresh(resolve(root!, randomUUID() + '.sqlite'), identity); t.after(() => store.close());
  store.registerResource('R', { workspaceId: 'W', repositoryId: 'P', credentialRef: 'not-exported' });
  store.appendPolicy(0, { resources: ['R'], audiences: ['A'], mandate: { actions: ['read', 'report'], expiresAt: 10000 }, proofRef: 'human' });
  const reserved = store.reserveManager(store.manager().revision, 'router', 'W', ROUTER_PRESET);
  store.bindManager(reserved.revision, { sessionId: 'router', workspaceId: 'W', preset: ROUTER_PRESET, nativeLogRef: 'native:router' });
  store.recordLifecycle(store.manager().revision, 'running', true);
  const router = { id: 'router' }, worker = { id: 'worker' };
  const registry = new Map([[router.id, router], [worker.id, worker]]);
  let task: NativeTask = { id: 'T', workspaceId: 'W', projectId: 'P', status: 'running', permission: 'workspace-write', mode: WORKER_PRESET, executions: [{ id: 'E', sessionId: worker.id, projectId: 'P' }] };
  let policy: HostPolicy = { revision: 'host-1', backend: 'native', resources: ['R'], tools: [...READ_TOOLS], actions: ['read', 'report'], audiences: ['A'], maxTokens: 2048 };
  let admitted = true, nativeRoot = true, now = 1;
  const admission = { taskId: 'T', executionId: 'E', sessionId: 'worker', revision: 'admission-1', assertCurrent() { if (!admitted) throw Error('admission-revoked'); } };
  const host: CallerHost<{ id: string }> = { identity, agent: id => registry.get(id), isRuntimeRoot: () => nativeRoot, preset: a => a.id === 'router' ? ROUTER_PRESET : WORKER_PRESET, workspace: () => 'W', policy: () => policy, admission: a => a.id === 'worker' ? admission : undefined, task: () => task, defaultPermission: () => 'read-only', assertAvailable() {}, now: () => now };
  const authority = new CallerAuthority(store, host);
  const call = (agent = router) => ({ agent, signal: new AbortController().signal });
  return { identity, store, router, worker, registry, host, authority, call, task: () => task, setTask: (value: NativeTask) => task = value, policy: () => policy, setPolicy: (value: HostPolicy) => policy = value, revoke: () => admitted = false, child: () => nativeRoot = false, expire: () => now = 10000 };
}
test('上下文工具权限只授予前台主理，不进入 Worker 或后台调用', t => {
  const f = fixture(t);
  f.setPolicy({ ...f.policy(), tools: [...READ_TOOLS, ...CONTEXT_TOOLS], allBoardProjects: true });
  assert.throws(() => f.authority.capture(f.call()).require(CONTEXT_TOOLS[0], 'read'), /没有此项权限/);
  assert.equal(f.authority.capture(f.call()).allBoardProjects, undefined);
  f.host.hasForegroundInput = agent => agent === f.router;
  const foreground = f.authority.capture(f.call());
  foreground.require(CONTEXT_TOOLS[0], 'read');
  assert.equal(foreground.allBoardProjects, true);
  assert.throws(() => f.authority.capture(f.call(f.worker)).require(CONTEXT_TOOLS[1], 'read'), /没有此项权限/);
  assert.equal(f.authority.capture(f.call(f.worker)).allBoardProjects, undefined);
  f.setPolicy({ ...f.policy(), allBoardProjects: undefined });
  assert.throws(() => foreground.assertCurrent(), { code: 'SCOPE_CHANGED' });
});
test('Router与Worker按真实对象及分支分别捕获，provider不共享caller', t => {
  const f = fixture(t), router = f.authority.provider(f.call()), worker = f.authority.provider(f.call(f.worker));
  const r = router(), w = worker();
  assert.deepEqual(r.branches, [{ workspaceId: 'W', projectIds: ['P'] }]);
  assert.deepEqual(w.branches, [{ workspaceId: 'W', projectIds: ['P'], taskIds: ['T'] }]);
  assert.equal(router().fingerprint, r.fingerprint); assert.equal(worker().fingerprint, w.fingerprint);
  assert.notEqual(r.fingerprint, w.fingerprint); r.assertCurrent(); w.assertCurrent();
});
test('无caller、同ID伪造对象、被替换旧对象与间接/后代调用拒绝', t => {
  const f = fixture(t), lease = f.authority.capture(f.call());
  assert.throws(() => f.authority.capture({ signal: f.call().signal }), { code: 'CALLER_NOT_CURRENT' });
  assert.throws(() => f.authority.capture(f.call({ id: 'router' })), { code: 'CALLER_NOT_CURRENT' });
  assert.throws(() => f.authority.capture({ ...f.call(), parent: {} }), { code: 'INDIRECT_CALL_DENIED' });
  f.registry.set('router', { id: 'router' }); assert.throws(() => lease.assertCurrent(), { code: 'CALLER_NOT_CURRENT' });
  f.registry.set('router', f.router); f.child(); assert.throws(() => lease.assertCurrent(), { code: 'INDIRECT_CALL_DENIED' });
});
test('原授权数组后续变化不会修改既有lease，但再核会拒旧lease', t => {
  const f = fixture(t), lease = f.authority.capture(f.call());
  assert.ok(Object.isFrozen(lease.branches)); assert.ok(Object.isFrozen(lease.branches[0]!.projectIds));
  (f.policy().tools as string[]).pop();
  assert.equal(lease.tools.length, 3); assert.throws(() => lease.assertCurrent(), { code: 'SCOPE_CHANGED' });
});
test('Worker不能跨卡/跨执行，旧执行/缺session/撤销admission拒绝', t => {
  const f = fixture(t), lease = f.authority.capture(f.call(f.worker));
  lease.require(READ_TOOLS[0]!, 'read', { taskId: 'T', executionId: 'E' });
  assert.throws(() => lease.require(READ_TOOLS[0]!, 'read', { taskId: 'B' }), { code: 'CROSS_TASK_DENIED' });
  assert.throws(() => lease.require(READ_TOOLS[0]!, 'read', { executionId: 'old' }), { code: 'CROSS_EXECUTION_DENIED' });
  f.setTask({ ...f.task(), executions: [{ id: 'new', sessionId: 'worker' }] });
  assert.throws(() => lease.assertCurrent(), { code: 'EXECUTION_NOT_CURRENT' });
  f.setTask({ ...f.task(), executions: [{ id: 'E' }] }); assert.throws(() => f.authority.capture(f.call(f.worker)), { code: 'EXECUTION_NOT_CURRENT' });
  f.setTask({ ...f.task(), executions: [{ id: 'E', sessionId: 'worker', projectId: 'P' }] }); f.revoke(); assert.throws(() => lease.assertCurrent(), /admission-revoked/);
});
test('await后政策收紧、stop、intent和Host策略变化都拒旧continuation', async t => {
  const f = fixture(t), lease = f.authority.capture(f.call());
  await Promise.resolve();
  f.store.appendPolicy(1, { resources: ['R'], audiences: [], mandate: { actions: ['read'], expiresAt: 10000 }, proofRef: 'narrow' });
  assert.throws(() => lease.assertCurrent(), { code: 'SCOPE_CHANGED' });
  const fresh = f.authority.capture(f.call()); f.setPolicy({ ...f.policy(), revision: 'host-2', maxTokens: 1024 });
  assert.throws(() => fresh.assertCurrent(), { code: 'SCOPE_CHANGED' });
  const beforeIntent = f.authority.capture(f.call());
  f.store.recordVerifiedActor('human', 'trusted-channel-proof', { source: 'component-user', externalId: 'H' });
  const evidence = commitLiveEvidence(f.store, 'W', '更新决定');
  const v = f.store.manager().versions;
  f.store.appendDecision({ ...evidence, id: 'decision-1', actorId: 'human', sourceMessageRef: 'native:1', expectedIntent: v.intentRevision, policyVersion: v.policyVersion, scopeVersion: v.scopeVersion, stopEpoch: v.stopEpoch, decision: '更新决定' });
  assert.throws(() => beforeIntent.assertCurrent(), { code: 'SCOPE_CHANGED' });
  const current = f.authority.capture(f.call()); f.store.stop(f.store.manager().revision, 'human');
  assert.throws(() => current.assertCurrent(), { code: 'NOT_RUNNING' });
});
test('read-only原卡限制动作，未知卡权限及特殊启动形状预先拒绝', t => {
  const f = fixture(t); f.setTask({ ...f.task(), permission: 'read-only' });
  assert.deepEqual(f.authority.capture(f.call(f.worker)).actions, ['read']);
  for (const field of [{ taskKind: 'inspection' }, { goalRun: true }, { teamRun: true }, { handover: {} }, { parentId: 'parent' }, { integrations: { acp: {} } }]) {
    assert.throws(() => assertSupportedLaunch({ ...f.task(), ...field }, WORKER_PRESET, 'read-only'), { code: 'UNSUPPORTED_EXECUTION_SHAPE' });
  }
  assert.throws(() => assertSupportedLaunch({ ...f.task(), permission: 'invented' }, WORKER_PRESET, undefined), { code: 'UNKNOWN_CARD_PERMISSION' });
});
test('资源和Host交集不能用workspace或模型selector增权，过期拒绝', t => {
  const f = fixture(t); f.setTask({ ...f.task(), executions: [{ id: 'E', sessionId: 'worker' }] });
  assert.throws(() => f.authority.capture(f.call(f.worker)), { code: 'EXECUTION_PROJECT_UNKNOWN' });
  f.setTask({ ...f.task(), executions: [{ id: 'E', sessionId: 'worker', projectId: 'OTHER' }] });
  assert.throws(() => f.authority.capture(f.call(f.worker)), { code: 'NO_AUTHORIZED_RESOURCE' });
  f.setPolicy({ ...f.policy(), resources: [] }); assert.throws(() => f.authority.capture(f.call()), { code: 'NO_AUTHORIZED_RESOURCE' });
  f.setPolicy({ ...f.policy(), resources: ['R'] }); f.expire(); assert.throws(() => f.authority.capture(f.call()), { code: 'MANDATE_EXPIRED' });
});
test('明确的无期限授权保持原范围，并可通过后续策略撤销', t => {
  const f = fixture(t);
  f.store.appendPolicy(1, { resources: ['R'], audiences: ['A'], mandate: { actions: ['read'], expiresAt: null }, proofRef: 'human-no-expiry' });
  f.expire();
  const lease = f.authority.capture(f.call());
  assert.deepEqual(lease.actions, ['read']);
  f.store.appendPolicy(2, { resources: [], audiences: [], mandate: { actions: [], expiresAt: 0 }, proofRef: 'human-revoke' });
  assert.throws(() => lease.assertCurrent());
  assert.throws(() => f.authority.capture(f.call()), { code: 'MANDATE_EXPIRED' });
});
