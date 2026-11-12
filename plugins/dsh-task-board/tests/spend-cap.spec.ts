/**
 * The daily token cap: the gate that stops board work once the day's measured
 * spend reached the configured ceiling, on both the action path a client drives
 * and the cron path nobody can throw at.
 *
 * The default is 0 = no gate, and that has to be the board that existed before
 * the cap. The cases that assert "nothing was measured" therefore count reader
 * calls as well as observing the card: an absent refusal alone would also pass
 * for a gate that refuses for some other reason.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, readConfigField } from '../src/index.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'
import { DEFAULT_SPEND_BUDGET_TOKENS, spendCapMessage, spendCapReached } from '../src/core/spend-budget.ts'
import { ledgerDayTokens, spendDateKey, usedTokensToday } from '../src/host-spend.ts'
import { nextRunAtMs } from '../src/core/schedule.ts'
import { createTask, withSchedule, type TaskRecord } from '../src/core/tasks.ts'

const roots: string[] = []
const NOW = new Date(2026, 7, 16, 10, 0, 30).getTime()

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-task-board-spend-'))
  roots.push(value)
  return value
}

/** A gateway that answers every session call immediately, so a permitted run starts instead of waiting. */
function idleGateway(): TypertGateway {
  const invoke = vi.fn(async (request: { namespace: string; method: string }) => {
    if (request.namespace !== 'session') return { items: [] }
    if (request.method === 'create') return { sessionId: 'session-1' }
    if (request.method === 'rename') return { title: 'card', seq: 1 }
    if (request.method === 'prompt') return { accepted: true }
    return { items: [] }
  })
  const stream = vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} }))
  return { invoke, stream } as unknown as TypertGateway
}

/** Drain the fire-and-forget launch chain: gateway promises only, so no timer is involved. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve()
}

/** Seed one todo card through the real create action. */
function seedCard(ledger: HostTaskLedger, id: string): void {
  ledger.applyRequest('seed-' + id, {
    kind: 'create', id, input: { title: id, description: '', prompt: id },
  })
}

function serviceFor(ledger: HostTaskLedger, cap: () => number, used: (now: number) => number | undefined): TaskBoardHostService {
  return new TaskBoardHostService(idleGateway(), {
    ledger,
    power: new PowerInhibitor({ platform: 'linux' }),
    now: () => NOW,
    spendBudgetTokens: cap,
    spendUsedToday: used,
  })
}

function scheduledTask(id: string): TaskRecord {
  return { ...createTask({ title: id, description: '', prompt: id }, NOW - 1000, id), updatedAt: NOW }
}

describe('token cap rules', () => {
  it('operator sees a day measured in tokens and refused only from a positive cap', () => {
    // Given the shipped default of no cap and a day that spent a million tokens
    expect(DEFAULT_SPEND_BUDGET_TOKENS).toBe(0)
    // When the cap is 0, below the spend, or reached exactly
    // Then only a reached positive cap refuses, in the board's own wording
    expect(spendCapReached(1_000_000, DEFAULT_SPEND_BUDGET_TOKENS)).toBe(false)
    expect(spendCapReached(999, 1000)).toBe(false)
    expect(spendCapReached(1000, 1000)).toBe(true)
    expect(spendCapMessage(1000, 1000))
      .toBe('spend cap reached: 1000 tokens of 1000 today; raise the cap in the task board settings')
  })

  it('operator sees the cap default to zero in the shipped config schema', () => {
    // Given the plugin config as the Loader validates it
    const shipped = Config({}) as { spendBudgetTokens?: number }
    // When the field is read the way the activation reads it
    // Then a deployment that configured nothing has no cap at all
    expect(readConfigField(shipped.spendBudgetTokens, -1)).toBe(DEFAULT_SPEND_BUDGET_TOKENS)
  })
})

describe('today spend from the usage ledger', () => {
  it('operator sees today summed over billed input and output, without reasoning twice', () => {
    // Given a ledger holding a large yesterday and a two-provider today, whose
    // reasoning tokens are already inside its output count
    const path = join(root(), 'usage-ledger.json')
    const today = spendDateKey(NOW)
    const yesterday = spendDateKey(NOW - 86_400_000)
    writeFileSync(path, JSON.stringify({
      version: 1,
      days: {
        [yesterday]: { deepseek: { chat: { inputTokens: 9_999, outputTokens: 9_999, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 1, cost: 0 } } },
        [today]: {
          deepseek: { chat: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 40, calls: 2, cost: 1 } },
          openrouter: { other: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 1, cost: 0 } },
        },
      },
    }), 'utf8')
    // When the gate asks for the spend of that day
    // Then only today counts, and only its billed input plus output
    expect(usedTokensToday(NOW, path)).toBe(152)
  })

  it('operator sees an unmeasurable day reported instead of read as no spend', () => {
    // Given a missing ledger and a corrupt one
    // When the gate asks for today's spend from either
    // Then it answers "cannot see" rather than zero, and a degraded bucket
    // still totals what it does carry
    expect(usedTokensToday(NOW, join(root(), 'missing.json'))).toBeUndefined()
    const path = join(root(), 'usage-ledger.json')
    writeFileSync(path, '{not json', 'utf8')
    expect(usedTokensToday(NOW, path)).toBeUndefined()
    expect(ledgerDayTokens({ deepseek: { chat: { inputTokens: 5 } } })).toBe(5)
    expect(ledgerDayTokens(undefined)).toBe(0)
  })
})

