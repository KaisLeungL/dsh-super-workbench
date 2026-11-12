/**
 * This extension's own payload on a mirror card.
 *
 * The board stores the payload opaquely and never interprets it, so the shape is
 * this provider's private contract with itself: it is what makes claiming,
 * lease renewal, settlement and rework idempotent across a reconnect, because
 * the attempt credentials the hub wants back are exactly what the card already
 * carries. Everything is optional on read: a payload written by an older
 * revision of this extension must degrade instead of throwing.
 *
 * @module dsh-task-board-team/core/identity
 */
import type { HubIssueStatus } from './hub-protocol.ts'
import type { TaskBoardExtensionPayload } from './contract.ts'
import type { SettleRequestBody } from './settlement.ts'
import type { TaskRecord } from './task-record.ts'

/** Extension id: also the key of this provider's integration payload. */
export const TEAM_EXTENSION_ID = 'task-board-team'

/** One mirror card's linkage back to its hub issue. */
export interface TeamIssueLink {
  /** Hub issue id the card mirrors. */
  issueId: string
  /** Human-facing issue number, when the hub reported one. */
  issueNumber?: number
  /** Execution attempt the hub granted on the last successful claim. */
  attemptId?: string
  /** Lease token that attempt holds; the credential a renew or a re-claim needs. */
  leaseToken?: string
  /** Lease expiry the hub last reported (ms epoch). */
  leaseExpiresAt?: number
  /** Hub agent record this member is bound as. */
  agentId?: string
  /** dsh-agents member id the binding came from. */
  agentMemberId?: string
  /** Agent preset the member definition pins, recorded for the operator. */
  preset?: string
  /** Last collaboration status the hub reported for this issue. */
  hubStatus?: HubIssueStatus
  /** Human assignee display name, when the hub named one. */
  assignee?: string
  /** Human reviewer display name, when the hub named one. */
  reviewer?: string
  /** Last provider-side failure worth keeping on the card. */
  lastError?: string
  /**
   * A settlement the hub has not accepted yet.
   *
   * Recorded before the write-back is sent: a hub that refuses it (a lapsed
   * attempt answers 412) must not lose what the run produced, so the next sweep
   * or reconnect retries this same body and the hub's own gates still decide.
   */
  pendingSettle?: SettleRequestBody
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read one linkage out of an opaque payload.
 * @param payload - the stored payload, or undefined.
 * @returns the linkage, or undefined when the payload carries no issue id.
 */
export function readTeamIssueLink(payload: TaskBoardExtensionPayload | undefined): TeamIssueLink | undefined {
  if (payload === undefined) return undefined
  const issueId = text(payload.issueId)
  if (issueId === undefined) return undefined
  const link: TeamIssueLink = { issueId }
  const issueNumber = count(payload.issueNumber)
  if (issueNumber !== undefined) link.issueNumber = issueNumber
  const attemptId = text(payload.attemptId)
  if (attemptId !== undefined) link.attemptId = attemptId
  const leaseToken = text(payload.leaseToken)
  if (leaseToken !== undefined) link.leaseToken = leaseToken
  const leaseExpiresAt = count(payload.leaseExpiresAt)
  if (leaseExpiresAt !== undefined) link.leaseExpiresAt = leaseExpiresAt
  const agentId = text(payload.agentId)
  if (agentId !== undefined) link.agentId = agentId
  const agentMemberId = text(payload.agentMemberId)
  if (agentMemberId !== undefined) link.agentMemberId = agentMemberId
  const preset = text(payload.preset)
  if (preset !== undefined) link.preset = preset
  const hubStatus = text(payload.hubStatus) as HubIssueStatus | undefined
  if (hubStatus !== undefined) link.hubStatus = hubStatus
  const assignee = text(payload.assignee)
  if (assignee !== undefined) link.assignee = assignee
  const reviewer = text(payload.reviewer)
  if (reviewer !== undefined) link.reviewer = reviewer
  const lastError = text(payload.lastError)
  if (lastError !== undefined) link.lastError = lastError
  const pendingSettle = readPendingSettle(payload.pendingSettle)
  if (pendingSettle !== undefined) link.pendingSettle = pendingSettle
  return link
}

/**
 * Read one recorded settlement out of an opaque payload.
 * @param value - the stored member, or undefined.
 * @returns the body to retry, or undefined when it carries no usable outcome.
 */
function readPendingSettle(value: unknown): SettleRequestBody | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const outcome = row.outcome === 'succeeded' || row.outcome === 'failed' ? row.outcome : undefined
  const summary = text(row.summary)
  if (outcome === undefined || summary === undefined) return undefined
  const pending: SettleRequestBody = { outcome, summary }
  const error = text(row.error)
  if (error !== undefined) pending.error = error
  const attemptId = text(row.execution_attempt_id)
  if (attemptId !== undefined) pending.execution_attempt_id = attemptId
  const evidence = row.verification_evidence
  if (typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence)) {
    pending.verification_evidence = evidence as Record<string, unknown>
  }
  return pending
}

