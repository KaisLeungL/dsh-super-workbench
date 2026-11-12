/**
 * Run-launch admission. A board action opens one execution (one session
 * creation and its prompt), so the queue bounds how many of those are in
 * flight across concurrent runs. The measurement here is deterministic and
 * independent of wall-clock time: a gateway whose `session/create` blocks
 * until the test releases it, and the peak number of creations in flight.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'
import { DEFAULT_RUN_LAUNCH_WIDTH, RUN_LAUNCH_WIDTH_MAX, normalizeRunLaunchWidth } from '../src/core/launch-width.ts'
import { fixtureWorkspaces } from './workspace-fixture.ts'

const roots: string[] = []
const NOW = 1_700_000_000_000

type GatewayRequest = {
  namespace: string
  method: string
  args: Record<string, unknown>
  signal?: AbortSignal
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-task-board-launch-width-'))
  roots.push(value)
  return value
}

/**
 * Let every promise in the launch chain advance. The chain is gateway promises
 * and ledger writes only, so draining the microtask queue is deterministic and
 * needs no timer.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
}

/**
 * A gateway that holds every `session/create` until the test releases it, so
 * "how many creations are in flight at once" is an exact count rather than a
 * race. `failCreateOn` makes one ordinal fail before it is held, for the
 * failure-isolation case.
 */
function createGate(failCreateOn?: (ordinal: number) => string | undefined) {
  let calls = 0
  let created = 0
  let inFlight = 0
  let peak = 0
  const waiting: Array<() => void> = []
  const invoke = vi.fn(async (request: GatewayRequest) => {
    if (request.namespace === 'agentPresets' && request.method === 'list') return { presets: [{ id: 'liangshen' }] }
    if (request.namespace !== 'session') throw new Error('unexpected namespace: ' + request.namespace)
    if (request.method === 'create') {
      calls += 1
      const failure = failCreateOn?.(calls)
      if (failure !== undefined) throw new Error(failure)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise<void>(resolve => { waiting.push(resolve) })
      inFlight -= 1
      created += 1
      return { sessionId: `session-${created}` }
    }
    if (request.method === 'rename') return { title: 'x', seq: 1 }
    if (request.method === 'prompt') return { accepted: true }
    if (request.method === 'list') return { items: [] }
    throw new Error('unexpected gateway call: ' + request.method)
  })
  const stream = vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} }))
  return {
    gateway: { invoke, stream } as unknown as TypertGateway,
    releaseAll(): void { while (waiting.length > 0) waiting.shift()?.() },
    get calls(): number { return calls },
    get created(): number { return created },
    get inFlight(): number { return inFlight },
    get waiting(): number { return waiting.length },
    get peak(): number { return peak },
  }
}

type Gate = ReturnType<typeof createGate>

/** Release held creations until the Host has asked for all `total` sessions. */
async function drain(gate: Gate, total: number): Promise<void> {
  for (let round = 0; round < total * 4 + 20; round += 1) {
    if (gate.calls >= total && gate.waiting === 0 && gate.inFlight === 0) break
    gate.releaseAll()
    await settle()
  }
  if (gate.calls < total || gate.waiting > 0 || gate.inFlight > 0) {
    throw new Error(`launch admission did not drain: ${gate.calls}/${total} requested, ${gate.waiting} held, ${gate.inFlight} in flight`)
  }
}

/** `count` independent root cards, seeded through the real create action. */
function seedCards(ledger: HostTaskLedger, count: number): string[] {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const id = `card-${index}`
    ledger.applyRequest('seed-' + id, {
      kind: 'create', id, input: { title: `card ${index}`, description: '', prompt: `work ${index}`, workspaceId: 'workspace-' + id },
    })
    ids.push(id)
  }
  return ids
}

/** Ask the board to run every card once; each request opens its own execution. */
function runAll(service: TaskBoardHostService, ids: readonly string[]): void {
  for (const id of ids) service.apply('run-' + id, { kind: 'run', taskId: id })
}

function serviceFor(ledger: HostTaskLedger, gate: Gate, width: () => number): TaskBoardHostService {
  return new TaskBoardHostService(gate.gateway, {
    ledger,
    power: new PowerInhibitor({ platform: 'linux' }),
    now: () => NOW,
    runLaunchWidth: width,
    workspaceRegistry: fixtureWorkspaces(ledger.allTasks().map(task => task.workspaceId!)),
  })
}

