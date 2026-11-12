import test from 'node:test';
import assert from 'node:assert/strict';
import { bindLifecyclePolicy } from '../../src/app/lifecycle/host.js';
import { BatchWindow } from '../../src/app/lifecycle/batch.js';
import { ManualClock } from './fixture.js';
test('Host policy装配绑定实例nonce与generation，不复制或扩大原权限', () => {
  let lifecycle: { generation: number } | undefined;
  const policy = { revision: 'trusted-1', backend: 'native' as const, resources: ['R'], audiences: ['private'],
    tools: ['steward_read_task'], actions: ['read'], maxTokens: 1000 };
  const first = bindLifecyclePolicy(() => policy, () => lifecycle);
  assert.throws(() => first(undefined), /LIFECYCLE_NOT_READY/);
  lifecycle = { generation: 0 };
  const before = first(undefined);
  assert.deepEqual({ ...before, revision: policy.revision }, policy);
  assert.equal(before.resources, policy.resources);
  lifecycle.generation++; const paused = first(undefined);
  lifecycle.generation++; const resumed = first(undefined);
  assert.notEqual(before.revision, paused.revision); assert.notEqual(before.revision, resumed.revision);
  const other = bindLifecyclePolicy(() => policy, () => ({ generation: 0 }));
  assert.notEqual(before.revision, other(undefined).revision);
  policy.resources = []; policy.revision = 'trusted-2';
  assert.deepEqual(first(undefined).resources, []);
});
test('batch最长250ms，控制即时唤醒，暂停清除自有计时器', () => {
  const clock = new ManualClock(), abort = new AbortController(); let wakes = 0;
  const window = new BatchWindow(() => ({ signal: abort.signal, assertCurrent() { abort.signal.throwIfAborted(); } }), () => { wakes++; }, clock);
  for (let n=0;n<100;n++) window.request();
  assert.equal(window.handles(),1); clock.advance(249); assert.equal(wakes,0);
  window.request(true); assert.equal(wakes,1); assert.equal(window.handles(),0);
  clock.advance(1); assert.equal(wakes,1);
  window.request(); clock.advance(250); assert.equal(wakes,2);
  window.request(); window.clear(); abort.abort(); assert.throws(() => window.request());
  window.dispose(); assert.equal(clock.callbacks.size,0);
});
