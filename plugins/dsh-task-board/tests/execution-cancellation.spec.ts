import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import type { TaskBoardWorkspaceRegistry } from '../src/host-runner.ts'
import { parseActionEnvelope } from '../src/protocol.ts'

const NOW = 1_700_000_000_000
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
async function flush(): Promise<void> {
  for (let index = 0; index < 80; index += 1) await Promise.resolve()
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cancel-test-'))
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, 'one'))
  mkdirSync(join(root, 'two'))
  symlinkSync(join(root, 'one'), join(root, 'alias'))
  const workspaces = ['one', 'two', 'alias'].map(id => ({ id, path: join(root, id), updatedAt: '2026-01-01T00:00:00Z', sessionIds: [] as string[] }))
  const registry = { list: () => workspaces } as unknown as TaskBoardWorkspaceRegistry
  const ledger = new HostTaskLedger(root, () => NOW)
  const calls: Array<{ method: string; request: Record<string, unknown> }> = []
  let cancelError: string | undefined
  let state = { active: true, running: true, queue: [] as unknown[], pendingInput: [] as unknown[] }
  let createGate: ReturnType<typeof deferred<unknown>> | undefined
  let stateGate: ReturnType<typeof deferred<unknown>> | undefined
  let poll = () => {}
  let serial = 0
  const gateway = {
    async invoke(call: { method: string; args: { request?: Record<string, unknown> } }) {
      const request = call.args.request ?? {}
      calls.push({ method: call.method, request })
      if (call.method === 'create') {
        if (createGate !== undefined) return await createGate.promise
        const sessionId = 'session-' + (++serial)
        workspaces.find(item => item.id === request.workspaceId)?.sessionIds.push(sessionId)
        return { sessionId }
      }
      if (call.method === 'cancel') {
        if (cancelError !== undefined) throw new Error(cancelError)
        return { accepted: true }
      }
      if (call.method === 'state') return stateGate === undefined ? state : await stateGate.promise
      if (call.method === 'list') return { items: workspaces.flatMap(item => item.sessionIds.map(sessionId => ({ sessionId, running: true }))) }
      return {}
    },
  } as unknown as TypertGateway
  const service = new TaskBoardHostService(gateway, {
    ledger, now: () => NOW, workspaceRegistry: registry,
    timers: { interval(callback) { poll = callback; return () => {} }, timeout() { return () => {} } },
  })
  cleanups.push(() => { service.dispose() })
  const create = (id: string, workspaceId = 'one', projectId = 'business') => {
    service.apply('create-' + id, { kind: 'create', id, input: { title: id, description: '', prompt: 'work', workspaceId, projectId } })
  }
  const run = async (id: string) => {
    service.apply(crypto.randomUUID(), { kind: 'run', taskId: id })
    await flush()
    return ledger.getTask(id)!.executions.at(-1)!
  }
  const cancel = async (id: string, executionId: string) => {
    service.apply(crypto.randomUUID(), { kind: 'cancel', taskId: id, executionId })
    await flush()
  }
  return {
    root, ledger, service, calls, workspaces, create, run, cancel,
    failCancel: (error?: string) => { cancelError = error },
    stopped: () => { state = { active: true, running: false, queue: [], pendingInput: [] } },
    holdCreate: () => { createGate = deferred<unknown>(); return createGate },
    holdState: () => { stateGate = deferred<unknown>(); return stateGate },
    poll: async () => { poll(); await flush() },
  }
}

