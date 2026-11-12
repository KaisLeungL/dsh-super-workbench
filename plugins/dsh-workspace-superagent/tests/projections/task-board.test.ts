import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskBoardReadAdapter } from '../../src/adapters/task-board/read/source.js';
import { TaskBoardProjection } from '../../src/app/projections/task-board.js';
import type { BoardReadSource, ReadBranch, TaskDetailPage } from '../../src/app/projections/types.js';
import { NativeFixture, rawTask, authority } from '../task-board-read/fixture.js';
function setup(branches?: readonly ReadBranch[]) {
  const native = new NativeFixture(), scope = authority(branches), source = new TaskBoardReadAdapter(() => native);
  source.bind(); const projection = new TaskBoardProjection(source, scope.provider);
  return { native, scope, source, projection, dispose: () => { projection.dispose(); source.dispose(); } };
}
test('双workspace/project AND、null/undefined、ID/标题/来源别名均过滤', async () => {
  const h = setup();
  h.native.rows = [rawTask('yes'), rawTask('other-project', { projectId: 'P2', title: '越权标题' }), rawTask('other-ws', { workspaceId: 'B' }), rawTask('none', { projectId: null }), rawTask('fallback', { projectId: undefined })];
  assert.deepEqual((await h.projection.listTasks()).items.map(row => row.id), ['yes']);
  for (const id of ['other-project', 'other-ws', 'none', 'fallback', 'missing']) assert.deepEqual(await h.projection.readTask(id), { state: 'not_found' });
  for (const query of ['越权标题', 'SECRET_ALIAS', 'SECRET_TOKEN', 'SECRET_PROMPT']) assert.equal((await h.projection.listTasks({ query })).items.length, 0);
  assert.equal((await h.projection.listTasks({ workspaceId: 'B' })).items.length, 0);
  assert.equal(JSON.stringify(await h.projection.listTasks()).includes('total'), false);
  h.scope.change([{ workspaceId: 'A', projectIds: [null, 'A'] }]);
  assert.deepEqual((await h.projection.listTasks()).items.map(row => row.id), ['fallback', 'none']); h.dispose();
});
test('当前卡可读不透传跨项目旧execution/session/report，人工Done不改执行失败', async () => {
  const h = setup(); h.native.rows = [rawTask('one', { status: 'done', executions: [
    { id: 'visible', sessionId: 'visible-session', projectId: 'P1', startedAt: 1, endedAt: 2, result: 'failed', summary: { text: '失败摘要', seq: 3 } },
    { id: 'hidden', sessionId: 'HIDDEN_SESSION', projectId: 'P2', startedAt: 4, summary: { text: 'HIDDEN_REPORT', seq: 5 } },
  ] })];
  const page = await h.projection.listTasks(); assert.equal(page.items[0].status, 'done'); assert.equal(page.items[0].latestExecution, null); assert.equal(page.items[0].currentExecutionId, null);
  const history = await h.projection.readTask('one', 'executions') as TaskDetailPage;
  assert.deepEqual(history.executions?.map(row => row.id), ['visible']);
  assert.equal(JSON.stringify(history).includes('HIDDEN'), false);
  assert.deepEqual(await h.projection.readExecutionReport('one', 'hidden'), { state: 'not_found' });
  const report = await h.projection.readExecutionReport('one', 'visible'); assert.ok('result' in report); assert.equal(report.result, 'failed');
  h.dispose();
});
test('旧任务召回只搜索可读卡和可读报告，修订后重新取事实', async t => {
  const h = setup(); t.after(h.dispose);
  const report = { text: 'OAuth 超时', seq: 1 };
  h.native.rows = [
    rawTask('login', { title: '登录问题', updatedAt: 20, executions: [
      { id: 'old', projectId: 'P1', startedAt: 1, endedAt: 2, result: 'failed', summary: report },
      { id: 'current', projectId: 'P1', startedAt: 3 },
      { id: 'hidden', projectId: 'P2', startedAt: 0, endedAt: 1, summary: { text: '保密错误', seq: 2 } },
    ] }),
    rawTask('another', { title: '登录问题', updatedAt: 10 }),
    rawTask('private', { title: '登录保密问题', projectId: 'P2', updatedAt: 25 }),
  ];
  const first = await h.projection.recallTasks({ terms: ['登录', 'ＯＡＵＴＨ'], updatedSince: 10, updatedBefore: 25 }, true);
  assert.deepEqual(first.items.map(row => row.task.id), ['login', 'another']);
  assert.deepEqual(first.items[0].matchedBy, ['title', 'report']);
  assert.equal(first.items[0].reportExecutionId, 'old');
  assert.equal(first.items[0].task.currentExecutionId, 'current');
  assert.deepEqual((await h.projection.recallTasks({ terms: ['保密'] }, true)).items, []);
  assert.deepEqual((await h.projection.recallTasks({ terms: ['OAuth'] }, false)).items, []);
  h.native.mutate(() => { report.text = '代理故障'; });
  assert.deepEqual((await h.projection.recallTasks({ terms: ['OAuth'] }, true)).items, []);
  assert.equal((await h.projection.recallTasks({ terms: ['代理故障'] }, true)).items[0].reportExecutionId, 'old');
  h.scope.change([]);
  assert.deepEqual((await h.projection.recallTasks({ terms: ['login', '登录'] }, true)).items, []);
  assert.deepEqual(await h.projection.readExecutionReport('login', 'old'), { state: 'not_found' });
});
test('关系每跳核父子，不能从可读子卡泄范围外父卡或按父ID查询', async () => {
  const h = setup(); h.native.rows = [rawTask('child', { parentId: 'private-parent' }), rawTask('private-parent', { projectId: 'P2' }), rawTask('private-child', { parentId: 'child', workspaceId: 'B' }), rawTask('allowed-child', { parentId: 'child' })];
  const page = await h.projection.readTask('child', 'relations') as TaskDetailPage;
  assert.deepEqual(page.relations?.map(row => row.task.id), ['allowed-child']);
  assert.equal(JSON.stringify(page).includes('private-'), false);
  assert.equal((await h.projection.listTasks({ parentId: 'private-parent' })).items.length, 0); h.dispose();
});
test('51+项稳定有界翻页、完整JSON≤8000、长正文含转义可重建、cursor不可篡改/换查询/跨实例', async () => {
  const h = setup();
  h.native.rows = Array.from({ length: 75 }, (_, i) => rawTask('card-' + String(i).padStart(3, '0'), { title: i === 0 ? '长'.repeat(12000) : '', description: i === 0 ? '中文"\n\\😀'.repeat(6000) : '' }));
  const ids: string[] = []; let cursor: string | undefined;
  do { const page = await h.projection.listTasks({}, cursor); assert.ok(JSON.stringify(page).length <= 8000); assert.ok(page.items.length <= 50); ids.push(...page.items.map(row => row.id)); cursor = page.nextCursor; } while (cursor);
  assert.equal(ids.length, 75); assert.equal(new Set(ids).size, 75);
  const initial = await h.projection.listTasks(); assert.ok(initial.nextCursor);
  await assert.rejects(h.projection.listTasks({}, initial.nextCursor + 'x'), { code: 'cursor_stale' });
  await assert.rejects(h.projection.listTasks({ sort: 'updated' }, initial.nextCursor), { code: 'cursor_stale' });
  const other = new TaskBoardProjection(h.source, h.scope.provider);
  await assert.rejects(other.listTasks({}, initial.nextCursor), { code: 'cursor_stale' }); other.dispose();
  let restored = ''; cursor = undefined;
  do { const page = await h.projection.readTask('card-000', 'description', cursor) as TaskDetailPage; assert.ok(JSON.stringify(page).length <= 8000); restored += page.text?.text; cursor = page.nextCursor; } while (cursor);
  assert.equal(restored, h.native.rows[0].description); h.dispose();
});
test('board/scope/policy变化拒旧cursor，撤权立刻不返回旧标题/详情，不当删除', async () => {
  const h = setup(); h.native.rows = Array.from({ length: 60 }, (_, i) => rawTask('card-' + i));
  const first = await h.projection.listTasks(); assert.ok(first.nextCursor);
  h.native.mutate(() => { h.native.rows[0].title = '新标题'; });
  await assert.rejects(h.projection.listTasks({}, first.nextCursor), { code: 'cursor_stale' });
  const second = await h.projection.listTasks(); h.scope.change([]);
  await assert.rejects(h.projection.listTasks({}, second.nextCursor), { code: 'cursor_stale' });
  assert.equal((await h.projection.listTasks()).items.length, 0); assert.deepEqual(await h.projection.readTask('card-0'), { state: 'not_found' });
  h.scope.revoke(); await assert.rejects(h.projection.listTasks(), { code: 'scope_changed' }); h.dispose();
});
test('await中撤权/重绑定/失效拒迟到capture，dispose后不遗留投影监听', async () => {
  const h = setup(); let resolve!: () => void; const barrier = new Promise<void>(ok => { resolve = ok; });
  const slow: BoardReadSource = { isAvailable: () => h.source.isAvailable(), watchInvalidate: listener => h.source.watchInvalidate(listener), capture: async () => { const snapshot = h.source.capture(); await barrier; return snapshot; } };
  const projection = new TaskBoardProjection(slow, h.scope.provider);
  const pending = projection.listTasks(); h.scope.revoke(); resolve();
  await assert.rejects(pending, { code: 'scope_changed' }); projection.dispose(); h.dispose();
  const next = setup(); let release!: () => void; const wait = new Promise<void>(ok => { release = ok; });
  const delayed = new TaskBoardProjection({ ...slow, isAvailable: () => next.source.isAvailable(), watchInvalidate: listener => next.source.watchInvalidate(listener), capture: async () => { const snapshot = next.source.capture(); await wait; return snapshot; } }, next.scope.provider);
  const old = delayed.listTasks(); next.source.unbind(); next.source.bind(); release();
  await assert.rejects(old, { code: 'unavailable' }); delayed.dispose(); next.dispose();
});
test('历史项目缺失不猜当前归属；保留上限20，详情/报告撤权续页明确失效', async () => {
  const h = setup();
  h.native.rows = [rawTask('one', { description: '长'.repeat(18000), executions: Array.from({ length: 22 }, (_, i) => ({
    id: 'execution-' + i, sessionId: 'session-' + i, projectId: i === 21 ? undefined : 'P1',
    startedAt: i, endedAt: i + 1, result: 'failed', summary: { text: '报告'.repeat(8000), seq: i },
  })) })];
  const detail = await h.projection.readTask('one', 'description') as TaskDetailPage; assert.ok(detail.nextCursor);
  const report = await h.projection.readExecutionReport('one', 'execution-20'); assert.ok('nextCursor' in report && report.nextCursor);
  const history = await h.projection.readTask('one', 'executions') as TaskDetailPage;
  assert.ok((history.executions?.length ?? 0) <= 20); assert.ok(!history.executions?.some(row => ['execution-0', 'execution-1', 'execution-21'].includes(row.id)));
  assert.deepEqual(await h.projection.readExecutionReport('one', 'execution-21'), { state: 'not_found' });
  h.scope.change([]);
  await assert.rejects(h.projection.readTask('one', 'description', detail.nextCursor), { code: 'cursor_stale' });
  await assert.rejects(h.projection.readExecutionReport('one', 'execution-20', report.nextCursor), { code: 'cursor_stale' });
  h.dispose();
});
test('明确删除位置按当前scope过滤，归档/恢复只读呈现；无任意写口', async () => {
  const h = setup(); await h.projection.listTasks();
  h.native.mutate(() => { h.native.rows[0].archivedAt = 2; });
  assert.equal((await h.projection.listTasks({ archived: 'only' })).items.length, 1);
  h.native.mutate(() => { h.native.rows[0].archivedAt = undefined; });
  assert.equal((await h.projection.listTasks({ archived: 'only' })).items.length, 0);
  h.native.mutate(() => { h.native.rows[0].workspaceId = 'B'; h.native.rows[0].projectId = 'P2'; });
  h.native.delete('one'); assert.deepEqual(await h.projection.readTask('one'), { state: 'not_found' });
  h.scope.change([{ workspaceId: 'B', projectIds: ['P2'] }]);
  const deleted = await h.projection.readTask('one'); assert.ok('state' in deleted); assert.equal(deleted.state, 'deleted');
  assert.equal(h.native.writes, 0); h.dispose();
});
