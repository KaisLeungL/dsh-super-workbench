import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION } from '../../src/storage/schema.js';
import { StewardStore, fingerprint } from '../../src/storage/store.js';
import { LIMITS, type EffectRequest, type EvalRequest, type RouteItem, type Projection, type JobRequest } from '../../src/storage/types.js';
import { dispatchOnce } from '../../src/app/effects/outbox.js';
import { computeOnce } from '../../src/app/effects/jobs.js';
import { commitLiveEvidence } from '../audit/live-evidence.js';

const run = process.env.B02_RUN_DIR;
assert.ok(run && run.includes('/.superagent-product-lab/b02/runs/'), '测试只写自有 B02 新运行目录');
mkdirSync(run, { recursive: true });
const policy = (resources = ['R']) => ({ resources, audiences: ['private'], mandate: { actions: ['read'], expiresAt: 9999999999999 }, proofRef: 'trusted-host-policy-proof' });
function fixture(t: TestContext, userText?: string) {
  const path = resolve(run!, randomUUID() + '.sqlite'), identity = { instanceId: randomUUID(), domainId: 'test-domain' };
  const s = StewardStore.initializeFresh(path, identity); t.after(() => { try { s.close(); } catch {} });
  s.registerResource('R', { workspaceId: 'workspace-A' }); s.registerSource('S', 'tenant/repo/stable-id', 'R'); s.appendPolicy(0, policy());
  const start = () => s.recordLifecycle(s.manager().revision, 'running', true);
  start();
  const evidence = commitLiveEvidence(s, 'workspace-A', userText);
  const effect = (key: string, destination = 'private-A'): EffectRequest => ({ ...evidence, effectKey: key, operationKey: key + ':op1', boardTaskId: 'board-A', destination, purpose: 'ack', payload: 'original', requestId: key + ':request1', audience: 'private', versions: s.manager().versions });
  const evaluation = (id: string, count = 1, control = false): EvalRequest => ({ ...evidence, evalId: id, versions: s.manager().versions, candidates: Array.from({ length: count }, (_, n) => ({ triggerId: id + ':t' + n, externalEventId: id + ':e' + n, triggerRevision: 1, resourceId: 'R', threadKey: 'thread', body: 'hello', neighbors: [], payloadRef: evidence.inputSnapshotRef, payloadHash: evidence.inputHash })), control, queuedAt: 0 });
  const route = (e: EvalRequest, n = 0): RouteItem => ({ triggerId: e.candidates[n].triggerId, triggerRevision: 1, boardTaskId: 'board-A', executionId: 'execution-A', executionGeneration: 1, purpose: 'work', watermark: n + 1, inputId: e.candidates[n].triggerId + ':input', rpcId: 'rpc:' + n, inputHash: evidence.inputHash, effect: { ...effect(e.candidates[n].triggerId), executionId: 'execution-A' } });
  return { s, path, identity, effect, evaluation, route, evidence, start };
}
function deliver(s: StewardStore, e: EvalRequest) {
  s.acceptEval('S', s.source('S').revision, e.evalId + ':cursor', e);
  assert.equal(s.beginEval(e.evalId, 0, 0), true);
  s.recordEvalDelivery(e.evalId, 1, { nativeLogRef: 'log:delivered', basis: 'native-log', deliveredAt: 100 });
}
function reopen(t: TestContext, f: ReturnType<typeof fixture>) {
  const s = StewardStore.openExisting(f.path, f.identity); t.after(() => { try { s.close(); } catch {} }); return s;
}