/**
 * Read the linkage off one card.
 * @param task - the card to read.
 * @returns its linkage, or undefined when it does not mirror an issue.
 */
export function readTaskIssueLink(task: TaskRecord): TeamIssueLink | undefined {
  return readTeamIssueLink(task.integrations?.[TEAM_EXTENSION_ID] as TaskBoardExtensionPayload | undefined)
}

/**
 * Project a linkage back onto a payload, dropping undefined members so a merge
 * never stores a key whose value is absent.
 * @param link - the linkage to store.
 * @returns the payload the board keeps under this extension's id.
 */
export function toPayload(link: TeamIssueLink): TaskBoardExtensionPayload {
  const payload: TaskBoardExtensionPayload = { issueId: link.issueId }
  if (link.issueNumber !== undefined) payload.issueNumber = link.issueNumber
  if (link.attemptId !== undefined) payload.attemptId = link.attemptId
  if (link.leaseToken !== undefined) payload.leaseToken = link.leaseToken
  if (link.leaseExpiresAt !== undefined) payload.leaseExpiresAt = link.leaseExpiresAt
  if (link.agentId !== undefined) payload.agentId = link.agentId
  if (link.agentMemberId !== undefined) payload.agentMemberId = link.agentMemberId
  if (link.preset !== undefined) payload.preset = link.preset
  if (link.hubStatus !== undefined) payload.hubStatus = link.hubStatus
  if (link.assignee !== undefined) payload.assignee = link.assignee
  if (link.reviewer !== undefined) payload.reviewer = link.reviewer
  if (link.lastError !== undefined) payload.lastError = link.lastError
  if (link.pendingSettle !== undefined) payload.pendingSettle = { ...link.pendingSettle }
  return payload
}

/**
 * Find the card that already mirrors one issue.
 * @param linked - every card this extension linked.
 * @param issueId - the issue to look for.
 * @returns the linked task, or undefined when the issue has no card yet.
 */
export function findLinkedTask(
  linked: readonly { task: TaskRecord; payload: TaskBoardExtensionPayload }[],
  issueId: string,
): TaskRecord | undefined {
  for (const entry of linked) {
    const link = readTeamIssueLink(entry.payload)
    if (link?.issueId === issueId) return entry.task
  }
  return undefined
}

/**
 * Find the card whose execution owns one session.
 *
 * Questions and mentions arrive addressed by SESSION, and the only session a
 * team question may be routed for is one a mirror card opened — that is what
 * keeps this provider out of every other conversation on the machine.
 * @param linked - every card this extension linked.
 * @param sessionId - the session that asked, or that will receive the message.
 * @returns the linked task, or undefined when this session is not a team card's.
 */
export function findTaskBySession(
  linked: readonly { task: TaskRecord; payload: TaskBoardExtensionPayload }[],
  sessionId: string,
): TaskRecord | undefined {
  for (const entry of linked) {
    if (readTeamIssueLink(entry.payload) === undefined) continue
    if (entry.task.executions.some(execution => execution.sessionId === sessionId)) return entry.task
  }
  return undefined
}