describe('the cap on the action path', () => {
  it('user with the default cap sees the card run and no ledger read at all', async () => {
    // Given a todo card and a default deployment whose reader would report a
    // spend far above any cap
    const ledger = new HostTaskLedger(root(), () => NOW)
    seedCard(ledger, 'work')
    const used = vi.fn(() => 5_000_000)
    const service = serviceFor(ledger, () => DEFAULT_SPEND_BUDGET_TOKENS, used)

    // When the user runs the card
    expect(() => service.apply('run-default', { kind: 'run', taskId: 'work' })).not.toThrow()
    await settle()

    // Then the run opened and the gate never measured anything
    expect(used).not.toHaveBeenCalled()
    expect(ledger.state().tasks[0].executions).toHaveLength(1)
    service.dispose()
  })

  it('operator whose day reached the cap sees run and rerun refused, with the card untouched', () => {
    // Given a todo card and a day that already spent its whole cap
    const ledger = new HostTaskLedger(root(), () => NOW)
    seedCard(ledger, 'work')
    const service = serviceFor(ledger, () => 1_000, () => 1_000)

    // When the operator starts it, then asks to re-run it
    // Then both are refused in the message the caller shows as board-refused
    expect(() => service.apply('run-capped', { kind: 'run', taskId: 'work' }))
      .toThrow('spend cap reached: 1000 tokens of 1000 today; raise the cap in the task board settings')
    expect(() => service.apply('rerun-capped', { kind: 'rerun', taskId: 'work' }))
      .toThrow('spend cap reached: 1000 tokens of 1000 today')

    // And the refusal left no execution and no column move behind
    const task = ledger.state().tasks[0]
    expect(task.executions).toEqual([])
    expect(task.status).toBe('todo')
    service.dispose()
  })

  it('user below the cap, or with a day nothing can measure, still sees the card run', async () => {
    // Given two todo cards: one day just under the cap, one day unmeasurable
    const ledger = new HostTaskLedger(root(), () => NOW)
    seedCard(ledger, 'below')
    seedCard(ledger, 'blind')

    // When each is run under a positive cap
    const below = serviceFor(ledger, () => 1_000, () => 999)
    expect(() => below.apply('run-below', { kind: 'run', taskId: 'below' })).not.toThrow()
    await settle()
    below.dispose()

    const blind = serviceFor(ledger, () => 1_000, () => undefined)
    expect(() => blind.apply('run-blind', { kind: 'run', taskId: 'blind' })).not.toThrow()
    await settle()
    blind.dispose()

    // Then both opened an execution instead of being refused on a guess
    expect(ledger.state().tasks.filter(task => task.executions.length === 1).map(task => task.id).sort())
      .toEqual(['below', 'blind'])
  })
})

describe('the cap on the scheduled path', () => {
  it('operator sees a due occurrence over the cap skipped onto the scheduler with no run spent', () => {
    // Given an armed cron rule whose day already spent the cap
    const ledger = new HostTaskLedger(root(), () => NOW, {
      spendBudgetTokens: () => 1_000,
      spendUsedToday: () => 5_000,
    })
    const firstDue = nextRunAtMs('* * * * *', NOW)!
    const due = withSchedule(scheduledTask('scheduled'), {
      enabled: true, cron: '* * * * *', nextRunAt: firstDue, lastTriggeredAt: undefined,
    }, NOW)
    ledger.applyRequest('import', { kind: 'import', sourceId: 'source', tasks: [due] })

    // When the occurrence comes due
    expect(ledger.openScheduled('scheduled', firstDue)).toEqual([])

    // Then the board states the refusal on the scheduler, rolls the rule to its
    // next target, and leaves the planned run available for that later trigger
    const current = ledger.state().tasks[0]
    expect(ledger.state().scheduler.error).toContain('scheduled run refused for task scheduled: spend cap reached: 5000 tokens of 1000')
    expect(current.executions).toEqual([])
    expect(current.schedule?.runCount).toBe(0)
    expect(current.schedule?.skippedReason).toBe('limit')
    expect(current.schedule?.nextRunAt).toBe(firstDue + 60_000)
    ledger.dispose()
  })

  it('user with the default cap sees the due run opened and no ledger read at all', () => {
    // Given an armed cron rule and a default deployment whose reader would
    // report a spend far above any cap
    const used = vi.fn(() => 5_000_000)
    const ledger = new HostTaskLedger(root(), () => NOW, { spendUsedToday: used })
    const firstDue = nextRunAtMs('* * * * *', NOW)!
    const due = withSchedule(scheduledTask('scheduled'), {
      enabled: true, cron: '* * * * *', nextRunAt: firstDue, lastTriggeredAt: undefined,
    }, NOW)
    ledger.applyRequest('import', { kind: 'import', sourceId: 'source', tasks: [due] })

    // When the occurrence comes due
    // Then it opens its run, spends its planned run, and the gate never measured
    expect(ledger.openScheduled('scheduled', firstDue)).toHaveLength(1)
    expect(used).not.toHaveBeenCalled()
    expect(ledger.state().tasks[0].schedule?.runCount).toBe(1)
    ledger.dispose()
  })
})
