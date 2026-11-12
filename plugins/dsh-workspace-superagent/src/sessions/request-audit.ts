import { fingerprint, type StewardStore } from '../storage/store.js';
import { LIMITS, StorageError, type AuditSessionRegistration, type RequestAuditBasis, type AuditRequestDescription, type NativeAuditFact, type Evidence } from '../storage/types.js';

export interface AuditLogEvent { readonly type: string; readonly seq: number; readonly data: unknown; readonly [key: string]: unknown }
export interface PassiveSessionHandle {
  readonly header: Readonly<Record<string, unknown>>; readonly inheritedEventCount: number;
  read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: readonly AuditLogEvent[]; eventState: 'detached' | 'shared-frozen' }>;
  close(): Promise<void>;
}
export interface PassiveSessionPersistence {
  readonly identity: symbol;
  stat(id: string, options?: { signal?: AbortSignal }): Promise<{ readonly header: Readonly<Record<string, unknown>>; readonly eventCount?: number } | undefined>;
  open(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<PassiveSessionHandle>;
}
/** 由可信Host装配的同版本公开纯解释器；日志内容不得提供代码或选择解释器。 */
export interface NativeAuditReplay {
  readonly id: string;
  validate(events: readonly AuditLogEvent[], registration: AuditSessionRegistration): void;
  describe(events: readonly AuditLogEvent[], registration: AuditSessionRegistration): AuditRequestDescription;
}
export interface RequestAuditPhase {
  readonly phase: 'config' | 'request' | 'authorization'; readonly turn: number; readonly step: number; readonly attempt: number;
  readonly boundaryOffset?: number; readonly actualRequest?: AuditRequestDescription;
}
const reject = (ok: unknown, code: string): void => { if (!ok) throw new StorageError(code); };
const READ_CHUNK = 256;
// 固定JSONL格式4把缺省深度写为0；保留全部其它创建字段，非0绝不归并。
const creationHeader = (header: Readonly<Record<string,unknown>>) => ({...header,delegationDepth:header.delegationDepth ?? 0});
export class RequestAuditor {
  readonly #persistenceIdentity: symbol;
  constructor(readonly store: StewardStore, readonly persistence: PassiveSessionPersistence, readonly replay: NativeAuditReplay, readonly assertCurrent: () => void) {
    reject(replay && typeof replay.id === 'string' && replay.id && typeof replay.describe === 'function' && typeof replay.validate === 'function' &&
      persistence && typeof persistence.identity === 'symbol' && typeof persistence.open === 'function' && typeof persistence.stat === 'function' && typeof assertCurrent === 'function', 'AUDIT_REPLAY_REQUIRED');
    this.#persistenceIdentity = persistence.identity;
  }
  #current(): void { this.assertCurrent(); reject(this.persistence.identity === this.#persistenceIdentity,'AUDIT_PERSISTENCE_CHANGED'); }
  #check(signal: AbortSignal, assertReadContext: () => void = () => {}): void { signal.throwIfAborted(); this.#current(); assertReadContext(); }
  register(session: { id: string; header: Readonly<Record<string, unknown>>; inheritedEventCount: number }, workspaceId: string, current: () => boolean, foreground?: true, worker?: true): string {
    this.#current();
    const header=creationHeader(session.header);
    const registration: AuditSessionRegistration = {
      sessionId: session.id, sessionIdentity: fingerprint({ header, inheritedEventCount: session.inheritedEventCount }),
      header, inheritedEventCount: session.inheritedEventCount, workspaceId,
      projectionId: this.replay.id, formatVersion: Number(session.header.version), serializer: 'e37-json-v1',
    };
    this.store.registerAuditSession(registration,current,foreground,worker); return registration.sessionIdentity;
  }
  /** 读固定前缀；失败不推进游标。没有Agent恢复、模型调用、flush或输入重放。 */
  async reconcile(sessionIdentity: string, signal: AbortSignal, target: number, liveAuthority?: (basis: RequestAuditBasis) => boolean, assertReadContext: () => void = () => {}): Promise<Evidence[]> {
    this.#check(signal,assertReadContext);
    // target只能由可信runtime自有Session flush成功屏障或隔离冷读提供；stat/eventState不是耐久证明。
    reject(Number.isSafeInteger(target) && target >= this.store.readAuditCursor(sessionIdentity).offset,'AUDIT_LOG_BOUND_UNKNOWN');
    const result: Evidence[] = [];
    let more: boolean;
    do {
      this.#check(signal,assertReadContext);
      const batch = await this.#reconcileBatch(sessionIdentity,target!,signal,liveAuthority,assertReadContext); result.push(...batch.evidence); more = batch.more;
    } while (more);
    return result;
  }
  /** 冷进程拥有方核旧PID退出、无Agent恢复；每await重核该隔离事实，仅audit-only。 */
  async reconcileCold(sessionIdentity: string, signal: AbortSignal, assertIsolated: () => void): Promise<Evidence[]> {
    const assertReadContext=assertIsolated;
    const check=()=>this.#check(signal,assertReadContext); check();
    const registration=this.store.readAuditCursor(sessionIdentity).registration;
    const handle=await this.persistence.open(registration.sessionId,'read',{signal});
    let target=0;
    try {
      check(); reject(fingerprint(creationHeader(handle.header))===fingerprint(registration.header) && handle.inheritedEventCount===registration.inheritedEventCount,'AUDIT_SESSION_CONFLICT');
      for (;;) {
        const page=await handle.read(target,READ_CHUNK,{signal});check();
        reject(page.events.length<=READ_CHUNK && page.events.every((event,index)=>event.seq===target+index),'AUDIT_PREFIX_CONFLICT');
        target+=page.events.length;if(page.events.length<READ_CHUNK)break;
      }
    } finally {await handle.close();check();}
    return this.reconcile(sessionIdentity,signal,target,undefined,assertIsolated);
  }
  async #reconcileBatch(sessionIdentity: string, target: number, signal: AbortSignal, liveAuthority: ((basis: RequestAuditBasis) => boolean) | undefined, assertReadContext: () => void): Promise<{ evidence: Evidence[]; more: boolean }> {
    this.#check(signal,assertReadContext);
    const cursor = this.store.readAuditCursor(sessionIdentity), registration = cursor.registration;
    reject(registration.projectionId === this.replay.id && registration.serializer === 'e37-json-v1', 'AUDIT_INTERPRETER_CHANGED');
    this.#check(signal,assertReadContext);
    const handle = await this.persistence.open(registration.sessionId,'read',{ signal });
    let events: readonly AuditLogEvent[], more: boolean;
    try {
      this.#check(signal,assertReadContext);
      reject(fingerprint(creationHeader(handle.header)) === fingerprint(registration.header) && handle.inheritedEventCount === registration.inheritedEventCount, 'AUDIT_SESSION_CONFLICT');
      // 先读一批增量并固定本批上界；后续append不进入本批，也不替换历史header。
      const length=Math.min(READ_CHUNK,target-cursor.offset);
      reject(length >= 0,'AUDIT_CURSOR_CONFLICT');
      const tail = await handle.read(cursor.offset,length,{signal}); this.#check(signal,assertReadContext);
      reject(tail.events.length === length,'AUDIT_PREFIX_CONFLICT');
      const prefix: AuditLogEvent[] = [];
      for (let offset=0; offset<cursor.offset; offset+=READ_CHUNK) {
        const length=Math.min(READ_CHUNK,cursor.offset-offset);
        const part=await handle.read(offset,length,{signal}); this.#check(signal,assertReadContext);
        reject(part.events.length===length,'AUDIT_PREFIX_CONFLICT'); prefix.push(...part.events);
      }
      events=[...prefix,...tail.events]; more=events.length<target;
    } finally { await handle.close(); this.#check(signal,assertReadContext); }
    this.#check(signal,assertReadContext);
    reject(events.length >= cursor.offset && events.every((event,index) => event.seq === index), 'AUDIT_PREFIX_CONFLICT');
    reject(fingerprint(events.slice(0,cursor.offset)) === cursor.prefixHash, 'AUDIT_PREFIX_CONFLICT');
    this.replay.validate(events,registration);
    const pending = [];
    let after: string | undefined;
    for (;;) {
      const page=this.store.pendingRequestAudits(sessionIdentity,after); pending.push(...page);
      if (page.length < LIMITS.queueItems) break;
      after=page.at(-1)!.key;
    }
    const facts: NativeAuditFact[] = [], assigned = new Set<number>();
    for (const row of pending) {
      if (!row.basis) continue; // 已持久保留的孤立未知，不用当前数据倒填。
      const basis = row.basis, boundary = row.boundary;
      if (!boundary) { facts.push({ key: row.key, reason: 'REQUEST_BOUNDARY_NOT_DURABLE' }); continue; }
      if (boundary.boundaryOffset > events.length) { if (!more) facts.push({ key: row.key, reason: 'NATIVE_PREFIX_NOT_DURABLE' }); continue; }
      const siblings = pending.filter(other => other.key !== row.key && other.basis?.turn === basis.turn && other.basis.step === basis.step && other.boundary);
      const duplicateBoundary = siblings.some(other => other.boundary!.boundaryOffset === boundary.boundaryOffset);
      const nextBoundary = Math.min(events.length, ...siblings.map(other => other.boundary!.boundaryOffset).filter(offset => offset > boundary.boundaryOffset));
      const settlements = events.filter(event => {
        const data = event.data as { turn?: number; step?: number };
        return event.seq >= boundary.boundaryOffset && event.seq < nextBoundary &&
          (event.type === 'assistant/message' || event.type === 'assistant/attempt') && data.turn === basis.turn && data.step === basis.step;
      });
      if (!duplicateBoundary && settlements.length === 0 && more) continue;
      if (duplicateBoundary || settlements.length !== 1) {
        facts.push({ key: row.key, reason: duplicateBoundary || settlements.length > 1 ? 'REQUEST_SETTLEMENT_AMBIGUOUS' : 'REQUEST_SETTLEMENT_UNKNOWN' }); continue;
      }
      const event = settlements[0]!;
      const existing = this.store.auditedSettlement(sessionIdentity,event.seq);
      if (assigned.has(event.seq) || existing && existing.key !== row.key) { facts.push({ key: row.key, reason: 'REQUEST_SETTLEMENT_AMBIGUOUS' }); continue; }
      assigned.add(event.seq);
      const prefix = events.slice(0,boundary.boundaryOffset);
      let description: AuditRequestDescription;
      try { description = this.replay.describe(prefix,registration); }
      catch { facts.push({ key: row.key, settlementSeq:event.seq,eventHash:fingerprint(event),reason:'REQUEST_PROJECTION_UNAVAILABLE' }); continue; }
      if (fingerprint(description) !== boundary.requestHash || basis.messageIds.some(id => !description.messages.some(message => message.id === id))) {
        facts.push({ key: row.key,settlementSeq:event.seq,eventHash:fingerprint(event),reason:'REQUEST_INPUT_MISMATCH' }); continue;
      }
      facts.push({ key:row.key,settlementSeq:event.seq,eventHash:fingerprint(event),settlementType:event.type as 'assistant/message'|'assistant/attempt',request:description });
    }
    for (const event of events.slice(cursor.offset)) {
      if (!['assistant/message','assistant/attempt'].includes(event.type) || event.seq < registration.inheritedEventCount || assigned.has(event.seq) || this.store.auditedSettlement(sessionIdentity,event.seq)) continue;
      facts.push({ key:'unbound/' + sessionIdentity + '/' + event.seq,settlementSeq:event.seq,eventHash:fingerprint(event),reason:'HISTORICAL_BASIS_MISSING' });
    }
    // 已保留且本轮毫无新事实的unknown不反复写修订，也不占后续单批容量。
    const changes=facts.filter(fact => {
      const old=this.store.readRequestAudit(fact.key);
      return !(old?.state==='unknown' && !fact.request && old.reason===fact.reason &&
        (fact.settlementSeq===undefined || old.settlementSeq===fact.settlementSeq && old.eventHash===fact.eventHash));
    });
    reject(changes.length <= LIMITS.queueItems * 2,'AUDIT_BATCH_LIMIT');
    this.#check(signal,assertReadContext);
    return { evidence:this.store.commitRequestAuditBatch(sessionIdentity,cursor,{ offset:events.length,prefixHash:fingerprint(events) },changes,liveAuthority),more:more! };
  }
}
