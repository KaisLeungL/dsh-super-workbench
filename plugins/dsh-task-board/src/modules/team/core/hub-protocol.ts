/**
 * Wire vocabulary of the team-hub protocol v1, as the Host half reads it.
 *
 * The protocol specification (`team-hub/PROTOCOL.md`) is the single source of
 * truth; this module restates only what a Host uses and the operational
 * constants section 13 fixes, so a drift in either direction is visible in one
 * place. Nothing here interprets collaboration semantics: the hub is
 * authoritative over issues, comments, questions and activity, and the Host is
 * authoritative over execution.
 *
 * @module dsh-task-board-team/core/hub-protocol
 */

/** Protocol version sent on every REST call and on the WebSocket handshake. */
export const HUB_PROTOCOL_VERSION = '1.0.0'

/** Header carrying {@link HUB_PROTOCOL_VERSION}. */
export const HUB_PROTOCOL_HEADER = 'X-Team-Hub-Protocol-Version'

/** Prefix of every REST path this Host speaks. */
export const HUB_API_PREFIX = '/api/v1'

/** Heartbeat cadence the hub expects from an online Host (section 13). */
export const HEARTBEAT_INTERVAL_MS = 15_000

/** Lease lifetime the hub grants on a claim (section 13). */
export const LEASE_DURATION_MS = 60_000

/** Lease renewal cadence while an execution is active (section 13). */
export const LEASE_RENEW_INTERVAL_MS = 20_000

/** Question lifetime before the hub expires it (section 13). */
export const QUESTION_TTL_MS = 86_400_000

/** Execution summary character cap, aligned with the board's own limit. */
export const EXECUTION_SUMMARY_LIMIT = 4_000

/** Comment text byte cap (section 11). */
export const COMMENT_LIMIT_BYTES = 32_768

/** Cadence the claim sweep is coalesced to (protocol amendment A4 point 6). */
export const SWEEP_INTERVAL_MS = 5_000

/** Backoff the reconnect loop starts at after a dropped WebSocket. */
export const RECONNECT_BASE_MS = 1_000

/** Upper bound of the reconnect backoff; a longer outage never waits longer. */
export const RECONNECT_MAX_MS = 30_000

/** Client version this Host reports at registration. */
export const HOST_CLIENT_VERSION = '0.4.12'

/** Collaboration status of one issue, owned by the hub. */
export type HubIssueStatus =
  | 'todo'
  | 'assigned'
  | 'waiting_host'
  | 'running'
  | 'in_review'
  | 'done'
  | 'canceled'
  | 'failed'

/**
 * One Agent definition this Host registers with the hub.
 *
 * Protocol amendment A4 fixes the registration body as snake_case and requires a
 * non-empty `preset_id`: a member whose definition pins no preset is not
 * reported at all, because the hub would otherwise store an agent this Host can
 * only run under the deployment's default preset.
 */
export interface HubAgentDefinition {
  /** Name the hub resolves `@` mentions by. */
  name: string
  /** Agent preset id the member definition pins; never empty. */
  preset_id: string
  /** Pinned model of that member, when it pins one. */
  model?: string
  /** Reasoning effort bound to that model, when the member pins one. */
  reasoning_effort?: string
}

/** One Agent record the hub answered registration with. */
export interface HubAgentRecord {
  id: string
  name: string
}

/** One issue, as the hub serves it. */
export interface HubIssue {
  id: string
  issue_number: number
  title: string
  description: string
  status: HubIssueStatus
  assignee_type?: 'member' | 'agent'
  assignee_member_id?: string
  assignee_agent_id?: string
  reviewer_member_id?: string
  executing_host_id?: string
  lease_expires_at?: number
  /** Attempt the hub currently holds for this issue; null when it holds none. */
  execution_attempt_id?: string | null
  execution_summary?: string
  /**
   * Rework instructions waiting to be applied (protocol amendment A4 point 5).
   *
   * Non-empty instructions on the issue mean "a review sent this back": whichever
   * path claims the card next must apply them to the existing mirror card.
   */
  rework_instructions?: string | null
  failure_error?: string | null
  updated_at?: number
}

/** What a successful claim hands back. */
export interface HubClaim {
  lease_token: string
  lease_expires_at: number
  execution_attempt_id: string
}

/** One selectable answer, as the hub exposes it on the wire. */
export interface HubQuestionOption {
  label: string
  description?: string
}

/**
 * One decision question, in the wire shape (protocol amendment A2).
 *
 * The D1 columns `options_json` and `answer_json` are storage forms only: over
 * the wire both are parsed values, so this client never sees a serialized string
 * and never produces one.
 */
export interface HubQuestion {
  id: string
  issue_id: string
  /** Question prompt text. */
  text: string
  options: readonly HubQuestionOption[] | null
  multi_select: boolean
  status: 'pending' | 'answered' | 'dismissed' | 'expired'
  answer: HubQuestionAnswer | null
  answered_at: number | null
}

/** One comment on an issue. */
export interface HubComment {
  id: string
  issue_id: string
  author_type: 'human' | 'agent'
  author_member_id?: string
  author_agent_id?: string
  content: string
  created_at: number
}

/**
 * One entry of the hub's append-only activity stream, in the wire shape: the
 * payload is a JSON object here, and `payload_json` exists only inside D1.
 */
export interface HubActivity {
  id: string
  issue_id: string
  actor_type: 'member' | 'agent' | 'host' | 'system'
  actor_id: string | null
  activity_type: string
  payload: Record<string, unknown>
  created_at: number
}

/** The answer one human gives to one question (protocol amendment A2). */
export interface HubQuestionAnswer {
  selected: readonly string[]
  custom?: string
}

/** One client frame the Host sends on the team channel. */
export type HubClientFrame =
  | { t: 'ping'; ts: number }
  | { t: 'resume'; since_seq: number }

/** One server frame the Host reads from the team channel. */
export type HubServerFrame =
  | { t: 'pong'; ts: number }
  | { t: 'event'; seq: number; event: string; payload: Record<string, unknown>; ts: number }
  | { t: 'resync_required'; reason: string; latest_seq: number }

/**
 * Read one server frame, tolerating anything the hub may add.
 * @param raw - one decoded frame.
 * @returns the frame, or undefined when it carries no recognizable shape.
 */
export function readServerFrame(raw: unknown): HubServerFrame | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const frame = raw as Record<string, unknown>
  switch (frame.t) {
    case 'pong':
      return { t: 'pong', ts: typeof frame.ts === 'number' ? frame.ts : 0 }
    case 'event': {
      if (typeof frame.seq !== 'number' || typeof frame.event !== 'string') return undefined
      const payload = typeof frame.payload === 'object' && frame.payload !== null
        ? frame.payload as Record<string, unknown>
        : {}
      return { t: 'event', seq: frame.seq, event: frame.event, payload, ts: typeof frame.ts === 'number' ? frame.ts : 0 }
    }
    case 'resync_required':
      return {
        t: 'resync_required',
        reason: typeof frame.reason === 'string' ? frame.reason : '',
        latest_seq: typeof frame.latest_seq === 'number' ? frame.latest_seq : 0,
      }
    default:
      return undefined
  }
}