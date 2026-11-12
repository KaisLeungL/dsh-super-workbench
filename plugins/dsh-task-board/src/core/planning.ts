import type { TaskRecord } from './tasks.ts'

/** Business ownership is independent of the directory a run executes in. */
export function resolveProjectId(task: Pick<TaskRecord, 'projectId' | 'workspaceId'>): string | null {
  return task.projectId === undefined ? task.workspaceId ?? null : task.projectId
}

export interface TaskOrigin {
  kind: 'inspection'
  ruleId: string
  batchId: string
}
export interface TaskRecommendation {
  sourceKey: string
  fingerprint: string
  reasonNow: string
  evidenceRefs: string[]
  acceptanceCriteria: string[]
  scope: string
  effortBand: string
  observedAt: number
  validUntil?: number
}
export interface TaskPlanning {
  state: 'proposed' | 'accepted' | 'snoozed' | 'dismissed' | 'stale'
  acceptedAt?: number
  acceptedBy?: string
  acceptedRevision?: number
  snoozedUntil?: number
  dismissReason?: string
}
export interface TaskBusinessEvent {
  id: string
  at: number
  kind: string
  actor?: string
  executionId?: string
  detail?: string
}
export interface TaskWaiting {
  kind: 'user' | 'permission' | 'external' | 'dependency'
  since: number
  executionId: string
  reason?: string
}
export type CompletionPolicy = 'auto' | 'human-review'

const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 4000
const instant = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
export function isProjectId(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || (text(value) && value.length <= 256)
}
export function isTaskOrigin(value: unknown): value is TaskOrigin {
  if (typeof value !== 'object' || value === null) return false
  const row = value as TaskOrigin
  return Object.keys(row).every(key => ['kind', 'ruleId', 'batchId'].includes(key)) && row.kind === 'inspection' && text(row.ruleId) && text(row.batchId)
}
export function isTaskRecommendation(value: unknown): value is TaskRecommendation {
  if (typeof value !== 'object' || value === null) return false
  const row = value as TaskRecommendation
  const list = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 40 && v.every(text)
  return Object.keys(row).every(key => ['sourceKey', 'fingerprint', 'reasonNow', 'evidenceRefs', 'acceptanceCriteria', 'scope', 'effortBand', 'observedAt', 'validUntil'].includes(key))
    && text(row.sourceKey) && text(row.fingerprint) && text(row.reasonNow) && text(row.scope)
    && text(row.effortBand) && list(row.evidenceRefs) && list(row.acceptanceCriteria)
    && instant(row.observedAt) && (row.validUntil === undefined || instant(row.validUntil))
}
/** Presence of any recommendation marker fails closed, even if another marker is damaged. */
export function isUnacceptedRecommendation(task: Pick<TaskRecord, 'origin' | 'recommendation' | 'planning'>): boolean {
  if (task.origin === undefined && task.recommendation === undefined && task.planning === undefined) return false
  return !isTaskOrigin(task.origin) || !isTaskRecommendation(task.recommendation) || task.planning?.state !== 'accepted' || !instant(task.planning.acceptedAt)
    || !text(task.planning.acceptedBy) || !instant(task.planning.acceptedRevision)
}
export function appendBusinessEvent(task: TaskRecord, event: TaskBusinessEvent): TaskRecord {
  return { ...task, timeline: [...(task.timeline ?? []), event].slice(-200) }
}
