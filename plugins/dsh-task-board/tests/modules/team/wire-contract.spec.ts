/**
 * The wire contract and the collaboration fields the browser renders.
 *
 * Two things are checked here. First, comment authors read as names instead of
 * ids (S5). Second, the frozen samples under `team-hub/contract/` are the
 * authority for the request and response shapes this provider speaks: the fake
 * hub validates every Host call against them in both directions and at every
 * depth, and the assertions below name what the samples have to contain, so a
 * checkout that lost them fails the suite instead of validating nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareRequest, compareResponse, loadContractSamples } from './support/contract.ts'
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

/** Claim and start one issue, then return the card id. */
async function claimedCard(current: Harness): Promise<string> {
  current.hub.addIssue({ assigneeAgentId: 'agent_1' })
  await current.service().sweep()
  await flush()
  return current.tasks()[0].id
}

describe('comment authors', () => {
  it('member sees an agent comment attributed to the agent name', async () => {
    // Given a claimed issue whose card is mirrored here
    harness = makeHarness()
    const taskId = await claimedCard(harness)

    // When the hub pushes a comment the bound agent wrote
    harness.hub.push('comment.created', {
      comment: {
        id: 'comm_1',
        issue_id: 'issue_1',
        author_type: 'agent',
        author_agent_id: 'agent_1',
        content: 'migration applied',
        created_at: 1,
      },
    })
    await flush()

    // Then the detail section reads a name, never the hub's agent id
    expect(harness.service().summary().cards[taskId]?.comments[0]?.author).toBe('builder')
  })

  it('member sees a human comment attributed without exposing a member id', async () => {
    // Given a claimed issue whose card is mirrored here
    harness = makeHarness()
    const taskId = await claimedCard(harness)

    // When the hub pushes a comment from a member this Host cannot name
    harness.hub.push('comment.created', {
      comment: {
        id: 'comm_2',
        issue_id: 'issue_1',
        author_type: 'human',
        author_member_id: 'mem_unknown',
        content: 'looks good',
        created_at: 2,
      },
    })
    await flush()

    // Then the author is a readable label rather than a synthetic identifier
    const author = harness.service().summary().cards[taskId]?.comments[0]?.author ?? ''
    expect(author).toBe('team member')
    expect(author.includes('mem_')).toBe(false)
  })
})

describe('frozen wire samples', () => {
  it('operator sees every Host call match the samples this checkout carries', async () => {
    // Given a checkout that publishes the hub's frozen samples
    const contracts = loadContractSamples()

    // When a full claim, comment and settlement flow runs
    harness = makeHarness()
    const taskId = await claimedCard(harness)
    harness.hub.push('comment.created', {
      comment: { id: 'comm_3', issue_id: 'issue_1', author_type: 'agent', author_agent_id: 'agent_1', content: 'x', created_at: 3 },
    })
    await flush()
    harness.board.extensions.emitExecutionSettled({ taskId, executionId: harness.tasks()[0].executions[0].id, outcome: 'succeeded' })
    await flush()

    // Then the samples are really there, and no call drifted from its sample
    expect(contracts.present).toBe(true)
    expect(harness.hub.contractProblems).toEqual([])
  })

  it('operator sees the comment thread answer the comments-list sample', async () => {
    // Given the frozen comment-thread sample this comparison is owed to
    const sample = loadContractSamples().samples.find(entry => entry.interface === 'comments.list')
    expect(sample?.file).toBe('comments-list.json')

    // Given a claimed issue the bound agent commented on
    harness = makeHarness()
    const taskId = await claimedCard(harness)
    await harness.service().postComment({ taskId, text: 'Starting the run, will report back.' })

    // When this Host reads the thread back through the client it also posts with
    const thread = await harness.hubClient.comments('issue_1')

    // Then the hub served the frozen comments-list shape, unchanged
    expect(thread).toHaveLength(1)
    expect(thread[0]).toMatchObject({
      issue_id: 'issue_1',
      author_type: 'agent',
      author_agent_id: 'agent_1',
      content: 'Starting the run, will report back.',
    })
    expect(harness.hub.contractProblems).toEqual([])
  })

  it('operator sees a renamed field caught by the sample comparison', () => {
    // Given a frozen register sample that declares snake_case keys
    const sample = {
      interface: 'hosts.register',
      file: 'register.json',
      method: 'POST',
      path: '/api/v1/teams/:teamId/hosts/register',
      request: { body: { hostname: 'host', client_version: '0.4.12', agents: [{ name: 'builder', preset_id: 'liangshen' }] } },
      response: {},
    }

    // When a client sends the camelCase shape this round exists to remove
    const problems = compareRequest(sample, {
      headers: {},
      query: {},
      method: 'POST',
      path: '/api/v1/teams/team_1/hosts/register',
      body: { hostname: 'host', clientVersion: '0.4.12', agents: [{ name: 'builder', presetId: 'liangshen' }] },
    })

    // Then both renamed fields are named at the depth they were renamed at
    expect(problems).toEqual([
      'hosts.register body.clientVersion is not part of this interface',
      'hosts.register body.client_version is missing',
      'hosts.register body.agents[0].presetId is not part of this interface',
      'hosts.register body.agents[0].preset_id is missing',
    ])
  })

  it('operator sees a response element that lost a field caught by the sample comparison', () => {
    // Given the frozen issue list sample and the element it shows
    const sample = loadContractSamples().samples.find(entry => entry.interface === 'issues.list')
    if (sample === undefined) throw new Error('this checkout publishes no issues.list sample')
    const issues = sample.response.body?.issues
    if (!Array.isArray(issues) || issues.length === 0) throw new Error('the issues.list sample shows no issue')
    const shown = issues[0] as Record<string, unknown>
    const dropped: Record<string, unknown> = { ...shown }
    delete dropped.has_lease

    // When the hub answers two issues, the second of which lost that member
    const problems = compareResponse(sample, { issues: [shown, dropped] })

    // Then the loss is named on the element that lost it, and only there
    expect(problems).toEqual(['issues.list response.issues[1].has_lease is missing'])
  })
})
