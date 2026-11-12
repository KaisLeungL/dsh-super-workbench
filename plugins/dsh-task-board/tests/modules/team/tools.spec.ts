/**
 * The comment tool and the extension's action surface.
 *
 * \`team_comment\` is the agent's half of the collaboration surface, and the
 * actions are what the settings block drives over the board's same-origin
 * channel. Both are exercised against a live provider over the fake hub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTeamTools } from '../../../src/modules/team/host/tools.ts'
import { TEAM_EXTENSION_ID, readTaskIssueLink } from '../../../src/modules/team/core/identity.ts'
import { flush, makeHarness, type Harness } from './support/harness.ts'

let harness: Harness | undefined

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  harness?.release()
  harness = undefined
  vi.useRealTimers()
})

/** Claim one issue so a card and its hub agent exist. */
async function claimedCard(current: Harness): Promise<string> {
  current.hub.addIssue({ assigneeAgentId: 'agent_1' })
  await current.service().sweep()
  await flush()
  return current.tasks()[0].id
}

/** Run one tool definition the way the registry would. */
async function callTool(harnessValue: Harness, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const [tool] = buildTeamTools(harnessValue.service())
  const result = await tool.execute(args, {
    signal: new AbortController().signal,
  } as never)
  return result as Record<string, unknown>
}

describe('team_comment', () => {
  it('operator sees an agent comment land on the issue its card mirrors', async () => {
    // Given a claimed issue with a card
    harness = makeHarness()
    const taskId = await claimedCard(harness)

    // When the agent comments on that card
    const result = await callTool(harness, { taskId, text: 'the migration is applied' })

    // Then the hub stored it as an agent comment from the bound agent record
    expect(result.ok).toBe(true)
    expect(harness.hub.comments).toHaveLength(1)
    expect(harness.hub.comments[0]).toMatchObject({ issue_id: 'issue_1', content: 'the migration is applied', author_agent_id: 'agent_1' })
    expect(readTaskIssueLink(harness.tasks()[0])?.issueId).toBe('issue_1')
  })

  it('operator gets an agent refusal for a card that mirrors no issue', async () => {
    // Given a plain board card
    harness = makeHarness()
    harness.board.apply('plain-card', { kind: 'create', id: 'plain', input: { title: 'Plain', description: '', prompt: 'p' } })

    // When the agent comments on it
    const result = await callTool(harness, { taskId: 'plain', text: 'hello' })

    // Then the refusal names the missing link and no comment was sent
    expect(result.ok).toBe(false)
    expect(String(result.message)).toContain('does not mirror')
    expect(harness.hub.comments).toHaveLength(0)
  })

  it('operator gets an agent refusal for a blank body and for a body past the byte cap', async () => {
    // Given a claimed issue
    harness = makeHarness()
    const taskId = await claimedCard(harness)

    // When the agent sends an empty body, then an oversized one
    const blank = await callTool(harness, { taskId, text: '   ' })
    const oversized = await callTool(harness, { taskId, text: 'x'.repeat(40_000) })

    // Then both are refused locally, with no hub round trip
    expect(blank.code).toBe('text-required')
    expect(oversized.code).toBe('text-too-long')
    expect(harness.hub.comments).toHaveLength(0)
  })

  it('operator gets an agent refusal when no target is named', async () => {
    // Given a running provider
    harness = makeHarness()
    await harness.service().start()

    // When the tool is called with no target
    const result = await callTool(harness, { text: 'hello' })

    // Then the refusal asks for a target
    expect(result.code).toBe('target-required')
  })
})

describe('extension actions', () => {
  it('operator refreshes the claim sweep through the board action channel', async () => {
    // Given a provider that finished its bootstrap and one issue assigned later
    harness = makeHarness()
    await harness.service().whenStarted()
    harness.hub.addIssue({ assigneeAgentId: 'agent_1' })

    // When the settings block asks for a refresh
    const result = await harness.board.extensions.handleAction({
      extensionId: TEAM_EXTENSION_ID,
      action: 'refresh',
    }) as Record<string, unknown>

    // Then one issue was claimed and the answer says so
    expect(result).toEqual({ ok: true, claimed: 1 })
    expect(harness.tasks()).toHaveLength(1)
  })

  it('operator gets a refusal for an action this provider does not own', async () => {
    // Given a registered provider
    harness = makeHarness()

    // When an unknown action is dispatched
    const refusal = await harness.board.extensions.handleAction({
      extensionId: TEAM_EXTENSION_ID,
      action: 'delete-everything',
    }).catch((error: unknown) => error)

    // Then the refusal names the action
    expect(String(refusal)).toContain('delete-everything')
  })

  it('operator sees an agent comment posted through the action channel as well', async () => {
    // Given a claimed issue
    harness = makeHarness()
    const taskId = await claimedCard(harness)

    // When a comment is dispatched through the board channel
    const result = await harness.board.extensions.handleAction({
      extensionId: TEAM_EXTENSION_ID,
      action: 'comment',
      taskId,
      payload: { text: 'from the settings block' },
    }) as Record<string, unknown>

    // Then the hub stored it
    expect(result.ok).toBe(true)
    expect(harness.hub.comments[0]?.content).toBe('from the settings block')
  })
})