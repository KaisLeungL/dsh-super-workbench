/**
 * The published summary this extension's browser half renders.
 *
 * The Host publishes one opaque payload per extension; the board forwards it
 * verbatim in the snapshot and this module is the only place that interprets it.
 * It is a store rather than a hook so the seats (which receive only their owner
 * props) can read one live value and re-render when the board pushes a new one.
 *
 * @module dsh-task-board-team/client/team/summary
 */
import { useSyncExternalStore } from 'react'
import type { TeamExtensionSummary } from '../../host/service.ts'

/** The value the seats read. */
const EMPTY: TeamExtensionSummary | undefined = undefined

let current: TeamExtensionSummary | undefined = EMPTY
const listeners = new Set<() => void>()

/**
 * Take the summaries the board snapshot carries.
 * @param extensions - the snapshot's published extension summaries.
 */
export function acceptPublishedSummaries(extensions: Readonly<Record<string, unknown>> | undefined): void {
  const entry = extensions?.['task-board-team']
  const next = readSummary(entry)
  if (next === undefined && current === undefined) return
  current = next
  for (const listener of [...listeners]) listener()
}

/** Drop the published summary: a hidden provider must not look like live state. */
export function clearSummary(): void {
  if (current === undefined) return
  current = undefined
  for (const listener of [...listeners]) listener()
}

/**
 * Read the live summary.
 * @returns the summary, or undefined before the Host published one.
 */
export function getSummary(): TeamExtensionSummary | undefined {
  return current
}

/**
 * Read one card's collaboration view.
 * @param taskId - the board card id.
 * @returns the view, or undefined when this card mirrors no issue.
 */
export function cardViewOf(taskId: string): TeamExtensionSummary['cards'][string] | undefined {
  return current?.cards[taskId]
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Subscribe one component to the live summary.
 * @returns the current summary and a re-render on every change.
 */
export function useTeamSummary(): TeamExtensionSummary | undefined {
  return useSyncExternalStore(subscribe, getSummary, getSummary)
}

/**
 * Validate one published payload into the summary shape.
 *
 * A payload from another revision of this extension is read for the fields it
 * does carry and never trusted for the ones it does not, so a version skew
 * degrades one section instead of throwing inside the board's render.
 * @param raw - the opaque payload the board forwarded.
 * @returns the summary, or undefined when it carries no usable shape.
 */
export function readSummary(raw: unknown): TeamExtensionSummary | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Partial<TeamExtensionSummary>
  if (typeof value.connection !== 'object' || value.connection === null) return undefined
  const connection = value.connection as TeamExtensionSummary['connection']
  return {
    connection: {
      state: readState(connection.state),
      ...(typeof connection.hostId === 'string' ? { hostId: connection.hostId } : {}),
      ...(typeof connection.lastHeartbeatAt === 'number' ? { lastHeartbeatAt: connection.lastHeartbeatAt } : {}),
      reconnects: typeof connection.reconnects === 'number' ? connection.reconnects : 0,
      ...(typeof connection.lastError === 'string' ? { lastError: connection.lastError } : {}),
    },
    capabilities: {
      followUp: value.capabilities?.followUp === true,
      rework: value.capabilities?.rework === true,
      run: value.capabilities?.run === true,
    },
    agents: Array.isArray(value.agents)
      ? value.agents.flatMap(agent => typeof agent?.memberId === 'string' && typeof agent?.name === 'string'
        ? [{
            memberId: agent.memberId,
            name: agent.name,
            ...(typeof agent.preset === 'string' ? { preset: agent.preset } : {}),
            ...(typeof agent.hubAgentId === 'string' ? { hubAgentId: agent.hubAgentId } : {}),
          }]
        : [])
      : [],
    problems: Array.isArray(value.problems) ? value.problems.filter((line): line is string => typeof line === 'string') : [],
    presetPin: value.presetPin === 'supported' || value.presetPin === 'missing' ? value.presetPin : 'unknown',
    cards: typeof value.cards === 'object' && value.cards !== null ? value.cards : {},
    ...(readConfigurationField(value.configuration) === undefined
      ? {}
      : { configuration: readConfigurationField(value.configuration) as NonNullable<TeamExtensionSummary['configuration']> }),
    pendingQuestions: Array.isArray(value.pendingQuestions)
      ? value.pendingQuestions.flatMap(question => typeof question?.taskId === 'string'
        ? [{
            id: typeof question.id === 'string' ? question.id : '',
            taskId: question.taskId,
            issueId: typeof question.issueId === 'string' ? question.issueId : '',
            question: typeof question.question === 'string' ? question.question : '',
            askedAt: typeof question.askedAt === 'number' ? question.askedAt : 0,
            ...(typeof question.hubQuestionId === 'string' ? { hubQuestionId: question.hubQuestionId } : {}),
          }]
        : [])
      : [],
  }
}

/**
 * Read the configuration half of one published payload.
 * @param raw - the opaque member.
 * @returns the fields this build understands, or undefined when there are none.
 */
function readConfigurationField(raw: unknown): TeamExtensionSummary['configuration'] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  const configuration: NonNullable<TeamExtensionSummary['configuration']> = {
    ...(typeof value.hubUrl === 'string' ? { hubUrl: value.hubUrl } : {}),
    ...(typeof value.teamId === 'string' ? { teamId: value.teamId } : {}),
    ...(typeof value.hostname === 'string' ? { hostname: value.hostname } : {}),
    ...(typeof value.tokenConfigured === 'boolean' ? { tokenConfigured: value.tokenConfigured } : {}),
    ...(typeof value.questionWaitMinutes === 'number' ? { questionWaitMinutes: value.questionWaitMinutes } : {}),
  }
  return Object.keys(configuration).length === 0 ? undefined : configuration
}

function readState(raw: unknown): TeamExtensionSummary['connection']['state'] {
  switch (raw) {
    case 'idle':
    case 'connecting':
    case 'online':
    case 'reconnecting':
    case 'error':
      return raw
    default:
      return 'idle'
  }
}