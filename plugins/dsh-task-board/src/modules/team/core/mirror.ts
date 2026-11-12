/**
 * The card one hub issue becomes on this Host.
 *
 * Mirroring is deliberately one-way in shape: the card carries the issue's
 * title and body so an operator can read and run it locally, while every
 * collaboration field (assignee, reviewer, status, comments, activity) stays on
 * the hub and reaches the browser through the published summary. Nothing the
 * hub serves is ever interpreted as an execution target — remote text never
 * becomes a permission, a workspace or a preset.
 *
 * @module dsh-task-board-team/core/mirror
 */
import type { HubIssue } from './hub-protocol.ts'

/** Longest title a mirrored card carries, matching the hub's own issue cap. */
export const MIRROR_TITLE_LIMIT = 256

/** Longest issue body carried into a card description. */
export const MIRROR_DESCRIPTION_LIMIT = 32_000

/** The member one issue was claimed for, as the mirror needs it. */
export interface MirrorAgent {
  /** Hub agent record id. */
  agentId: string
  /** dsh-agents member id. */
  memberId: string
  /** Member name the hub resolves mentions by. */
  name: string
  /** Agent preset the member definition pins. */
  preset?: string
  /** Model the member definition pins, when it pins one. */
  model?: string
  /** Reasoning effort the member definition pins for that model. */
  reasoningEffort?: string
  /** Workspace the card runs in, as the caller resolved it for this member. */
  workspaceId?: string
}

/** The draft a mirror card is created from. */
export interface MirrorDraft {
  title: string
  description: string
  prompt: string
  workspaceId?: string
  mode?: string
  model?: string
  reasoningEffort?: string
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit)
}

/**
 * Build the card a claimed issue becomes.
 * @param issue - the claimed issue.
 * @param agent - the member it was claimed for.
 * @returns the draft the board creates the card from.
 */
export function buildMirrorDraft(issue: HubIssue, agent: MirrorAgent): MirrorDraft {
  const title = clip(`#${String(issue.issue_number)} ${issue.title}`, MIRROR_TITLE_LIMIT)
  const body = clip(issue.description, MIRROR_DESCRIPTION_LIMIT)
  const lines = [
    `Team issue ${issue.id} (issue #${String(issue.issue_number)}) claimed for agent ${agent.name}.`,
    '',
    issue.title.trim(),
  ]
  if (body !== '') lines.push('', body)
  lines.push(
    '',
    'Work on this task in this workspace. Report progress and ask for decisions with the team_comment tool;',
    'a question asked through ask_user_question is routed to the team and answered by its reviewer.',
    'Answering a rework request in the same session keeps the review thread on the hub intact.',
  )
  return {
    title,
    description: body === '' ? `Team issue #${String(issue.issue_number)} mirror card.` : body,
    prompt: lines.join('\n'),
    // The member's own execution targets travel with the draft: the run has to be
    // the member's preset, model and effort, never the deployment's defaults, and
    // in the workspace the caller resolved rather than one the board picks.
    ...(agent.workspaceId === undefined ? {} : { workspaceId: agent.workspaceId }),
    ...(agent.preset === undefined ? {} : { mode: agent.preset }),
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(agent.reasoningEffort === undefined ? {} : { reasoningEffort: agent.reasoningEffort }),
  }
}