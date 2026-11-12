import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type StewardStore, fingerprint } from '../../src/storage/store.js';
import type { AuditRequestDescription, Evidence, RequestAuditBasis } from '../../src/storage/types.js';

/** 用组件夹具模拟宿主回调，走真实的审计登记、请求绑定和结算入口。 */
export function commitLiveEvidence(store: StewardStore, workspaceId: string, userText = '组件测试输入'): Evidence {
  const header = { version: 4, id: randomUUID(), createdAt: 1, isSeeded: false };
  const sessionIdentity = fingerprint({ header, inheritedEventCount: 0 });
  const current = () => true;
  store.registerAuditSession({
    sessionId: header.id, sessionIdentity, header, inheritedEventCount: 0, workspaceId,
    projectionId: 'pure-fixture-v4', formatVersion: 4, serializer: 'e37-json-v1',
  }, current);
  const basis: RequestAuditBasis = {
    basisKey: randomUUID(), sessionId: header.id, sessionIdentity, identity: store.identity, workspaceId,
    turn: 0, step: 0, stepOffset: 0, messageIds: ['u'], versions: store.manager().versions,
    leaseFingerprint: 'test-lease', promptPackageVersion: 'v1', promptPackageHash: fingerprint('prompt-v1'),
  };
  const request: AuditRequestDescription = {
    config: { provider: 'test-native-port', model: 'bounded-model', maxTokens: 1000, reasoningEffort: 'low' },
    adapterDefaults: {}, messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: userText }] }],
    tools: [], toolHistory: { tools: [] },
  };
  const key = store.prepareRequestAudit(basis, current);
  store.bindRequestBoundary(basis.basisKey, { turn: 0, step: 0, attempt: 0, boundaryOffset: 0, requestHash: fingerprint(request) }, current);
  const [evidence] = store.commitRequestAuditBatch(sessionIdentity, store.readAuditCursor(sessionIdentity),
    { offset: 1, prefixHash: 'fixture-prefix' }, [{ key, settlementSeq: 0, eventHash: 'fixture-event', settlementType: 'assistant/message', request }], current);
  assert.ok(evidence);
  assert.equal(store.readRequestAudit(key)?.eligibility, 'live');
  return evidence;
}