test('初始化、预留创建绑定与冷恢复；不能自动补空或替换会话', t => {
  const f = fixture(t), s = f.s;
  assert.deepEqual(s.diagnostics(), { journalMode: 'wal', synchronous: 2, foreignKeys: true, recoveryPending: false, healthy: true });
  assert.throws(() => StewardStore.initializeFresh(f.path, f.identity));
  const m1 = s.reserveManager(s.manager().revision, 'reserved-session', 'workspace-A', 'native-router');
  assert.throws(() => s.reserveManager(m1.revision, 'another', 'workspace-A', 'native-router'));
  const m2 = s.beginManagerCreate(m1.revision);
  assert.throws(() => s.beginManagerCreate(m2.revision));
  assert.throws(() => s.bindManager(m2.revision, { sessionId: 'new-id-from-create', workspaceId: 'workspace-A', preset: 'native-router', nativeLogRef: 'log' }));
  s.bindManager(m2.revision, { sessionId: 'reserved-session', workspaceId: 'workspace-A', preset: 'native-router', nativeLogRef: 'native-log:stable-id' });
  const cold = reopen(t, f); assert.throws(() => cold.recordLifecycle(cold.manager().revision, 'running', false));
  const recovery = cold.recover(); assert.equal(recovery.manager.sessionId, 'reserved-session'); assert.equal(recovery.manager.pin, true); assert.equal(recovery.manager.lifecycle, 'paused');
  const missing = resolve(run!, randomUUID() + '.missing'); assert.throws(() => StewardStore.openExisting(missing, f.identity)); assert.equal(existsSync(missing), false);
  assert.throws(() => StewardStore.openExisting(f.path, { ...f.identity, domainId: 'wrong' }));
});
test('corrupt、未来schema、空半初始化和必要表丢失均拒绝，主文件不变', t => {
  for (const kind of ['corrupt', 'future', 'partial', 'missing-ledger', 'missing-index']) {
    const f = fixture(t); f.s.close();
    if (kind === 'corrupt') writeFileSync(f.path, 'not a sqlite database');
    if (kind === 'partial') writeFileSync(f.path, '');
    if (['future','missing-ledger','missing-index'].includes(kind)) { const db = new DatabaseSync(f.path); db.exec(kind === 'future' ? 'PRAGMA user_version=' + (SCHEMA_VERSION + 1) : kind === 'missing-index' ? 'DROP INDEX brief_occurrence' : 'DROP TABLE audit'); db.close(); }
    const before = readFileSync(f.path); assert.throws(() => StewardStore.openExisting(f.path, f.identity)); assert.deepEqual(readFileSync(f.path), before);
  }
});
test('同一宿主并发认领仅外呼一次，独立连接不能复用其审计授权', async t => {
  const f = fixture(t);
  const identity = { effectKey: 'race', ...f.s.enqueueEffect(f.effect('race')) };
  const receipt = Promise.withResolvers<{ nativeLogRef: string; accepted: boolean }>();
  const first = dispatchOnce(f.s, identity, () => true, () => receipt.promise);
  try {
    assert.equal(f.s.effectState('race', 1)?.state, 'unknown');
    assert.equal(await dispatchOnce(f.s, identity, () => true, async () => assert.fail('重复外呼')), 'blocked');
  } finally { receipt.resolve({ nativeLogRef: 'native-receipt', accepted: true }); }
  assert.equal(await first, 'accepted');
  assert.equal(f.s.effectState('race', 1)?.state, 'succeeded');
  const pending = { effectKey: 'cold', ...f.s.enqueueEffect(f.effect('cold')) };
  f.s.close();
  const cold = reopen(t, f);
  cold.recover();
  cold.recordLifecycle(cold.manager().revision, 'running', true);
  await assert.rejects(dispatchOnce(cold, pending, () => true, async () => assert.fail('冷连接不得外呼')),
    { code: 'AUDIT_EVIDENCE_NOT_CURRENT' });
  assert.equal(cold.effectState('cold', 1)?.state, 'pending');
});
test('enqueue 幂等/内容冲突；显式replace保留g1 unknown及其迟到回执', async t => {
  const f = fixture(t); f.start(); const request = f.effect('k'); const g1 = f.s.enqueueEffect(request);
  assert.deepEqual(f.s.enqueueEffect(request), g1); assert.throws(() => f.s.enqueueEffect({ ...request, payload: 'changed' })); assert.throws(() => f.s.enqueueEffect({ ...request, destination: 'public' }));
  const claim = f.s.claimEffect('k', g1.seq, 1, () => true)!; assert.ok(claim); assert.equal(f.s.effectState('k', 1)?.state, 'unknown');
  const next = { ...request, payload: 'new-body', operationKey: 'op2', requestId: 'rpc2' }; const g2 = f.s.replaceEffect('k', 1, next);
  assert.equal(g2.generation, 2); assert.equal(f.s.claimEffect('k', g2.seq, 2, () => true), undefined);
  const bypass = f.s.enqueueEffect({ ...f.effect('different-key'), payload: 'cannot bypass same destination' }); assert.equal(f.s.claimEffect('different-key', bypass.seq, 1, () => true), undefined);
  const other = f.s.enqueueEffect(f.effect('different-destination', 'private-B')); assert.ok(f.s.claimEffect('different-destination', other.seq, 1, () => true));
  assert.equal(f.s.recordEffectReceipt(claim, { nativeLogRef: 'late:g1', accepted: true }), false);
  assert.equal(f.s.effectState('k', 1)?.state, 'unknown'); assert.equal(f.s.effectState('k', 2)?.state, 'pending'); assert.equal(f.s.effectState('k', 2)?.request.payload, 'new-body');
  const cold = reopen(t, f); const recovery = cold.recover(); assert.ok(recovery.unknownEffects.some(e => e.effectKey === 'k' && e.generation === 1));
  cold.recordLifecycle(cold.manager().revision, 'running', true);
  assert.throws(() => cold.claimEffect('k', g2.seq, 2, () => true), { code: 'AUDIT_EVIDENCE_NOT_CURRENT' });
  assert.throws(() => cold.reconcileUnknown('k', g1.seq, 1, { remoteProofRef: '', requestId: request.requestId, destination: request.destination, payloadHash: fingerprint(request.payload), outcome: 'succeeded' }));
  cold.reconcileUnknown('k', g1.seq, 1, { remoteProofRef: 'remote-log:proved', requestId: request.requestId, destination: request.destination, payloadHash: fingerprint(request.payload), outcome: 'succeeded' });
  assert.equal(cold.effectState('k', 1)?.state, 'succeeded');
  await assert.rejects(dispatchOnce(cold, { effectKey: 'k', ...g2 }, () => true, async () => assert.fail('对账不得恢复发送授权')),
    { code: 'AUDIT_EVIDENCE_NOT_CURRENT' });
  cold.terminateEffect('different-key', bypass.seq, 1, 'revoked', '撤回同目标待发项');
  const g3 = cold.replaceEffect('k', 2, { ...next, ...commitLiveEvidence(cold, 'workspace-A'), versions: cold.manager().versions,
    operationKey: 'op3', requestId: 'rpc3' });
  assert.equal(await dispatchOnce(cold, { effectKey: 'k', ...g3 }, () => true, async req => {
    assert.equal(req.payload, 'new-body');
    return { nativeLogRef: 'g3', accepted: true };
  }), 'accepted');
});
test('pending replace不被自身旧代阻塞，永久dropped/revoked不复活或扩渠', t => {
  const f = fixture(t); f.start(); const req = f.effect('pending'); const old = f.s.enqueueEffect(req);
  const next = f.s.replaceEffect('pending', 1, { ...req, payload: 'v2', operationKey: 'p2', requestId: 'p2' }); assert.equal(f.s.effectState('pending', 1)?.state, 'revoked');
  assert.ok(f.s.claimEffect('pending', next.seq, 2, () => true));
  assert.throws(() => f.s.replaceEffect('pending', 2, { ...req, operationKey: 'p3', requestId: 'p3', destination: 'wider' }));
  const dropped = f.s.enqueueEffect(f.effect('dropped', 'private-C')); f.s.terminateEffect('dropped', dropped.seq, 1, 'dropped', 'destination permanently absent');
  assert.throws(() => f.s.replaceEffect('dropped', 1, { ...f.effect('dropped', 'private-C'), operationKey: 'd2', requestId: 'd2', payload: 'revive' }));
  assert.equal(f.s.claimEffect('dropped', dropped.seq, 1, () => true), undefined); assert.equal(old.generation, 1);
});
test('多条route逐项CAS，坏项不拖有效项；重复结果幂等', t => {
  const f = fixture(t); const e = f.evaluation('route', 3); deliver(f.s, e); const a = f.route(e), bad = { ...f.route(e, 1), triggerRevision: 99 }, mismatched = f.route(e, 2);
  mismatched.effect.boardTaskId = 'wrong-board'; mismatched.effect.executionId = 'wrong-execution';
  const results = f.s.commitRoute(e.evalId, 2, e.versions.policyVersion, [a, bad, mismatched]); assert.deepEqual(results.map(x => x.committed), [true, false, false]);
  assert.equal(results[2].reason, 'INPUT_BINDING_MISMATCH'); assert.equal(f.s.effectState(mismatched.effect.effectKey, 1), undefined);
  assert.ok(f.s.inputState(a.inputId)); assert.equal(f.s.inputState(bad.inputId), undefined); assert.equal(f.s.effectState(bad.effect.effectKey, 1), undefined);
  assert.equal(f.s.commitRoute(e.evalId, 2, e.versions.policyVersion, [a])[0].committed, true);
});
test('双work owner与context独立；末owner仅一次重路由，answered不重派', t => {
  const f = fixture(t); const e = f.evaluation('owners'); deliver(f.s, e); const a = f.route(e); f.s.commitRoute(e.evalId, 2, e.versions.policyVersion, [a]);
  const b = { ...a, boardTaskId: 'board-B', executionId: 'execution-B', rpcId: 'rpc-B' }; const c = { ...a, boardTaskId: 'board-C', executionId: 'execution-C', rpcId: 'rpc-C', purpose: 'context' as const };
  f.s.attachRecipient(b, e.versions); f.s.attachRecipient(c, e.versions); assert.equal(f.s.inputState(a.inputId)?.owners.length, 2);
  assert.equal(f.s.releaseInputs(c.executionId, 1, 1, 'context done'), 0); assert.equal(f.s.releaseInputs(a.executionId, 1, 1, 'handoff A'), 0);
  assert.equal(f.s.releaseInputs(b.executionId, 1, 1, 'handoff B'), 1); assert.equal(f.s.releaseInputs(b.executionId, 1, 1, 'duplicate'), 0); assert.equal(f.s.inputState(a.inputId)?.rerouteGeneration, 1);
  const e2 = f.evaluation('answered'); deliver(f.s, e2); const ans = { ...f.route(e2), watermark: 2 }; f.s.commitRoute(e2.evalId, 2, e2.versions.policyVersion, [ans]);
  f.s.observeInput(ans.inputId, ans.executionId, 1, 'answered', { rpcId: ans.rpcId, inputHash: ans.inputHash, nativeItemId: 'native-answered', nativeLogRef: 'explicit-work-report' });
  assert.equal(f.s.releaseInputs(ans.executionId, 1, 2, 'ended'), 0); assert.equal(f.s.inputState(ans.inputId)?.state, 'answered');
});
test('释放水位不丢后续输入，旧execution不能释放后继', t => {
  const f = fixture(t); const e = f.evaluation('watermarks', 2); deliver(f.s, e); const a = f.route(e), b = f.route(e, 1); f.s.commitRoute(e.evalId, 2, e.versions.policyVersion, [a, b]);
  assert.equal(f.s.releaseInputs(a.executionId, 1, 1, 'at first watermark'), 1); assert.deepEqual(f.s.inputState(b.inputId)?.owners, [a.executionId]);
  assert.throws(() => f.s.advanceExecution('board-A', 1, 'execution-successor', 2), /PENDING_OWNERS/);
  assert.equal(f.s.releaseInputs(a.executionId, 1, 2, 'release precise remaining input'), 1);
  f.s.advanceExecution('board-A', 1, 'execution-successor', 2);
  f.s.attachRecipient({ ...b, executionId: 'execution-successor', executionGeneration: 2, watermark: 1, rpcId: 'successor-rpc' }, e.versions);
  assert.throws(() => f.s.releaseInputs(a.executionId, 1, 2, 'stale end'));
  assert.deepEqual(f.s.inputState(b.inputId)?.owners, ['execution-successor']);
});
test('当前版本竞争与stop墓碑跨重启，不恢复动态发送权', t => {
  const f = fixture(t); f.start(); const req = f.effect('stop'); const id = f.s.enqueueEffect(req); const m = f.s.manager();
  f.s.stop(m.revision, 'human stop'); assert.throws(() => f.s.recordLifecycle(m.revision, 'running', true));
  const cold = reopen(t, f); const recovery = cold.recover(); assert.equal(recovery.manager.lifecycle, 'stopped'); assert.equal(recovery.manager.versions.stopEpoch, 1);
  assert.throws(() => cold.claimEffect('stop', id.seq, 1, () => true));
  assert.throws(() => cold.recordLifecycle(cold.manager().revision, 'running', true));
  const reopened = cold.reopenScope(cold.manager().revision, 0, 'new-user-scope-proof'); assert.equal(reopened.versions.scopeVersion, 1); assert.equal(reopened.versions.stopEpoch, 1);
  assert.equal(cold.effectState('stop', 1)?.state, 'revoked');
});
test('撤权、别名/摘要/标题和续页逐跳过滤；来源纠正立即失效', t => {
  const f = fixture(t); f.s.registerResource('SECRET', { workspaceId: 'other' }); f.s.registerSource('SS', 'secret-source', 'SECRET');
  f.s.appendPolicy(1, policy(['R', 'SECRET']));
  const projection = (id: string, resourceId = 'R'): Projection => ({ id, kind: 'thread', resourceId, audience: 'private', title: resourceId + ':title', aliases: [resourceId + ':alias'], summary: resourceId + ':summary', sourceRefs: [{ sourceId: resourceId === 'R' ? 'S' : 'SS', revision: 1, watermark: '' }] });
  f.s.putProjection(0, projection('A')); f.s.putProjection(0, projection('B')); f.s.putProjection(0, projection('PRIVATE', 'SECRET'));
  const scope = () => ({ policyVersion: f.s.manager().versions.policyVersion, resources: ['R'], audiences: ['private'] });
  const page = f.s.search(scope, '', { limit: 1 }); assert.equal(page.items.length, 1); assert.ok(page.nextCursor); assert.ok(!JSON.stringify(page).includes('SECRET'));
  assert.equal(f.s.readProjection(scope, 'PRIVATE'), undefined); assert.deepEqual(f.s.search(scope, 'SECRET:alias').items, []);
  const broad = () => ({ ...scope(), resources: ['R', 'SECRET'] });
  f.s.appendPolicy(2, policy(['R'])); assert.equal(f.s.readProjection(broad, 'PRIVATE'), undefined);
  assert.throws(() => f.s.search(scope, '', { cursor: page.nextCursor })); assert.throws(() => f.s.search(() => ({ ...scope(), policyVersion: 2 }), ''));
  f.s.correctSource('S', 1, 'corrected:watermark'); assert.deepEqual(f.s.search(scope, 'R:title').items, []); assert.deepEqual(f.s.search(scope, 'R:alias').items, []);
  assert.throws(() => f.s.putProjection(1, projection('A')));
  const corrected = { ...projection('A'), title: 'corrected', sourceRefs: [{ sourceId: 'S', revision: 2, watermark: 'corrected:watermark' }] };
  f.s.putProjection(2, corrected); assert.equal(f.s.readProjection(scope, 'A')?.title, 'corrected');
});
test('queue条数/字节/control保留与事务故障不推进游标', t => {
  const f = fixture(t);
  for (let n = 0; n < 32; n++) f.s.acceptEval('S', f.s.source('S').revision, 'cursor:' + n, f.evaluation('q' + n, 8));
  const before = f.s.source('S');
  assert.throws(() => f.s.acceptEval('S', before.revision, 'lost', f.evaluation('overflow')), { code: 'QUEUE_CAPACITY' });
  assert.deepEqual(f.s.source('S'), before);
  f.s.acceptEval('S', before.revision, 'control-accepted', f.evaluation('control', 1, true));
  const g = fixture(t, 'x'.repeat(64000));
  let accepted = 0; for (; accepted < 256; accepted++) {
    const e = g.evaluation('bytes' + accepted);
    try { g.s.acceptEval('S', g.s.source('S').revision, String(accepted), e); }
    catch (error) { assert.equal((error as { code?: string }).code, 'QUEUE_CAPACITY'); break; }
  }
  assert.ok(accepted > 0 && accepted < 256); assert.equal(g.s.source('S').cursor, String(accepted - 1));
  assert.throws(() => g.s.saveInput({ ref: 'too-big', sourceWatermark: '0', headers: { system: '', developer: '', user: 'x'.repeat(65536), tools: '' } }));
  const h = fixture(t); const db = new DatabaseSync(h.path);
  db.exec("CREATE TRIGGER fault_cursor BEFORE UPDATE OF cursor ON source_instance BEGIN SELECT RAISE(ABORT,'injected transaction fault'); END");
  const original = h.s.source('S');
  assert.throws(() => h.s.acceptEval('S', original.revision, 'not-committed', h.evaluation('fault')), /injected transaction fault/);
  assert.deepEqual(h.s.source('S'), original); assert.equal(db.prepare("SELECT id FROM eval WHERE id='fault'").get(), undefined); assert.equal(db.prepare("SELECT id FROM trigger WHERE id='fault:t0'").get(), undefined); db.close();
});
test('Eval deadline按已投递日志开始，pause不耗预算，attempt与排队年龄有界', t => {
  const f = fixture(t); const e = f.evaluation('deadline'); f.s.acceptEval('S', 1, 'a', e);
  assert.equal(f.s.evalState(e.evalId)?.deadline, null); f.s.beginEval(e.evalId, 0, 0); assert.equal(f.s.evalState(e.evalId)?.deadline, null);
  f.s.recordEvalDelivery(e.evalId, 1, { nativeLogRef: 'log', basis: 'native-log', deliveredAt: 100 });
  f.s.pauseEval(e.evalId, 2, 1100); assert.equal(f.s.evalState(e.evalId)?.remaining, 59000);
  f.s.resumeEval(e.evalId, 3, 1000000); assert.equal(f.s.evalState(e.evalId)?.deadline, 1059000);
  const g = fixture(t); const aged = g.evaluation('old'); g.s.acceptEval('S', 1, 'b', aged); assert.equal(g.s.beginEval('old', 0, LIMITS.queueAgeMs + 1), false);
});
test('内部Job回执先提交；cancel后迟到只审计且名额一次释放；恢复不启动producer', async t => {
  const f = fixture(t); f.start();
  const request = (id: string): JobRequest => ({ ...f.evidence, versions: f.s.manager().versions, jobId: id, operationKey: 'job:' + id, kind: 'brief', budget: { maxTokens: 1000, deadlineMs: LIMITS.jobTimeoutMs } });
  f.s.createJob(request('j1')); f.s.createJob(request('j2')); f.s.createJob(request('j3'));
  const c1 = f.s.claimJob('j1', 0, () => true)!; const c2 = f.s.claimJob('j2', 0, () => true)!; assert.throws(() => f.s.claimJob('j3', 0, () => true));
  assert.equal(f.s.cancelJob('j1', 0, 'cancel'), true); assert.equal(f.s.cancelJob('j1', 1, 'again'), false); assert.ok(f.s.claimJob('j3', 0, () => true));
  const result = { resultRef: 'artifact:j1', hash: fingerprint('result'), nativeReceiptRef: 'native-job-receipt' };
  assert.equal(f.s.completeJob(c1, result, 1), false); assert.equal(f.s.completeJob(c1, result, 1), false); assert.deepEqual(f.s.jobState('j1'), { state: 'cancelled', cancelGeneration: 1, released: true, receipts: 1 });
  f.s.completeJob(c2, { ...result, resultRef: 'artifact:j2' }, 1); assert.equal(f.s.jobState('j2')?.state, 'completed');
  const cold = reopen(t, f); const recovery = cold.recover(); assert.ok(recovery.interruptedJobs.includes('j3')); cold.recordLifecycle(cold.manager().revision, 'running', true); assert.equal(cold.claimJob('j3', 1, () => true), undefined);
  const notify = { ...request('notify'), versions: cold.manager().versions };
  assert.throws(() => cold.createJob(notify), { code: 'AUDIT_EVIDENCE_NOT_CURRENT' });
  cold.createJob({ ...notify, ...commitLiveEvidence(cold, 'workspace-A') }); let notified = 0;
  const state = await computeOnce(cold, 'notify', () => true, async () => result, id => { assert.equal(cold.jobState(id)?.state, 'completed'); notified++; throw Error('non-blocking observer failure'); }, () => 0);
  assert.equal(state, 'completed'); assert.equal(notified, 1); assert.equal(cold.jobState('notify')?.receipts, 1);
});
test('问题关闭失效待发；日报唯一发生点、计划CAS和工件保护引用', t => {
  const f = fixture(t); f.start();
  f.s.openQuestion({ id: 'Q', eventKey: 'event', purpose: 'clarify', audience: 'private', boardTaskId: 'board-A', executionId: 'execution-A', versions: f.s.manager().versions });
  const req = { ...f.effect('question'), purpose: 'question' as const, questionId: 'Q' }; const id = f.s.enqueueEffect(req); f.s.closeQuestion('Q', 0, 'answered', 'native-user-answer');
  assert.equal(f.s.claimEffect('question', id.seq, 1, () => true), undefined);
  assert.equal(f.s.reserveBriefSlot('2026-11-10:plan', { localDate: '2026-11-10', kind: 'plan', sourceRefs: ['S'] }), true);
  assert.equal(f.s.reserveBriefSlot('2026-11-10:plan', { localDate: '2026-11-10', kind: 'plan', sourceRefs: ['S'] }), false);
  f.s.putPlanItem('plan', 0, { boardTaskId: 'board-A', localDate: '2026-11-10', rank: 1, reason: 'reason' }); assert.throws(() => f.s.putPlanItem('plan', 0, { boardTaskId: 'board-A', localDate: '2026-11-10', rank: 2, reason: 'stale' }));
  f.s.indexArtifact('active', fingerprint('artifact'), 10, 0); f.s.protectArtifact('active', 'open-coordination'); assert.equal(f.s.proposeArtifactArchive('active', LIMITS.archiveAgeMs + 1), false);
  assert.throws(() => f.s.recordArtifactTombstone('active', 'age', LIMITS.archiveAgeMs + 1)); assert.throws(() => f.s.indexArtifact('huge', 'hash', LIMITS.artifactBytes + 1, 0));
  assert.throws(() => f.s.reserveBriefSlot('different-key-same-occurrence', { localDate: '2026-11-10', kind: 'plan', sourceRefs: ['S'] }));
});
test('安全重试必须有未接纳证据；unknown暂停不变成可自动重发队列', t => {
  const f = fixture(t); const e = f.evaluation('safe-retry'); f.s.acceptEval('S', 1, 'r', e); f.s.beginEval(e.evalId, 0, 0);
  assert.throws(() => f.s.retryUndeliveredEval(e.evalId, 1, ''));
  f.s.pauseEval(e.evalId, 1, 10); f.s.resumeEval(e.evalId, 2, 1000); assert.equal(f.s.evalState(e.evalId)?.state, 'unavailable');
  f.s.retryUndeliveredEval(e.evalId, 3, 'native-log-proof:not-accepted'); f.s.beginEval(e.evalId, 4, 0); assert.equal(f.s.evalState(e.evalId)?.attempt, 2);
  assert.throws(() => f.s.retryUndeliveredEval(e.evalId, 5, 'another-proof'));
});
test('策略与有效业务决定CAS留痕，包/实际动态输入保持不可变', t => {
  const f = fixture(t);
  assert.throws(() => f.s.saveInput({ ref: f.evidence.inputSnapshotRef, sourceWatermark: 'different', headers: { system: '', developer: '', user: '', tools: '' } }));
  const decision = { ...f.evidence, id: 'D1', actorId: 'verified-human', sourceMessageRef: 'native:user-message:1', expectedIntent: 0, policyVersion: 1, scopeVersion: 0, stopEpoch: 0, decision: 'work on original intent' };
  assert.throws(() => f.s.appendDecision(decision)); f.s.recordVerifiedActor('verified-human', 'mapping-proof', { source: 'native', externalId: 'human-A' });
  assert.equal(f.s.appendDecision(decision), 1); assert.equal(f.s.appendDecision(decision), 1);
  assert.throws(() => f.s.appendDecision({ ...decision, decision: 'mutate history' }));
  const next = { ...decision, id: 'D2', expectedIntent: 1 };
  assert.throws(() => f.s.appendDecision({ ...next, supersedesId: 'D1' }), { code: 'AUDIT_EVIDENCE_NOT_CURRENT' });
  const refreshed = { ...next, ...commitLiveEvidence(f.s, 'workspace-A') };
  assert.throws(() => f.s.appendDecision({ ...refreshed, decision: 'implicit last message wins' }), { code: 'EXPLICIT_SUPERSESSION_REQUIRED' });
  assert.equal(f.s.appendDecision({ ...refreshed, supersedesId: 'D1', decision: 'explicitly replaces D1' }), 2);
  assert.throws(() => f.s.appendPolicy(0, policy()));
  assert.equal(f.s.manager().versions.scopeVersion, 0); assert.equal(f.s.manager().versions.stopEpoch, 0); assert.equal(f.s.manager().versions.intentRevision, 2);
});
test('Job producer失败、超时和取消迟到不泄漏名额，不信任回传claim的预算', async t => {
  const f = fixture(t); const request = (id: string): JobRequest => ({ ...f.evidence, versions: f.s.manager().versions, jobId: id, operationKey: id, kind: 'brief', budget: { deadlineMs: 10, maxTokens: 1000 } });
  f.s.createJob(request('failure')); assert.equal(await computeOnce(f.s, 'failure', () => true, async () => { throw Error('pure-compute-failure'); }, () => assert.fail('failure must not notify')), 'failed');
  assert.equal(f.s.jobState('failure')?.released, true); assert.equal(f.s.claimJob('failure', 0, () => true), undefined);
  f.s.createJob(request('timeout')); const claim = f.s.claimJob('timeout', 0, () => true)!;
  claim.request.budget.deadlineMs = 9999999;
  assert.equal(f.s.completeJob(claim, { resultRef: 'late', hash: 'hash', nativeReceiptRef: 'receipt' }, 100), false);
  assert.equal(f.s.jobState('timeout')?.state, 'interrupted');
});
test('分页数量/字符边界、候选上限与独立控制通道上限', t => {
  const f = fixture(t); const scope = () => ({ resources: ['R'], audiences: ['private'], policyVersion: f.s.manager().versions.policyVersion });
  for (let i = 0; i < 55; i++) f.s.putProjection(0, { id: String(i).padStart(3, '0'), kind: 'summary', resourceId: 'R', audience: 'private', title: 'row', aliases: [], summary: 'body', sourceRefs: [{ sourceId: 'S', revision: 1, watermark: '' }] });
  const page = f.s.search(scope, '', { limit: 50 }); assert.ok(page.items.length <= 50); assert.ok(JSON.stringify(page.items).length <= LIMITS.pageChars + 2); assert.ok(page.nextCursor);
  const more = f.s.search(scope, '', { cursor: page.nextCursor }); assert.equal(new Set([...page.items, ...more.items].map(x => x.id)).size, 55);
  assert.throws(() => f.s.search(scope, '', { limit: 51 })); assert.throws(() => f.s.search(scope, '', { cursor: 'malformed' }));
  const bad = f.evaluation('bad-candidate'); bad.candidates[0].body = 'x'.repeat(2001); const cursor = f.s.source('S'); assert.throws(() => f.s.acceptEval('S', cursor.revision, 'no', bad)); assert.deepEqual(f.s.source('S'), cursor);
  const neighbors = f.evaluation('bad-neighbors'); neighbors.candidates[0].neighbors = ['a', 'b', 'c', 'd']; assert.throws(() => f.s.acceptEval('S', cursor.revision, 'no', neighbors));
  for (let n = 0; n < 4; n++) f.s.acceptEval('S', f.s.source('S').revision, 'control:' + n, f.evaluation('control-cap:' + n, 8, true));
  const controlCursor = f.s.source('S'); assert.throws(() => f.s.acceptEval('S', controlCursor.revision, 'overflow', f.evaluation('control-overflow', 1, true))); assert.deepEqual(f.s.source('S'), controlCursor);
});
test('停止写入故障立即进入不健康拒绝链；问题关闭后的旧receipt仅审计', t => {
  const f = fixture(t); const req = f.effect('stop-fault'); const id = f.s.enqueueEffect(req);
  const db = new DatabaseSync(f.path); db.exec("CREATE TRIGGER deny_stop BEFORE UPDATE OF lifecycle ON manager_instance BEGIN SELECT RAISE(ABORT,'storage write failure'); END");
  assert.throws(() => f.s.stop(f.s.manager().revision, 'human stop')); assert.equal(f.s.diagnostics().healthy, false);
  assert.throws(() => f.s.claimEffect('stop-fault', id.seq, 1, () => true)); db.close();
  const g = fixture(t); g.s.openQuestion({ id: 'late-Q', eventKey: 'late-question-event', purpose: 'clarify', audience: 'private', boardTaskId: 'board-A', executionId: 'execution-A', versions: g.s.manager().versions });
  const q = { ...g.effect('late-question'), questionId: 'late-Q', purpose: 'question' as const }; const qi = g.s.enqueueEffect(q); const claim = g.s.claimEffect(q.effectKey, qi.seq, 1, () => true)!;
  g.s.closeQuestion('late-Q', 0, 'cancelled', 'native-human-cancel');
  assert.equal(g.s.recordEffectReceipt(claim, { nativeLogRef: 'late-accepted', accepted: true }), false); assert.equal(g.s.effectState(q.effectKey, 1)?.state, 'unknown');
});
test('线程身份按domain/source/externalKey隔离；已有恢复缺必要输入拒绝不补空', t => {
  const f = fixture(t); const e = f.evaluation('thread-A'); f.s.acceptEval('S', 1, 'A', e);
  f.s.registerSource('S2', 'different-tenant/same-thread', 'R'); const e2 = f.evaluation('thread-B'); f.s.acceptEval('S2', 1, 'B', e2);
  const db = new DatabaseSync(f.path);
  assert.equal(db.prepare('SELECT count(*) AS n FROM thread').get()!.n, 2);
  assert.equal(db.prepare("SELECT count(DISTINCT id) AS n FROM thread WHERE external_key='thread'").get()!.n, 2);
  db.exec('PRAGMA foreign_keys=OFF');
  assert.equal(db.prepare('DELETE FROM input_snapshot WHERE ref=?').run(f.evidence.inputSnapshotRef).changes, 1);
  db.close();
  f.s.close();
  const before = readFileSync(f.path);
  assert.throws(() => StewardStore.openExisting(f.path, f.identity), { code: 'CORRUPT_REFERENCES' });
  assert.deepEqual(readFileSync(f.path), before);
});