/** Every task whose latest execution reached a session. */
function started(ledger: HostTaskLedger): number {
  return ledger.state().tasks.filter(task => task.executions.at(-1)?.sessionId !== undefined).length
}

function latest(ledger: HostTaskLedger, id: string) {
  return ledger.state().tasks.find(task => task.id === id)?.executions.at(-1)
}

describe('run launch admission width', () => {
  it('user running forty cards at once sees only the width of sessions created in parallel', async () => {
    // Given forty independent cards and the default width
    const ledger = new HostTaskLedger(root(), () => NOW)
    const ids = seedCards(ledger, 40)
    const gate = createGate()
    const service = serviceFor(ledger, gate, () => DEFAULT_RUN_LAUNCH_WIDTH)

    // When the user runs every card
    runAll(service, ids)
    await settle()

    // Then only the width is in flight, not every run
    expect(gate.inFlight).toBe(DEFAULT_RUN_LAUNCH_WIDTH)
    expect(gate.peak).toBe(DEFAULT_RUN_LAUNCH_WIDTH)
    expect(gate.waiting).toBe(DEFAULT_RUN_LAUNCH_WIDTH)
    expect(gate.calls).toBe(DEFAULT_RUN_LAUNCH_WIDTH)

    // When the queue drains
    await drain(gate, 40)

    // Then the bound held for the whole batch and every card reached a session
    expect(gate.peak).toBe(DEFAULT_RUN_LAUNCH_WIDTH)
    expect(gate.calls).toBe(40)
    expect(started(ledger)).toBe(40)
  }, 30_000)

  it('operator running at width 1 sees one session at a time and every card still start', async () => {
    // Given eight independent cards and the narrowest width
    const ledger = new HostTaskLedger(root(), () => NOW)
    const ids = seedCards(ledger, 8)
    const gate = createGate()
    const service = serviceFor(ledger, gate, () => 1)

    // When the user runs every card
    runAll(service, ids)
    await settle()

    // Then exactly one creation is in flight and nothing else was asked for
    expect(gate.peak).toBe(1)
    expect(gate.calls).toBe(1)

    // When the queue drains
    await drain(gate, 8)

    // Then no creation ever overlapped and every card entered the running column
    expect(gate.peak).toBe(1)
    expect(latest(ledger, 'card-0')?.sessionId).toBe('session-1')
    expect(started(ledger)).toBe(8)
    expect(ledger.state().tasks.filter(task => task.status === 'running')).toHaveLength(8)
  }, 30_000)

  it('operator running at width 16 sees the bound hold instead of every run firing at once', async () => {
    // Given forty independent cards and the widest accepted width
    const ledger = new HostTaskLedger(root(), () => NOW)
    const ids = seedCards(ledger, 40)
    const gate = createGate()
    const service = serviceFor(ledger, gate, () => RUN_LAUNCH_WIDTH_MAX)

    // When the user runs every card
    runAll(service, ids)
    await settle()

    // Then the burst is the width, not the whole batch: a queue that is bypassed
    // fires all forty and turns this red
    expect(gate.peak).toBe(RUN_LAUNCH_WIDTH_MAX)
    expect(gate.calls).toBe(RUN_LAUNCH_WIDTH_MAX)

    await drain(gate, 40)
    expect(gate.peak).toBe(RUN_LAUNCH_WIDTH_MAX)
    expect(started(ledger)).toBe(40)
  }, 30_000)

  it('operator sees an unknown session creation keep its directory locked without holding other directories back', async () => {
    // Given four cards pinned to distinct directories and a lost second creation response
    const ledger = new HostTaskLedger(root(), () => NOW)
    const ids = seedCards(ledger, 4)
    const gate = createGate(ordinal => ordinal === 2 ? 'session creation response lost' : undefined)
    const service = serviceFor(ledger, gate, () => 1)

    // When the user runs every card and the queue drains
    runAll(service, ids)
    await drain(gate, 4)
    await settle()

    // Then other directories still start, but the unknown creation cannot be
    // settled or release its directory without Host reconciliation.
    expect(gate.calls).toBe(4)
    expect(gate.created).toBe(3)
    expect(latest(ledger, 'card-1')?.result).toBeUndefined()
    expect(latest(ledger, 'card-1')?.endedAt).toBeUndefined()
    expect(latest(ledger, 'card-1')?.launchUncertain).toBe(true)
    expect(latest(ledger, 'card-1')?.executionDirectory).toEqual(expect.any(String))
    expect(latest(ledger, 'card-1')?.cancellation?.error).toContain('Session creation outcome is unknown')
    expect(latest(ledger, 'card-1')?.sessionId).toBeUndefined()
    // The gateway acknowledged three sessions; only those ids can be attached.
    expect(latest(ledger, 'card-0')?.sessionId).toBe('session-1')
    expect(latest(ledger, 'card-2')?.sessionId).toBe('session-2')
    expect(latest(ledger, 'card-3')?.sessionId).toBe('session-3')
    for (const id of ['card-0', 'card-2', 'card-3']) expect(latest(ledger, id)?.result).toBeUndefined()
    service.dispose()
  })

  it('operator switching the board off while runs wait still sees every one of them start', async () => {
    // Given a width-1 batch whose cards are queued
    const ledger = new HostTaskLedger(root(), () => NOW)
    const ids = seedCards(ledger, 4)
    const gate = createGate()
    const service = serviceFor(ledger, gate, () => 1)
    runAll(service, ids)
    await settle()
    expect(gate.waiting).toBe(1)
    expect(gate.calls).toBe(1)

    // When the operator switches the board off mid-batch
    service.setConfiguration(false, false)

    // Then the runs it already opened still start: the switch governs new work,
    // and a queued run is work this board already opened
    await drain(gate, 4)
    expect(gate.peak).toBe(1)
    expect(started(ledger)).toBe(4)
    service.dispose()
  })

  it('operator stopping the Host sees the runs still waiting settle instead of staying running', async () => {
    // Given a width-1 batch with five cards waiting for a slot
    const ledger = new HostTaskLedger(root(), () => NOW)
    const ids = seedCards(ledger, 6)
    const gate = createGate()
    const service = serviceFor(ledger, gate, () => 1)
    runAll(service, ids)
    await settle()
    expect(gate.calls).toBe(1)
    expect(gate.waiting).toBe(1)

    // When the Host stops
    service.dispose()
    await settle()
    gate.releaseAll()
    await settle()

    // Then nothing new was ever asked for after the stop...
    expect(gate.calls).toBe(1)
    // ...and every run still waiting was settled out of the running column
    for (let index = 1; index < 6; index += 1) {
      const execution = latest(ledger, `card-${index}`)
      expect(execution?.result).toBe('cancelled')
      expect(execution?.error).toBe('host stopped before this execution started')
      expect(ledger.state().tasks.find(task => task.id === `card-${index}`)?.status).toBe('todo')
    }
    // Nothing is left open except the one launch that was already in flight
    const open = ledger.state().tasks.flatMap(task => task.executions).filter(entry => entry.endedAt === undefined)
    expect(open).toHaveLength(1)
    // The one launch that was already in flight follows the normal path: it
    // reached its session, so its card stays running for the next Host to observe.
    expect(latest(ledger, 'card-0')?.sessionId).toBe('session-1')
    expect(ledger.state().tasks.find(task => task.id === 'card-0')?.status).toBe('running')
  }, 30_000)

  it('operator sees a scheduled run still waiting when the Host stops refund its occurrence', async () => {
    // Given a cron rule whose occurrence fires while the single slot is busy
    let now = new Date(2026, 7, 16, 10, 0, 30).getTime()
    const ledger = new HostTaskLedger(root(), () => now)
    ledger.applyRequest('seed-busy', {
      kind: 'create', id: 'busy', input: { title: 'busy', description: '', prompt: 'busy', workspaceId: 'workspace-busy' },
    })
    ledger.applyRequest('seed-sched', {
      kind: 'create', id: 'sched', input: {
        title: 'sched', description: '', prompt: 'scheduled work', workspaceId: 'workspace-sched',
        schedule: { enabled: true, cron: '* * * * *', maxRuns: 2 },
      },
    })
    const gate = createGate()
    let last: { callback: () => void; delay: number } | undefined
    const timers = {
      timeout(callback: () => void, delay: number): () => void { last = { callback, delay }; return () => {} },
      interval(): () => void { return () => {} },
    }
    const service = new TaskBoardHostService(gate.gateway, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      timers,
      now: () => now,
      runLaunchWidth: () => 1,
      workspaceRegistry: fixtureWorkspaces(ledger.allTasks().map(task => task.workspaceId!)),
    })
    service.start()
    expect(last?.delay).toBe(30_000)
    service.apply('run-manual', { kind: 'run', taskId: 'busy' })
    await settle()
    expect(gate.inFlight).toBe(1)

    // When the rule fires and its launch cannot be admitted
    now = new Date(2026, 7, 16, 10, 1, 0).getTime()
    last?.callback()
    await settle()
    expect(ledger.state().tasks.find(task => task.id === 'sched')?.schedule?.runCount).toBe(1)
    expect(gate.calls).toBe(1)

    // And the Host stops before the scheduled run ever started
    service.dispose()
    await settle()

    // Then the occurrence is refunded rather than silently spent, and the
    // scheduled card is not left in the running column
    expect(ledger.state().tasks.find(task => task.id === 'sched')?.schedule?.runCount).toBe(0)
    expect(latest(ledger, 'sched')?.result).toBe('cancelled')
    expect(ledger.state().tasks.find(task => task.id === 'sched')?.status).toBe('todo')
    gate.releaseAll()
    await settle()
  })

  it('operator raising the width while runs wait sees them admitted sooner, with every one started', async () => {
    // Given a width-1 batch whose runs are waiting
    const ledger = new HostTaskLedger(root(), () => NOW)
    const ids = seedCards(ledger, 6)
    let width = 1
    const gate = createGate()
    const service = serviceFor(ledger, gate, () => width)
    runAll(service, ids)
    await settle()
    expect(gate.calls).toBe(1)

    // When the operator raises the width while the batch is still queueing
    width = 3
    gate.releaseAll()
    await settle()

    // Then the new width bounds the launches that had not been admitted yet
    expect(gate.peak).toBe(3)
    await drain(gate, 6)
    expect(gate.peak).toBe(3)
    expect(started(ledger)).toBe(6)
    service.dispose()
  })

  it('operator sees a run settled while it waits for a slot never start afterwards', async () => {
    // Given a width-1 batch whose second run is still waiting
    const ledger = new HostTaskLedger(root(), () => NOW)
    const ids = seedCards(ledger, 2)
    const gate = createGate()
    const service = serviceFor(ledger, gate, () => 1)
    runAll(service, ids)
    await settle()
    const queuedExecution = latest(ledger, 'card-1')?.id
    if (queuedExecution === undefined) throw new Error('the batch did not open card-1')

    // When the operator force-settles that waiting run (task_board_manage settle)
    ledger.settle('card-1', queuedExecution, 'cancelled', 'settled by the operator')

    // Then it never gets a session of its own, and the run in flight still does
    await drain(gate, 1)
    await settle()
    expect(gate.calls).toBe(1)
    expect(latest(ledger, 'card-1')?.sessionId).toBeUndefined()
    expect(latest(ledger, 'card-0')?.sessionId).toBe('session-1')
    service.dispose()
  })
})

describe('run launch width setting', () => {
  it("operator's hand-edited width is normalized into the supported range", () => {
    // Given the published range (1..16) and default (3) of the admission width
    // When a hand-edited configuration value is normalized
    // Then every value lands inside the range, and a missing one takes the default
    expect(DEFAULT_RUN_LAUNCH_WIDTH).toBe(3)
    expect(normalizeRunLaunchWidth(undefined)).toBe(3)
    expect(normalizeRunLaunchWidth(Number.NaN)).toBe(3)
    expect(normalizeRunLaunchWidth(0)).toBe(1)
    expect(normalizeRunLaunchWidth(-5)).toBe(1)
    expect(normalizeRunLaunchWidth(2.7)).toBe(2)
    expect(normalizeRunLaunchWidth(RUN_LAUNCH_WIDTH_MAX)).toBe(16)
    expect(normalizeRunLaunchWidth(1000)).toBe(RUN_LAUNCH_WIDTH_MAX)
  })
})
