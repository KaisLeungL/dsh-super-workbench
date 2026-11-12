/**
 * Mentions and rework: the two deliveries that push work INTO a card.
 *
 * A comment that mentions an agent becomes a follow-up message in that card's
 * session, and a review rejection becomes a re-run of the same session — but only
 * after the hub granted a fresh attempt. Both capabilities are optional in the
 * provider contract, so both specs also prove the visible degradation a board
 * without them produces: nothing is silently dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readTaskIssueLink } from '../../../src/modules/team/core/identity.ts'
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

/**
 * Reject the review on the hub, the way `POST /review/reject` does: the issue
 * returns to the bound Host for rework (`team-hub/PROTOCOL.md` section 8), which
 * is the only status a rework claim may be granted from.
 */
function rejectOnHub(current: Harness, instructions: string): void {
  const issue = current.hub.issues.get('issue_1')
  if (issue === undefined) throw new Error('the fake hub lost the issue')
  issue.status = 'assigned'
  issue.reworkInstructions = instructions
}

/**
 * Let one settle-and-write-back pass happen for a card: the execution settles in
 * the ledger AND the board's own fanout tells the provider, which is what clears
 * the hub's lease and lets a rework claim succeed.
 */
async function settleOnce(
  current: Harness,
  taskId: string,
  outcome: 'succeeded' | 'failed' = 'succeeded',
  error?: string,
): Promise<void> {
  const task = current.tasks().find(candidate => candidate.id === taskId)
  const execution = task?.executions[task.executions.length - 1]
  if (task === undefined || execution === undefined) throw new Error('the card has no execution to settle')
  current.ledger.settle(taskId, execution.id, outcome, error)
  current.board.extensions.emitExecutionSettled({
    taskId,
    executionId: execution.id,
    outcome,
    ...(error === undefined ? {} : { error }),
  })
  await flush()
}

describe('mention delivery', () => {
  it('operator sees a mention arrive as a follow-up message in the agent session', async () => {
    // Given a claimed issue whose card already executed
    const delivered: Array<{ taskId: string; text: string }> = []
    harness = makeHarness()
    const taskId = await claimedCard(harness)
    await settleOnce(harness, taskId)
    const followUp = harness.face().sessions?.followUp
    if (followUp === undefined) throw new Error('the harness face serves no follow-up')

    // When the hub pushes a mention of the bound agent
    harness.hub.push('comment.mentioned', {
      issue_id: 'issue_1',
      comment_id: 'comm_9',
      author: 'alice',
      content: 'can you also update the docs?',
    })
    await flush()

    // Then the session received the message and the card recorded who said it
    const view = harness.service().summary().cards[taskId]
    expect(view?.activity.map(entry => entry.type)).toContain('comment.mentioned')
    expect(view?.activity.some(entry => entry.text.includes('alice'))).toBe(true)
    void delivered
  })

  it('operator sees a mention recorded even when this board serves no follow-up', async () => {
    // Given a board revision without the follow-up capability
    harness = makeHarness({ withFollowUp: false })
    const taskId = await claimedCard(harness)
    await settleOnce(harness, taskId)

    // When the hub pushes a mention
    harness.hub.push('comment.mentioned', { issue_id: 'issue_1', comment_id: 'comm_1', author: 'alice', content: 'ping' })
    await flush()

    // Then the card keeps the mention AND says why it could not be delivered
    const view = harness.service().summary().cards[taskId]
    expect(view?.activity.map(entry => entry.type)).toContain('comment.mentioned')
    expect(String(view?.lastError)).toContain('follow-up')
    expect(readTaskIssueLink(harness.tasks()[0])?.lastError).toContain('follow-up')
  })

  it('operator sees a refused delivery surfaced on the card instead of swallowed', async () => {
    // Given a follow-up seam that refuses the delivery
    harness = makeHarness({ followUpError: new Error('session is not attached to this host') })
    const taskId = await claimedCard(harness)
    await settleOnce(harness, taskId)

    // When the hub pushes a mention
    harness.hub.push('comment.mentioned', { issue_id: 'issue_1', comment_id: 'comm_2', author: 'bob', content: 'ping' })
    await flush()

    // Then the refusal is visible on the card
    expect(harness.service().summary().cards[taskId]?.lastError).toBe('session is not attached to this host')
  })
})

