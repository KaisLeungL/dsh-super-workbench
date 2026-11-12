import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { StewardStore } from '../../src/storage/store.js';
import { CallerAuthority, READ_TOOLS, type CallerHost } from '../../src/tools/authority.js';
import { ScopedBoardReads } from '../../src/tools/reads.js';
import { ROUTER_PRESET } from '../../src/sessions/manager.js';
import type { BoardCapture, TaskPage, TaskRecallPage } from '../../src/app/projections/types.js';
const root = process.env.B03_RUN_DIR; assert.ok(root?.includes('/.superagent-product-lab/b03/runs/'));
function fixture(t: TestContext) {
  const identity = { instanceId: randomUUID(), domainId: 'read-tools' };
  const store = StewardStore.initializeFresh(resolve(root!, randomUUID() + '.sqlite'), identity); t.after(() => store.close());
  store.registerResource('R', { workspaceId: 'W', repositoryId: 'P' });
  store.appendPolicy(0, { resources: ['R'], audiences: [], mandate: { actions: ['read'], expiresAt: 9999999999999 }, proofRef: 'human' });
  const reserved = store.reserveManager(store.manager().revision, 'S', 'W', ROUTER_PRESET);
  store.bindManager(reserved.revision, { sessionId: 'S', workspaceId: 'W', preset: ROUTER_PRESET, nativeLogRef: 'native:S' });
  store.recordLifecycle(store.manager().revision, 'running', false);
  let agent = { id: 'S' }, listeners = 0;
  const host: CallerHost<{ id: string }> = { identity, agent: () => agent, isRuntimeRoot: () => true, preset: () => ROUTER_PRESET, workspace: () => 'W', policy: () => ({ revision: 'host', backend: 'native', resources: ['R'], tools: READ_TOOLS, actions: ['read'], audiences: [], maxTokens: 2048 }), admission: () => undefined, task: () => undefined, defaultPermission: () => 'read-only', assertAvailable() {}, now: () => 1 };
  const capture: BoardCapture = { sourceEpoch: 'source', boardRevision: '1', asOf: 1, tasks: Array.from({ length: 80 }, (_, n) => ({ id: String(n).padStart(3, '0'), workspaceId: 'W', resolvedProjectId: 'P', title: '合成任务', description: '说明', status: 'todo', updatedAt: 1, archivedAt: null, parentId: null, executions: [] })), tombstones: [] };
  let afterCapture: (() => void) | undefined;
  const source = { capture: async () => { afterCapture?.(); return capture; }, isAvailable: () => true, watchInvalidate: () => { listeners++; return () => { listeners--; }; } };
  const reads = new ScopedBoardReads(new CallerAuthority(store, host), source); t.after(() => reads.dispose());
  const call = () => ({ agent, signal: new AbortController().signal, name: READ_TOOLS[0]! });
  return { store, reads, call, agent: () => agent, replace: () => agent = { id: 'S' }, listeners: () => listeners, after: (fn: () => void) => afterCapture = fn };
}
test('同一真实caller跨工具调用复用cursor，单次signal取消不污染下次调用', async t => {
  const f = fixture(t), first = await f.reads.execute({}, f.call()) as TaskPage;
  assert.ok(first.nextCursor); const second = await f.reads.execute({ cursor: first.nextCursor }, f.call()) as TaskPage;
  assert.ok(second.items[0]!.id > first.items.at(-1)!.id); assert.equal(f.listeners(), 1);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.reads.execute({}, { ...f.call(), signal: cancelled.signal }));
  assert.equal(f.listeners(), 0);
  assert.ok((await f.reads.execute({}, f.call()) as TaskPage).items.length > 0);
});
test('换Agent对象或政策代次拒旧cursor，stop释放旧投影', async t => {
  const f = fixture(t), first = await f.reads.execute({}, f.call()) as TaskPage, old = f.agent();
  f.replace(); await assert.rejects(f.reads.execute({ cursor: first.nextCursor }, f.call()), { code: 'cursor_stale' });
  await assert.rejects(f.reads.execute({}, { ...f.call(), agent: old }), { code: 'CALLER_NOT_CURRENT' });
  const page = await f.reads.execute({}, f.call()) as TaskPage;
  f.store.appendPolicy(1, { resources: ['R'], audiences: [], mandate: { actions: ['read'], expiresAt: 9999999999999 }, proofRef: 'new-revision' });
  await assert.rejects(f.reads.execute({ cursor: page.nextCursor }, f.call()), { code: 'cursor_stale' });
  await f.reads.execute({}, f.call()); f.store.stop(f.store.manager().revision, 'human');
  await assert.rejects(f.reads.execute({}, f.call()), { code: 'NOT_RUNNING' }); assert.equal(f.listeners(), 0);
});
test('源await期间撤权不返回旧页，selector与任意额外字段不能增权', async t => {
  const f = fixture(t);
  const denied = await f.reads.execute({ selector: { workspaceId: 'foreign' } }, f.call()) as TaskPage; assert.deepEqual(denied.items, []);
  await assert.rejects(f.reads.execute({ grant: { workspaceId: 'foreign' } }, f.call()), { code: 'INVALID_ARGUMENTS' });
  f.after(() => f.store.stop(f.store.manager().revision, 'await-stop'));
  await assert.rejects(f.reads.execute({}, f.call())); assert.equal(f.listeners(), 0);
});
test('主理列表工具可召回有界候选，拒绝混用分页、注入权限或空关键词', async t => {
  const f = fixture(t);
  const page = await f.reads.execute({ recall: { terms: ['合成'] } }, f.call()) as TaskRecallPage;
  assert.equal(page.items.length, 8);
  assert.equal(page.truncated, true);
  assert.deepEqual(page.items[0].matchedBy, ['title']);
  for (const args of [
    { recall: { terms: ['合成'], scope: ['foreign'] } },
    { recall: { terms: ['合成'] }, cursor: 'old' },
    { recall: { terms: ['合成'] }, selector: {} },
  ]) await assert.rejects(f.reads.execute(args, f.call()), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(f.reads.execute({ recall: { terms: ['  '] } }, f.call()), { code: 'invalid_query' });
});
