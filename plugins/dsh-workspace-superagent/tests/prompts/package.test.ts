import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { StewardStore, fingerprint } from '../../src/storage/store.js';
import { persistRequestEvidence, PROMPT_PACKAGE_HASH, PROMPT_PACKAGE_VERSION, ROUTER_PROMPT, WORKER_PROMPT, ACTION_PROMPT, DELEGATION_PROMPT, type CommittedRequest } from '../../src/prompts/package.js';
const root = process.env.B03_RUN_DIR;
assert.ok(root?.includes('/.superagent-product-lab/b03/runs/'));
function fixture(t: TestContext) {
  const store = StewardStore.initializeFresh(resolve(root!, randomUUID() + '.sqlite'), { instanceId: randomUUID(), domainId: 'prompt-test' });
  t.after(() => store.close());
  const request: CommittedRequest = {
    sessionId: 'native-session', seq: 12, nativeLogRef: 'native-session/events:12', sourceWatermark: 'source:2',
    config: { provider: 'controlled-native', model: 'test-model', reasoningEffort: 'low', maxTokens: 1000 },
    adapterDefaults: { reasoningEffort: true },
    headers: { system: ROUTER_PROMPT, developer: '实际开发者提示', user: '实际用户输入', tools: '实际工具头' },
    versions: store.manager().versions, taskId: 'A', executionId: 'A-current',
  };
  return { store, request };
}
test('中文角色与包hash固定，实际动态输入单独不可变', t => {
  const { store, request } = fixture(t);
  assert.equal(PROMPT_PACKAGE_HASH, fingerprint({ version: PROMPT_PACKAGE_VERSION, router: ROUTER_PROMPT, worker: WORKER_PROMPT, actions: ACTION_PROMPT, delegation: DELEGATION_PROMPT }));
  const first = persistRequestEvidence(store, request), same = persistRequestEvidence(store, request);
  assert.deepEqual(first, same); assert.equal(first.effort, 'low');
  assert.equal(first.promptPackageHash, PROMPT_PACKAGE_HASH);
  assert.throws(() => persistRequestEvidence(store, { ...request, headers: { ...request.headers, user: '悄悄换原文' } }), /IMMUTABLE_INPUT_CONFLICT/);
  const next = persistRequestEvidence(store, { ...request, seq: 13, headers: { ...request.headers, user: '下一次实际输入' } });
  assert.equal(next.promptPackageHash, first.promptPackageHash); assert.notEqual(next.inputHash, first.inputHash);
});
test('不完整配置、不明推理默认或旧版本拒绝留作当前证据', t => {
  const { store, request } = fixture(t);
  assert.throws(() => persistRequestEvidence(store, { ...request, nativeLogRef: '' }));
  assert.throws(() => persistRequestEvidence(store, { ...request, config: { ...request.config, reasoningEffort: undefined } }));
  const unconfigured = persistRequestEvidence(store, { ...request, seq: 14, config: { ...request.config, reasoningEffort: undefined }, adapterDefaults: {} });
  assert.equal(unconfigured.effort, 'not-configured');
  assert.throws(() => persistRequestEvidence(store, { ...request, config: { ...request.config, maxTokens: 0 } }));
  store.stop(0, 'stop');
  assert.throws(() => persistRequestEvidence(store, request), /版本已失效/);
});