describe('rework', () => {
  it('operator sees a review rejection re-run the same session under a freshly minted attempt', async () => {
    // Given a claimed issue whose card executed once
    harness = makeHarness()
    const taskId = await claimedCard(harness)
    const first = readTaskIssueLink(harness.tasks()[0])?.attemptId
    expect(first).toBe('attempt_1')
    await settleOnce(harness, taskId)

    // When the reviewer rejects with instructions
    rejectOnHub(harness, 'add the missing test')
    harness.hub.push('issue.rework', { issue_id: 'issue_1', instructions: 'add the missing test', reviewer_member_id: 'mem_reviewer' })
    await flush()

    // Then the claim was fresh, because a rework is a new attempt and the hub
    // mints its id (protocol amendment A4 point 5): the finished attempt's
    // credentials are not presented again
    const claims = harness.hub.calls.filter(call => call.path.endsWith('/claim'))
    const presented = claims[claims.length - 1]?.body as { execution_attempt_id?: string } | undefined
    expect(presented?.execution_attempt_id).toBeUndefined()
    // And the card carried the attempt the hub minted for it: the write-back of
    // the reworked run names that attempt, never the finished one
    const settles = harness.hub.calls.filter(call => call.path.endsWith('/settle'))
    const settled = settles[settles.length - 1]?.body as { execution_attempt_id?: string } | undefined
    expect(settled?.execution_attempt_id).toBe('attempt_2')
    // And the card re-ran in its own session with the reviewer's instructions
    const executions = harness.tasks()[0].executions
    expect(executions).toHaveLength(2)
    expect(executions[executions.length - 1].rework?.instructions).toBe('add the missing test')
  })

  it('operator sees the rejection event and a sweep race one claim and record no error', async () => {
    // Given a mirrored card that already ran, and an issue the reviewer sent back
    harness = makeHarness()
    const taskId = await claimedCard(harness)
    await settleOnce(harness, taskId)
    rejectOnHub(harness, 'add the missing test')

    const claimsBefore = harness.hub.calls.filter(call => call.path.endsWith('/claim')).length

    // When the sweep's own claim is still in flight and the rejection event asks
    // for the same issue (the two signals the hub sends back to back)
    harness.hub.holdNextClaim()
    const swept = harness.service().sweep()
    await flush()
    harness.hub.push('issue.updated', { issue: { id: 'issue_1' }, changed_fields: ['status', 'rework_instructions'] })
    harness.hub.push('issue.rework', { issue_id: 'issue_1', instructions: 'add the missing test', reviewer_member_id: 'mem_reviewer' })
    await flush()
    harness.hub.releaseClaim()
    await swept
    await vi.advanceTimersByTimeAsync(5_000)
    await flush()

    // Then the in-flight claim was the only one, and the path that found it is
    // not reported as a failure anywhere the operator can see
    expect(harness.hub.calls.filter(call => call.path.endsWith('/claim'))).toHaveLength(claimsBefore + 1)
    expect(harness.tasks()).toHaveLength(1)
    expect(harness.tasks()[0].executions).toHaveLength(2)
    expect(harness.service().summary().connection.lastError).toBeUndefined()
    expect(harness.service().summary().cards[taskId]?.lastError).toBeUndefined()
    expect(readTaskIssueLink(harness.tasks()[0])?.lastError).toBeUndefined()
  })

  it('operator sees a rejection on an issue the hub closed recorded instead of run', async () => {
    // Given a card whose run failed and whose outcome the hub accepted
    harness = makeHarness()
    const taskId = await claimedCard(harness)
    await settleOnce(harness, taskId, 'failed', 'the acceptance command exited 1')
    const issue = harness.hub.issues.get('issue_1')
    if (issue === undefined) throw new Error('the fake hub lost the issue')
    expect(issue.status).toBe('failed')

    // When a rejection arrives for that closed issue
    harness.hub.push('issue.rework', { issue_id: 'issue_1', instructions: 'add the missing test', reviewer_member_id: 'mem_reviewer' })
    await flush()

    // Then the hub refused the impossible transition and nothing ran here
    expect(harness.tasks()[0].executions).toHaveLength(1)
    expect(String(harness.service().summary().cards[taskId]?.lastError)).toContain('INVALID_STATE_TRANSITION')

    // And the same gate holds for an issue the hub parked in todo
    issue.status = 'todo'
    harness.hub.push('issue.rework', { issue_id: 'issue_1', instructions: 'add the missing test', reviewer_member_id: 'mem_reviewer' })
    await flush()
    expect(issue.status).toBe('todo')
    expect(harness.tasks()[0].executions).toHaveLength(1)
  })

  it('operator sees a pending rework applied when a sweep claims the card instead of the event', async () => {
    // Given an issue whose review was rejected while this Host was offline, and a
    // card that already executed once
    harness = makeHarness()
    const taskId = await claimedCard(harness)
    await settleOnce(harness, taskId)
    rejectOnHub(harness, 'add the missing test')

    // When the sweep claims the card again (no issue.rework event at all)
    await harness.service().sweep()
    await flush()

    // Then the rework ran on the existing card, from the instructions the issue carried
    const executions = harness.tasks()[0].executions
    expect(executions).toHaveLength(2)
    expect(executions[executions.length - 1].rework?.instructions).toBe('add the missing test')
  })

  it('operator sees an event and a sweep for the same issue apply the rework only once', async () => {
    // Given an issue whose review was rejected, with a card that already executed
    harness = makeHarness()
    const taskId = await claimedCard(harness)
    await settleOnce(harness, taskId)
    rejectOnHub(harness, 'try again')

    // When the rejection event and the sweep arrive together
    harness.hub.push('issue.rework', { issue_id: 'issue_1', instructions: 'try again', reviewer_member_id: 'mem_reviewer' })
    const swept = harness.service().sweep()
    await swept
    await vi.advanceTimersByTimeAsync(5_000)
    await flush()

    // Then one claim at a time kept the card to a single extra execution
    expect(harness.tasks()[0].executions).toHaveLength(2)
  })

  it('operator sees a rejected claim start no execution at all', async () => {
    // Given a claimed issue whose card executed once
    harness = makeHarness()
    const taskId = await claimedCard(harness)
    await settleOnce(harness, taskId)
    rejectOnHub(harness, 'add the missing test')
    const executionsBefore = harness.tasks()[0].executions.length
    harness.hub.failNextClaim = 'HOST_MISMATCH'

    // When the reviewer rejects and the hub refuses the new attempt
    harness.hub.push('issue.rework', { issue_id: 'issue_1', instructions: 'add the missing test', reviewer_member_id: 'mem_reviewer' })
    await flush()

    // Then nothing ran and the local error names the refusal
    expect(harness.tasks()[0].executions).toHaveLength(executionsBefore)
    expect(String(harness.service().summary().cards[taskId]?.lastError)).toContain('HOST_MISMATCH')
  })

  it('operator sees a rework recorded when this board serves no rework capability', async () => {
    // Given a board revision without the rework capability
    harness = makeHarness({ withRework: false })
    const taskId = await claimedCard(harness)
    await settleOnce(harness, taskId)
    rejectOnHub(harness, 'try again')
    const executionsBefore = harness.tasks()[0].executions.length

    // When the reviewer rejects
    harness.hub.push('issue.rework', { issue_id: 'issue_1', instructions: 'try again', reviewer_member_id: 'mem_reviewer' })
    await flush()

    // Then the claim still happened, no session was started, and the gap is named
    expect(harness.tasks()[0].executions).toHaveLength(executionsBefore)
    expect(String(harness.service().summary().cards[taskId]?.lastError)).toContain('rework')
  })

  it('operator sees a rework for an issue this Host does not mirror ignored', async () => {
    // Given a Host mirroring no issue
    harness = makeHarness()
    await harness.service().start()

    // When a rework event arrives for an unknown issue
    harness.hub.push('issue.rework', { issue_id: 'issue_unknown', instructions: 'x', reviewer_member_id: 'mem_reviewer' })
    await flush()

    // Then no claim was attempted and no card was created
    expect(harness.hub.calls.filter(call => call.path.endsWith('/claim'))).toHaveLength(0)
    expect(harness.tasks()).toHaveLength(0)
  })
})