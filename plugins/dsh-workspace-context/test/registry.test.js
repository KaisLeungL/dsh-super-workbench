import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from '../index.js';

function fixture() {
  let service, close;
  apply({ effect: setup => { close = setup(); }, provide: (_name, value) => { service = value; } });
  const owner = name => ({ fiber: { entry: { options: { name } } } });
  const access = { scope: { workspaceId: 'one', projectIds: ['project'] }, binding: 'session-generation',
    grants: { 'example.list': '@example/context' }, signal: new AbortController().signal, assertCurrent() {} };
  const item = id => ({ workspaceId: 'one', projectId: 'project', ref: { kind: 'example.item', id } });
  const base = { id: 'example.list', protocol: 1, source: '示例', description: '列表', scope: 'project',
    filters: { state: { type: 'string', description: '状态', enum: ['active'] } } };
  return { service, owner, access, item, base, close };
}

test('只发现当前授权的注册者，并检查筛选和每条结果的归属', async () => {
  const { service, owner, access, item, base, close } = fixture();
  service.register(owner('@example/other'), { ...base, read: () => assert.fail('未经授权的注册者被调用') });
  assert.equal(service.catalog(access).capabilities[0].status, 'unavailable');
  const unregister = service.register(owner('@example/context'), { ...base, read: () => ({
    items: [{ ...item('different-workspace'), workspaceId: 'two' }], more: false, revision: '1',
  }) });
  assert.equal(service.catalog(access).capabilities[0].status, 'available');
  const query = { capability: base.id };
  assert.equal((await service.query(access, { ...query, filter: { state: 'unknown' } })).status, 'invalid_query');
  assert.equal((await service.query(access, { ...query, workspaceId: 'two' })).status, 'invalid_query');
  assert.equal((await service.query(access, query)).status, 'unavailable');
  assert.equal((await service.query({ ...access, grants: {} }, query)).status, 'denied');
  unregister();
  service.register(owner('@example/context'), { ...base, read: () => ({
    items: [{ ...item('different-project'), projectId: 'private' }], more: false, revision: '1',
  }) });
  assert.equal((await service.query(access, query)).status, 'unavailable');
  close();
});

test('分页绑定调用身份、查询条件和来源代次', async () => {
  const { service, owner, access, item, base, close } = fixture();
  let revision = 'one';
  const register = () => service.register(owner('@example/context'), { ...base, read: ({ offset }) => ({
    items: [item(String(offset))], more: offset === 0, revision,
  }) });
  const unregister = register();
  const query = { capability: base.id, limit: 1, filter: { state: 'active' } };
  const first = await service.query(access, query);
  assert.equal(first.complete, false);
  const next = { ...query, cursor: first.nextCursor };
  assert.equal((await service.query(access, next)).items[0].ref.id, '1');
  assert.equal((await service.query({ ...access, binding: 'new-authorization' }, next)).status, 'cursor_stale');
  assert.equal((await service.query(access, { ...next, filter: {} })).status, 'cursor_stale');
  revision = 'two';
  assert.equal((await service.query(access, next)).status, 'cursor_stale');
  unregister();
  register();
  assert.equal((await service.query(access, next)).status, 'cursor_stale');
  close();
});

test('读取过程中卸载或撤回授权时丢弃在途结果', async () => {
  const { service, owner, access, item, base, close } = fixture();
  let finish, active = true;
  const register = () => service.register(owner('@example/context'), { ...base, read: () => new Promise(resolve => { finish = resolve; }) });
  const result = { items: [item('private')], more: false, revision: '1' };
  const unregister = register();
  const query = { capability: base.id };
  const pending = service.query(access, query);
  await Promise.resolve();
  unregister();
  finish(result);
  assert.equal((await pending).status, 'unavailable');
  register();
  const revoked = service.query({ ...access, assertCurrent() { assert.ok(active, '授权已撤回'); } }, query);
  await Promise.resolve();
  active = false;
  finish(result);
  await assert.rejects(revoked, /授权已撤回/);
  close();
});
