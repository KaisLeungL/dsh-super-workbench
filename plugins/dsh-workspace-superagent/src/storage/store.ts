import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import { closeSync, openSync, statSync, lstatSync, statfsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { APPLICATION_ID, SCHEMA, SCHEMA_VERSION, TABLES, V1_SCHEMA, V1_TABLES, AUDIT_SCHEMA } from './schema.js';
import type { AuditSessionRegistration, RequestAuditBasis, RequestAuditBoundary, AuditRequestDescription, RequestAuditRecord, NativeAuditCursor, NativeAuditFact, HealthSummary } from './types.js';
import { LIMITS, StorageError, type Identity, type Versions, type InputSnapshot, type Evidence, type EvalRequest, type RouteItem, type EffectRequest, type EffectClaim, type JobRequest, type JobClaim, type Projection, type ReadScope } from './types.js';

type Row = Record<string, SQLOutputValue>;
const encode = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const fingerprint = (value: unknown): string => createHash('sha256').update(encode(value)).digest('hex');
const parse = <T>(row: Row): T => JSON.parse(String(row.body)) as T;
const requireValue = (condition: unknown, code: string): void => { if (!condition) throw new StorageError(code); };
const same = (a: unknown, b: unknown): boolean => encode(a) === encode(b);
const schemaFingerprint = (db: DatabaseSync): string => fingerprint(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name").all());
const trustedSchemas = new Map<number, string>();
function trustedSchema(version: 1 | 2): string {
  let hash = trustedSchemas.get(version);
  if (!hash) { const memory = new DatabaseSync(':memory:'); try { memory.exec(version === 1 ? V1_SCHEMA : SCHEMA); hash = schemaFingerprint(memory); trustedSchemas.set(version, hash); } finally { memory.close(); } }
  return hash;
}
function verifyDatabase(db: DatabaseSync, identity: Identity, version: 1 | 2): void {
  requireValue(db.prepare('PRAGMA user_version').get()?.user_version === version, 'SCHEMA_UNSUPPORTED');
  requireValue(db.prepare('PRAGMA application_id').get()?.application_id === APPLICATION_ID, 'IDENTITY_MISMATCH');
  requireValue(db.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok', 'CORRUPT');
  for (const table of version === 1 ? V1_TABLES : TABLES) requireValue(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), 'MISSING_LEDGER');
  const id = db.prepare('SELECT * FROM deployment WHERE singleton=1').get();
  requireValue(id?.complete === 1 && id.instance_id === identity.instanceId && id.domain_id === identity.domainId, 'IDENTITY_MISMATCH');
  requireValue(id?.schema_hash === schemaFingerprint(db) && id.schema_hash === trustedSchema(version), 'SCHEMA_SHAPE_MISMATCH');
  requireValue(db.prepare('SELECT * FROM manager_instance WHERE singleton=1').get(), 'MISSING_LEDGER');
  const policy = db.prepare('SELECT policy_version FROM manager_instance WHERE singleton=1').get();
  requireValue(db.prepare('SELECT version FROM policy_revision WHERE version=?').get(Number(policy?.policy_version)), 'MISSING_LEDGER');
  requireValue(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'CORRUPT_REFERENCES');
  for (const row of db.prepare('SELECT * FROM input_snapshot').all()) {
    const snapshot = parse<InputSnapshot>(row);
    requireValue(snapshot.ref === row.ref && fingerprint(snapshot) === row.hash && Buffer.byteLength(encode(snapshot)) === row.bytes, 'CORRUPT_INPUT');
  }
  for (const table of ['eval', 'effect', 'internal_job', 'business_decision']) for (const row of db.prepare('SELECT body FROM ' + table).all()) {
    const evidence = parse<Evidence>(row);
    requireValue(db.prepare('SELECT hash FROM input_snapshot WHERE ref=?').get(evidence.inputSnapshotRef)?.hash === evidence.inputHash, 'MISSING_INPUT_LEDGER');
  }
  if (version === 2) {
    for (const row of db.prepare('SELECT * FROM native_audit_cursor').all()) {
      const registration = JSON.parse(String(row.registration)) as AuditSessionRegistration;
      requireValue(fingerprint(registration) === row.registration_hash && registration.sessionIdentity === row.session_identity && registration.sessionId === row.session_id, 'CORRUPT_AUDIT');
    }
    for (const row of db.prepare('SELECT * FROM native_request_audit').all()) {
      const basis = JSON.parse(String(row.basis)) as RequestAuditBasis;
      requireValue(fingerprint(basis) === row.basis_hash && (basis === null ? row.state === 'unknown' : basis.sessionIdentity === row.session_identity && same(basis.identity, identity)), 'CORRUPT_AUDIT');
      if (row.boundary !== null) requireValue(fingerprint(JSON.parse(String(row.boundary))) === row.boundary_hash, 'CORRUPT_AUDIT');
      if (row.state === 'verified') {
        const evidence = JSON.parse(String(row.evidence)) as Evidence;
        requireValue(row.settlement_seq !== null && row.event_hash && evidence.inputSnapshotRef === row.input_ref && evidence.inputHash === row.input_hash &&
          db.prepare('SELECT hash FROM input_snapshot WHERE ref=?').get(String(row.input_ref))?.hash === row.input_hash, 'CORRUPT_AUDIT');
      }
    }
  }
}
const terminalEffects = ['succeeded', 'dropped', 'revoked'];
interface Policy { resources: string[]; audiences: string[]; mandate: { actions: string[]; expiresAt: number | null }; proofRef: string }
export interface AuthorizationSnapshot {
  versions: Versions; lifecycle: string; policy: Policy;
  resources: { id: string; revision: number; workspaceId: string | null; repositoryId?: string }[];
}
interface Manager {
  revision: number; lifecycle: string; pin: boolean; sessionId: string | null; bindingState: string;
  workspaceId: string | null; preset: string | null; versions: Versions;
}
/** 单 Host 内部领域存储。没有任意 SQL/setter 或动态 grant；调用者鉴权由 B03/T03 负责。 */
export class StewardStore {
  readonly #db: DatabaseSync;
  #recoveryPending: boolean;
  #healthy = true;
  #transactionOpen = false;
  readonly #preparedAuditKeys = new Set<string>();
  readonly #liveAuditKeys = new Set<string>();
  private constructor(readonly path: string, readonly identity: Identity, db: DatabaseSync, existing: boolean) {
    this.#db = db; this.#recoveryPending = existing;
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  }
  /** 只允许可信运维在 Host 指定、Worker 不可写的位置首次调用；绝不自动回退到此入口。 */
  static initializeFresh(path: string, identity: Identity): StewardStore {
    requireValue(isAbsolute(path) && identity.instanceId && identity.domainId, 'INVALID_IDENTITY_OR_PATH');
    closeSync(openSync(path, 'wx', 0o600));
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
      db.exec(SCHEMA);
      db.prepare('INSERT INTO deployment VALUES(1,?,?,1,?)').run(identity.instanceId, identity.domainId, schemaFingerprint(db));
      db.exec("INSERT INTO manager_instance VALUES(1,0,'paused',1,NULL,'none',NULL,NULL,0,0,0,0)");
      db.prepare('INSERT INTO policy_revision VALUES(0,?)').run(encode({ resources: [], audiences: [], mandate: { actions: [], expiresAt: 0 }, proofRef: 'fresh-deny' }));
      db.exec('PRAGMA application_id=' + APPLICATION_ID + '; PRAGMA user_version=' + SCHEMA_VERSION + '; COMMIT;');
      return new StewardStore(path, identity, db, false);
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw e; }
  }
  static openExisting(path: string, identity: Identity): StewardStore {
    requireValue(isAbsolute(path), 'INVALID_PATH');
    const info = lstatSync(path); requireValue(info.isFile() && !info.isSymbolicLink() && info.size > 0, 'MISSING_OR_PARTIAL');
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      if (probe.prepare('PRAGMA user_version').get()?.user_version === 1) throw new StorageError('MIGRATION_REQUIRED');
      verifyDatabase(probe, identity, 2);
    } finally { probe.close(); }
    return new StewardStore(path, identity, new DatabaseSync(path), true);
  }
  /** 显式运维迁移；普通打开绝不自动调用，也不回退 fresh。 */
  static migrateV1ToV2(path: string, identity: Identity): { migrated: boolean; from: number; to: 2 } {
    requireValue(isAbsolute(path), 'INVALID_PATH');
    const original = lstatSync(path); requireValue(original.isFile() && !original.isSymbolicLink() && original.size > 0, 'MISSING_OR_PARTIAL');
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      const version = probe.prepare('PRAGMA user_version').get()?.user_version;
      if (version === 2) { verifyDatabase(probe, identity, 2); return { migrated: false, from: 2, to: 2 }; }
      verifyDatabase(probe, identity, 1);
    } finally { probe.close(); }
    const db = new DatabaseSync(path);
    let begun = false;
    try {
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;'); begun = true;
      const current = lstatSync(path); requireValue(current.dev === original.dev && current.ino === original.ino && !current.isSymbolicLink(), 'IDENTITY_MISMATCH');
      if (db.prepare('PRAGMA user_version').get()?.user_version === 2) {
        verifyDatabase(db, identity, 2); db.exec('COMMIT'); begun = false; return { migrated: false, from: 2, to: 2 };
      }
      verifyDatabase(db, identity, 1);
      const disk = statfsSync(dirname(path)); requireValue(disk.bavail * disk.bsize >= LIMITS.diskReserveBytes && current.size < LIMITS.dbBytes, 'CAPACITY_UNHEALTHY');
      db.exec(AUDIT_SCHEMA);
      requireValue(schemaFingerprint(db) === trustedSchema(2), 'SCHEMA_SHAPE_MISMATCH');
      db.prepare('UPDATE deployment SET schema_hash=? WHERE singleton=1 AND instance_id=? AND domain_id=?').run(trustedSchema(2), identity.instanceId, identity.domainId);
      db.exec('PRAGMA user_version=2');
      verifyDatabase(db, identity, 2);
      db.exec('COMMIT'); begun = false;
      return { migrated: true, from: 1, to: 2 };
    } catch (error) { if (begun) db.exec('ROLLBACK'); throw error; }
    finally { db.close(); }
  }
  close(): void { this.#db.close(); }
  diagnostics(): { journalMode: string; synchronous: number; foreignKeys: boolean; recoveryPending: boolean; healthy: boolean } {
    return { journalMode: String(this.#one('PRAGMA journal_mode')!.journal_mode), synchronous: Number(this.#one('PRAGMA synchronous')!.synchronous), foreignKeys: this.#one('PRAGMA foreign_keys')!.foreign_keys === 1, recoveryPending: this.#recoveryPending, healthy: this.#healthy };
  }
  /** 同步白名单观测；不修改授权、审计或游标，文件统计不冒充数据库快照。 */
  readHealthSummary(now: number): HealthSummary {
    requireValue(Number.isFinite(now), 'INVALID_TIME');
    this.#db.exec('BEGIN');
    let result: Omit<HealthSummary, 'capacity'>, artifactIndexedBytes: number;
    try {
      const counts = (table: 'eval' | 'internal_job' | 'effect'): Record<string, number> =>
        Object.fromEntries(this.#all('SELECT state,count(*) AS n FROM ' + table + ' GROUP BY state').map(row => [String(row.state), Number(row.n)]));
      const queue = (control: number) => {
        const row = this.#one("SELECT coalesce(sum(json_array_length(body,'$.candidates')),0) AS items,coalesce(sum(bytes),0) AS bytes,min(queued_at) AS oldest FROM eval WHERE control=? AND state IN ('queued','dispatching','delivered','paused','retry_wait')", control)!;
        return { items: Number(row.items), bytes: Number(row.bytes), oldestQueuedAt: row.oldest === null ? null : Number(row.oldest) };
      };
      const evalPredicate = "state IN ('queued','dispatching','delivered','paused','retry_wait','unavailable')";
      const evalTotal = Number(this.#one('SELECT count(*) AS n FROM eval WHERE ' + evalPredicate)!.n);
      const evals = this.#all('SELECT * FROM eval WHERE ' + evalPredicate + ' ORDER BY queued_at,id LIMIT 288').map(row => ({
        id: String(row.id), revision: Number(row.revision), state: String(row.state), attempt: Number(row.attempt), control: row.control === 1,
        queuedAt: Number(row.queued_at), deadlineBasis: row.deadline_basis === null ? null : String(row.deadline_basis),
        deadline: row.deadline === null ? null : Number(row.deadline), remainingMs: Number(row.remaining),
        threadKeys: [...new Set(parse<EvalRequest>(row).candidates.map(c => c.threadKey))],
      }));
      const jobPredicate = "state IN ('running','unknown')";
      const jobTotal = Number(this.#one('SELECT count(*) AS n FROM internal_job WHERE ' + jobPredicate)!.n);
      const jobs = this.#all('SELECT * FROM internal_job WHERE ' + jobPredicate + ' ORDER BY started_at,id LIMIT 2').map(row => ({
        id: String(row.id), state: String(row.state), attempt: Number(row.attempt), cancelGeneration: Number(row.cancel_generation),
        released: row.released === 1, startedAt: row.started_at === null ? null : Number(row.started_at),
        deadline: row.started_at === null ? null : Number(row.started_at) + parse<JobRequest>(row).budget.deadlineMs,
      }));
      const effects = counts('effect');
      const pending = Number(this.#one("SELECT count(*) AS n FROM native_request_audit WHERE state!='verified'")!.n) +
        Number(this.#one('SELECT count(*) AS n FROM input_snapshot i WHERE NOT EXISTS(SELECT 1 FROM native_request_audit a WHERE a.input_ref=i.ref)')!.n);
      const scopes = this.#all('SELECT session_id,inspected_offset,prefix_hash FROM native_audit_cursor WHERE inspected_offset>0 ORDER BY session_id').map(row => ({
        sessionId: String(row.session_id), offset: Number(row.inspected_offset), prefixHash: String(row.prefix_hash),
      }));
      artifactIndexedBytes = Number(this.#one('SELECT coalesce(sum(bytes),0) AS n FROM artifact_index WHERE tombstone IS NULL')!.n);
      result = {
        sampledAt: now, manager: this.manager(), diagnostics: this.diagnostics(), queues: { normal: queue(0), control: queue(1) },
        evals: { counts: counts('eval'), active: evals, limit: 288, truncated: evalTotal > 288, reason: evalTotal > 288 ? 'ACTIVE_EVAL_LIMIT_EXCEEDED' : null },
        jobs: { counts: counts('internal_job'), occupied: Number(this.#one("SELECT count(*) AS n FROM internal_job WHERE state IN ('running','unknown') AND released=0")!.n),
          active: jobs, limit: 2, truncated: jobTotal > 2, reason: jobTotal > 2 ? 'ACTIVE_JOB_LIMIT_EXCEEDED' : null },
        effects: { unknown: effects.unknown ?? 0, pending: effects.pending ?? 0, retryWait: effects.retry_wait ?? 0 },
        audit: { status: pending === 0 && scopes.length > 0 ? 'verified_scope' : 'pending', pending,
          reason: pending ? '含未核请求或旧输入；不得驱动业务' : scopes.length ? '仅表示所列固定日志范围；不代表完整E37或远端执行通过' : '尚无已核日志范围；pending为零不代表完整审计',
          verifiedScope: scopes },
      };
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    const reasons: HealthSummary['capacity']['reasons'] = { dbBytes: null, walBytes: null, diskAvailableBytes: null };
    const size = (path: string, key: 'dbBytes' | 'walBytes'): number | null => {
      try { return statSync(path).size; } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'STAT_FAILED'; reasons[key] = code;
        return key === 'walBytes' && code === 'ENOENT' ? 0 : null;
      }
    };
    const observedAt = Date.now(), dbBytes = size(this.path, 'dbBytes'), walBytes = size(this.path + '-wal', 'walBytes');
    let diskAvailableBytes: number | null = null;
    try { const disk = statfsSync(dirname(this.path)); diskAvailableBytes = disk.bavail * disk.bsize; }
    catch (error) { reasons.diskAvailableBytes = (error as NodeJS.ErrnoException).code ?? 'STATFS_FAILED'; }
    return { ...result!, capacity: { observedAt, dbBytes, walBytes, artifactIndexedBytes: artifactIndexedBytes!, diskAvailableBytes, reasons } };
  }
  #one(sql: string, ...args: SQLInputValue[]): Row | undefined { return this.#db.prepare(sql).get(...args); }
  #all(sql: string, ...args: SQLInputValue[]): Row[] { return this.#db.prepare(sql).all(...args); }
  #run(sql: string, ...args: SQLInputValue[]): number { return Number(this.#db.prepare(sql).run(...args).changes); }
  #transaction<T>(fn: () => T): T {
    requireValue(!this.#transactionOpen, 'NESTED_WRITE_TRANSACTION');
    this.#db.exec('BEGIN IMMEDIATE'); this.#transactionOpen = true;
    try { const result = fn(); this.#db.exec('COMMIT'); return result; }
    catch (e) { this.#db.exec('ROLLBACK'); throw e; }
    finally { this.#transactionOpen = false; }
  }
  #audit(kind: string, body: unknown): void { this.#run('INSERT INTO audit(kind,body) VALUES(?,?)', kind, encode(body)); }
  #capacity(): void {
    const disk = statfsSync(dirname(this.path));
    const bytes = [this.path, this.path + '-wal'].reduce((n, p) => { try { return n + statSync(p).size; } catch { return n; } }, 0);
    requireValue(disk.bavail * disk.bsize >= LIMITS.diskReserveBytes && bytes < LIMITS.dbBytes, 'CAPACITY_UNHEALTHY');
  }
  manager(): Manager {
    const r = this.#one('SELECT * FROM manager_instance WHERE singleton=1')!;
    return { revision: Number(r.revision), lifecycle: String(r.lifecycle), pin: r.pin === 1, sessionId: r.session_id === null ? null : String(r.session_id),
      bindingState: String(r.binding_state), workspaceId: r.workspace_id === null ? null : String(r.workspace_id), preset: r.preset === null ? null : String(r.preset),
      versions: { policyVersion: Number(r.policy_version), scopeVersion: Number(r.scope_version), stopEpoch: Number(r.stop_epoch), intentRevision: Number(r.intent_revision) } };
  }
  /** 同一读取快照内的授权来源白名单；不授予动态权限，不暴露凭据或写入口。 */
  readAuthorizationSnapshot(): AuthorizationSnapshot {
    const ownSnapshot = !this.#transactionOpen;
    if (ownSnapshot) this.#db.exec('BEGIN');
    try {
      const manager = this.#one('SELECT * FROM manager_instance WHERE singleton=1');
      requireValue(manager, 'MISSING_LEDGER');
      const versions: Versions = { policyVersion: Number(manager!.policy_version), scopeVersion: Number(manager!.scope_version), stopEpoch: Number(manager!.stop_epoch), intentRevision: Number(manager!.intent_revision) };
      requireValue(Object.values(versions).every(v => Number.isSafeInteger(v) && v >= 0), 'INVALID_AUTHORIZATION_RECORD');
      const lifecycle = String(manager!.lifecycle);
      requireValue(['running', 'paused', 'stopped'].includes(lifecycle), 'INVALID_AUTHORIZATION_RECORD');
      const row = this.#one('SELECT body FROM policy_revision WHERE version=?', versions.policyVersion);
      requireValue(row, 'MISSING_LEDGER');
      const policy = parse<Policy>(row!);
      const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string' && v.length > 0);
      requireValue(policy && strings(policy.resources) && strings(policy.audiences) && policy.mandate && strings(policy.mandate.actions) && (policy.mandate.expiresAt === null || (typeof policy.mandate.expiresAt === 'number' && Number.isFinite(policy.mandate.expiresAt))) && typeof policy.proofRef === 'string' && policy.proofRef.length > 0, 'INVALID_AUTHORIZATION_RECORD');
      const resources = [...new Set(policy.resources)].map(id => {
        const resource = this.#one('SELECT revision,body FROM resource_binding WHERE id=?', id);
        requireValue(resource, 'RESOURCE_MISSING');
        const binding = parse<{ workspaceId: string | null; repositoryId?: string }>(resource!);
        requireValue(binding && (binding.workspaceId === null || typeof binding.workspaceId === 'string') && (binding.repositoryId === undefined || typeof binding.repositoryId === 'string') && Number.isSafeInteger(resource!.revision) && Number(resource!.revision) > 0, 'INVALID_AUTHORIZATION_RECORD');
        return { id, revision: Number(resource!.revision), workspaceId: binding.workspaceId, ...(binding.repositoryId === undefined ? {} : { repositoryId: binding.repositoryId }) };
      });
      const snapshot = { versions, lifecycle, policy: { resources: [...policy.resources], audiences: [...policy.audiences], mandate: { actions: [...policy.mandate.actions], expiresAt: policy.mandate.expiresAt }, proofRef: policy.proofRef }, resources };
      if (ownSnapshot) this.#db.exec('COMMIT');
      return snapshot;
    } catch (error) { if (ownSnapshot) this.#db.exec('ROLLBACK'); throw error; }
  }
  #versions(expected: Versions): void { requireValue(same(this.manager().versions, expected), 'VERSION_CONFLICT'); }
  #managerCAS(revision: number): void { requireValue(this.manager().revision === revision, 'REVISION_CONFLICT'); }
  reserveManager(revision: number, sessionId: string, workspaceId: string, preset: string): Manager {
    return this.#transaction(() => {
      this.#managerCAS(revision); requireValue(this.manager().bindingState === 'none' && sessionId && workspaceId && preset, 'BINDING_EXISTS');
      this.#run("UPDATE manager_instance SET session_id=?,workspace_id=?,preset=?,binding_state='reserved',revision=revision+1 WHERE singleton=1", sessionId, workspaceId, preset);
      this.#audit('manager-reserved', { sessionId, workspaceId, preset }); return this.manager();
    });
  }
  beginManagerCreate(revision: number): Manager {
    return this.#transaction(() => { this.#managerCAS(revision); requireValue(this.manager().bindingState === 'reserved', 'MANAGER_RECONCILE_REQUIRED');
      this.#run("UPDATE manager_instance SET binding_state='unknown',revision=revision+1 WHERE singleton=1"); this.#audit('manager-create-unknown', this.manager()); return this.manager(); });
  }
  bindManager(revision: number, observed: { sessionId: string; workspaceId: string; preset: string; nativeLogRef: string; nativeIdentity?: string }): Manager {
    return this.#transaction(() => {
      this.#managerCAS(revision); const m = this.manager();
      requireValue(['reserved', 'unknown'].includes(m.bindingState) && observed.nativeLogRef && m.sessionId === observed.sessionId && m.workspaceId === observed.workspaceId && m.preset === observed.preset, 'BINDING_MISMATCH');
      this.#run("UPDATE manager_instance SET binding_state='bound',revision=revision+1 WHERE singleton=1"); this.#audit('manager-bound', observed); return this.manager();
    });
  }
  managerBinding(): { sessionId: string; workspaceId: string; preset: string; nativeLogRef: string; nativeIdentity?: string } | undefined {
    const row = this.#one("SELECT body FROM audit WHERE kind='manager-bound' ORDER BY seq DESC LIMIT 1");
    return row && parse(row);
  }
  #mayAuditSession(sessionId: string, workspaceId: string, foreground?: true, worker?: true): boolean {
    const manager = this.manager();
    return manager.lifecycle === 'running' || (manager.lifecycle === 'paused' && manager.bindingState === 'bound' &&
      ((foreground === true && manager.sessionId === sessionId && manager.workspaceId === workspaceId) ||
        (worker === true && manager.workspaceId === workspaceId)));
  }
  recordLifecycle(revision: number, next: 'running' | 'paused', pin: boolean): Manager {
    return this.#transaction(() => { this.#managerCAS(revision); const m = this.manager();
      requireValue(this.#healthy && !this.#recoveryPending && m.lifecycle !== 'stopped', 'RECOVERY_OR_STOPPED');
      this.#run('UPDATE manager_instance SET lifecycle=?,pin=?,revision=revision+1 WHERE singleton=1', next, Number(pin));
      this.#audit('lifecycle', { next, pin }); return this.manager(); });
  }
  stop(revision: number, reason: string): Manager {
    try { return this.#transaction(() => { this.#managerCAS(revision);
      this.#run("UPDATE manager_instance SET lifecycle='stopped',stop_epoch=stop_epoch+1,revision=revision+1 WHERE singleton=1");
      this.#run("UPDATE effect SET state='revoked' WHERE state IN ('pending','retry_wait')");
      this.#run("UPDATE internal_job SET state='cancelled',cancel_generation=cancel_generation+1,released=1 WHERE state IN ('queued','running','unknown')");
      this.#audit('stop-tombstone', { reason, versions: this.manager().versions }); return this.manager(); });
    } catch (error) { if (!(error instanceof StorageError)) this.#healthy = false; throw error; }
  }
  reopenScope(revision: number, expectedScope: number, proofRef: string): Manager {
    return this.#transaction(() => { this.#managerCAS(revision); requireValue(this.manager().versions.scopeVersion === expectedScope && proofRef, 'SCOPE_CONFLICT');
      this.#run("UPDATE manager_instance SET lifecycle='paused',scope_version=scope_version+1,revision=revision+1 WHERE singleton=1");
      this.#audit('scope-reopened', { proofRef }); return this.manager(); });
  }
  appendPolicy(expectedVersion: number, policy: Policy): number {
    return this.#transaction(() => { requireValue(this.manager().versions.policyVersion === expectedVersion && policy.proofRef, 'POLICY_CONFLICT');
      const version = expectedVersion + 1; this.#run('INSERT INTO policy_revision VALUES(?,?)', version, encode(policy));
      this.#run('UPDATE manager_instance SET policy_version=?,revision=revision+1 WHERE singleton=1', version);
      this.#run("UPDATE search_index SET invalidated=1 WHERE json_extract(body,'$.kind')='summary'");
      this.#audit('policy-revision', { version, proofRef: policy.proofRef });
      return version; });
  }
  recordVerifiedActor(actorId: string, proofRef: string, identity: { source: string; externalId: string }): void {
    this.#transaction(() => { requireValue(proofRef && actorId && identity.source && identity.externalId, 'ACTOR_PROOF_REQUIRED');
      const old = this.#one('SELECT * FROM verified_actor WHERE actor_id=?', actorId);
      if (old) requireValue(old.proof_ref === proofRef && same(parse(old), identity), 'ACTOR_CONFLICT');
      else this.#run('INSERT INTO verified_actor VALUES(?,?,?)', actorId, proofRef, encode(identity)); });
  }
  appendDecision(input: Evidence & { id: string; actorId: string; sourceMessageRef: string; expectedIntent: number; policyVersion: number; scopeVersion: number; stopEpoch: number; supersedesId?: string; decision: string }): number {
    return this.#transaction(() => { const old = this.#one('SELECT * FROM business_decision WHERE id=?', input.id);
      if (old) {
        requireValue(same(parse(old), input) && Number.isSafeInteger(input.expectedIntent) && old.intent_revision === input.expectedIntent + 1, 'DECISION_CONFLICT');
        const row = this.#one('SELECT * FROM input_snapshot WHERE ref=?', input.inputSnapshotRef);
        requireValue(row?.hash === input.inputHash, 'INPUT_BINDING_MISMATCH');
        const snapshot = parse<InputSnapshot>(row!);
        requireValue(snapshot && snapshot.ref === input.inputSnapshotRef && fingerprint(snapshot) === row!.hash && Buffer.byteLength(encode(snapshot)) === row!.bytes, 'CORRUPT_INPUT');
        return Number(old.intent_revision);
      }
      const v = this.manager().versions; this.#evidence(input);
      this.#versions({ policyVersion: input.policyVersion, scopeVersion: input.scopeVersion, stopEpoch: input.stopEpoch, intentRevision: input.expectedIntent });
      requireValue(v.intentRevision === input.expectedIntent && v.policyVersion === input.policyVersion && input.sourceMessageRef && this.#one('SELECT * FROM verified_actor WHERE actor_id=?', input.actorId), 'DECISION_CONFLICT');
      if (v.intentRevision > 0) requireValue(input.supersedesId && this.#one('SELECT id FROM business_decision WHERE id=? AND intent_revision=?', input.supersedesId, v.intentRevision), 'EXPLICIT_SUPERSESSION_REQUIRED');
      this.#run('INSERT INTO business_decision VALUES(?,?,?)', input.id, v.intentRevision + 1, encode(input));
      this.#run('UPDATE manager_instance SET intent_revision=intent_revision+1,revision=revision+1 WHERE singleton=1'); this.#audit('decision', input); return v.intentRevision + 1;
    });
  }
  registerResource(id: string, binding: { workspaceId: string | null; repositoryId?: string; credentialRef?: string }): void {
    this.#transaction(() => { const old = this.#one('SELECT * FROM resource_binding WHERE id=?', id);
      if (old) requireValue(same(parse(old), binding), 'RESOURCE_CONFLICT'); else this.#run('INSERT INTO resource_binding VALUES(?,1,?)', id, encode(binding)); });
  }
  registerSource(id: string, stableKey: string, resourceId: string): void {
    this.#transaction(() => { const old = this.#one('SELECT * FROM source_instance WHERE id=?', id);
      if (old) requireValue(old.stable_key === stableKey && old.resource_id === resourceId, 'SOURCE_CONFLICT');
      else this.#run("INSERT INTO source_instance VALUES(?,?,?,1,'')", id, stableKey, resourceId); });
  }
  source(id: string): { revision: number; cursor: string } {
    const r = this.#one('SELECT * FROM source_instance WHERE id=?', id); requireValue(r, 'SOURCE_MISSING');
    return { revision: Number(r!.revision), cursor: String(r!.cursor) };
  }
  #insertInput(snapshot: InputSnapshot): { ref: string; hash: string } {
    const body = encode(snapshot); requireValue(Buffer.byteLength(body) <= LIMITS.inputBytes, 'INPUT_LIMIT');
    const hash = fingerprint(snapshot), old = this.#one('SELECT * FROM input_snapshot WHERE ref=?', snapshot.ref);
    if (old) requireValue(old.hash === hash && old.body === body && old.bytes === Buffer.byteLength(body), 'IMMUTABLE_INPUT_CONFLICT');
    else this.#run('INSERT INTO input_snapshot VALUES(?,?,?,?)', snapshot.ref, hash, Buffer.byteLength(body), body);
    return { ref: snapshot.ref, hash };
  }
  saveInput(snapshot: InputSnapshot): { ref: string; hash: string } {
    return this.#transaction(() => { this.#capacity(); return this.#insertInput(snapshot); });
  }
  readExecutionAuditGeneration(taskId: string, executionId: string): number | undefined {
    const row = this.#one('SELECT e.generation FROM execution_ref e JOIN coordination c ON c.board_task_id=e.board_task_id AND c.execution_id=e.execution_id AND c.execution_generation=e.generation WHERE e.board_task_id=? AND e.execution_id=?', taskId, executionId);
    return row && Number.isSafeInteger(row.generation) ? Number(row.generation) : undefined;
  }
  registerAuditSession(registration: AuditSessionRegistration, currentAuthority: () => boolean, foreground?: true, worker?: true): void {
    this.#transaction(() => {
      this.#capacity(); requireValue(!this.#recoveryPending && this.#healthy && this.#mayAuditSession(registration.sessionId, registration.workspaceId, foreground, worker) && currentAuthority() === true, 'CURRENT_AUTHORITY_REQUIRED');
      requireValue(registration.sessionId && registration.header.id === registration.sessionId && registration.header.version === registration.formatVersion &&
        registration.sessionIdentity === fingerprint({ header: registration.header, inheritedEventCount: registration.inheritedEventCount }) &&
        Number.isSafeInteger(registration.inheritedEventCount) && registration.inheritedEventCount >= 0 && registration.workspaceId &&
        registration.projectionId && registration.formatVersion === 4 && registration.serializer === 'e37-json-v1', 'AUDIT_IDENTITY_REQUIRED');
      const body = encode(registration), hash = fingerprint(registration);
      requireValue(Buffer.byteLength(body) <= LIMITS.inputBytes, 'INPUT_LIMIT');
      const old = this.#one('SELECT * FROM native_audit_cursor WHERE session_identity=? OR session_id=?', registration.sessionIdentity, registration.sessionId);
      if (old) requireValue(old.registration_hash === hash && old.registration === body, 'AUDIT_SESSION_CONFLICT');
      else this.#run('INSERT INTO native_audit_cursor VALUES(?,?,?,?,0,?,0)', registration.sessionIdentity, registration.sessionId, hash, body, fingerprint([]));
    });
  }
  readAuditCursor(sessionIdentity: string): NativeAuditCursor {
    const row = this.#one('SELECT * FROM native_audit_cursor WHERE session_identity=?', sessionIdentity); requireValue(row, 'AUDIT_SESSION_UNREGISTERED');
    return { registration: JSON.parse(String(row!.registration)), offset: Number(row!.inspected_offset), prefixHash: String(row!.prefix_hash), revision: Number(row!.revision) };
  }
  listAuditSessions(): AuditSessionRegistration[] {
    return this.#all('SELECT registration FROM native_audit_cursor ORDER BY session_id').map(row => JSON.parse(String(row.registration)) as AuditSessionRegistration);
  }
  #requestAudit(row: Row): RequestAuditRecord {
    return { key: String(row.request_key), basis: JSON.parse(String(row.basis)),
      ...(row.boundary === null ? {} : { boundary: JSON.parse(String(row.boundary)) }),
      ...(row.settlement_seq === null ? {} : { settlementSeq: Number(row.settlement_seq), eventHash: String(row.event_hash) }),
      state: row.state as RequestAuditRecord['state'], eligibility: row.eligibility as RequestAuditRecord['eligibility'],
      ...(row.evidence === null ? {} : { evidence: JSON.parse(String(row.evidence)) }), reason: String(row.reason), revision: Number(row.revision) };
  }
  readRequestAudit(key: string): RequestAuditRecord | undefined {
    const row = this.#one('SELECT * FROM native_request_audit WHERE request_key=?', key); return row && this.#requestAudit(row);
  }
  pendingRequestAudits(sessionIdentity: string, afterKey = ''): RequestAuditRecord[] {
    this.readAuditCursor(sessionIdentity);
    return this.#all("SELECT * FROM native_request_audit WHERE session_identity=? AND state!='verified' AND basis!='null' AND request_key>? ORDER BY request_key LIMIT 256", sessionIdentity,afterKey).map(row => this.#requestAudit(row));
  }
  auditedSettlement(sessionIdentity: string, seq: number): RequestAuditRecord | undefined {
    const row = this.#one('SELECT * FROM native_request_audit WHERE session_identity=? AND settlement_seq=?', sessionIdentity, seq); return row && this.#requestAudit(row);
  }
  prepareRequestAudit(basis: RequestAuditBasis, currentAuthority: () => boolean): string {
    const key = basis.basisKey + '/0';
    const created = this.#transaction(() => {
      this.#capacity(); requireValue(!this.#recoveryPending && this.#healthy && this.#mayAuditSession(basis.sessionId, basis.workspaceId, basis.foreground, basis.executionId !== undefined ? true : undefined) && currentAuthority() === true, 'CURRENT_AUTHORITY_REQUIRED');
      this.#versions(basis.versions);
      const cursor = this.readAuditCursor(basis.sessionIdentity);
      requireValue(same(basis.identity, this.identity) && cursor.registration.sessionId === basis.sessionId && cursor.registration.workspaceId === basis.workspaceId &&
        basis.basisKey && basis.leaseFingerprint && basis.promptPackageVersion && basis.promptPackageHash &&
        [basis.turn,basis.step,basis.stepOffset].every(n => Number.isSafeInteger(n) && n >= 0) &&
        Array.isArray(basis.messageIds) && basis.messageIds.every(id => typeof id === 'string' && id.length > 0) &&
        (basis.executionId === undefined ? basis.taskId === undefined && basis.executionGeneration === undefined :
          !!basis.taskId && Number.isSafeInteger(basis.executionGeneration) && basis.executionGeneration! >= 0), 'AUDIT_BASIS_REQUIRED');
      const body = encode(basis); requireValue(Buffer.byteLength(body) <= LIMITS.inputBytes, 'INPUT_LIMIT');
      const old = this.#one('SELECT * FROM native_request_audit WHERE request_key=?', key);
      if (old) { requireValue(old.basis_hash === fingerprint(basis) && old.basis === body, 'IMMUTABLE_AUDIT_CONFLICT'); return false; }
      requireValue(Number(this.#one("SELECT count(*) AS n FROM native_request_audit WHERE session_identity=? AND state='prepared'",basis.sessionIdentity)!.n) < LIMITS.queueItems,'AUDIT_PREPARED_CAPACITY');
      this.#run("INSERT INTO native_request_audit VALUES(?,?,?,?,NULL,NULL,NULL,NULL,'prepared','audit-only',NULL,NULL,NULL,'等待原生请求边界',0)", key, basis.sessionIdentity, fingerprint(basis), body);
      requireValue(currentAuthority() === true, 'CURRENT_AUTHORITY_REQUIRED'); return true;
    });
    if (created) this.#preparedAuditKeys.add(key); return key;
  }
  bindRequestBoundary(basisKey: string, boundary: RequestAuditBoundary, currentAuthority: () => boolean): string {
    const key = basisKey + '/' + boundary.attempt;
    this.#transaction(() => {
      this.#capacity();
      const basisRow = this.readRequestAudit(basisKey + '/0'), basis = basisRow?.basis;
      requireValue(basis && this.#preparedAuditKeys.has(basisKey + '/0') && currentAuthority() === true &&
        !this.#recoveryPending && this.#healthy && this.#mayAuditSession(basis.sessionId, basis.workspaceId, basis.foreground, basis.executionId !== undefined ? true : undefined), 'CURRENT_AUTHORITY_REQUIRED');
      this.#versions(basis!.versions);
      requireValue(boundary.turn === basis!.turn && boundary.step === basis!.step && boundary.requestHash &&
        Number.isSafeInteger(boundary.attempt) && boundary.attempt >= 0 && Number.isSafeInteger(boundary.boundaryOffset) &&
        boundary.boundaryOffset >= basis!.stepOffset, 'REQUEST_BOUNDARY_REQUIRED');
      let row = this.#one('SELECT * FROM native_request_audit WHERE request_key=?', key);
      if (!row) {
        requireValue(boundary.attempt > 0 && this.readRequestAudit(basisKey + '/' + (boundary.attempt - 1))?.boundary, 'ATTEMPT_ORDER_REQUIRED');
        this.#run("INSERT INTO native_request_audit VALUES(?,?,?,?,NULL,NULL,NULL,NULL,'prepared','audit-only',NULL,NULL,NULL,'等待原生请求边界',0)", key, basis!.sessionIdentity, fingerprint(basis), encode(basis));
        row = this.#one('SELECT * FROM native_request_audit WHERE request_key=?', key)!;
      }
      const body = encode(boundary), hash = fingerprint(boundary);
      if (row.boundary !== null) requireValue(row.boundary_hash === hash && row.boundary === body, 'IMMUTABLE_AUDIT_CONFLICT');
      else {
        requireValue(row.state === 'prepared', 'AUDIT_NOT_PREPARED');
        this.#run("UPDATE native_request_audit SET boundary_hash=?,boundary=?,reason='请求已构造；发送结果尚未知',revision=revision+1 WHERE request_key=?", hash, body, key);
      }
      requireValue(currentAuthority() === true, 'CURRENT_AUTHORITY_REQUIRED');
    });
    this.#preparedAuditKeys.add(key); return key;
  }
  /** 唯一补账写事务；调用方必须先核原生日志固定前缀，恢复绝不授予 live。 */
  commitRequestAuditBatch(sessionIdentity: string, expected: { revision: number; offset: number; prefixHash: string },
    next: { offset: number; prefixHash: string }, facts: readonly NativeAuditFact[],
    liveAuthority?: (basis: RequestAuditBasis) => boolean): Evidence[] {
    const liveKeys: string[] = [];
    const evidence = this.#transaction(() => {
      this.#capacity(); const cursor = this.readAuditCursor(sessionIdentity);
      requireValue(cursor.revision === expected.revision && cursor.offset === expected.offset && cursor.prefixHash === expected.prefixHash, 'AUDIT_CURSOR_CONFLICT');
      requireValue(Number.isSafeInteger(next.offset) && next.offset >= cursor.offset && next.prefixHash &&
        (next.offset !== cursor.offset || next.prefixHash === cursor.prefixHash) && facts.length <= LIMITS.queueItems * 2, 'AUDIT_PREFIX_CONFLICT');
      const results: Evidence[] = [];
      for (const fact of facts) {
        let row = this.#one('SELECT * FROM native_request_audit WHERE request_key=?', fact.key);
        if (!row) {
          requireValue(fact.reason && fact.request === undefined, 'AUDIT_BASIS_MISSING');
          this.#run("INSERT INTO native_request_audit VALUES(?,?,?,? ,NULL,NULL,NULL,NULL,'unknown','audit-only',NULL,NULL,NULL,?,0)",
            fact.key, sessionIdentity, fingerprint(null), 'null', fact.reason!);
          row = this.#one('SELECT * FROM native_request_audit WHERE request_key=?', fact.key)!;
        }
        requireValue(row.session_identity === sessionIdentity, 'AUDIT_SESSION_CONFLICT');
        const audit = this.#requestAudit(row);
        if (fact.settlementSeq !== undefined) {
          requireValue(Number.isSafeInteger(fact.settlementSeq) && fact.settlementSeq >= 0 && fact.settlementSeq < next.offset && fact.eventHash, 'AUDIT_SETTLEMENT_REQUIRED');
          if (audit.settlementSeq !== undefined) requireValue(audit.settlementSeq === fact.settlementSeq && audit.eventHash === fact.eventHash, 'IMMUTABLE_AUDIT_CONFLICT');
        }
        if (!fact.request) {
          requireValue(fact.reason && audit.state !== 'verified', 'AUDIT_UNKNOWN_REASON_REQUIRED');
          this.#run("UPDATE native_request_audit SET state='unknown',eligibility='audit-only',settlement_seq=coalesce(settlement_seq,?),event_hash=coalesce(event_hash,?),reason=?,revision=revision+1 WHERE request_key=?",
            fact.settlementSeq ?? null, fact.eventHash ?? null, fact.reason!, fact.key); continue;
        }
        const basis = audit.basis, boundary = audit.boundary, request = fact.request;
        requireValue(basis && boundary && fact.settlementSeq !== undefined && fact.settlementSeq >= boundary.boundaryOffset &&
          (fact.settlementType === 'assistant/message' || fact.settlementType === 'assistant/attempt') &&
          fingerprint(request) === boundary.requestHash, 'REQUEST_INPUT_MISMATCH');
        const config = request.config;
        requireValue(config.provider && config.model && Number.isSafeInteger(config.maxTokens) && config.maxTokens > 0 &&
          (!request.adapterDefaults.reasoningEffort || config.reasoningEffort) && Array.isArray(request.messages) && Array.isArray(request.toolHistory.tools), 'REQUEST_CONFIG_MISSING');
        const seq = fact.settlementSeq!, nativeLogRef = 'session:' + basis!.sessionId + ':' + (fact.settlementType === 'assistant/message' ? 'assistant' : 'attempt') + ':' + seq;
        const snapshot = this.#insertInput({ ref: 'native-request/' + basis!.sessionId + '/' + seq,
          sourceWatermark: 'session:' + basis!.sessionId + ':through:' + seq,
          headers: { system: JSON.stringify(request.messages.filter(m => m.role === 'system')),
            developer: JSON.stringify({ text: JSON.stringify(request.messages.filter(m => m.role === 'developer')), nativeLogRef,
              config, adapterDefaults: request.adapterDefaults, versions: basis!.versions, taskId: basis!.taskId, executionId: basis!.executionId }),
            user: JSON.stringify(request.messages.filter(m => !['system','developer'].includes(m.role))), tools: JSON.stringify(request.toolHistory.tools) } });
        const e: Evidence = { backend: 'native', provider: config.provider, model: config.model, effort: config.reasoningEffort ?? 'not-configured',
          maxTokens: config.maxTokens, promptPackageVersion: basis!.promptPackageVersion, promptPackageHash: basis!.promptPackageHash,
          inputSnapshotRef: snapshot.ref, inputHash: snapshot.hash };
        if (audit.state === 'verified') { requireValue(same(audit.evidence,e) && audit.eventHash === fact.eventHash, 'IMMUTABLE_AUDIT_CONFLICT'); continue; }
        const live = audit.state === 'prepared' && fact.settlementType === 'assistant/message' && this.#preparedAuditKeys.has(fact.key) &&
          !this.#recoveryPending && this.#healthy && this.manager().lifecycle === 'running' && same(basis!.versions,this.manager().versions) && liveAuthority?.(basis!) === true;
        this.#run("UPDATE native_request_audit SET settlement_seq=?,event_hash=?,state='verified',eligibility=?,input_ref=?,input_hash=?,evidence=?,reason=?,revision=revision+1 WHERE request_key=?",
          seq, fact.eventHash!, live ? 'live' : 'audit-only', snapshot.ref, snapshot.hash, encode(e), live ? '本进程当前准入与实际请求已核' : '历史输入已核；不恢复动态授权', fact.key);
        if (live) liveKeys.push(fact.key); results.push(e);
      }
      if (next.offset !== cursor.offset || facts.length > 0) requireValue(this.#run('UPDATE native_audit_cursor SET inspected_offset=?,prefix_hash=?,revision=revision+1 WHERE session_identity=? AND revision=?',
        next.offset,next.prefixHash,sessionIdentity,expected.revision) === 1, 'AUDIT_CURSOR_CONFLICT');
      for (const key of liveKeys) requireValue(liveAuthority?.(this.readRequestAudit(key)!.basis!) === true, 'CURRENT_AUTHORITY_REQUIRED');
      return results;
    });
    for (const key of liveKeys) this.#liveAuditKeys.add(key); return evidence;
  }
  #isCurrentEvidence(e: Evidence): boolean {
    try { this.#evidence(e); return true; } catch (error) { if (error instanceof StorageError) return false; throw error; }
  }
  #evidence(e: Evidence): void {
    requireValue(e.backend === 'native' && e.provider && e.model && e.effort && e.promptPackageVersion && e.promptPackageHash && Number.isInteger(e.maxTokens) && e.maxTokens > 0, 'EVIDENCE_REQUIRED');
    requireValue(this.#one('SELECT hash FROM input_snapshot WHERE ref=?', e.inputSnapshotRef)?.hash === e.inputHash, 'INPUT_BINDING_MISMATCH');
    const row = this.#one("SELECT * FROM native_request_audit WHERE input_ref=? AND input_hash=? AND state='verified' AND eligibility='live'", e.inputSnapshotRef, e.inputHash);
    const audit = row && this.#requestAudit(row), bound = audit?.evidence;
    requireValue(audit?.basis && bound && this.#liveAuditKeys.has(audit.key) && !this.#recoveryPending && this.#healthy &&
      this.manager().lifecycle === 'running' && same(audit.basis.versions,this.manager().versions) &&
      (audit.basis.executionId === undefined || this.readExecutionAuditGeneration(audit.basis.taskId!,audit.basis.executionId) === audit.basis.executionGeneration) &&
      same(bound, { backend: e.backend,provider:e.provider,model:e.model,effort:e.effort,maxTokens:e.maxTokens,
        promptPackageVersion:e.promptPackageVersion,promptPackageHash:e.promptPackageHash,inputSnapshotRef:e.inputSnapshotRef,inputHash:e.inputHash }), 'AUDIT_EVIDENCE_NOT_CURRENT');
  }
  acceptEval(sourceId: string, expectedRevision: number, nextCursor: string, request: EvalRequest): void {
    this.#transaction(() => {
      this.#capacity(); this.#versions(request.versions); this.#evidence(request);
      const source = this.#one('SELECT * FROM source_instance WHERE id=?', sourceId); requireValue(source && source.revision === expectedRevision, 'SOURCE_CONFLICT');
      const existing = this.#one('SELECT * FROM eval WHERE id=?', request.evalId);
      if (existing) { requireValue(same(parse(existing), request), 'EVAL_CONFLICT'); return; }
      requireValue(request.candidates.length > 0 && request.candidates.length <= LIMITS.batchItems, 'BATCH_LIMIT');
      const bytes = Buffer.byteLength(encode(request)) + Number(this.#one('SELECT bytes FROM input_snapshot WHERE ref=?', request.inputSnapshotRef)!.bytes);
      const control = Number(request.control); const q = this.#one("SELECT coalesce(sum(json_array_length(body,'$.candidates')),0) AS n,coalesce(sum(bytes),0) AS bytes FROM eval WHERE control=? AND state IN ('queued','dispatching','delivered','paused','retry_wait')", control)!;
      requireValue(Number(q.n) + request.candidates.length <= (control ? LIMITS.controlItems : LIMITS.queueItems) && Number(q.bytes) + bytes <= (control ? LIMITS.controlBytes : LIMITS.queueBytes), 'QUEUE_CAPACITY');
      for (const c of request.candidates) {
        requireValue(c.resourceId === source!.resource_id && c.body.length <= LIMITS.candidateChars && c.neighbors.length <= LIMITS.neighbors && c.neighbors.every(s => s.length <= LIMITS.candidateChars) && c.payloadRef && c.payloadHash, 'CANDIDATE_LIMIT_OR_RESOURCE');
        this.#run('INSERT OR IGNORE INTO thread VALUES(?,?,?,?)', fingerprint({ domain: this.identity.domainId, sourceId, threadKey: c.threadKey }), sourceId, c.threadKey, c.resourceId);
        this.#run('INSERT INTO trigger VALUES(?,?,?,?,?,?)', c.triggerId, sourceId, c.externalEventId, c.triggerRevision, c.resourceId, encode(c));
      }
      this.#run("INSERT INTO eval VALUES(?,0,'queued',?,?,?,0,NULL,NULL,?,?,NULL)", request.evalId, control, bytes, request.queuedAt, LIMITS.evalTimeoutMs, encode(request));
      this.#run('UPDATE source_instance SET cursor=?,revision=revision+1 WHERE id=? AND revision=?', nextCursor, sourceId, expectedRevision);
    });
  }
  evalState(id: string): Row | undefined { return this.#one('SELECT id,revision,state,attempt,deadline_basis,deadline,remaining,queued_at FROM eval WHERE id=?', id); }
  beginEval(id: string, revision: number, now: number): boolean {
    return this.#transaction(() => { requireValue(this.#healthy && !this.#recoveryPending && this.manager().lifecycle === 'running', 'RECOVERY_OR_STOPPED');
      const e = this.#one('SELECT * FROM eval WHERE id=?', id); requireValue(e && e.revision === revision, 'EVAL_CONFLICT');
      this.#evidence(parse<EvalRequest>(e!)); this.#versions(parse<EvalRequest>(e!).versions);
      if (now - Number(e!.queued_at) > LIMITS.queueAgeMs || Number(e!.attempt) >= LIMITS.evalAttempts) { this.#run("UPDATE eval SET state='unavailable',revision=revision+1 WHERE id=?", id); return false; }
      requireValue(!this.#one("SELECT id FROM eval WHERE state IN ('dispatching','delivered')") && ['queued','retry_wait'].includes(String(e!.state)), 'EVAL_BUSY');
      this.#run("UPDATE eval SET state='dispatching',attempt=attempt+1,revision=revision+1 WHERE id=?", id); return true; });
  }
  recordEvalDelivery(id: string, revision: number, receipt: { nativeLogRef: string; deliveredAt: number; basis: 'native-log' }): void {
    this.#transaction(() => { requireValue(receipt.nativeLogRef && receipt.basis === 'native-log', 'DELIVERY_PROOF_REQUIRED');
      const row = this.#one('SELECT * FROM eval WHERE id=?', id); requireValue(row, 'EVAL_CONFLICT'); this.#evidence(parse<EvalRequest>(row!));
      requireValue(this.#run("UPDATE eval SET state='delivered',deadline_basis=?,deadline=?+remaining,revision=revision+1 WHERE id=? AND revision=? AND state='dispatching'", receipt.basis, receipt.deliveredAt, id, revision) === 1, 'EVAL_CONFLICT');
      this.#audit('eval-delivered', { id, receipt }); });
  }
  pauseEval(id: string, revision: number, now: number): void {
    this.#transaction(() => { const e = this.#one('SELECT * FROM eval WHERE id=?', id); requireValue(e && e.revision === revision && ['queued','dispatching','delivered'].includes(String(e.state)), 'EVAL_CONFLICT');
      this.#run("UPDATE eval SET paused_from=state,state='paused',remaining=?,deadline=NULL,revision=revision+1 WHERE id=?", e!.deadline === null ? Number(e!.remaining) : Math.max(0, Number(e!.deadline) - now), id); });
  }
  resumeEval(id: string, revision: number, now: number): void {
    this.#transaction(() => { const e = this.#one('SELECT * FROM eval WHERE id=?', id); requireValue(e && e.revision === revision && e.state === 'paused', 'EVAL_CONFLICT');
      this.#evidence(parse<EvalRequest>(e!)); this.#versions(parse<EvalRequest>(e!).versions);
      const state = e!.paused_from === 'dispatching' ? 'unavailable' : e!.deadline_basis === null ? 'queued' : 'delivered';
      if (state === 'delivered') requireValue(!this.#one("SELECT id FROM eval WHERE state IN ('dispatching','delivered')"), 'EVAL_BUSY');
      this.#run('UPDATE eval SET state=?,deadline=?,revision=revision+1 WHERE id=?', state, state === 'delivered' ? now + Number(e!.remaining) : null, id); });
  }
  retryUndeliveredEval(id: string, revision: number, notAcceptedNativeLogRef: string): void {
    this.#transaction(() => { const e = this.#one('SELECT * FROM eval WHERE id=?', id);
      requireValue(e && e.revision === revision && ['dispatching','unavailable'].includes(String(e.state)) && e.deadline_basis === null && Number(e.attempt) < LIMITS.evalAttempts && notAcceptedNativeLogRef, 'RETRY_NOT_PROVEN_SAFE');
      this.#evidence(parse<EvalRequest>(e!)); this.#versions(parse<EvalRequest>(e!).versions);
      this.#run("UPDATE eval SET state='retry_wait',revision=revision+1 WHERE id=?", id);
      this.#audit('eval-safe-retry', { id, revision, notAcceptedNativeLogRef });
    });
  }
  expireEval(id: string, revision: number, now: number): void {
    this.#transaction(() => { const e = this.#one('SELECT * FROM eval WHERE id=?', id);
      requireValue(e && e.revision === revision && e.state === 'delivered' && e.deadline !== null && now >= Number(e.deadline), 'EVAL_NOT_EXPIRED');
      this.#run("UPDATE eval SET state='unavailable',remaining=0,revision=revision+1 WHERE id=?", id); this.#audit('eval-timeout', { id, now });
    });
  }
  #recipient(item: RouteItem): void {
    this.#evidence(item.effect);
    const existing = this.#one('SELECT * FROM disposition WHERE input_id=?', item.inputId);
    if (existing) requireValue(existing.trigger_id === item.triggerId && existing.trigger_revision === item.triggerRevision && existing.state !== 'answered', 'INPUT_CONFLICT');
    else this.#run("INSERT INTO disposition VALUES(?,?,?,'queued',0)", item.inputId, item.triggerId, item.triggerRevision);
    if (existing?.state === 'handed_back' && item.purpose === 'work') this.#run("UPDATE disposition SET state='queued' WHERE input_id=?", item.inputId);
    const head = this.#one('SELECT * FROM coordination WHERE board_task_id=?', item.boardTaskId);
    if (head) requireValue(head.execution_id === item.executionId && head.execution_generation === item.executionGeneration, 'EXECUTION_CONFLICT');
    else this.#run('INSERT INTO coordination VALUES(?,1,?,?)', item.boardTaskId, item.executionId, item.executionGeneration);
    const execution = this.#one('SELECT * FROM execution_ref WHERE execution_id=?', item.executionId);
    if (execution) requireValue(execution.board_task_id === item.boardTaskId && execution.generation === item.executionGeneration && item.watermark > Number(execution.released_watermark), 'EXECUTION_CONFLICT');
    else this.#run('INSERT INTO execution_ref VALUES(?,?,?,?,-1)', item.executionId, item.boardTaskId, item.executionGeneration, item.watermark);
    this.#run('UPDATE execution_ref SET watermark=max(watermark,?) WHERE execution_id=?', item.watermark, item.executionId);
    const previous = this.#one('SELECT * FROM input_recipient WHERE input_id=? AND execution_id=? AND execution_generation=? AND purpose=?', item.inputId, item.executionId, item.executionGeneration, item.purpose);
    if (previous) requireValue(previous.rpc_id === item.rpcId && previous.input_hash === item.inputHash && previous.watermark === item.watermark, 'RECIPIENT_CONFLICT');
    else this.#run("INSERT INTO input_recipient VALUES(?,?,?,?,?,'queued',?,?,?,NULL)", item.inputId, item.executionId, item.executionGeneration, item.purpose, item.watermark, item.rpcId, item.nativeItemId ?? null, item.inputHash);
    const triggerRow = this.#one('SELECT * FROM trigger WHERE id=?', item.triggerId)!;
    const trigger = parse<{ threadKey: string }>(triggerRow);
    const threadId = fingerprint({ domain: this.identity.domainId, sourceId: triggerRow.source_id, threadKey: trigger.threadKey });
    this.#run('INSERT OR IGNORE INTO subscription VALUES(?,?,?)', item.boardTaskId, threadId, item.purpose);
  }
  commitRoute(evalId: string, expectedRevision: number, expectedPolicy: number, items: RouteItem[]): { triggerId: string; committed: boolean; reason?: string }[] {
    return this.#transaction(() => {
      const e = this.#one('SELECT * FROM eval WHERE id=?', evalId);
      if (e) this.#evidence(parse<EvalRequest>(e));
      if (e?.state === 'decided' && Number(e.revision) === expectedRevision + 1) {
        return items.map(item => { const previous = this.#one('SELECT * FROM route_result WHERE eval_id=? AND trigger_id=?', evalId, item.triggerId);
          return previous && same(parse(previous), item) ? { triggerId: item.triggerId, committed: true } : { triggerId: item.triggerId, committed: false, reason: 'ROUTE_CONFLICT' }; });
      }
      requireValue(e && e.revision === expectedRevision && e.state === 'delivered', 'EVAL_CONFLICT');
      const request = parse<EvalRequest>(e!); this.#evidence(request); this.#versions(request.versions);
      requireValue(expectedPolicy === request.versions.policyVersion && items.length <= LIMITS.batchItems, 'POLICY_CONFLICT');
      const results = items.map(item => {
        this.#db.exec('SAVEPOINT route_item');
        try {
          const old = this.#one('SELECT * FROM route_result WHERE eval_id=? AND trigger_id=?', evalId, item.triggerId);
          if (old) requireValue(same(parse(old), item), 'ROUTE_CONFLICT');
          else {
            const candidate = request.candidates.find(c => c.triggerId === item.triggerId);
            const t = this.#one('SELECT * FROM trigger WHERE id=?', item.triggerId);
            requireValue(candidate && t && candidate.triggerRevision === item.triggerRevision && t.revision === item.triggerRevision, 'TRIGGER_CONFLICT');
            requireValue(item.inputHash === request.inputHash && item.effect.inputHash === item.inputHash && item.effect.boardTaskId === item.boardTaskId && item.effect.executionId === item.executionId && same(item.effect.versions, request.versions), 'INPUT_BINDING_MISMATCH');
            this.#recipient(item); this.#enqueueEffect(item.effect);
            this.#run('INSERT INTO route_result VALUES(?,?,?)', evalId, item.triggerId, encode(item));
          }
          this.#db.exec('RELEASE route_item'); return { triggerId: item.triggerId, committed: true };
        } catch (err) {
          this.#db.exec('ROLLBACK TO route_item; RELEASE route_item');
          if (!(err instanceof StorageError) && !(err instanceof Error && err.message.includes('constraint'))) throw err;
          return { triggerId: item.triggerId, committed: false, reason: err instanceof StorageError ? err.code : 'CONSTRAINT_CONFLICT' };
        }
      });
      this.#run("UPDATE eval SET state='decided',revision=revision+1 WHERE id=?", evalId); this.#audit('route-results', { evalId, results }); return results;
    });
  }
  attachRecipient(item: RouteItem, versions: Versions): void {
    this.#transaction(() => { this.#versions(versions);
      requireValue(this.#one('SELECT * FROM disposition WHERE input_id=? AND trigger_id=? AND trigger_revision=?', item.inputId, item.triggerId, item.triggerRevision), 'INPUT_MISSING');
      this.#recipient(item); this.#audit('recipient-attached', { inputId: item.inputId, executionId: item.executionId, purpose: item.purpose }); });
  }
  observeInput(inputId: string, executionId: string, generation: number, phase: 'delivered' | 'read' | 'claimed' | 'answered', proof: { rpcId: string; nativeItemId: string; inputHash: string; nativeLogRef: string }): void {
    this.#transaction(() => {
      const r = this.#one("SELECT * FROM input_recipient WHERE input_id=? AND execution_id=? AND execution_generation=? AND purpose='work'", inputId, executionId, generation);
      requireValue(r && proof.nativeLogRef && r.rpc_id === proof.rpcId && r.input_hash === proof.inputHash && ['queued','delivered','read','claimed','answered'].includes(String(r.state)), 'INPUT_RECEIPT_CONFLICT');
      const head = this.#one('SELECT * FROM coordination WHERE board_task_id=(SELECT board_task_id FROM execution_ref WHERE execution_id=?)', executionId);
      requireValue(head?.execution_id === executionId && head.execution_generation === generation, 'STALE_EXECUTION');
      const rank = ['queued', 'delivered', 'read', 'claimed', 'answered']; requireValue(rank.indexOf(phase) >= rank.indexOf(String(r!.state)), 'INPUT_PHASE_REGRESSION');
      this.#run("UPDATE input_recipient SET state=?,native_item_id=?,receipt_ref=? WHERE input_id=? AND execution_id=? AND execution_generation=? AND purpose='work'", phase, proof.nativeItemId, proof.nativeLogRef, inputId, executionId, generation);
      if (phase === 'answered') this.#run("UPDATE disposition SET state='answered' WHERE input_id=?", inputId);
      this.#audit('input-receipt', { inputId, executionId, generation, phase, proof });
    });
  }
  advanceExecution(boardTaskId: string, expectedRevision: number, executionId: string, generation: number): void {
    this.#transaction(() => this.#advanceExecution(boardTaskId, expectedRevision, executionId, generation));
  }
  #advanceExecution(boardTaskId: string, expectedRevision: number, executionId: string, generation: number): void {
    const old = this.#one('SELECT * FROM coordination WHERE board_task_id=?', boardTaskId);
    requireValue(old?.revision === expectedRevision && generation > Number(old.execution_generation), 'EXECUTION_CONFLICT');
    requireValue(!this.#one("SELECT r.input_id FROM input_recipient r JOIN disposition d ON d.input_id=r.input_id WHERE r.execution_id=? AND r.execution_generation=? AND r.purpose='work' AND r.state NOT IN ('answered','handed_back') AND d.state!='answered' LIMIT 1", String(old!.execution_id), Number(old!.execution_generation)), 'PENDING_OWNERS');
    this.#run('UPDATE coordination SET execution_id=?,execution_generation=?,revision=revision+1 WHERE board_task_id=?', executionId, generation, boardTaskId);
    this.#run('INSERT INTO execution_ref VALUES(?,?,?,0,-1)', executionId, boardTaskId, generation);
  }
  /** 登记一次由主理派工打开的看板执行；同一执行重试幂等，新执行推进 generation。 */
  registerExecution(boardTaskId: string, executionId: string, generation: number): void {
    this.#transaction(() => {
      const ref = this.#one('SELECT * FROM execution_ref WHERE execution_id=?', executionId);
      if (ref) requireValue(ref.board_task_id === boardTaskId && Number(ref.generation) === generation, 'EXECUTION_CONFLICT');
      const head = this.#one('SELECT * FROM coordination WHERE board_task_id=?', boardTaskId);
      if (!head) {
        if (!ref) this.#run('INSERT INTO execution_ref VALUES(?,?,?,0,-1)', executionId, boardTaskId, generation);
        this.#run('INSERT INTO coordination VALUES(?,1,?,?)', boardTaskId, executionId, generation); return;
      }
      if (head.execution_id === executionId && Number(head.execution_generation) === generation) {
        if (!ref) this.#run('INSERT INTO execution_ref VALUES(?,?,?,0,-1)', executionId, boardTaskId, generation); return;
      }
      requireValue(generation > Number(head.execution_generation), 'EXECUTION_CONFLICT');
      this.#advanceExecution(boardTaskId, Number(head.revision), executionId, generation);
    });
  }
  releaseInputs(executionId: string, expectedGeneration: number, watermark: number, reason: string): number {
    return this.#transaction(() => {
      const e = this.#one('SELECT * FROM execution_ref WHERE execution_id=?', executionId);
      const head = e && this.#one('SELECT * FROM coordination WHERE board_task_id=?', String(e.board_task_id));
      requireValue(e?.generation === expectedGeneration && head?.execution_id === executionId && head.execution_generation === expectedGeneration, 'STALE_EXECUTION');
      if (Number(e!.released_watermark) >= watermark) return 0;
      requireValue(watermark <= Number(e!.watermark), 'WATERMARK_CONFLICT');
      const rows = this.#all("SELECT * FROM input_recipient WHERE execution_id=? AND execution_generation=? AND watermark<=? AND state NOT IN ('answered','handed_back')", executionId, expectedGeneration, watermark);
      let rerouted = 0;
      for (const row of rows) {
        const id = String(row.input_id);
        this.#run("UPDATE input_recipient SET state='handed_back' WHERE input_id=? AND execution_id=? AND execution_generation=? AND purpose=?", id, executionId, expectedGeneration, String(row.purpose));
        if (row.purpose === 'context') continue;
        const d = this.#one('SELECT * FROM disposition WHERE input_id=?', id)!;
        const owners = this.#one("SELECT count(*) AS n FROM input_recipient WHERE input_id=? AND purpose='work' AND state NOT IN ('answered','handed_back')", id)!;
        if (d.state !== 'answered' && Number(owners.n) === 0) {
          const next = Number(d.reroute_generation) + 1;
          this.#run('INSERT INTO reroute VALUES(?,?,?)', id, next, reason);
          this.#run("UPDATE disposition SET state='handed_back',reroute_generation=? WHERE input_id=?", next, id); rerouted++;
        }
      }
      this.#run('UPDATE execution_ref SET released_watermark=? WHERE execution_id=?', watermark, executionId);
      this.#audit('release-inputs', { executionId, expectedGeneration, watermark, rerouted, reason }); return rerouted;
    });
  }
  inputState(inputId: string): { state: string; rerouteGeneration: number; owners: string[] } | undefined {
    const d = this.#one('SELECT * FROM disposition WHERE input_id=?', inputId); if (!d) return undefined;
    return { state: String(d.state), rerouteGeneration: Number(d.reroute_generation), owners: this.#all("SELECT execution_id FROM input_recipient WHERE input_id=? AND purpose='work' AND state NOT IN ('answered','handed_back')", inputId).map(r => String(r.execution_id)) };
  }
  #enqueueEffect(request: EffectRequest): { seq: number; generation: number } {
    this.#evidence(request); this.#versions(request.versions);
    const previous = this.#one('SELECT * FROM effect WHERE effect_key=? ORDER BY generation DESC LIMIT 1', request.effectKey);
    if (previous) { requireValue(same(parse(previous), request), 'EFFECT_CONFLICT'); return { seq: Number(previous.seq), generation: Number(previous.generation) }; }
    this.#run("INSERT INTO effect(effect_key,generation,operation_key,board_task_id,destination,payload_hash,state,body) VALUES(?,1,?,?,?,?,'pending',?)", request.effectKey, request.operationKey, request.boardTaskId, request.destination, fingerprint(request.payload), encode(request));
    const row = this.#one('SELECT seq FROM effect WHERE effect_key=?', request.effectKey)!;
    return { seq: Number(row.seq), generation: 1 };
  }
  enqueueEffect(request: EffectRequest): { seq: number; generation: number } { return this.#transaction(() => { this.#capacity(); return this.#enqueueEffect(request); }); }
  replaceEffect(effectKey: string, expectedGeneration: number, request: EffectRequest): { seq: number; generation: number } {
    return this.#transaction(() => {
      this.#capacity(); this.#evidence(request); this.#versions(request.versions);
      const old = this.#one('SELECT * FROM effect WHERE effect_key=? ORDER BY generation DESC LIMIT 1', effectKey);
      requireValue(old && old.generation === expectedGeneration && request.effectKey === effectKey && !['dropped','revoked'].includes(String(old.state)), 'EFFECT_GENERATION_CONFLICT');
      const before = parse<EffectRequest>(old!);
      requireValue(before.destination === request.destination && before.boardTaskId === request.boardTaskId && before.purpose === request.purpose && before.operationKey !== request.operationKey && before.requestId !== request.requestId, 'EFFECT_TARGET_OR_ID_CONFLICT');
      this.#run("UPDATE effect SET state='revoked' WHERE seq=? AND state IN ('pending','retry_wait')", Number(old!.seq));
      this.#run("INSERT INTO effect(effect_key,generation,operation_key,board_task_id,destination,payload_hash,state,body) VALUES(?,?,?,?,?,?,'pending',?)", effectKey, expectedGeneration + 1, request.operationKey, request.boardTaskId, request.destination, fingerprint(request.payload), encode(request));
      this.#audit('effect-replaced', { effectKey, previousGeneration: expectedGeneration, generation: expectedGeneration + 1 });
      return { seq: Number(this.#one('SELECT seq FROM effect WHERE effect_key=? AND generation=?', effectKey, expectedGeneration + 1)!.seq), generation: expectedGeneration + 1 };
    });
  }
  claimEffect(effectKey: string, seq: number, generation: number, currentAuthority: (request: EffectRequest) => boolean): EffectClaim | undefined {
    return this.#transaction(() => {
      requireValue(this.#healthy && !this.#recoveryPending && this.manager().lifecycle === 'running', 'RECOVERY_OR_STOPPED');
      const row = this.#one("SELECT * FROM effect WHERE effect_key=? AND seq=? AND generation=? AND state IN ('pending','retry_wait')", effectKey, seq, generation);
      if (!row) return undefined;
      const latest = this.#one('SELECT max(generation) AS g FROM effect WHERE effect_key=?', effectKey)!; if (latest.g !== generation) return undefined;
      const request = parse<EffectRequest>(row); this.#evidence(request); this.#versions(request.versions);
      if (this.#one("SELECT seq FROM effect WHERE board_task_id=? AND destination=? AND seq<? AND state NOT IN ('succeeded','dropped','revoked') LIMIT 1", request.boardTaskId, request.destination, seq)) return undefined;
      if (request.questionId) requireValue(this.#one("SELECT id FROM question WHERE id=? AND state='open'", request.questionId), 'QUESTION_CLOSED');
      // 必须为同步的真实 Host 权限检查；只持久化版本，不持久化/恢复其动态 grant。
      requireValue(currentAuthority(request) === true, 'CURRENT_AUTHORITY_REQUIRED');
      const attemptId = randomUUID();
      this.#run("UPDATE effect SET state='unknown' WHERE seq=? AND state IN ('pending','retry_wait')", seq);
      this.#run('INSERT INTO effect_attempt VALUES(?,?,?,?,NULL,0)', attemptId, seq, generation, request.requestId);
      return { effectKey, seq, generation, attemptId, request };
    });
  }
  recordEffectReceipt(claim: EffectClaim, receipt: { nativeLogRef: string; accepted: boolean }): boolean {
    return this.#transaction(() => {
      const attempt = this.#one('SELECT * FROM effect_attempt WHERE id=? AND seq=? AND generation=?', claim.attemptId, claim.seq, claim.generation);
      requireValue(attempt && receipt.nativeLogRef, 'ATTEMPT_MISMATCH');
      if (attempt!.receipt !== null) { requireValue(same(JSON.parse(String(attempt!.receipt)), receipt), 'RECEIPT_CONFLICT'); return false; }
      const row = this.#one('SELECT * FROM effect WHERE seq=? AND effect_key=? AND generation=?', claim.seq, claim.effectKey, claim.generation)!;
      const latest = this.#one('SELECT max(generation) AS g FROM effect WHERE effect_key=?', claim.effectKey)!;
      const req = parse<EffectRequest>(row); const current = this.#isCurrentEvidence(req) && latest.g === claim.generation && same(req.versions, this.manager().versions) && this.manager().lifecycle === 'running' && (!req.questionId || !!this.#one("SELECT id FROM question WHERE id=? AND state='open'", req.questionId));
      this.#run('UPDATE effect_attempt SET receipt=?,late=? WHERE id=?', encode(receipt), Number(!current), claim.attemptId);
      if (current && receipt.accepted) this.#run("UPDATE effect SET state='succeeded' WHERE seq=? AND state='unknown'", claim.seq);
      this.#audit('effect-receipt', { effectKey: claim.effectKey, generation: claim.generation, late: !current, receipt }); return current && receipt.accepted;
    });
  }
  reconcileUnknown(effectKey: string, seq: number, generation: number, evidence: { remoteProofRef: string; requestId: string; payloadHash: string; destination: string; outcome: 'succeeded' | 'dropped' }): void {
    this.#transaction(() => {
      const row = this.#one("SELECT * FROM effect WHERE effect_key=? AND seq=? AND generation=? AND state='unknown'", effectKey, seq, generation);
      requireValue(row && evidence.remoteProofRef, 'RECONCILIATION_REQUIRED'); const request = parse<EffectRequest>(row!);
      requireValue(request.requestId === evidence.requestId && row!.payload_hash === evidence.payloadHash && row!.destination === evidence.destination, 'RECONCILIATION_MISMATCH');
      this.#run('UPDATE effect SET state=? WHERE seq=?', evidence.outcome, seq); this.#audit('effect-reconciled', { effectKey, seq, generation, evidence });
    });
  }
  terminateEffect(effectKey: string, seq: number, generation: number, outcome: 'dropped' | 'revoked', reason: string): void {
    this.#transaction(() => { requireValue(reason, 'REASON_REQUIRED');
      const row = this.#one('SELECT * FROM effect WHERE effect_key=? AND seq=? AND generation=?', effectKey, seq, generation);
      requireValue(row && row.state !== 'unknown' && !terminalEffects.includes(String(row.state)), 'EFFECT_TERMINAL_OR_UNKNOWN');
      this.#run('UPDATE effect SET state=? WHERE seq=?', outcome, seq); this.#audit('effect-terminal', { effectKey, seq, generation, outcome, reason }); });
  }
  effectState(effectKey: string, generation: number): { seq: number; state: string; request: EffectRequest; receipt: unknown } | undefined {
    const row = this.#one('SELECT * FROM effect WHERE effect_key=? AND generation=?', effectKey, generation); if (!row) return undefined;
    const receipt = this.#one('SELECT receipt FROM effect_attempt WHERE seq=?', Number(row.seq))?.receipt;
    return { seq: Number(row.seq), state: String(row.state), request: parse(row), receipt: receipt ? JSON.parse(String(receipt)) : null };
  }
  createJob(request: JobRequest): void {
    this.#transaction(() => { this.#capacity(); this.#evidence(request); this.#versions(request.versions);
      requireValue(request.budget.deadlineMs > 0 && request.budget.deadlineMs <= LIMITS.jobTimeoutMs && request.budget.maxTokens <= request.maxTokens, 'JOB_BUDGET');
      const old = this.#one('SELECT * FROM internal_job WHERE operation_key=? OR id=?', request.operationKey, request.jobId);
      if (old) requireValue(same(parse(old), request), 'OPERATION_CONFLICT');
      else this.#run("INSERT INTO internal_job VALUES(?,?,?,'queued',0,0,0,NULL,?)", request.jobId, request.operationKey, request.inputHash, encode(request)); });
  }
  claimJob(jobId: string, now: number, currentAuthority: (request: JobRequest) => boolean): JobClaim | undefined {
    return this.#transaction(() => {
      requireValue(this.#healthy && !this.#recoveryPending && this.manager().lifecycle === 'running', 'RECOVERY_OR_STOPPED');
      const row = this.#one("SELECT * FROM internal_job WHERE id=? AND state='queued'", jobId); if (!row) return undefined;
      requireValue(Number(this.#one("SELECT count(*) AS n FROM internal_job WHERE state='running' AND released=0")!.n) < LIMITS.jobs, 'JOB_CAPACITY');
      const request = parse<JobRequest>(row); this.#evidence(request); this.#versions(request.versions); requireValue(currentAuthority(request) === true, 'CURRENT_AUTHORITY_REQUIRED');
      this.#run("UPDATE internal_job SET state='running',attempt=attempt+1,started_at=? WHERE id=?", now, jobId);
      return { jobId, attempt: Number(row.attempt) + 1, cancelGeneration: Number(row.cancel_generation), request };
    });
  }
  cancelJob(jobId: string, expectedGeneration: number, reason: string): boolean {
    return this.#transaction(() => {
      const row = this.#one('SELECT * FROM internal_job WHERE id=?', jobId); requireValue(row, 'JOB_MISSING');
      if (row!.state === 'cancelled') return false;
      requireValue(row!.cancel_generation === expectedGeneration && !['completed','interrupted'].includes(String(row!.state)), 'JOB_GENERATION_CONFLICT');
      this.#run("UPDATE internal_job SET state='cancelled',cancel_generation=cancel_generation+1,released=1 WHERE id=?", jobId);
      this.#audit('job-cancel', { jobId, expectedGeneration, reason }); return true;
    });
  }
  completeJob(claim: JobClaim, result: { resultRef: string; hash: string; nativeReceiptRef: string }, now: number): boolean {
    return this.#transaction(() => {
      const row = this.#one('SELECT * FROM internal_job WHERE id=?', claim.jobId); requireValue(row && result.resultRef && result.hash && result.nativeReceiptRef, 'JOB_RECEIPT_REQUIRED');
      const old = this.#one('SELECT * FROM job_receipt WHERE job_id=? AND attempt=? AND cancel_generation=?', claim.jobId, claim.attempt, claim.cancelGeneration);
      if (old) { requireValue(same(JSON.parse(String(old.receipt)), result), 'JOB_RECEIPT_CONFLICT'); return false; }
      const persistedRequest = parse<JobRequest>(row!);
      const current = this.#isCurrentEvidence(persistedRequest) && row!.state === 'running' && row!.attempt === claim.attempt && row!.cancel_generation === claim.cancelGeneration &&
        now <= Number(row!.started_at) + persistedRequest.budget.deadlineMs && same(persistedRequest.versions, this.manager().versions) && this.manager().lifecycle === 'running';
      // 结果与释放先原子持久化，通知在提交后，不把观察回调当跨库事务。
      this.#run('INSERT INTO job_receipt(job_id,attempt,cancel_generation,receipt,late) VALUES(?,?,?,?,?)', claim.jobId, claim.attempt, claim.cancelGeneration, encode(result), Number(!current));
      if (current) this.#run("UPDATE internal_job SET state='completed',released=1 WHERE id=?", claim.jobId);
      else if (row!.state === 'running') this.#run("UPDATE internal_job SET state='interrupted',released=1 WHERE id=?", claim.jobId);
      this.#audit('job-receipt', { jobId: claim.jobId, attempt: claim.attempt, cancelGeneration: claim.cancelGeneration, late: !current, result }); return current;
    });
  }
  failJob(claim: JobClaim, failureRef: string): boolean {
    return this.#transaction(() => { const row = this.#one('SELECT * FROM internal_job WHERE id=?', claim.jobId); requireValue(row && failureRef, 'JOB_FAILURE_REQUIRED');
      const current = row!.state === 'running' && row!.attempt === claim.attempt && row!.cancel_generation === claim.cancelGeneration;
      this.#audit('job-failure', { jobId: claim.jobId, attempt: claim.attempt, cancelGeneration: claim.cancelGeneration, failureRef, late: !current });
      if (current) this.#run("UPDATE internal_job SET state='failed',released=1 WHERE id=?", claim.jobId); return current;
    });
  }
  jobState(jobId: string): { state: string; cancelGeneration: number; released: boolean; receipts: number } | undefined {
    const row = this.#one('SELECT * FROM internal_job WHERE id=?', jobId); if (!row) return undefined;
    return { state: String(row.state), cancelGeneration: Number(row.cancel_generation), released: row.released === 1, receipts: Number(this.#one('SELECT count(*) AS n FROM job_receipt WHERE job_id=?', jobId)!.n) };
  }
  openQuestion(input: { id: string; purpose: string; eventKey: string; audience: string; boardTaskId: string; executionId: string; versions: Versions }): void {
    this.#transaction(() => { this.#versions(input.versions); const old = this.#one('SELECT * FROM question WHERE event_key=? AND purpose=?', input.eventKey, input.purpose);
      if (old) requireValue(same(parse(old), input), 'QUESTION_CONFLICT');
      else this.#run("INSERT INTO question VALUES(?,?,?,0,'open',?,NULL,?)", input.id, input.eventKey, input.purpose, input.audience, encode(input)); });
  }
  closeQuestion(id: string, revision: number, state: 'answered' | 'cancelled' | 'superseded', closeRef: string): void {
    this.#transaction(() => { requireValue(closeRef, 'RESOLUTION_REQUIRED');
      requireValue(this.#run("UPDATE question SET state=?,close_ref=?,revision=revision+1 WHERE id=? AND revision=? AND state='open'", state, closeRef, id, revision) === 1, 'QUESTION_CONFLICT');
      this.#run("UPDATE effect SET state='revoked' WHERE json_extract(body,'$.questionId')=? AND state IN ('pending','retry_wait')", id);
      this.#audit('question-closed', { id, revision, state, closeRef }); });
  }
  reserveBriefSlot(slotKey: string, input: { localDate: string; kind: 'plan' | 'review'; sourceRefs: string[] }): boolean {
    return this.#transaction(() => { const old = this.#one('SELECT * FROM brief_slot WHERE slot_key=?', slotKey);
      if (old) { requireValue(same(parse(old), input), 'SLOT_CONFLICT'); return false; }
      this.#run('INSERT INTO brief_slot VALUES(?,0,?)', slotKey, encode(input)); return true; });
  }
  putPlanItem(id: string, expectedRevision: number, item: { boardTaskId: string; localDate: string; rank: number; reason: string }): number {
    return this.#transaction(() => { const old = this.#one('SELECT * FROM plan_item WHERE id=?', id);
      requireValue((old ? Number(old.revision) : 0) === expectedRevision, 'PLAN_CONFLICT');
      if (old) this.#run('UPDATE plan_item SET revision=revision+1,board_task_id=?,body=? WHERE id=?', item.boardTaskId, encode(item), id);
      else this.#run('INSERT INTO plan_item VALUES(?,1,?,?)', id, item.boardTaskId, encode(item)); return expectedRevision + 1; });
  }
  recordBoardReference(boardTaskId: string, revision: number, asOf: number, snapshotRef: string): void {
    this.#transaction(() => { const old = this.#one('SELECT * FROM board_snapshot WHERE board_task_id=?', boardTaskId);
      requireValue(snapshotRef && (!old || Number(old.revision) <= revision), 'BOARD_REVISION_CONFLICT');
      this.#run('INSERT INTO board_snapshot VALUES(?,?,?,0,?) ON CONFLICT(board_task_id) DO UPDATE SET revision=excluded.revision,as_of=excluded.as_of,stale=0,body=excluded.body', boardTaskId, revision, asOf, encode({ snapshotRef, authority: 'taskBoard.snapshot' })); });
  }
  correctSource(id: string, expectedRevision: number, correctedWatermark: string): void {
    this.#transaction(() => {
      requireValue(this.#run('UPDATE source_instance SET revision=revision+1,cursor=? WHERE id=? AND revision=?', correctedWatermark, id, expectedRevision) === 1, 'SOURCE_CONFLICT');
      for (const row of this.#all('SELECT * FROM search_index WHERE invalidated=0')) if (parse<Projection>(row).sourceRefs.some(ref => ref.sourceId === id)) this.#run('UPDATE search_index SET invalidated=1,revision=revision+1 WHERE id=?', String(row.id));
      this.#audit('source-corrected', { id, expectedRevision, correctedWatermark });
    });
  }
  putProjection(expectedRevision: number, projection: Projection): number {
    return this.#transaction(() => { const old = this.#one('SELECT * FROM search_index WHERE id=?', projection.id);
      requireValue((old ? Number(old.revision) : 0) === expectedRevision, 'PROJECTION_CONFLICT');
      requireValue(encode(projection).length <= LIMITS.pageChars, 'PROJECTION_SIZE');
      requireValue(projection.sourceRefs.length > 0 && projection.sourceRefs.every(ref => {
        const s = this.#one('SELECT * FROM source_instance WHERE id=?', ref.sourceId);
        return s?.revision === ref.revision && s.cursor === ref.watermark && s.resource_id === projection.resourceId;
      }), 'STALE_SOURCE_REFERENCE');
      this.#run('INSERT INTO search_index VALUES(?,?,0,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,invalidated=0,resource_id=excluded.resource_id,audience=excluded.audience,body=excluded.body', projection.id, expectedRevision + 1, projection.resourceId, projection.audience, encode(projection));
      return expectedRevision + 1;
    });
  }
  #visible(current: () => ReadScope): { scope: ReadScope; rows: { revision: number; projection: Projection }[] } {
    const scope = current(); requireValue(scope.policyVersion === this.manager().versions.policyVersion, 'READ_POLICY_STALE');
    const policy = parse<Policy>(this.#one('SELECT body FROM policy_revision WHERE version=?', scope.policyVersion)!);
    const rows = this.#all('SELECT * FROM search_index WHERE invalidated=0 ORDER BY id').filter(row => {
      if (!scope.resources.includes(String(row.resource_id)) || !policy.resources.includes(String(row.resource_id)) || !scope.audiences.includes(String(row.audience)) || !policy.audiences.includes(String(row.audience))) return false;
      return parse<Projection>(row).sourceRefs.every(ref => {
        const source = this.#one('SELECT * FROM source_instance WHERE id=?', ref.sourceId);
        return source?.revision === ref.revision && source.cursor === ref.watermark && scope.resources.includes(String(source.resource_id)) && policy.resources.includes(String(source.resource_id));
      });
    }).map(row => ({ revision: Number(row.revision), projection: parse<Projection>(row) }));
    rows.sort((a, b) => a.projection.id < b.projection.id ? -1 : a.projection.id > b.projection.id ? 1 : 0);
    return { scope, rows };
  }
  search(current: () => ReadScope, query: string, options: { limit?: number; cursor?: string } = {}): { items: Projection[]; nextCursor?: string } {
    return this.#transaction(() => {
      const { scope, rows } = this.#visible(current); const limit = options.limit ?? LIMITS.pageItems;
      requireValue(Number.isInteger(limit) && limit > 0 && limit <= LIMITS.pageItems && query.length <= LIMITS.candidateChars, 'PAGE_LIMIT');
      const filtered = rows.filter(({ projection: p }) => [p.title, ...p.aliases, p.summary].some(s => s.includes(query)));
      // 仅以当前可见集合产生续页水位，不暴露全域计数或标题；续页重新取得可信权限。
      const stamp = fingerprint({ domain: this.identity.domainId, scope, query, rows: filtered });
      let after = ''; if (options.cursor) {
        let cursor: { stamp: string; after: string }; try { cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString()); } catch { throw new StorageError('CURSOR_INVALID'); }
        requireValue(cursor.stamp === stamp && typeof cursor.after === 'string', 'CURSOR_STALE'); after = cursor.after;
      }
      const remaining = filtered.filter(x => x.projection.id > after); const items: Projection[] = []; let chars = 0;
      for (const { projection } of remaining) { const size = encode(projection).length;
        requireValue(size <= LIMITS.pageChars, 'PROJECTION_SIZE');
        if (items.length >= limit || chars + size > LIMITS.pageChars) break;
        items.push(projection); chars += size;
      }
      const nextCursor = items.length < remaining.length && items.length > 0 ? Buffer.from(encode({ stamp, after: items.at(-1)!.id })).toString('base64url') : undefined;
      return { items, ...(nextCursor ? { nextCursor } : {}) };
    });
  }
  readProjection(current: () => ReadScope, id: string): Projection | undefined {
    return this.#transaction(() => this.#visible(current).rows.find(x => x.projection.id === id)?.projection);
  }
  indexArtifact(ref: string, hash: string, bytes: number, now: number): void {
    this.#transaction(() => { this.#capacity(); requireValue(bytes > 0 && bytes <= LIMITS.artifactBytes && hash, 'ARTIFACT_LIMIT');
      const old = this.#one('SELECT * FROM artifact_index WHERE ref=?', ref);
      if (old) requireValue(old.hash === hash && old.bytes === bytes && old.tombstone === null, 'ARTIFACT_CONFLICT');
      else {
        requireValue(Number(this.#one('SELECT coalesce(sum(bytes),0) AS n FROM artifact_index WHERE tombstone IS NULL')!.n) + bytes <= LIMITS.artifactsBytes, 'ARTIFACT_CAPACITY');
        this.#run('INSERT INTO artifact_index VALUES(?,?,?,?,NULL)', ref, hash, bytes, now);
      }
    });
  }
  protectArtifact(ref: string, owner: string): void { this.#transaction(() => { requireValue(owner, 'OWNER_REQUIRED'); this.#run('INSERT OR IGNORE INTO artifact_protection VALUES(?,?)', ref, owner); }); }
  proposeArtifactArchive(ref: string, now: number): boolean {
    const row = this.#one('SELECT * FROM artifact_index WHERE ref=?', ref); if (!row || row.tombstone !== null || now - Number(row.created_at) < LIMITS.archiveAgeMs) return false;
    return !this.#one('SELECT ref FROM artifact_protection WHERE ref=?', ref) &&
      !this.#one("SELECT seq FROM effect WHERE state IN ('pending','retry_wait','unknown') AND json_extract(body,'$.inputSnapshotRef')=?", ref);
  }
  recordArtifactTombstone(ref: string, reason: string, now: number): void {
    this.#transaction(() => { requireValue(reason && this.proposeArtifactArchive(ref, now), 'ARTIFACT_PROTECTED');
      this.#run('UPDATE artifact_index SET tombstone=? WHERE ref=?', encode({ reason, now }), ref); this.#audit('artifact-tombstone', { ref, reason, now }); });
  }
  recover(): { manager: Manager; pendingSession: string | null; unknownEffects: { effectKey: string; seq: number; generation: number }[]; interruptedJobs: string[] } {
    const result = this.#transaction(() => {
      // 不解析/创建会话，不发送，不重启 producer；保留停止墓碑与 pin，所有动态权限须由 Host 重新取得。
      this.#run("UPDATE native_request_audit SET eligibility='audit-only',reason='冷恢复仅保留历史事实',revision=revision+1 WHERE eligibility='live'");
      this.#run("UPDATE manager_instance SET lifecycle=CASE WHEN lifecycle='stopped' THEN 'stopped' ELSE 'paused' END,revision=revision+1 WHERE singleton=1");
      const jobs = this.#all("SELECT id FROM internal_job WHERE state IN ('running','unknown')");
      this.#run("UPDATE internal_job SET state='interrupted',cancel_generation=cancel_generation+1,released=1 WHERE state IN ('running','unknown')");
      this.#run("UPDATE eval SET state='unavailable',revision=revision+1 WHERE state IN ('dispatching','delivered')");
      this.#run('UPDATE board_snapshot SET stale=1');
      const unknownEffects = this.#all("SELECT effect_key,seq,generation FROM effect WHERE state='unknown'").map(r => ({ effectKey: String(r.effect_key), seq: Number(r.seq), generation: Number(r.generation) }));
      this.#audit('recovery', { unknownEffects, interruptedJobs: jobs.map(r => r.id) });
      const manager = this.manager(); return { manager, pendingSession: manager.bindingState === 'bound' ? null : manager.sessionId, unknownEffects, interruptedJobs: jobs.map(r => String(r.id)) };
    });
    this.#preparedAuditKeys.clear(); this.#liveAuditKeys.clear(); this.#recoveryPending = false; return result;
  }
}

