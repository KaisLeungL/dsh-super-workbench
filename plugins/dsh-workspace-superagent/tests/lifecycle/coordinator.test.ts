import test from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleCoordinator } from '../../src/app/lifecycle/coordinator.js';
import { fixture, deferred } from './fixture.js';
import { componentInstallation } from '../f8/component.js';

test('冷启动暂停、显式恢复、旧lease永不复活、停止保留Session', async t => {
  const { store } = fixture(t); let disposed = 0;
  const dependency = {};
  const coordinator = new LifecycleCoordinator(store,
    [{ name: 'native', current: () => dependency, accepts: v => v === dependency }],
    { pause() {}, resume() {}, cancel() {}, dispose() {} },
    componentInstallation, () => { disposed++; });
  coordinator.initialize();
  assert.equal(store.manager().lifecycle, 'paused'); assert.throws(() => coordinator.lease());
  await coordinator.resume(store.manager().revision, 'trusted-browser-owner');
  const first = coordinator.lease();
  coordinator.pause(); assert.throws(first.assertCurrent); assert.equal(store.manager().lifecycle, 'paused');
  await coordinator.resume(store.manager().revision, 'trusted-browser-owner');
  assert.throws(first.assertCurrent); coordinator.lease().assertCurrent();
  const sessionId = store.manager().sessionId;
  coordinator.stop(); const epoch = store.manager().versions.stopEpoch;
  coordinator.stop(); assert.equal(store.manager().versions.stopEpoch, epoch);
  assert.equal(store.manager().sessionId, sessionId);
  await coordinator.dispose(); await coordinator.dispose(); assert.equal(disposed, 1);
});
test('依赖换代同步拒旧lease，重绑不自动恢复；Cordis代理原身份稳定', async t => {
  const { store } = fixture(t);
  let dependency = {}, count = 0;
  const original = Symbol.for('cordis.original');
  const coordinator = new LifecycleCoordinator(store,
    [{ name: 'native', current: () => ({ [original]: dependency }), accepts: Boolean }],
    { pause() { count++; }, resume() {}, cancel() {}, dispose() {} }, componentInstallation, () => {});
  coordinator.initialize(); await coordinator.resume(store.manager().revision, 'owner');
  const lease = coordinator.lease(); lease.assertCurrent();
  dependency = {}; assert.throws(lease.assertCurrent);
  assert.equal(store.manager().lifecycle, 'paused'); assert.equal(coordinator.status().accepting, false);
  await coordinator.resume(store.manager().revision, 'owner');
  coordinator.lease().assertCurrent(); assert.ok(count >= 2); coordinator.dispose();
});
test('恢复await期间暂停、依赖变更和重复点击都不能迟到开放', async t => {
  const { store } = fixture(t), gate = deferred<void>(); let dependency: object | undefined = {};
  const coordinator = new LifecycleCoordinator(store,
    [{ name: 'native', current: () => dependency, accepts: Boolean }],
    { pause() {}, resume() {}, cancel() {}, dispose() {} }, async operation => { await gate.promise; return componentInstallation(operation); }, () => {});
  coordinator.initialize();
  const pending = coordinator.resume(store.manager().revision, 'owner');
  await assert.rejects(coordinator.resume(store.manager().revision, 'owner'), /CONTROL_BUSY/);
  dependency = undefined; coordinator.pause(); gate.resolve();
  await assert.rejects(pending);
  assert.equal(store.manager().lifecycle, 'paused'); assert.throws(() => coordinator.lease());
  coordinator.dispose();
});
test('持久暂停失败仍同步关闭新准入并取消自有计算', async t => {
  const { store } = fixture(t); let cancel = 0;
  const coordinator = new LifecycleCoordinator(store, [],
    { pause() {}, resume() {}, cancel() { cancel++; }, dispose() {} }, componentInstallation, () => {});
  coordinator.initialize(); await coordinator.resume(store.manager().revision, 'owner');
  const lease = coordinator.lease(), original = store.recordLifecycle.bind(store);
  store.recordLifecycle = () => { throw Error('test-write-failure'); };
  assert.throws(() => coordinator.pause(), /test-write-failure/);
  assert.throws(lease.assertCurrent); assert.equal(cancel, 1);
  store.recordLifecycle = original; coordinator.dispose();
});
