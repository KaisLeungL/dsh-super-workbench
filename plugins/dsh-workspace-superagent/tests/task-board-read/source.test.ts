import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskBoardReadAdapter } from '../../src/adapters/task-board/read/source.js';
import { NativeFixture, rawTask } from './fixture.js';
test('原生仅白名单、项目undefined/null分开，重复bind不叠监听，dispose清全部', () => {
  const native = new NativeFixture(); native.rows = [rawTask('fallback', { projectId: undefined }), rawTask('none', { projectId: null })];
  const source = new TaskBoardReadAdapter(() => native); source.bind(); source.bind();
  const capture = source.capture();
  assert.deepEqual(capture.tasks.map(row => row.resolvedProjectId), ['A', null]);
  assert.equal(JSON.stringify(capture).includes('SECRET'), false);
  assert.equal(native.listeners.size, 1); assert.equal(native.deletions.size, 1);
  source.dispose(); assert.equal(native.listeners.size, 0); assert.equal(native.deletions.size, 0); assert.equal(native.extensions.size, 0); assert.equal(native.writes, 0);
});
test('旧face仍能snapshot时也拒断连，重启epoch变化，替换face需显式重绑', () => {
  const first = new NativeFixture(); let current: NativeFixture | undefined = first;
  const source = new TaskBoardReadAdapter(() => current); source.bind(); const before = source.capture();
  first.setEnabled(false); assert.ok(first.snapshot()); assert.equal(source.isAvailable(), false);
  assert.throws(() => source.capture(), { code: 'unavailable' });
  first.setEnabled(true); assert.notEqual(source.capture().sourceEpoch, before.sourceEpoch);
  current = new NativeFixture(); assert.equal(source.isAvailable(), false); source.bind();
  assert.equal(first.listeners.size, 0); assert.equal(first.deletions.size, 0); assert.equal(current.listeners.size, 1);
  current = undefined; assert.throws(() => source.capture(), { code: 'unavailable' }); source.dispose();
});
test('迁出后尚无产品capture即删除，不用旧A/P1位置造墓碑；跳修订拒推断', () => {
  const native = new NativeFixture(), source = new TaskBoardReadAdapter(() => native); source.bind(); source.capture();
  native.mutate(() => { native.rows[0].workspaceId = 'B'; native.rows[0].projectId = 'P2'; });
  native.delete('one');
  assert.deepEqual(source.capture().tombstones.map(row => [row.id, row.workspaceId, row.resolvedProjectId]), [['one', 'B', 'P2']]);
  native.mutate(() => { native.rows.push(rawTask('jump')); }); source.capture();
  native.rows = []; native.revision += 2; native.notify();
  for (const listener of native.deletions) listener({ taskId: 'jump' });
  assert.equal(source.capture().tombstones.some(row => row.id === 'jump'), false);
  source.dispose();
});
test('来源无效形状拒绝，原始私密字段getter从不读取', () => {
  const native = new NativeFixture(), source = new TaskBoardReadAdapter(() => native); source.bind();
  const row = rawTask('one'); Object.defineProperty(row, 'prompt', { get() { throw Error('不可读prompt'); } });
  native.snapshot = () => ({ revision: 1, tasks: [row] });
  assert.equal(source.capture().tasks[0].id, 'one');
  native.snapshot = () => ({ tasks: [row] }); assert.throws(() => source.capture(), { code: 'source_invalid' }); source.dispose();
});
