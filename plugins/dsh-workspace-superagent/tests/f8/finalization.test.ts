import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StewardStore } from '../../src/storage/store.js';
import { LifecycleCoordinator } from '../../src/app/lifecycle/coordinator.js';
import { InstallationOperation } from '../../src/sessions/installation.js';

for (const kind of ['normal', 'pause', 'dispose', 'both', 'runtime']) test('Coordinator 最早错误仍等待真实清理 gate：' + kind, async t => {
  const dir = process.env.F84_TEST_ROOT!; assert.ok(dir?.includes('/b04-f8-product/')); mkdirSync(dir, { recursive: true });
  const store = StewardStore.initializeFresh(resolve(dir, randomUUID() + '.sqlite'), { instanceId: randomUUID(), domainId: 'finalization-adapter' });
  t.after(() => store.close());
  let release!: () => void, enter!: () => void; const gate = new Promise<void>(ok => { release = ok; }), entered = new Promise<void>(ok => { enter = ok; });
  const pauseFailure = Error('PAUSE_FAILURE'), disposeFailure = Error('RESOURCE_DISPOSE_FAILURE'), runtimeFailure = Error('RUNTIME_FAILURE');
  let armed = false, settled = false, runtimeSettled = false, resourceCalls = 0, runtimeCalls = 0;
  const coordinator = new LifecycleCoordinator(store, [], {
    pause() { if (armed && ['pause', 'both'].includes(kind)) throw pauseFailure; }, resume() {}, cancel() {},
    dispose() { resourceCalls++; if (['dispose', 'both'].includes(kind)) throw disposeFailure; },
  }, async () => { throw Error('UNEXPECTED_INSTALL'); }, async () => {
    runtimeCalls++; enter(); await gate; runtimeSettled = true; if (kind === 'runtime') throw runtimeFailure;
  });
  coordinator.initialize(); armed = true;
  const first = coordinator.dispose('detach'); first.then(() => { settled = true; }, () => { settled = true; });
  assert.equal(first, coordinator.dispose('detach')); await entered;
  assert.equal(settled, false); assert.equal(runtimeSettled, false); assert.equal(coordinator.status().accepting, false);
  release();
  if (kind === 'normal') await first;
  else await assert.rejects(first, error => kind === 'both'
    ? error instanceof AggregateError && error.errors.length === 2 && error.errors.includes(pauseFailure) && error.errors.includes(disposeFailure)
    : error === ({ pause: pauseFailure, dispose: disposeFailure, runtime: runtimeFailure } as Record<string, Error>)[kind]);
  assert.equal(runtimeSettled, true); assert.equal(resourceCalls, 1); assert.equal(runtimeCalls, 1);
});
test('安装取消的全部自有清理尽力执行，首次 Promise 等 gate 后聚合错误', async t => {
  const dir = process.env.F84_TEST_ROOT!, store = StewardStore.initializeFresh(resolve(dir, randomUUID() + '.sqlite'), { instanceId: randomUUID(), domainId: 'finalization-adapter' });
  t.after(() => store.close());
  const operation = new InstallationOperation(store, new AbortController().signal, () => {});
  let release!: () => void; const gate = new Promise<void>(ok => { release = ok; }); const a = Error('A'), b = Error('B'); const calls: string[] = [];
  operation.onFailure(async () => { calls.push('a'); throw a; });
  operation.onFailure(async () => { calls.push('b'); await gate; throw b; });
  const first = operation.cancel(); assert.equal(first, operation.cancel()); let settled = false; first.catch(() => { settled = true; });
  await Promise.resolve(); assert.deepEqual(calls, ['b']); assert.equal(settled, false); release();
  await assert.rejects(first, error => error instanceof AggregateError && error.errors.length === 2 && error.errors.includes(a) && error.errors.includes(b));
  assert.deepEqual(calls, ['b', 'a']);
});
// 本组只验证真实 Store/Installation/Coordinator 与受控资源适配器；不称原生 Host。
for (const kind of ['original', 'pause', 'cleanup', 'both']) test('恢复安装拒绝始终等待取消 gate 并保留全部错误：' + kind, async t => {
  const dir = process.env.F84_TEST_ROOT!; assert.ok(dir?.includes('/b04-f8-product/')); mkdirSync(dir, { recursive: true });
  const store = StewardStore.initializeFresh(resolve(dir, randomUUID() + '.sqlite'), { instanceId: randomUUID(), domainId: 'resume-finalization-adapter' });
  const original = Error('INSTALL_FAILURE'), pauseFailure = Error('FAILURE_PAUSE'), cleanupFailure = Error('CANCEL_CLEANUP_FAILURE');
  let release!: () => void, enter!: () => void; const gate = new Promise<void>(ok => { release = ok; }), entered = new Promise<void>(ok => { enter = ok; });
  let armed = false, settled = false, cleanupEntered = false, cleanupSettled = false, releases = 0, publications = 0, resumeCalls = 0;
  let captured = store.manager(); const signal = new AbortController().signal;
  const coordinator = new LifecycleCoordinator(store, [], {
    pause() { if (armed && ['pause', 'both'].includes(kind)) throw pauseFailure; },
    resume() { resumeCalls++; }, cancel() {}, dispose() {},
  }, async operation => {
    const id = 'resume-refusal-' + randomUUID();
    operation.reserve(id, 'W', 'workspace-superagent-router'); operation.beginCreate();
    operation.bind({ sessionId: id, workspaceId: 'W', preset: 'workspace-superagent-router', nativeLogRef: 'fixture-log' });
    operation.onFailure(async () => { releases++; });
    operation.onFailure(async () => { cleanupEntered = true; enter(); await gate; cleanupSettled = true; if (['cleanup', 'both'].includes(kind)) throw cleanupFailure; });
    captured = store.manager(); armed = true; throw original;
  }, () => {});
  coordinator.initialize(); coordinator.subscribe(() => { publications++; assert.equal(cleanupSettled, true); });
  const pending = coordinator.resume(store.manager().revision, 'trusted-fixture', { signal, assertCurrent() {} });
  const outcome = pending.then(() => { settled = true; }, error => { settled = true; return error; });
  t.after(async () => { release(); await outcome; store.close(); });
  await Promise.race([entered, outcome]);
  assert.equal(cleanupEntered, true); assert.equal(settled, false); assert.equal(releases, 0); assert.equal(publications, 0);
  assert.equal(coordinator.status().accepting, false);
  await assert.rejects(coordinator.resume(store.manager().revision, 'reentry'), error => error instanceof Error && error.message === 'CONTROL_BUSY');
  release(); const error = await outcome;
  const expected = [original, ...(['pause', 'both'].includes(kind) ? [pauseFailure] : []), ...(['cleanup', 'both'].includes(kind) ? [cleanupFailure] : [])];
  if (expected.length === 1) assert.equal(error, original);
  else { assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, expected); }
  assert.equal(cleanupSettled, true); assert.equal(releases, 1); assert.equal(publications, 1); assert.equal(resumeCalls, 0);
  assert.equal(signal.aborted, false); assert.deepEqual(store.manager(), captured);
});
for (const failPause of [false, true]) test('恢复失败补偿 Store 抛错仍调用取消并保留原错误：' + failPause, async t => {
  const dir = process.env.F84_TEST_ROOT!; mkdirSync(dir, { recursive: true });
  const store = StewardStore.initializeFresh(resolve(dir, randomUUID() + '.sqlite'), { instanceId: randomUUID(), domainId: 'resume-compensation-adapter' });
  const original = Error('RESOURCE_RESUME_FAILURE'), storeFailure = Error('COMPENSATION_STORE_FAILURE'), pauseFailure = Error('FAILURE_PAUSE');
  let armed = false, cancelCalls = 0, publications = 0; const publication = { ready: false };
  const record = store.recordLifecycle.bind(store);
  store.recordLifecycle = (revision, lifecycle, pin) => { if (armed && lifecycle === 'paused') throw storeFailure; return record(revision, lifecycle, pin); };
  t.after(() => { store.recordLifecycle = record; store.close(); });
  const coordinator = new LifecycleCoordinator(store, [], {
    pause() { if (armed && failPause) throw pauseFailure; }, resume() { armed = true; throw original; }, cancel() {}, dispose() {},
  }, async operation => {
    const id = 'resume-compensation-' + randomUUID();
    operation.reserve(id, 'W', 'workspace-superagent-router'); operation.beginCreate();
    operation.bind({ sessionId: id, workspaceId: 'W', preset: 'workspace-superagent-router', nativeLogRef: 'fixture-log' });
    const cancel = operation.cancel.bind(operation); operation.cancel = () => { cancelCalls++; return cancel(); };
    return operation.stage(publication, () => {});
  }, () => {});
  coordinator.initialize(); coordinator.subscribe(() => { publications++; assert.equal(cancelCalls, 1); });
  await assert.rejects(coordinator.resume(store.manager().revision, 'trusted-fixture'), error => error instanceof AggregateError &&
    error.errors.length === (failPause ? 3 : 2) && error.errors[0] === original && error.errors.includes(storeFailure) && (!failPause || error.errors.includes(pauseFailure)));
  assert.equal(cancelCalls, 1); assert.equal(publications, 1); assert.equal(publication.ready, false); assert.equal(coordinator.status().accepting, false);
  assert.equal(store.manager().lifecycle, 'running'); assert.equal(store.manager().bindingState, 'bound'); assert.ok(store.manager().sessionId);
});
