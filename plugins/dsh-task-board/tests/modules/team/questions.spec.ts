/**
 * Question routing: what this provider claims on the Host's question waterfall,
 * how a team answer reaches the waiting session, and how the three terminal
 * states end it.
 *
 * The claim is driven through the same installer the host entry uses, against a
 * seat that records every subscription, so "tool permission approvals are never
 * claimed" is a fact about the wiring rather than a comment about it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuestionAnswer, QuestionRequestShape } from '../../../src/modules/team/core/question-report.ts'
import { CLAIMED_EVENTS, installTeamWaterfall, NEVER_CLAIMED_EVENTS, type WaterfallSeat } from '../../../src/modules/team/host/waterfall.ts'
import type { QuestionRouter } from '../../../src/modules/team/host/questions.ts'
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

/** Claim and start one issue, then return the card and the session it opened. */
async function claimedSession(current: Harness): Promise<{ taskId: string; sessionId: string }> {
  current.hub.addIssue({ assigneeAgentId: 'agent_1' })
  await current.service().sweep()
  await flush()
  const task = current.tasks()[0]
  const execution = task.executions[task.executions.length - 1]
  const sessionId = execution.sessionId ?? 'session-1'
  if (execution.sessionId === undefined) current.ledger.attachSession(task.id, execution.id, sessionId)
  return { taskId: task.id, sessionId }
}

/** One ask_user_question shaped request addressed at one session. */
function ask(sessionId: string, signal?: AbortSignal): QuestionRequestShape {
  return {
    questions: [{
      id: 'q1',
      question: 'Ship it?',
      header: 'Confirm',
      options: [{ label: 'yes', description: 'ship today' }, { label: 'no' }],
    }],
    agent: { id: sessionId },
    ...(signal === undefined ? {} : { signal }),
  }
}

/** The next answerer: it records that it was consulted and answers "no". */
function nextAnswerer(): { next: () => Promise<QuestionAnswer>; calls: () => number } {
  let calls = 0
  return {
    next: async () => {
      calls += 1
      return { answers: [{ id: 'local', selected: ['local'] }] }
    },
    calls: () => calls,
  }
}

