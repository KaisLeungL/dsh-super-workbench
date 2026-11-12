import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LifecycleCoordinator } from '../../src/app/lifecycle/coordinator.js';
import { JobSupervisor, type JobResult } from '../../src/app/lifecycle/jobs.js';
import { fixture, ManualClock, deferred, flush } from './fixture.js';
import { componentInstallation } from '../f8/component.js';

test('Host容量摘要与真实Job事务组合，producer可进入且仍在准入前后检查', async t => {
  const f = fixture(t), faults: string[] = []; let capacityReads = 0, calls = 0, claimed = false, checkedAfterClaim = false;
  const capacity = () => { f.store.readHealthSummary(Date.now()); capacityReads++; if (claimed) checkedAfterClaim = true; };
  const coordinator = new LifecycleCoordinator(f.store, [],
    { pause() {}, resume() {}, cancel() {}, dispose() {} }, componentInstallation, () => {}, capacity);
  coordinator.initialize(); await coordinator.resume(f.store.manager().revision, 'trusted-host');
  f.store.createJob({ ...f.evidence, operationKey: 'host-capacity', jobId: 'host-capacity', kind: 'brief',
    versions: f.store.manager().versions, budget: { maxTokens: 1000, deadlineMs: 120_000 } });
  const jobs = new JobSupervisor(f.store, () => coordinator.lease(), () => {}, error => faults.push(String(error)));
  try {
    const before = capacityReads;
    assert.equal(await jobs.start('host-capacity', () => { claimed = true; return true; }, async () => {
      assert.ok(capacityReads > before); assert.equal(checkedAfterClaim, true); calls++;
      return { resultRef: 'capacity-result', hash: 'capacity-hash', nativeReceiptRef: 'component-only' };
    }), 'completed');
    await flush(); assert.equal(calls, 1); assert.deepEqual(faults, []);
    assert.equal(f.store.jobState('host-capacity')?.released, true);
  } finally { jobs.dispose(); coordinator.dispose(); }
});

test('F1：人工恢复await期间政策撤回，不能沿旧人工操作开放运行', async t => {
  const { store } = fixture(t), gate = deferred<void>(), entered = deferred<void>();
  const coordinator = new LifecycleCoordinator(store, [],
    { pause() {}, resume() {}, cancel() {}, dispose() {} }, async operation => { entered.resolve(); await gate.promise; return componentInstallation(operation); }, () => {});
  coordinator.initialize();
  const pending = coordinator.resume(store.manager().revision, 'trusted-owner-policy-v1');
  await entered.promise;
  store.appendPolicy(store.manager().versions.policyVersion,
    { resources: [], audiences: [], mandate: { actions: [], expiresAt: 0 }, proofRef: 'host-revoked-during-await' });
  gate.resolve();
  await assert.rejects(pending);
  assert.equal(store.manager().lifecycle, 'paused');
  assert.equal(coordinator.status().accepting, false); coordinator.dispose();
});
test('F2：取消已释放持久槽但producer未退出，实际计算最多2个', async t => {
  const f = fixture(t), clock = new ManualClock(), abort = new AbortController(); f.start();
  const works = [deferred<JobResult>(), deferred<JobResult>(), deferred<JobResult>()];
  let calls = 0;
  const supervisor = new JobSupervisor(f.store,
    () => ({ signal: abort.signal, assertCurrent() { abort.signal.throwIfAborted(); } }),
    () => { throw Error('不得通知晚到结果'); }, () => {}, clock);
  for (let n=0;n<3;n++) f.store.createJob({ ...f.evidence, operationKey: 'op'+n, jobId: 'job'+n, kind: 'brief',
    versions: f.store.manager().versions, budget: { maxTokens: 1000, deadlineMs: 120_000 } });
  for (let n=0;n<2;n++) {
    const pending = supervisor.start('job'+n, () => true, () => { calls++; return works[n].promise; });
    supervisor.cancel('job'+n, '请求取消但producer忽略signal');
    assert.equal(await pending, 'cancelled');
    assert.equal(f.store.jobState('job'+n)?.released, true);
  }
  const third = supervisor.start('job2', () => true, () => { calls++; return works[2].promise; });
  // 先保留可重现的状态，再结清所有测试producer，避免反例本身留下异步句柄。
  const observed = { calls, pendingResults: supervisor.handles().pendingResults };
  supervisor.cancelAll('测试结束');
  for (let n=0;n<3;n++) works[n].resolve({ resultRef: 'late'+n, hash: 'sha'+n, nativeReceiptRef: 'native'+n });
  await flush(); supervisor.dispose();
  assert.equal(observed.calls, 2);
  assert.equal(observed.pendingResults, 2);
  assert.equal(await third, 'blocked');
});
test('F3：同进程重新装配supervisor，未退出producer仍共用部署的两个名额', async t => {
  const f = fixture(t); f.start();
  const works = [deferred<JobResult>(), deferred<JobResult>(), deferred<JobResult>()];
  const supervisors: JobSupervisor[] = [], outcomes: string[] = [], faults: string[] = [];
  let calls = 0;
  try {
    for (let n = 0; n < 3; n++) {
      f.store.createJob({ ...f.evidence, operationKey: 'rebind-op' + n, jobId: 'rebind-job' + n, kind: 'brief',
        versions: f.store.manager().versions, budget: { maxTokens: 1000, deadlineMs: 120_000 } });
      // 查询串重新求值模块，模拟同进程插件重装；共享的仅是尚未退出的计算占用。
      const { JobSupervisor: Reloaded } = await import(new URL('../../src/app/lifecycle/jobs.js?rebind=' + n, import.meta.url).href);
      const signal = new AbortController().signal;
      const supervisor = new Reloaded(f.store, () => ({ signal, assertCurrent() { signal.throwIfAborted(); } }),
        () => { throw Error('晚到不得通知'); }, (error: unknown) => faults.push(String(error)), new ManualClock()) as JobSupervisor;
      supervisors.push(supervisor);
      const pending = supervisor.start('rebind-job' + n, () => true, () => { calls++; return works[n]!.promise; });
      supervisor.dispose(); outcomes.push(await pending);
    }
    writeFileSync(join(process.env.B04_RUN_DIR!, 'F3-rebind-observations.json'), JSON.stringify({
      calls, outcomes, handles: supervisors.map(supervisor => supervisor.handles()),
      states: works.map((_, n) => f.store.jobState('rebind-job' + n)), level: '真实SQLite与schema2组件审计事件夹具',
    }, null, 2) + '\n');
    assert.equal(calls, 2);
    assert.deepEqual(outcomes, ['cancelled', 'cancelled', 'blocked']);
    assert.equal(f.store.jobState('rebind-job2')?.state, 'queued');
    assert.equal(supervisors[2]!.handles().pendingResults, 2);
  } finally {
    supervisors.forEach(supervisor => supervisor.dispose());
    works.forEach((work, n) => work.resolve({ resultRef: 'late-rebind-' + n, hash: 'hash-' + n, nativeReceiptRef: 'component-' + n }));
    await new Promise<void>(resolve => setImmediate(resolve));
    writeFileSync(join(process.env.B04_RUN_DIR!, 'F3-rebind-cleanup.json'), JSON.stringify({
      handles: supervisors.map(supervisor => supervisor.handles()), faults,
    }, null, 2) + '\n');
    assert.ok(supervisors.every(supervisor => supervisor.handles().pendingResults === 0));
    assert.deepEqual(faults, []);
  }
});
