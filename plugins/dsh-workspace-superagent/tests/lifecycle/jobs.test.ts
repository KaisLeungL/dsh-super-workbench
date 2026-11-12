import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { JobSupervisor, type JobResult } from '../../src/app/lifecycle/jobs.js';
import { fixture, ManualClock, deferred, flush } from './fixture.js';

test('SQLite恢复将已认领Job记为中断且仅释放一次，不假称进程退出', t => {
  const f = fixture(t); f.start();
  f.store.createJob({ ...f.evidence, operationKey: 'restart-op', jobId: 'restart-job', kind: 'brief',
    versions: f.store.manager().versions, budget: { maxTokens: 1000, deadlineMs: 120_000 } });
  const claim = f.store.claimJob('restart-job', 1000, () => true); assert.ok(claim);
  assert.equal(f.store.jobState('restart-job')?.released, false);
  assert.deepEqual(f.store.recover().interruptedJobs, ['restart-job']);
  const interrupted = f.store.jobState('restart-job');
  assert.equal(interrupted?.state, 'interrupted'); assert.equal(interrupted?.released, true);
  assert.equal(f.store.manager().lifecycle, 'paused'); assert.equal(f.store.readHealthSummary(1000).jobs.occupied, 0);
  assert.deepEqual(f.store.recover().interruptedJobs, []);
  assert.deepEqual(f.store.jobState('restart-job'), interrupted);
  const result = { resultRef: 'restart-late', hash: 'restart-hash', nativeReceiptRef: 'component-late' };
  assert.equal(f.store.completeJob(claim, result, 2000), false);
  assert.equal(f.store.completeJob(claim, result, 2000), false);
  assert.equal(f.store.jobState('restart-job')?.receipts, 1);
  assert.equal(f.store.jobState('restart-job')?.state, 'interrupted');
});

