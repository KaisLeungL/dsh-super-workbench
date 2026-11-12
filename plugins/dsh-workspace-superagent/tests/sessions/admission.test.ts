import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { StewardStore } from '../../src/storage/store.js';
import { ExecutionAdmission, type AdmissionAgent, type AdmittedMessage } from '../../src/sessions/admission.js';
import { WORKER_PRESET, type NativeTask } from '../../src/tools/authority.js';
import { ROUTER_PRESET } from '../../src/sessions/manager.js';
const root = process.env.B03_RUN_DIR;
assert.ok(root?.includes('/.superagent-product-lab/b03/runs/'));
function fixture(t: TestContext) {
  const store = StewardStore.initializeFresh(resolve(root!, randomUUID() + '.sqlite'), { instanceId: randomUUID(), domainId: 'admission-test' }); t.after(() => store.close());
  store.registerResource('R', { workspaceId: 'W' });
  const reserved = store.reserveManager(store.manager().revision, 'R', 'W', ROUTER_PRESET);
  store.beginManagerCreate(reserved.revision);
  store.bindManager(store.manager().revision, { sessionId: 'R', workspaceId: 'W', preset: ROUTER_PRESET, nativeLogRef: 'log' });
  store.recordLifecycle(store.manager().revision, 'running', false);
  const nextTurn: AdmittedMessage[] = [], nextStep: AdmittedMessage[] = [];
  let version: number | undefined = 4, required = 0, valid = true;
  const agent: AdmissionAgent = { id: 'S', inputAdmissionVersion: 4, requireInputAdmission() { required++; }, inbox: { nextTurn, nextStep }, async runMaintenance(operation) { return operation(new AbortController().signal); } };
  const registry = new Map([[agent.id, agent]]);
  const task: NativeTask = { id: 'T', workspaceId: 'W', projectId: 'P', status: 'running', mode: WORKER_PRESET, permission: 'workspace-write', executions: [{ id: 'E', sessionId: 'S' }] };
  const face = { availableVersion: () => version, agent: (id: string) => registry.get(id), resolve: async () => agent, preset: () => WORKER_PRESET, task: () => task, defaultPermission: () => 'read-only', assertLaunchPolicy() {} };
  const admission = new ExecutionAdmission(store, face);
  const request = { taskId: 'T', executionId: 'E', generation: 1, sessionId: 'S', task, isCurrent: () => valid };
  const payload = (messages = nextTurn) => ({ agent, messages, nextTurn, nextStep, signal: new AbortController().signal });
  return { store, agent, registry, admission, request, payload, nextTurn, nextStep, required: () => required, unavailable: (oldVersion?: number) => version = oldVersion, invalidate: () => valid = false };
}
test('缺接缝在创建前拒绝，未准入默认拒绝，冷恢复不复活pending', t => {
  const f = fixture(t); f.unavailable(); assert.throws(() => f.admission.assertLaunch(f.request.task, WORKER_PRESET), { code: 'PRECLAIM_CAPABILITY_REQUIRED' });
  for (const oldVersion of [1, 2]) { const old = fixture(t); old.unavailable(oldVersion); assert.throws(() => old.admission.assertAvailable(), { code: 'PRECLAIM_CAPABILITY_REQUIRED' }); }
  const g = fixture(t); assert.equal(g.admission.checkClaim(g.payload()).kind, 'reject');
  g.nextTurn.push({ id: 'old', source: { rpcId: 'old-request' } });
  assert.throws(() => g.admission.markScoped(g.agent), { code: 'PENDING_RESTORE' }); assert.equal(g.required(), 1);
});
test('真实准入形状的setup后才接受精确rpc，claim validate再次核权', async t => {
  const f = fixture(t); f.admission.markScoped(f.agent);
  await f.admission.admit(f.request, async setup => { assert.ok(setup); await setup('rpc'); f.nextTurn.push({ id: 'M', source: { rpcId: 'rpc' } }); });
  const decision = f.admission.checkClaim(f.payload()); assert.equal(decision.kind, 'claim');
  f.admission.checkStep(f.agent, f.nextTurn, f.payload().signal);
  f.invalidate(); assert.equal(decision.kind === 'claim' && decision.validate(), false);
  assert.throws(() => f.admission.current(f.agent), { code: 'ADMISSION_REVOKED' });
});
test('await撤权、pins失败、陌生followup和旧rpc新消息拒绝', async t => {
  const f = fixture(t); f.admission.markScoped(f.agent);
  await assert.rejects(f.admission.admit(f.request, async setup => { await Promise.resolve(); f.invalidate(); await setup!('rpc'); }), { code: 'STALE_EXECUTION' });
  assert.equal(f.admission.current(f.agent), undefined);
  const g = fixture(t); g.admission.markScoped(g.agent);
  await assert.rejects(g.admission.admit(g.request, async () => { throw Error('pins-failed'); }), /pins-failed/);
  assert.equal(g.admission.current(g.agent), undefined);
  await g.admission.admit(g.request, async setup => setup!('rpc'));
  g.nextTurn.push({ id: 'first', source: { rpcId: 'rpc' } }); assert.equal(g.admission.checkClaim(g.payload()).kind, 'claim');
  g.nextTurn.splice(0, 1, { id: 'replay', source: { rpcId: 'rpc' } }); assert.equal(g.admission.checkClaim(g.payload()).kind, 'reject');
  g.nextTurn.splice(0, 1, { id: 'foreign', source: { rpcId: 'other' } }); assert.equal(g.admission.checkClaim(g.payload()).kind, 'reject');
});
test('候选messages与队列快照独立核rpc，拒绝不设messageIds也不改队列', async t => {
  const f = fixture(t); f.admission.markScoped(f.agent); await f.admission.admit(f.request, async setup => setup!('rpc'));
  const foreign = [{ id: 'foreign', source: { rpcId: 'foreign-rpc' } }];
  assert.equal(f.admission.checkClaim(f.payload(foreign)).kind, 'reject');
  assert.equal(f.nextTurn.length, 0); assert.equal(f.nextStep.length, 0);
  f.nextTurn.push({ id: 'own', source: { rpcId: 'rpc' } });
  const before = JSON.stringify([f.nextTurn, f.nextStep]);
  assert.equal(f.admission.checkClaim(f.payload(foreign)).kind, 'reject');
  assert.equal(JSON.stringify([f.nextTurn, f.nextStep]), before);
  // 若拒绝分支误保存foreign IDs，这里的合法首次候选会被错误拒绝。
  assert.equal(f.admission.checkClaim(f.payload()).kind, 'claim');
});
test('精确执行撤销不误伤其他执行，停止及同ID新Agent使旧能力失效', async t => {
  const f = fixture(t); f.admission.markScoped(f.agent); await f.admission.admit(f.request, async setup => setup!('rpc'));
  f.admission.revoke({ taskId: 'T', executionId: 'other', sessionId: 'S' }); assert.ok(f.admission.current(f.agent));
  f.admission.revoke({ taskId: 'T', executionId: 'E', sessionId: 'S' }); assert.throws(() => f.admission.current(f.agent), { code: 'ADMISSION_REVOKED' });
  const g = fixture(t); g.admission.markScoped(g.agent); await g.admission.admit(g.request, async setup => setup!('rpc'));
  g.registry.set('S', { ...g.agent }); assert.throws(() => g.admission.current(g.agent), { code: 'ADMISSION_REVOKED' });
  const h = fixture(t); h.admission.markScoped(h.agent); await h.admission.admit(h.request, async setup => setup!('rpc'));
  h.store.stop(h.store.manager().revision, 'human-stop'); assert.throws(() => h.admission.current(h.agent), { code: 'NOT_RUNNING' });
});
const policy = (resources = ['R']) => ({ resources, audiences: ['private'], mandate: { actions: ['read'], expiresAt: 9999999999999 }, proofRef: 'trusted-host-policy-proof' });
test('主理暂停时仍可准入Worker，暂停恢复不撤销，policy变化撤销', async t => {
  const f = fixture(t);
  f.store.recordLifecycle(f.store.manager().revision, 'paused', false);
  f.admission.markScoped(f.agent);
  await f.admission.admit(f.request, async setup => setup!('rpc'));
  f.store.recordLifecycle(f.store.manager().revision, 'running', true);
  assert.ok(f.admission.current(f.agent));
  f.store.appendPolicy(f.store.manager().versions.policyVersion, policy());
  assert.throws(() => f.admission.current(f.agent), { code: 'ADMISSION_REVOKED' });
});
test('registerExecution同执行幂等并推进新generation', t => {
  const f = fixture(t);
  f.store.registerExecution('T', 'E', 1); f.store.registerExecution('T', 'E', 1);
  f.store.registerExecution('T', 'E2', 2);
  assert.equal(f.store.readExecutionAuditGeneration('T', 'E2'), 2);
  assert.throws(() => f.store.registerExecution('T', 'E2', 1), { code: 'EXECUTION_CONFLICT' });
});
