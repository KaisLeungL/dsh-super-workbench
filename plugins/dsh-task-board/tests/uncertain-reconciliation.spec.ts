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
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function flush(): Promise<void> {
  for (let index = 0; index < 80; index += 1) await Promise.resolve()
}
// Official live Agent state remains active even after work and inbox stop.
const idle = { active: true, running: false, queue: [], pendingInput: [] }
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-uncertain-test-'))
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, 'work'))
  mkdirSync(join(root, 'other'))
  symlinkSync(join(root, 'work'), join(root, 'alias'))
  const directory = realpathSync(join(root, 'work'))
  const registry = { list: () => [{ id: 'workspace', path: directory, updatedAt: '2026-01-01T00:00:00Z', sessionIds: [] }] } as unknown as TaskBoardWorkspaceRegistry
  let items: unknown[] = []
  let state: unknown = idle
  let listError: string | undefined
  let stateError: string | undefined
  let nextList: unknown[] | undefined
  let stateGate: ReturnType<typeof deferred<unknown>> | undefined
  const stateEntered = deferred<void>()
  let createCount = 0
  const requests: Array<{ namespace: string; method: string; args: Record<string, unknown> }> = []
  const gateway = {
    async invoke(call: { namespace: string; method: string; args: Record<string, unknown> }) {
      requests.push(call)
      if (call.method === 'create') {
        createCount += 1
        if (createCount === 1) throw new Error('create response lost')
        return { sessionId: 'next-session' }
      }
      if (call.method === 'list') {
        if (listError !== undefined) throw new Error(listError)
        const result = { items: [...items] }
        if (nextList !== undefined) { items = nextList; nextList = undefined }
        return result
      }
      if (call.method === 'state') {
        stateEntered.resolve()
        if (stateError !== undefined) throw new Error(stateError)
        if (stateGate !== undefined) {
          const gate = stateGate
          stateGate = undefined
          return await gate.promise
        }
        return state
      }
      return {}
    },
  } as unknown as TypertGateway
  const ledger = new HostTaskLedger(root, () => NOW)
  const service = new TaskBoardHostService(gateway, {
    ledger, now: () => NOW, workspaceRegistry: registry,
    timers: { interval() { return () => {} }, timeout() { return () => {} } },
  })
  cleanups.push(() => { service.dispose(); ledger.dispose() })
  service.apply('create', { kind: 'create', id: 'task', input: { title: 'Task', description: '', prompt: 'work', workspaceId: 'workspace' } })
  const action = (executionId: string) => ({ kind: 'reconcile-uncertain' as const, taskId: 'task', executionId })
  const current = () => ledger.getTask('task')!.executions.at(-1)!
  return {
    root, directory, requests, ledger, service, current, action,
    row: (sessionId: string, cwd = directory, running = false) => ({ sessionId, cwd, running, agentAvailable: false, updatedAt: NOW, blank: false }),
    roster: (rows: unknown[]) => { items = rows },
    state: (value: unknown) => { state = value },
    failList: (error?: string) => { listError = error },
    failState: (error?: string) => { stateError = error },
    changeList: (rows: unknown[]) => { nextList = rows },
    holdState: () => { stateGate = deferred<unknown>(); return { ...stateGate, entered: stateEntered.promise } },
    async run() { service.apply(crypto.randomUUID(), { kind: 'run', taskId: 'task' }); await flush(); return current() },
    reconcile: (id: string, humanVerified = true) => service.applyVerified(crypto.randomUUID(), action(id), 'human', humanVerified),
  }
}

