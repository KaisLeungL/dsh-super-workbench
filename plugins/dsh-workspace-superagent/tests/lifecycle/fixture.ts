import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { StewardStore, fingerprint } from '../../src/storage/store.js';
import type { Clock } from '../../src/app/lifecycle/clock.js';

export class ManualClock implements Clock {
  time = 1_000;
  #next = 0;
  readonly callbacks = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  schedule(callback: () => void, delayMs: number): () => void {
    const id = ++this.#next; this.callbacks.set(id, { at: this.time + delayMs, callback });
    return () => { this.callbacks.delete(id); };
  }
  advance(ms: number): void {
    this.time += ms;
    for (;;) {
      const due = [...this.callbacks].filter(([, value]) => value.at <= this.time).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      this.callbacks.delete(due[0]); due[1].callback();
    }
  }
}
export function fixture(t: TestContext, identity = { instanceId: randomUUID(), domainId: 'b04-test' }) {
  const run = process.env.F84_TEST_ROOT ?? process.env.B04_RUN_DIR;
  assert.ok(run && (run.includes('/.superagent-product-lab/b04/runs/') || run.includes('/.superagent-product-lab/b04-f8-product/')), '只写新的隔离运行目录');
  mkdirSync(run, { recursive: true });
  const path = resolve(run, randomUUID() + '.sqlite');
  const store = StewardStore.initializeFresh(path, identity);
  t.after(() => store.close());
  store.registerResource('R', { workspaceId: 'W' });
  store.registerSource('S', 'b04/test-source', 'R');
  store.appendPolicy(0, { resources: ['R'], audiences: ['private'], mandate: { actions: ['read'], expiresAt: 9999999999999 }, proofRef: 'test-host-proof' });
  const input = store.saveInput({ ref: 'test-input', sourceWatermark: 'test:0', headers: { system: '实际测试system', developer: '', user: '实际测试user', tools: '[]' } });
  const start = () => store.recordLifecycle(store.manager().revision, 'running', true);
  return { store, path, identity, get evidence() { return auditedEvidence(store, identity); }, input, start };
}
/** 仅证明公开SQLite审计契约的组件事件夹具，不声称发生过真实模型调用。 */
function auditedEvidence(store: StewardStore, identity: { instanceId: string; domainId: string }) {
  const header = { version: 4, id: 'b04-component-' + randomUUID(), createdAt: 1, isSeeded: false };
  const sessionIdentity = fingerprint({ header, inheritedEventCount: 0 });
  store.registerAuditSession({ sessionId: header.id, sessionIdentity, header, inheritedEventCount: 0,
    workspaceId: 'W', projectionId: 'b04-component-fixture', formatVersion: 4, serializer: 'e37-json-v1' }, () => true);
  const basis = { basisKey: randomUUID(), sessionId: header.id, sessionIdentity, identity, workspaceId: 'W',
    turn: 0, step: 0, stepOffset: 0, messageIds: ['user'], versions: store.manager().versions,
    leaseFingerprint: 'component-current-port', promptPackageVersion: 'b04-component', promptPackageHash: fingerprint('package') };
  const key = store.prepareRequestAudit(basis, () => true);
  const request = { config: { provider: 'b04-component', model: 'bounded', reasoningEffort: 'low', maxTokens: 1000 },
    adapterDefaults: {}, messages: [{ id: 'user', role: 'user', content: [{ type: 'text', text: 'B04组件实际输入夹具' }] }], tools: [], toolHistory: { tools: [] } };
  store.bindRequestBoundary(basis.basisKey, { turn: 0, step: 0, attempt: 0, boundaryOffset: 3, requestHash: fingerprint(request) }, () => true);
  const cursor = store.readAuditCursor(sessionIdentity);
  return store.commitRequestAuditBatch(sessionIdentity, cursor, { offset: 5, prefixHash: fingerprint('component-events') },
    [{ key, settlementSeq: 4, eventHash: fingerprint('component-assistant-event'), settlementType: 'assistant/message', request }], () => true)[0]!;
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
export const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
