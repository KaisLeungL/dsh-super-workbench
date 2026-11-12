// 仅供可信 Host 内部使用；这些持久化接口不授予调用者业务权限。
export const LIMITS = Object.freeze({
  queueItems: 256, queueBytes: 8 * 1024 * 1024, controlItems: 32, controlBytes: 256 * 1024,
  batchItems: 8, batchWaitMs: 250, evalConcurrency: 1, evalAttempts: 2, evalTimeoutMs: 60_000,
  queueAgeMs: 600_000, jobs: 2, jobTimeoutMs: 120_000, workerSubmissions: 2,
  candidateChars: 2000, neighbors: 3, inputBytes: 64 * 1024, artifactBytes: 8 * 1024 * 1024,
  pageChars: 8000, pageItems: 50, navigationMs: 5000, dbBytes: 512 * 1024 * 1024,
  artifactsBytes: 1024 * 1024 * 1024, diskReserveBytes: 256 * 1024 * 1024, archiveAgeMs: 30 * 86400_000,
});
export interface Identity { instanceId: string; domainId: string }
export interface Versions { policyVersion: number; scopeVersion: number; stopEpoch: number; intentRevision: number }
export interface Evidence {
  backend: 'native'; provider: string; model: string; effort: string; maxTokens: number;
  promptPackageVersion: string; promptPackageHash: string; inputSnapshotRef: string; inputHash: string;
}
export interface InputSnapshot {
  ref: string; sourceWatermark: string;
  // 保存实际输入或其不可变引用；包 hash 不能代替这些动态 header。
  headers: { system: string; developer: string; user: string; tools: string };
}
export interface Candidate {
  triggerId: string; externalEventId: string; triggerRevision: number; resourceId: string;
  threadKey: string; body: string; neighbors: string[]; payloadRef: string; payloadHash: string;
}
export interface EvalRequest extends Evidence {
  evalId: string; versions: Versions; candidates: Candidate[]; control: boolean; queuedAt: number;
}
export interface EffectRequest extends Evidence {
  effectKey: string; operationKey: string; boardTaskId: string; executionId?: string;
  destination: string; purpose: 'ack' | 'question' | 'result' | 'fault';
  payload: string; requestId: string; audience: string; questionId?: string; versions: Versions;
}
export interface EffectClaim { effectKey: string; seq: number; generation: number; attemptId: string; request: EffectRequest }
export interface RouteItem {
  triggerId: string; triggerRevision: number; boardTaskId: string; executionId: string;
  executionGeneration: number; purpose: 'work' | 'context'; watermark: number;
  inputId: string; rpcId: string; nativeItemId?: string; inputHash: string; effect: EffectRequest;
}
export interface ReadScope { resources: readonly string[]; audiences: readonly string[]; policyVersion: number }
export interface Projection {
  id: string; kind: 'thread' | 'task_link' | 'summary' | 'report'; resourceId: string; audience: string;
  title: string; aliases: string[]; summary: string; boardTaskId?: string;
  sourceRefs: { sourceId: string; revision: number; watermark: string }[];
}
export interface JobRequest extends Evidence {
  operationKey: string; jobId: string; kind: 'brief' | 'scan' | 'board_request';
  versions: Versions; budget: { maxTokens: number; deadlineMs: number }; slotId?: string;
}
export interface JobClaim { jobId: string; attempt: number; cancelGeneration: number; request: JobRequest }
/** 原生日志读侧仅允许预先登记的创建身份；不构成运行授权。 */
export interface AuditSessionRegistration {
  sessionId: string; sessionIdentity: string; header: Readonly<Record<string, unknown>>;
  inheritedEventCount: number; workspaceId: string; projectionId: string;
  formatVersion: number; serializer: 'e37-json-v1';
}
export interface RequestAuditBasis {
  basisKey: string; sessionIdentity: string; sessionId: string; identity: Identity; workspaceId: string;
  turn: number; step: number; stepOffset: number; messageIds: readonly string[];
  versions: Versions; leaseFingerprint: string; promptPackageVersion: string; promptPackageHash: string;
  foreground?: true;
  taskId?: string; executionId?: string; executionGeneration?: number;
}
export interface RequestAuditBoundary {
  turn: number; step: number; attempt: number; boundaryOffset: number; requestHash: string;
}
export interface AuditRequestDescription {
  config: { provider: string; model: string; reasoningEffort?: string; maxTokens: number; [key: string]: unknown };
  adapterDefaults: { reasoningEffort?: true; maxTokens?: true };
  messages: readonly { id: string; role: string; [key: string]: unknown }[];
  tools: readonly unknown[]; toolHistory: { readonly tools: readonly unknown[]; [key: string]: unknown };
}
export interface RequestAuditRecord {
  key: string; basis: RequestAuditBasis | null; boundary?: RequestAuditBoundary;
  settlementSeq?: number; eventHash?: string; state: 'prepared' | 'unknown' | 'verified';
  eligibility: 'live' | 'audit-only'; evidence?: Evidence; reason: string; revision: number;
}
export interface NativeAuditCursor {
  registration: AuditSessionRegistration; offset: number; prefixHash: string; revision: number;
}
export interface NativeAuditFact {
  key: string; settlementSeq?: number; eventHash?: string; settlementType?: 'assistant/message' | 'assistant/attempt'; request?: AuditRequestDescription;
  reason?: string;
}
export interface HealthEval {
  id: string; revision: number; state: string; attempt: number; control: boolean; queuedAt: number;
  deadlineBasis: string | null; deadline: number | null; remainingMs: number; threadKeys: string[];
}
export interface HealthJob {
  id: string; state: string; attempt: number; cancelGeneration: number; released: boolean;
  startedAt: number | null; deadline: number | null;
}
export interface HealthSummary {
  sampledAt: number;
  manager: { revision: number; lifecycle: string; pin: boolean; sessionId: string | null; bindingState: string; workspaceId: string | null; preset: string | null; versions: Versions };
  diagnostics: { journalMode: string; synchronous: number; foreignKeys: boolean; recoveryPending: boolean; healthy: boolean };
  queues: { normal: { items: number; bytes: number; oldestQueuedAt: number | null }; control: { items: number; bytes: number; oldestQueuedAt: number | null } };
  evals: { counts: Record<string, number>; active: HealthEval[]; limit: 288; truncated: boolean; reason: string | null };
  jobs: { counts: Record<string, number>; occupied: number; active: HealthJob[]; limit: 2; truncated: boolean; reason: string | null };
  effects: { unknown: number; pending: number; retryWait: number };
  capacity: { observedAt: number; dbBytes: number | null; walBytes: number | null; artifactIndexedBytes: number; diskAvailableBytes: number | null;
    reasons: { dbBytes: string | null; walBytes: string | null; diskAvailableBytes: string | null } };
  audit: { status: 'pending' | 'verified_scope'; pending: number; reason: string;
    verifiedScope: { sessionId: string; offset: number; prefixHash: string }[] };
}
export class StorageError extends Error {
  constructor(public readonly code: string, message = code) { super(message); this.name = 'StorageError'; }
}

/** null 表示受信用户明确授予的无期限授权；撤权仍由策略修订执行。 */
export function mandateExpired(expiresAt: number | null, now: number): boolean {
  return expiresAt !== null && expiresAt <= now;
}