describe('unknown launch reconciliation', () => {
  it('operator cannot release an unknown create while any session in the canonical directory is running', async () => {
    // Given an actual create failure and a session discovered through a directory alias.
    const bench = harness()
    const run = await bench.run()
    bench.roster([bench.row('unbound-session', join(bench.root, 'alias'), true)])
    // When the authenticated operator reconciles the run.
    await expect(bench.reconcile(run.id)).rejects.toThrow('running session')
    // Then the exact execution and writer claim remain open.
    expect(bench.current()).toMatchObject({ id: run.id, launchUncertain: true, executionDirectory: bench.directory })
    expect(bench.current().endedAt).toBeUndefined()
    expect(bench.current().cancellation?.error).toContain('unbound-session')
  })

  it('operator releases an empty execution directory only after a complete official roster check', async () => {
    // Given an unknown create with no session in its execution directory.
    const bench = harness()
    const run = await bench.run()
    bench.roster([bench.row('other-session', join(bench.root, 'other'), true)])
    // When two complete rosters establish that no session can own this directory.
    const result = await bench.reconcile(run.id)
    // Then only the old run is cancelled and the directory admits a new execution.
    expect(result.tasks[0]?.executions.at(-1)).toMatchObject({ id: run.id, endedAt: NOW, result: 'cancelled' })
    const next = await bench.run()
    expect(next.sessionId).toBe('next-session')
    expect(next.executionDirectory).toBe(bench.directory)
    expect(bench.requests.filter(call => call.method === 'list').map(call => call.args)).toEqual([{ _request: {} }, { _request: {} }])
  })

  it('operator checks every possible session instead of binding a convenient ended session', async () => {
    // Given two sessions in the same canonical directory, one still waiting.
    const bench = harness()
    const run = await bench.run()
    bench.roster([bench.row('ended'), bench.row('waiting')])
    bench.state({ ...idle, pendingInput: ['question'] })
    // When the operator requests recovery, without any asserted session identity.
    await expect(bench.reconcile(run.id)).rejects.toThrow('awaiting input')
    expect(bench.current().endedAt).toBeUndefined()
    // When every session is proven stopped by the official state endpoint.
    bench.state(idle)
    await bench.reconcile(run.id)
    // Then cancellation is recorded only after all states have been read.
    expect(bench.current()).toMatchObject({ id: run.id, result: 'cancelled', endedAt: NOW })
    const checked = bench.requests.filter(call => call.method === 'state').map(call => call.args)
    expect(checked).toContainEqual({ request: { sessionId: 'waiting' } })
    expect(checked).toContainEqual({ request: { sessionId: 'ended' } })
  })

  it.each([
    ['cold unknown queue', { ...idle, active: false, queue: null }],
    ['running', { ...idle, running: true }],
    ['queued', { ...idle, queue: [{ id: 'pending' }] }],
    ['pending input', { ...idle, pendingInput: ['approval'] }],
    ['unknown queue', { ...idle, queue: null }],
    ['unreadable state', {}],
  ])('operator retains the directory when a session has %s state', async (_name, state) => {
    // Given a listed session whose state is not proven quiescent.
    const bench = harness()
    const run = await bench.run()
    bench.roster([bench.row('candidate')])
    bench.state(state)
    // When recovery reads that official state.
    await expect(bench.reconcile(run.id)).rejects.toThrow('state is unknown')
    // Then the original run remains locked and can be retried.
    expect(bench.current().endedAt).toBeUndefined()
    expect(bench.current().executionDirectory).toBe(bench.directory)
  })

  it('operator retains ownership on list or state failures and can retry the same run', async () => {
    // Given an unknown create and a failing official roster.
    const bench = harness()
    const run = await bench.run()
    bench.failList('list unavailable')
    // When the first check and a later state read fail.
    await expect(bench.reconcile(run.id)).rejects.toThrow('list unavailable')
    expect(bench.current().endedAt).toBeUndefined()
    bench.failList()
    bench.roster([bench.row('candidate')])
    bench.failState('state unavailable')
    await expect(bench.reconcile(run.id)).rejects.toThrow('state unavailable')
    // Then failures persist visibly without releasing ownership; a successful retry closes it.
    expect(bench.current().cancellation?.error).toBe('state unavailable')
    expect(bench.current().endedAt).toBeUndefined()
    bench.failState()
    await bench.reconcile(run.id)
    expect(bench.current()).toMatchObject({ result: 'cancelled', endedAt: NOW })
  })

  it('operator retains ownership if the roster is unreadable or a new session appears during checking', async () => {
    // Given a roster row with no verifiable directory.
    const bench = harness()
    const run = await bench.run()
    bench.roster([{ ...bench.row('unknown'), cwd: undefined }])
    // When the operator checks, then retries while the roster changes.
    await expect(bench.reconcile(run.id)).rejects.toThrow('unknown session')
    bench.roster([bench.row('first')])
    bench.changeList([bench.row('first'), bench.row('late')])
    await expect(bench.reconcile(run.id)).rejects.toThrow('roster changed')
    // Then neither incomplete observation is accepted as stop proof.
    expect(bench.current().endedAt).toBeUndefined()
    expect(bench.current().cancellation?.error).toContain('retry')
  })

  it('operator cannot unlock a newer run with an old reconciliation callback', async () => {
    // Given a recovery read held on the old execution.
    const bench = harness()
    const old = await bench.run()
    bench.roster([bench.row('candidate')])
    const gate = bench.holdState()
    const pending = bench.reconcile(old.id)
    const rejected = expect(pending).rejects.toThrow('no longer current')
    await gate.entered
    // When a second valid recovery completes and the same card starts a new run.
    await bench.reconcile(old.id)
    const next = await bench.run()
    gate.resolve(idle)
    await rejected
    // Then the stale callback cannot close or mark the new epoch.
    expect(next.id).not.toBe(old.id)
    expect(bench.current()).toMatchObject({ id: next.id, sessionId: 'next-session', executionDirectory: bench.directory })
    expect(bench.current().endedAt).toBeUndefined()
    expect(bench.current().cancellation).toBeUndefined()
  })

  it('operator cannot impersonate human authority or provide a substitute session in the recovery action', async () => {
    // Given an unknown create whose initiator claims to be human.
    const bench = harness()
    const run = await bench.run()
    // When an unverified caller or forged protocol tries to unlock it.
    await expect(bench.reconcile(run.id, false)).rejects.toThrow('authenticated human')
    expect(() => bench.service.apply('forged', bench.action(run.id), 'authenticated-ui')).toThrow('authenticated human')
    expect(() => bench.ledger.applyRequest('forged-ledger', bench.action(run.id), 'human')).toThrow('authenticated human')
    // Then only the strict task-and-execution action can be parsed, with no session binding escape.
    expect(parseActionEnvelope({ requestId: 'bad', action: { ...bench.action(run.id), sessionId: 'ended-session' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'missing', action: { kind: 'reconcile-uncertain', taskId: 'task' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'good', action: bench.action(run.id) })?.action).toEqual(bench.action(run.id))
    expect(bench.current().endedAt).toBeUndefined()
  })
})