describe('execution cancellation and directory ownership', () => {
  it('operator retains directory ownership on stop failure and releases it only after a successful retry confirms stopping', async () => {
    // Given a live task and another card targeting the same real directory.
    const bench = harness()
    bench.create('first')
    bench.create('second', 'alias', 'another-business')
    const first = await bench.run('first')
    bench.failCancel('stop unavailable')
    // When cancellation fails and a competing card attempts to run.
    await bench.cancel('first', first.id)
    const second = await bench.run('second')
    // Then the first remains open and the competitor never receives a session.
    expect(bench.ledger.getTask('first')?.executions.at(-1)).toMatchObject({ cancellation: { error: 'stop unavailable' }, executionDirectory: realpathSync(join(bench.root, 'one')) })
    expect(bench.ledger.getTask('first')?.executions.at(-1)?.endedAt).toBeUndefined()
    expect(second).toMatchObject({ result: 'failed', sessionId: undefined })
    expect(second.error).toContain('occupied by task first')
    expect(bench.calls.filter(call => call.method === 'create')).toHaveLength(1)
    // When the official stop succeeds and state confirms quiescence.
    bench.failCancel()
    bench.stopped()
    await bench.cancel('first', first.id)
    const retried = await bench.run('second')
    // Then only the confirmed terminal record releases the writer slot.
    expect(bench.ledger.getTask('first')?.executions.at(-1)).toMatchObject({ result: 'cancelled', endedAt: NOW })
    expect(retried.sessionId).toBe('session-2')
    expect(bench.calls.filter(call => call.method === 'cancel').map(call => call.request)).toEqual([{ sessionId: 'session-1' }, { sessionId: 'session-1' }])
  })

  it('operator sees an accepted cancellation stay pending until a later Host state poll proves stopping', async () => {
    // Given an active execution and a cancellation endpoint that acknowledges immediately.
    const bench = harness()
    bench.create('task')
    const execution = await bench.run('task')
    // When cancellation is accepted while the session is still active.
    await bench.cancel('task', execution.id)
    expect(bench.ledger.getTask('task')?.executions.at(-1)?.endedAt).toBeUndefined()
    expect(bench.ledger.getTask('task')?.executions.at(-1)?.cancellation?.error).toContain('waiting')
    // When the existing Host roster poll observes the session is quiescent.
    bench.stopped()
    bench.service.start()
    await flush()
    // Then the original run closes as cancelled, without interpreting acknowledgement as proof.
    expect(bench.ledger.getTask('task')?.executions.at(-1)).toMatchObject({ id: execution.id, endedAt: NOW, result: 'cancelled' })
    expect(bench.ledger.getTask('task')?.status).toBe('todo')
  })

  it('operator cancels during session creation without a late prompt reviving the task', async () => {
    // Given a create RPC that has not returned its session identity.
    const bench = harness()
    bench.create('task')
    const gate = bench.holdCreate()
    const execution = await bench.run('task')
    // When cancellation arrives before create resolves.
    await bench.cancel('task', execution.id)
    expect(bench.ledger.getTask('task')?.executions.at(-1)?.endedAt).toBeUndefined()
    expect(bench.calls.filter(call => call.method === 'cancel')).toHaveLength(0)
    bench.stopped()
    gate.resolve({ sessionId: 'late-session' })
    await flush()
    // Then that exact session is stopped and no prompt or goal can be queued after the cancellation.
    expect(bench.calls.filter(call => call.method === 'prompt')).toHaveLength(0)
    expect(bench.calls.filter(call => call.method === 'cancel').map(call => call.request.sessionId)).toEqual(['late-session'])
    expect(bench.ledger.getTask('task')?.executions.at(-1)).toMatchObject({ id: execution.id, result: 'cancelled', sessionId: 'late-session' })
  })

  it('operator cannot cancel a newer execution using a stale execution id or receive a late old stop callback', async () => {
    // Given an outstanding stop-state request for the old run.
    const bench = harness()
    bench.create('task')
    const old = await bench.run('task')
    const gate = bench.holdState()
    await bench.cancel('task', old.id)
    // When an independent terminal fact closes it and the card starts a new run.
    bench.ledger.settle('task', old.id, 'cancelled')
    const current = await bench.run('task')
    gate.resolve({ active: false, running: false, queue: [], pendingInput: [] })
    await flush()
    // Then neither the old callback nor an old UI action touches the new run.
    expect(current.id).not.toBe(old.id)
    expect(bench.ledger.getTask('task')?.executions.at(-1)).toMatchObject({ id: current.id, sessionId: 'session-2' })
    expect(bench.ledger.getTask('task')?.executions.at(-1)?.endedAt).toBeUndefined()
    expect(() => bench.service.apply('stale', { kind: 'cancel', taskId: 'task', executionId: old.id })).toThrow('execution is no longer current')
  })

  it('operator runs different execution directories concurrently even when both cards belong to one business project', async () => {
    // Given two cards with identical business ownership and distinct workspace directories.
    const bench = harness()
    bench.create('first', 'one')
    bench.create('second', 'two')
    // When both are started.
    const first = await bench.run('first')
    const second = await bench.run('second')
    // Then their real directories and sessions are independently occupied.
    expect(first.sessionId).toBe('session-1')
    expect(second.sessionId).toBe('session-2')
    expect(first.executionDirectory).not.toBe(second.executionDirectory)
    expect(bench.calls.filter(call => call.method === 'prompt')).toHaveLength(2)
  })

  it('operator cannot force-settle or move a waiting writer to bypass its directory ownership', async () => {
    // Given a running session waiting on an official permission interaction.
    const bench = harness()
    bench.create('task')
    const execution = await bench.run('task')
    const finish = bench.service.observeWaiting(execution.sessionId!, 'permission', 'approval')
    // When a caller tries the former bookkeeping settlement or a manual column move.
    expect(() => bench.service.apply('settle', { kind: 'settle', taskId: 'task' })).toThrow(/stop confirmation/)
    expect(() => bench.service.apply('move', { kind: 'move', taskId: 'task', status: 'todo' })).toThrow(/running task/)
    // Then the session and directory remain owned throughout the wait.
    expect(bench.ledger.getTask('task')).toMatchObject({ status: 'needs_input' })
    expect(bench.ledger.getTask('task')?.executions.at(-1)?.endedAt).toBeUndefined()
    finish()
  })

  it('operator retains an unacknowledged create claim through restart and retries cannot manufacture stop proof', async () => {
    // Given an isolated ledger whose process stopped between create and durable session attachment.
    const bench = harness()
    bench.create('task')
    const execution = bench.ledger.applyRequest('open', { kind: 'run', taskId: 'task' }).runs![0]!.execution
    bench.ledger.claimExecutionDirectory('task', execution.id, realpathSync(join(bench.root, 'one')))
    bench.ledger.markSessionCreating('task', execution.id)
    bench.ledger.dispose()
    // When a new ledger owner restores it and the user retries cancellation.
    const restored = new HostTaskLedger(bench.root, () => NOW)
    cleanups.push(() => { restored.dispose() })
    const service = new TaskBoardHostService({ invoke: async () => { throw new Error('no session identity') } } as unknown as TypertGateway, { ledger: restored, now: () => NOW })
    cleanups.push(() => { service.dispose() })
    service.apply('retry', { kind: 'cancel', taskId: 'task', executionId: execution.id })
    await flush()
    // Then recovery preserves the lock and exposes the unresolved identity instead of cancelling bookkeeping.
    expect(restored.getTask('task')?.executions.at(-1)).toMatchObject({ id: execution.id, launchUncertain: true, cancellation: { error: 'Session creation outcome is unknown; directory ownership requires session reconciliation' } })
    expect(restored.getTask('task')?.executions.at(-1)?.endedAt).toBeUndefined()
  })

  it('operator must supply an exact execution id in the cancellation protocol', () => {
    // Given old UI input that names only a card.
    const action = { kind: 'cancel', taskId: 'task' }
    // When the parser receives missing, blank and current execution ids.
    expect(parseActionEnvelope({ requestId: 'missing', action })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'blank', action: { ...action, executionId: '' } })).toBeUndefined()
    // Then only the bound action crosses the wire.
    expect(parseActionEnvelope({ requestId: 'bound', action: { ...action, executionId: 'execution' } })?.action).toEqual({ ...action, executionId: 'execution' })
  })
})
