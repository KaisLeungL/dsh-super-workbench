import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StewardStore } from '../../src/storage/store.js';

const root = process.env.B03_RUN_DIR;
assert.ok(root?.includes('/.superagent-product-lab/b03/runs/'), '仅在本轮独占目录运行');
function fixture(t: TestContext) {
  const path = resolve(root!, randomUUID() + '.sqlite'), identity = { instanceId: randomUUID(), domainId: 'snapshot-domain' };
  const store = StewardStore.initializeFresh(path, identity);
  const inspect = new DatabaseSync(path);
  t.after(() => { inspect.close(); store.close(); });
  store.registerResource('allowed', { workspaceId: 'W', repositoryId: 'P', credentialRef: 'SECRET_NEVER_EXPORTED' });
  store.registerResource('unreferenced', { workspaceId: 'private', credentialRef: 'OTHER_SECRET' });
  store.appendPolicy(0, { resources: ['allowed'], audiences: ['A'], mandate: { actions: ['read'], expiresAt: 9999999999999 }, proofRef: 'human-policy-1' });
  const counters = () => ({ manager: store.manager(), audit: inspect.prepare('SELECT count(*) AS n FROM audit').get()!.n, policies: inspect.prepare('SELECT count(*) AS n FROM policy_revision').get()!.n });
  return { store, inspect, path, identity, counters };
}
test('快照只有白名单且detached，读取不改审计或修订', t => {
  const f = fixture(t), before = f.counters(), snapshot = f.store.readAuthorizationSnapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ['lifecycle', 'policy', 'resources', 'versions']);
  assert.deepEqual(snapshot.resources, [{ id: 'allowed', revision: 1, workspaceId: 'W', repositoryId: 'P' }]);
  assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
  snapshot.policy.resources.push('unreferenced'); snapshot.policy.mandate.actions.push('write');
  snapshot.resources[0]!.workspaceId = 'forged'; snapshot.versions.policyVersion = 500;
  const next = f.store.readAuthorizationSnapshot();
  assert.deepEqual(next.policy.resources, ['allowed']); assert.deepEqual(next.policy.mandate.actions, ['read']);
  assert.equal(next.resources[0]!.workspaceId, 'W'); assert.equal(next.versions.policyVersion, 1);
  assert.deepEqual(f.counters(), before);
});
test('修订及撤权后下一次读取最新值，双连接看到同一提交快照', t => {
  const f = fixture(t), peer = StewardStore.openExisting(f.path, f.identity); t.after(() => peer.close());
  assert.deepEqual(peer.readAuthorizationSnapshot(), f.store.readAuthorizationSnapshot());
  f.store.appendPolicy(1, { resources: [], audiences: [], mandate: { actions: [], expiresAt: 0 }, proofRef: 'human-revoke' });
  const next = peer.readAuthorizationSnapshot();
  assert.equal(next.versions.policyVersion, 2); assert.deepEqual(next.resources, []); assert.deepEqual(next.policy.resources, []);
  assert.deepEqual(next, f.store.readAuthorizationSnapshot());
  f.store.stop(f.store.manager().revision, 'human-stop');
  assert.equal(peer.readAuthorizationSnapshot().lifecycle, 'stopped');
  assert.equal(peer.readAuthorizationSnapshot().versions.stopEpoch, 1);
});
test('读取不抢写锁且不混入另一连接未提交政策', t => {
  const f = fixture(t), before = f.store.readAuthorizationSnapshot();
  f.inspect.exec('BEGIN IMMEDIATE');
  try {
    f.inspect.prepare('UPDATE manager_instance SET policy_version=99').run();
    assert.deepEqual(f.store.readAuthorizationSnapshot(), before);
  } finally { f.inspect.exec('ROLLBACK'); }
});
test('缺政策、资源或manager拒绝，不补空授权，失败后连接可继续读取', t => {
  const f = fixture(t);
  f.inspect.prepare('DELETE FROM policy_revision WHERE version=1').run();
  assert.throws(() => f.store.readAuthorizationSnapshot(), { code: 'MISSING_LEDGER' });
  f.inspect.prepare('INSERT INTO policy_revision VALUES(?,?)').run(1, JSON.stringify({ resources: ['missing'], audiences: [], mandate: { actions: [], expiresAt: 0 }, proofRef: 'broken' }));
  assert.throws(() => f.store.readAuthorizationSnapshot(), { code: 'RESOURCE_MISSING' });
  f.inspect.prepare('UPDATE policy_revision SET body=? WHERE version=1').run(JSON.stringify({ resources: [], audiences: [], mandate: { actions: [], expiresAt: 0 }, proofRef: 'fixed' }));
  assert.deepEqual(f.store.readAuthorizationSnapshot().resources, []);
  f.inspect.prepare('DELETE FROM manager_instance WHERE singleton=1').run();
  assert.throws(() => f.store.readAuthorizationSnapshot(), { code: 'MISSING_LEDGER' });
});