for (const outcome of ['completed', 'failed', 'cancelled', 'timeout'] as const) {
  test('Job '+outcome+'真实SQLite释放一次，迟到不当前通知', async t => {
    const f = fixture(t), clock = new ManualClock(), abort = new AbortController();
    f.start(); let notifications = 0, released = false, signal!: AbortSignal;
    f.store.createJob({ ...f.evidence, operationKey: 'op', jobId: 'job', kind: 'brief',
      versions: f.store.manager().versions, budget: { maxTokens: 1000, deadlineMs: 120_000 } });
    const work = deferred<JobResult>();
    const supervisor = new JobSupervisor(f.store,
      () => ({ signal: abort.signal, assertCurrent() { abort.signal.throwIfAborted(); } }),
      () => { notifications++; }, error => { throw error; }, clock);
    const pending = supervisor.start('job', () => true, async (_request, context) => {
      signal = context.signal; assert.equal(context.deadline, clock.now()+120_000); return work.promise;
    });
    assert.equal(f.store.jobState('job')?.released, false);
    assert.equal(await supervisor.start('job', () => true, async () => { throw Error('不得重复'); }), 'blocked');
    if (outcome === 'completed') work.resolve({ resultRef: 'result', hash: 'sha', nativeReceiptRef: 'native-result' });
    if (outcome === 'failed') work.reject(Error('producer failure'));
    if (outcome === 'cancelled') { supervisor.cancel('job', '人工取消'); assert.equal(signal.aborted, true); }
    if (outcome === 'timeout') { clock.advance(120_000); assert.equal(signal.aborted, true); }
    assert.equal(await pending, outcome);
    released = f.store.jobState('job')!.released; assert.equal(released, true);
    const generation = f.store.jobState('job')!.cancelGeneration;
    supervisor.cancelAll('再次取消'); assert.equal(f.store.jobState('job')!.cancelGeneration, generation);
    if (outcome === 'cancelled' || outcome === 'timeout') {
      work.resolve({ resultRef: 'late', hash: 'sha-late', nativeReceiptRef: 'native-late' }); await flush();
      assert.equal(f.store.jobState('job')!.receipts, 1); assert.equal(notifications, 0);
    } else { assert.equal(notifications, outcome === 'completed' ? 1 : 0); }
    supervisor.dispose(); await flush();
    assert.deepEqual(supervisor.handles(), { running: 0, timers: 0, pendingResults: 0 });
    assert.equal(clock.callbacks.size, 0);
  });
}
test('暂停signal取消与实际两名额；第三个拒绝，跨await授权失效不通知', async t => {
  const f = fixture(t), clock = new ManualClock(), abort = new AbortController(); f.start();
  let authorized = true, notifications = 0;
  const works = [deferred<JobResult>(), deferred<JobResult>()];
  for (let n=0;n<3;n++) f.store.createJob({ ...f.evidence, operationKey: 'op'+n, jobId: 'j'+n, kind: 'scan',
    versions: f.store.manager().versions, budget: { maxTokens: 1000, deadlineMs: 120_000 } });
  const supervisor = new JobSupervisor(f.store,
    () => ({ signal: abort.signal, assertCurrent() { abort.signal.throwIfAborted(); } }),
    () => notifications++, error => { throw error; }, clock);
  const a = supervisor.start('j0', () => authorized, () => works[0].promise);
  const b = supervisor.start('j1', () => authorized, () => works[1].promise);
  assert.equal(await supervisor.start('j2', () => true, async () => ({ resultRef: 'bad', hash: 'bad', nativeReceiptRef: 'bad' })), 'blocked');
  authorized = false; works[0].resolve({ resultRef: 'late', hash: 'sha', nativeReceiptRef: 'native' });
  assert.equal(await a, 'cancelled'); assert.equal(notifications, 0);
  abort.abort(); assert.equal(await b, 'cancelled');
  works[1].resolve({ resultRef: 'late2', hash: 'sha2', nativeReceiptRef: 'native2' }); await flush();
  supervisor.dispose(); assert.equal(supervisor.handles().running, 0);
});
test('F3边界：不同domain或instance不共享物理名额', async t => {
  const identity = { domainId: randomUUID(), instanceId: randomUUID() };
  const fixtures = [fixture(t, identity), fixture(t, { ...identity, domainId: randomUUID() }),
    fixture(t, { ...identity, instanceId: randomUUID() })];
  const supervisors = fixtures.map(f => new JobSupervisor(f.store,
    () => ({ signal: new AbortController().signal, assertCurrent() {} }), () => {}, error => { throw error; }, new ManualClock()));
  const works = Array.from({ length: 4 }, () => deferred<JobResult>());
  const outcomes: Promise<string>[] = [];
  let calls = 0;
  try {
    for (const f of fixtures) f.start();
    for (let n = 0; n < 4; n++) {
      const index = n < 2 ? 0 : n - 1, f = fixtures[index]!;
      f.store.createJob({ ...f.evidence, operationKey: 'isolation-op' + n, jobId: 'isolation-job' + n, kind: 'scan',
        versions: f.store.manager().versions, budget: { maxTokens: 1000, deadlineMs: 120_000 } });
      outcomes.push(supervisors[index]!.start('isolation-job' + n, () => true, () => { calls++; return works[n]!.promise; }));
    }
    assert.equal(calls, 4);
    assert.deepEqual(supervisors.map(supervisor => supervisor.handles().pendingResults), [2, 1, 1]);
  } finally {
    supervisors.forEach(supervisor => supervisor.dispose());
    works.forEach((work, n) => work.resolve({ resultRef: 'isolated-' + n, hash: 'hash-' + n, nativeReceiptRef: 'component-' + n }));
    await Promise.all(outcomes); await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(supervisors.every(supervisor => supervisor.handles().pendingResults === 0));
  }
});
test('F3边界：失败claim回收预占，同job跨实例拒，真settle后才重开', async t => {
  const f = fixture(t); f.start();
  for (let n = 0; n < 3; n++) f.store.createJob({ ...f.evidence, operationKey: 'reuse-op' + n, jobId: 'reuse-job' + n, kind: 'scan',
    versions: f.store.manager().versions, budget: { maxTokens: 1000, deadlineMs: 120_000 } });
  const supervisors = Array.from({ length: 3 }, () => new JobSupervisor(f.store,
    () => ({ signal: new AbortController().signal, assertCurrent() {} }), () => {}, error => { throw error; }, new ManualClock()));
  const works = [deferred<JobResult>(), deferred<JobResult>()];
  let calls = 0;
  const result = { resultRef: 'result', hash: 'hash', nativeReceiptRef: 'component' };
  try {
    assert.equal(await supervisors[0]!.start('missing', () => true, async () => result), 'blocked');
    assert.throws(() => supervisors[0]!.start('reuse-job0', () => false, async () => result), /CURRENT_AUTHORITY_REQUIRED/);
    assert.throws(() => supervisors[0]!.start('reuse-job0', () => { throw Error('claim失败'); }, async () => result), /claim失败/);
    assert.equal(supervisors[0]!.handles().pendingResults, 0);
    const first = supervisors[0]!.start('reuse-job0', () => true, () => { calls++; return works[0]!.promise; });
    supervisors[0]!.dispose(); assert.equal(await first, 'cancelled');
    assert.equal(await supervisors[1]!.start('reuse-job0', () => true, async () => { calls++; return result; }), 'blocked');
    const second = supervisors[1]!.start('reuse-job1', () => true, () => { calls++; return works[1]!.promise; });
    supervisors[1]!.dispose(); assert.equal(await second, 'cancelled');
    assert.equal(await supervisors[2]!.start('reuse-job2', () => true, async () => { calls++; return result; }), 'blocked');
    assert.equal(calls, 2); assert.equal(supervisors[2]!.handles().pendingResults, 2);
    works[0]!.resolve(result); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(supervisors[2]!.handles().pendingResults, 1);
    assert.equal(await supervisors[2]!.start('reuse-job2', () => true, async () => { calls++; return result; }), 'completed');
    assert.equal(calls, 3);
  } finally {
    supervisors.forEach(supervisor => supervisor.dispose()); works.forEach(work => work.resolve(result));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(supervisors.every(supervisor => supervisor.handles().pendingResults === 0));
  }
});
