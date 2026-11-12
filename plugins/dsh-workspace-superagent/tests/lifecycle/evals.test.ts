import test from 'node:test';
import assert from 'node:assert/strict';
import { EvalDeadlines, selectEvalBatch, type EvalState } from '../../src/app/lifecycle/evals.js';
import { fixture, ManualClock } from './fixture.js';
import type { EvalRequest } from '../../src/storage/types.js';
function evaluation(f: ReturnType<typeof fixture>, id: string, count = 1, control = false): EvalRequest {
  return { ...f.evidence, evalId: id, versions: f.store.manager().versions,
    candidates: Array.from({ length: count }, (_, n) => ({ triggerId: id+':t'+n, externalEventId: id+':e'+n,
      triggerRevision: 1, resourceId: 'R', threadKey: id, body: '候选', neighbors: [], payloadRef: f.input.ref, payloadHash: f.input.hash })),
    control, queuedAt: 1000 };
}
test('Eval只按投递回执计时，暂停冻结剩余，再恢复精确到期', t => {
  const f = fixture(t), clock = new ManualClock(); f.start();
  const lease = () => ({ signal: new AbortController().signal, assertCurrent() {} });
  const evals = new EvalDeadlines(f.store, lease, error => { throw error; }, clock);
  f.store.acceptEval('S', f.store.source('S').revision, 'cursor', evaluation(f, 'A'));
  evals.resume(); assert.equal(evals.begin('A', 0), true); assert.equal(evals.handles(), 0);
  evals.delivered('A', 1, { nativeLogRef: 'component-native-delivery', deliveredAt: clock.now(), basis: 'native-log' });
  clock.advance(20_000); evals.pause();
  assert.equal(f.store.evalState('A')!.remaining, 40_000); assert.equal(evals.handles(), 0);
  clock.advance(100_000); assert.equal(f.store.evalState('A')!.state, 'paused');
  evals.resume(); clock.advance(39_999); assert.equal(f.store.evalState('A')!.state, 'delivered');
  clock.advance(1); assert.equal(f.store.evalState('A')!.state, 'unavailable');
  evals.dispose(); assert.equal(clock.callbacks.size, 0);
});
test('投递unknown不自动重发', t => {
  const f = fixture(t), clock = new ManualClock(); f.start();
  const evals = new EvalDeadlines(f.store, () => ({ signal: new AbortController().signal, assertCurrent() {} }), () => {}, clock);
  f.store.acceptEval('S', f.store.source('S').revision, 'cursor', evaluation(f, 'unknown'));
  evals.resume(); evals.begin('unknown', 0); evals.pause(); evals.resume();
  assert.equal(f.store.evalState('unknown')!.state, 'unavailable');
  assert.equal(f.store.evalState('unknown')!.attempt, 1);
  evals.dispose();
});
test('普通队列到限拒收且不推进来源游标，控制预留仍可用', t => {
  const f = fixture(t); f.start();
  for (let n=0;n<32;n++) f.store.acceptEval('S', f.store.source('S').revision, 'cursor'+n, evaluation(f, 'normal'+n, 8));
  const before = f.store.source('S');
  assert.throws(() => f.store.acceptEval('S', before.revision, 'must-not-advance', evaluation(f, 'overflow')), /QUEUE_CAPACITY/);
  assert.deepEqual(f.store.source('S'), before);
  f.store.acceptEval('S', before.revision, 'control-cursor', evaluation(f, 'control', 1, true));
  const summary = f.store.readHealthSummary(1000);
  assert.equal(summary.queues.normal.items, 256); assert.equal(summary.queues.control.items, 1);
});
test('控制队列字节到限先于项数，拒收不推进来源游标', t => {
  const f = fixture(t); f.start(); let rejected = false, accepted = 0;
  for (let n = 0; n < 32; n++) {
    const request = evaluation(f, 'control-bytes-' + n, 1, true);
    request.candidates[0]!.body = '界'.repeat(2000);
    request.candidates[0]!.neighbors = Array.from({ length: 3 }, () => '界'.repeat(2000));
    const before = f.store.source('S');
    try { f.store.acceptEval('S', before.revision, 'byte-cursor-' + n, request); accepted++; }
    catch (error) {
      assert.match(String(error), /QUEUE_CAPACITY/); assert.deepEqual(f.store.source('S'), before); rejected = true; break;
    }
  }
  assert.equal(rejected, true); assert.ok(accepted > 0 && accepted < 32);
  const summary = f.store.readHealthSummary(1000);
  assert.equal(summary.queues.control.items, accepted); assert.ok(summary.queues.control.bytes <= 256 * 1024);
});

test('Eval摘要截断时拒绝恢复与暂停写入，不留下定时器', t => {
  const f = fixture(t), clock = new ManualClock(); f.start();
  f.store.acceptEval('S', f.store.source('S').revision, 'cursor', evaluation(f, 'truncated'));
  const before = f.store.evalState('truncated');
  const port = {
    evalState: f.store.evalState.bind(f.store), pauseEval: f.store.pauseEval.bind(f.store),
    resumeEval: f.store.resumeEval.bind(f.store), expireEval: f.store.expireEval.bind(f.store),
    beginEval: f.store.beginEval.bind(f.store), recordEvalDelivery: f.store.recordEvalDelivery.bind(f.store),
    readHealthSummary(now: number) { const summary = f.store.readHealthSummary(now); return { ...summary, evals: { ...summary.evals, truncated: true } }; },
  };
  const evals = new EvalDeadlines(port, () => ({ signal: new AbortController().signal, assertCurrent() {} }), () => {}, clock);
  assert.throws(() => evals.resume(), /EVAL_SCAN_TRUNCATED/);
  assert.throws(() => evals.pause(), /EVAL_SCAN_TRUNCATED/);
  assert.deepEqual(f.store.evalState('truncated'), before); assert.equal(evals.begin('truncated', 0), false);
  evals.dispose(); assert.equal(evals.handles(), 0); assert.equal(clock.callbacks.size, 0);
});

test('控制优先、batch有界、Thread轮转和年龄提升只选择元数据', () => {
  const state = (id: string, thread: string, queuedAt: number, control = false): EvalState =>
    ({ id, revision: 0, state: 'queued', attempt: 0, control, queuedAt, deadline: null, remainingMs: 60000, deadlineBasis: null, threadKeys: [thread] });
  const items = [state('control','control',1000,true),state('cold','cold',1000),
    ...Array.from({length:20},(_,n)=>state('hot'+n,'hot',1000))];
  const chosen = selectEvalBatch(items, 2000, 'hot');
  assert.equal(chosen.length,8); assert.equal(chosen[0].id,'control'); assert.equal(chosen[1].id,'cold');
  assert.equal(items.length,22);
  const aged = selectEvalBatch([...items,state('aged','z',0)],550000);
  assert.equal(aged[1].id,'aged');
});