describe('question routing', () => {
  it('member answers a team question and the waiting session receives that answer', async () => {
    // Given a claimed issue whose session asked a decision question
    harness = makeHarness()
    const { sessionId } = await claimedSession(harness)
    const router: QuestionRouter = harness.service().questions
    const answerer = nextAnswerer()

    // When the team member answers it on the hub
    const pending = router.request(ask(sessionId), answerer.next)
    await flush()
    const questionId = [...harness.hub.questions.keys()][0]
    harness.hub.answer(questionId, { selected: ['yes'], custom: 'go ahead' })

    // Then the hub question carries the asker's options as objects, and the
    // session is settled with exactly the team's selection and custom text
    const answer = await pending
    expect(answer).toEqual({ answers: [{ id: 'q1', selected: ['yes'], custom: 'go ahead' }] })
    expect(answerer.calls()).toBe(0)
    expect(harness.hub.questions.get(questionId)?.text).toBe('Confirm: Ship it?')
    expect(harness.hub.questions.get(questionId)?.options).toEqual([
      { label: 'yes', description: 'ship today' },
      { label: 'no' },
    ])
    expect(harness.hub.questions.get(questionId)?.multiSelect).toBe(false)
  })

  it('member sees a question asked outside a team card left to the local answerer', async () => {
    // Given a session that belongs to no mirrored card
    harness = makeHarness()
    const router = harness.service().questions
    const answerer = nextAnswerer()

    // When that session asks a question
    const answer = await router.request(ask('session-unrelated'), answerer.next)

    // Then the question never reached the hub and the next answerer decided
    expect(harness.hub.calls.filter(call => call.path.endsWith('/questions'))).toHaveLength(0)
    expect(answer).toEqual({ answers: [{ id: 'local', selected: ['local'] }] })
    expect(answerer.calls()).toBe(1)
  })

  it('member sees a question nobody answers kept open by default, however long it takes', async () => {
    // Given a question reported to the hub with no local cap configured
    harness = makeHarness()
    const { sessionId } = await claimedSession(harness)
    const router = harness.service().questions
    const answerer = nextAnswerer()
    const pending = router.request(ask(sessionId), answerer.next)
    await flush()
    const questionId = [...harness.hub.questions.keys()][0]

    // When ten minutes pass without an answer
    await vi.advanceTimersByTimeAsync(600_000)

    // Then the claim is still holding the ask and nothing was withdrawn
    expect(harness.hub.questions.get(questionId)?.status).toBe('pending')
    expect(answerer.calls()).toBe(0)

    // And a late answer still settles the session
    harness.hub.answer(questionId, { selected: ['yes'] })
    expect(await pending).toEqual({ answers: [{ id: 'q1', selected: ['yes'] }] })
  })

  it('member sees the optional local fallback withdraw a question after its wait', async () => {
    // Given a deployment that turned the local fallback on for one minute
    harness = makeHarness({ questionWaitMinutes: 1 })
    const { sessionId } = await claimedSession(harness)
    const router = harness.service().questions
    const answerer = nextAnswerer()
    const pending = router.request(ask(sessionId), answerer.next)
    await flush()
    const questionId = [...harness.hub.questions.keys()][0]

    // When that minute passes with no answer
    await vi.advanceTimersByTimeAsync(60_000)
    const answer = await pending

    // Then the question is withdrawn from the hub and the local answerer decides
    expect(harness.hub.questions.get(questionId)?.status).toBe('dismissed')
    expect(answer).toEqual({ answers: [{ id: 'local', selected: ['local'] }] })
    expect(answerer.calls()).toBe(1)
  })

  it('member sees an expired question end the ask as unanswered', async () => {
    // Given a question waiting on the hub
    harness = makeHarness()
    const { sessionId } = await claimedSession(harness)
    const router = harness.service().questions
    const pending = router.request(ask(sessionId), nextAnswerer().next)
    await flush()
    const questionId = [...harness.hub.questions.keys()][0]

    // When the hub expires it
    harness.hub.expire(questionId, 'issue_1')

    // Then the ask settles with an empty answer batch, not a fabricated choice
    expect(await pending).toEqual({ answers: [] })
  })

  it('operator sees a locally cancelled question withdrawn from the hub', async () => {
    // Given a question waiting on the hub
    harness = makeHarness()
    const { sessionId } = await claimedSession(harness)
    const router = harness.service().questions
    const controller = new AbortController()
    const answerer = nextAnswerer()
    const pending = router.request(ask(sessionId, controller.signal), answerer.next)
    await flush()
    const questionId = [...harness.hub.questions.keys()][0]

    // When the local ask is cancelled
    controller.abort()
    const answer = await pending
    await flush()

    // Then the hub was told to withdraw it and the next answerer took over
    expect(harness.hub.questions.get(questionId)?.status).toBe('dismissed')
    expect(answer).toEqual({ answers: [{ id: 'local', selected: ['local'] }] })
    expect(answerer.calls()).toBe(1)
  })

  it('operator sees a hub outage delegate the question instead of blocking the session', async () => {
    // Given a hub that refuses to store a question
    harness = makeHarness()
    const { sessionId } = await claimedSession(harness)
    const router = harness.service().questions
    const answerer = nextAnswerer()
    harness.hub.failNextQuestion = true

    // When the session asks
    const answer = await router.request(ask(sessionId), answerer.next)

    // Then the local answerer decides, as it did before this provider existed
    expect(answer).toEqual({ answers: [{ id: 'local', selected: ['local'] }] })
    expect(answerer.calls()).toBe(1)
  })

  it('operator sees the provider subscribe to the question waterfall and to nothing else', async () => {
    // Given the waterfall install the host entry performs
    harness = makeHarness()
    const subscribed: string[] = []
    const seat: WaterfallSeat = {
      on(event) {
        subscribed.push(event)
        return () => {}
      },
    }

    // When the installer runs
    installTeamWaterfall(seat, () => harness?.service().questions)

    // Then exactly one event is claimed, and the permission approval is not it
    expect(subscribed).toEqual([...CLAIMED_EVENTS])
    expect(subscribed).not.toContain(NEVER_CLAIMED_EVENTS[0])
  })

  it('operator sees a tool permission approval answered by the next answerer', async () => {
    // Given the installed waterfall and no question listener for approvals
    harness = makeHarness()
    const listeners = new Map<string, (request: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
    installTeamWaterfall({
      on(event, listener) {
        listeners.set(event, listener as unknown as (request: unknown, next: () => Promise<unknown>) => Promise<unknown>)
        return () => {}
      },
    }, () => harness?.service().questions)

    // When an approval request travels the waterfall this provider joined
    const approvalListener = listeners.get(NEVER_CLAIMED_EVENTS[0])
    const outcome = approvalListener === undefined
      ? 'not-claimed'
      : await approvalListener({ agent: { id: 'session-1' }, toolName: 'bash' }, async () => 'allowed-once')

    // Then this provider claimed nothing: the decision stayed on this machine
    expect(outcome).toBe('not-claimed')
    expect(listeners.has(NEVER_CLAIMED_EVENTS[0])).toBe(false)
  })
})