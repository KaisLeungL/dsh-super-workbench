import type { HealthSummary } from '../../storage/types.js';
import { LIMITS } from '../../storage/types.js';
import type { ChatModelSelection } from './chat-input.js';

export interface HealthView {
  version: 'b04'; available: boolean; reason: string | null; sampledAt: number;
  summary: HealthSummary | null;
  automation: { accepting: boolean; generation: number; reason: string; disposed: boolean } | null;
  dependencies: { name: string; available: boolean; changed: boolean }[];
  contextSources?: readonly { id: string; available: boolean }[];
  handles: { evalTimers: number; jobs: { running: number; timers: number; pendingResults: number } } | null;
  capacityBlocks: string[];
  control: { enabled: boolean; reason: string | null };
  chat?: { sessionId: string | null; ready: boolean; reason: string | null; workspace: string; model: ChatModelSelection };
  nativeExecution: { status: 'unavailable'; reason: string };
  auditGate: { completeE37: false; reason: string };
}
export function capacityBlocks(summary: HealthSummary): string[] {
  const reasons: string[] = [], capacity = summary.capacity;
  if (!summary.diagnostics.healthy || summary.diagnostics.recoveryPending) reasons.push('存储不健康或尚待冷恢复');
  if (summary.evals.truncated || summary.jobs.truncated) reasons.push('持久运行项超出可观测上限');
  if (capacity.dbBytes === null || capacity.walBytes === null) reasons.push('数据库或WAL容量未提供');
  else if (capacity.dbBytes + capacity.walBytes >= LIMITS.dbBytes) reasons.push('数据库与WAL已达容量阈值');
  if (capacity.artifactIndexedBytes >= LIMITS.artifactsBytes) reasons.push('工件索引已达容量阈值');
  if (capacity.diskAvailableBytes === null) reasons.push('磁盘可用量未提供');
  else if (capacity.diskAvailableBytes < LIMITS.diskReserveBytes) reasons.push('磁盘预留不足');
  return reasons;
}
export function unavailableHealth(reason: string, sampledAt = Date.now()): HealthView {
  return { version: 'b04', available: false, reason, sampledAt, summary: null, automation: null,
    dependencies: [], handles: null, capacityBlocks: [],
    control: { enabled: false, reason },
    nativeExecution: { status: 'unavailable', reason: '原生卡的精确执行控制尚未接入，本页停止仅停止自有自动化。' },
    auditGate: { completeE37: false, reason: '仅展示已有已核范围；完整E37仍须独立候选验收，不能由SQLite健康推断。' } };
}
