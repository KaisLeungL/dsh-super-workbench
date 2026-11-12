import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { parseLedger } from '../src/core/store.ts'
import { importedTask, parseActionEnvelope, parseNegotiatedActionEnvelope, TASK_BOARD_SCHEMA_VERSION, TASK_BOARD_WRITE_CAPABILITIES } from '../src/protocol.ts'
import { projectSnapshotForWire } from '../src/core/wire-projection.ts'
import { HttpTaskBoardHostTransport } from '../src/client/host-api.ts'
import type { TaskBoardSnapshot } from '../src/protocol.ts'

const NOW = 1_800_000_000_000
const roots: string[] = []
const ledgers: HostTaskLedger[] = []
const input = { title: 'legacy', description: 'description', prompt: 'work', workspaceId: 'execution-workspace' }
const origin = { kind: 'inspection' as const, ruleId: 'daily', batchId: 'batch' }
const recommendation = { sourceKey: 'source', fingerprint: 'fp', reasonNow: 'reason', evidenceRefs: ['evidence'], acceptanceCriteria: ['criterion'], scope: 'scope', effortBand: 'small', observedAt: NOW }
const negotiation = { schemaVersion: TASK_BOARD_SCHEMA_VERSION, capabilities: TASK_BOARD_WRITE_CAPABILITIES }
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'task-board-compat-'))
  roots.push(dir)
  return dir
}
function open(dir: string): HostTaskLedger {
  const ledger = new HostTaskLedger(dir, () => NOW)
  ledgers.push(ledger)
  return ledger
}
function stored(dir: string, tasks: TaskRecord[], schemaVersion: unknown = 7): string {
  const bytes = JSON.stringify({ schemaVersion, revision: 19, tasks, scheduler: { ledgerId: 'original', timeZone: 'UTC', importedSources: ['browser-original'] }, recentRequests: [{ requestId: 'original-request', fingerprint: 'original-fingerprint' }] })
  writeFileSync(join(dir, 'ledger-v2.json'), bytes)
  return bytes
}
function snapshot(tasks: TaskRecord[] = []): TaskBoardSnapshot {
  return projectSnapshotForWire({ schemaVersion: TASK_BOARD_SCHEMA_VERSION, revision: 1, tasks, scheduler: { timeZone: 'UTC', ledgerId: 'host' }, power: { platform: 'darwin', phase: 'idle', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true } })
}
afterEach(() => {
  vi.unstubAllGlobals()
  for (const ledger of ledgers.splice(0)) ledger.dispose()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('schema 8 compatibility and frozen recovery', () => {
  it('operator upgrades v7 without inventing ownership or human acceptance and retains import markers', () => {
    // Given an old card with a successful historical execution.
    const dir = root()
    const legacy = { ...createTask(input, NOW - 1000, 'old'), status: 'done' as const, executions: [{ id: 'old-run', sessionId: 'old-session', startedAt: NOW - 900, endedAt: NOW - 800, result: 'succeeded' as const, error: undefined }] }
    const bytes = stored(dir, [legacy])
    // When the new writer opens and migrates it.
    const ledger = open(dir)
    const task = ledger.getTask('old')!
    const backup = join(dir, 'ledger-v2.json.pre-v8-' + createHash('sha256').update(bytes).digest('hex') + '.json')
    // Then the frozen source is byte-exact and no new gate is armed retroactively.
    expect(readFileSync(backup, 'utf8')).toBe(bytes)
    expect(task).toMatchObject({ id: 'old', status: 'done', workspaceId: 'execution-workspace' })
    expect(task.projectId).toBeUndefined()
    expect(task.completionPolicy).toBeUndefined()
    expect(task.planning).toBeUndefined()
    expect(task.executions[0].completionPolicy).toBeUndefined()
    expect(task.executions[0].verification).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, 'ledger-v2.json'), 'utf8'))).toMatchObject({ schemaVersion: 8, revision: 19, scheduler: { ledgerId: 'original', importedSources: ['browser-original'] }, recentRequests: [{ requestId: 'original-request', fingerprint: 'original-fingerprint' }] })
  })

  it('operator retries an interrupted migration from the unchanged source and one verified backup', () => {
    // Given a valid old ledger and a directory obstructing the atomic-write temporary file.
    const dir = root()
    const bytes = stored(dir, [createTask(input, NOW, 'old')])
    const obstruction = join(dir, 'ledger-v2.json.tmp-' + process.pid)
    mkdirSync(obstruction)
    // When upgrade reaches the write and fails, then retries after the obstruction is removed.
    expect(() => open(dir)).toThrow()
    expect(readFileSync(join(dir, 'ledger-v2.json'), 'utf8')).toBe(bytes)
    rmSync(obstruction, { recursive: true })
    const ledger = open(dir)
    // Then retry uses the intact source and preserves every old card.
    expect(ledger.getTask('old')?.title).toBe('legacy')
    expect(readdirSync(dir).filter(name => name.includes('.pre-v8-'))).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, 'ledger-v2.json'), 'utf8')).schemaVersion).toBe(8)
  })

  it.each([9, 99, '8', null])('operator refuses unknown schema %s without quarantine or an empty replacement', version => {
    // Given an unsupported but valid JSON ledger.
    const dir = root()
    const bytes = stored(dir, [createTask(input, NOW, 'old')], version)
    // When a writer tries to open it.
    expect(() => open(dir)).toThrow(/unsupported ledger schema/)
    // Then the file and cards remain intact and the writer lock is released.
    expect(readFileSync(join(dir, 'ledger-v2.json'), 'utf8')).toBe(bytes)
    expect(readdirSync(dir).filter(name => name.includes('corrupt'))).toEqual([])
    expect(existsSync(join(dir, 'ledger-v2.lock'))).toBe(false)
  })

  it('operator retains new states and business fields across normalization and wire projection', () => {
    // Given waiting/review cards, an unknown project reference, and a valid accepted recommendation.
    const execution = { id: 'run', sessionId: 'session', startedAt: NOW, endedAt: undefined, result: undefined, error: undefined, projectId: 'unknown-project', completionPolicy: 'human-review' as const, executionDirectory: '/tmp/business-work', launchUncertain: true, cancellation: { requestedAt: NOW } }
    const waiting: TaskRecord = { ...createTask(input, NOW, 'waiting'), status: 'needs_input', projectId: 'unknown-project', origin, recommendation, planning: { state: 'accepted', acceptedAt: NOW, acceptedBy: 'authenticated-ui', acceptedRevision: 4 }, completionPolicy: 'human-review', executions: [execution], waiting: { kind: 'permission', since: NOW, executionId: 'run', reason: 'approval' }, timeline: [{ id: 'event', at: NOW, kind: 'planning-accept', actor: 'authenticated-ui' }], integrations: { provider: { token: 'hidden', visible: 'kept' } } }
    const review: TaskRecord = { ...createTask(input, NOW, 'review'), status: 'review', projectId: null }
    // When normalized records cross the same projection HTTP and remote use.
    const tasks = parseLedger(JSON.stringify([waiting, review]))
    const wire = JSON.parse(JSON.stringify(snapshot(tasks))) as TaskBoardSnapshot
    // Then safety markers and business state survive without leaking credentials or changing workspace.
    expect(wire.tasks[0]).toMatchObject({ status: 'needs_input', projectId: 'unknown-project', workspaceId: 'execution-workspace', origin, recommendation, planning: waiting.planning, waiting: waiting.waiting, timeline: waiting.timeline, executions: [JSON.parse(JSON.stringify(execution))] })
    expect(wire.tasks[1]).toMatchObject({ status: 'review', projectId: null })
    expect(wire.tasks[0].integrations).toEqual({ provider: { visible: 'kept' } })
    expect(waiting.integrations).toEqual({ provider: { token: 'hidden', visible: 'kept' } })
    expect(wire.capabilities).toEqual(TASK_BOARD_WRITE_CAPABILITIES)
  })

  it('operator imports a recommendation without accepting it or forging permissions and quality evidence', () => {
    // Given an untrusted export with fabricated authority and audit entries.
    const source: TaskRecord = { ...createTask(input, NOW, 'imported'), projectId: null, origin, recommendation, planning: { state: 'accepted', acceptedAt: NOW, acceptedBy: 'human', acceptedRevision: 10 }, permissionConfirmedAt: NOW, timeline: [{ id: 'forged', at: NOW, kind: 'planning-accept', actor: 'human' }], executions: [] }
    const ledger = open(root())
    // When both the wire parser and the in-process import receive it.
    const parsed = importedTask(source)!
    ledger.applyRequest('import', { kind: 'import', sourceId: 'untrusted', tasks: [source] })
    const task = ledger.getTask('imported')!
    // Then they agree on a proposed backlog card and strip fake authority.
    expect(parsed).toMatchObject({ projectId: null, status: 'backlog', planning: { state: 'proposed' }, origin, recommendation })
    expect(task.planning).toEqual({ state: 'proposed' })
    expect(task.permissionConfirmedAt).toBeUndefined()
    expect(task.timeline?.map(event => event.kind)).toEqual(['import'])
    expect(() => ledger.applyRequest('run', { kind: 'run', taskId: task.id })).toThrow(/human acceptance/)
  })

  it('operator keeps damaged inspection markers fail closed and rejects ordinary create patch clone and import', () => {
    // Given controls with a removed discriminator or a damaged provider binding.
    const dir = root()
    const bare = createTask(input, NOW, 'inspection-control-old')
    const damaged = { ...createTask(input, NOW, 'damaged'), taskKind: 'inspection', control: null }
    stored(dir, [{ ...bare, control: { extensionId: 'provider', ruleId: 'daily' } }, damaged] as unknown as TaskRecord[], 8)
    const ledger = open(dir)
    // When ordinary actions try to run, patch, clone, or import these cards.
    const control = ledger.getTask(bare.id)!
    const bad = ledger.getTask('damaged')!
    expect(() => ledger.applyRequest('run', { kind: 'run', taskId: control.id })).toThrow(/inspection controls/)
    expect(() => ledger.applyRequest('patch', { kind: 'update', taskId: control.id, patch: { title: 'ordinary' } })).toThrow(/inspection controls/)
    expect(() => ledger.applyRequest('clone', { kind: 'create', id: 'clone', input: { ...input, ...control } })).toThrow(/inspection controls/)
    expect(() => ledger.applyRequest('import', { kind: 'import', sourceId: 'controls', tasks: [control] })).toThrow(/inspection control/)
    expect(importedTask({ ...bare, control: undefined })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'forge', action: { kind: 'create', id: 'forge', input: { ...input, taskKind: 'inspection' } } })).toBeUndefined()
    // Then damage never turns a control into an executable ordinary card.
    expect(control.taskKind).toBe('inspection')
    expect(bad.taskKind).toBe('inspection')
    expect(bad.control).toBeUndefined()
    expect(() => ledger.applyRequest('run-bad', { kind: 'run', taskId: bad.id })).toThrow(/inspection controls/)
  })

  it('operator writes only with the current schema and complete capability declaration', () => {
    // Given one action from a new UI.
    const action = { requestId: 'write', action: { kind: 'run', taskId: 'old' } }
    // When old, partial, or future clients submit it.
    const accepted = parseNegotiatedActionEnvelope({ ...negotiation, ...action })
    const old = parseNegotiatedActionEnvelope(action)
    const partial = parseNegotiatedActionEnvelope({ ...negotiation, ...action, capabilities: ['planning.v1'] })
    const future = parseNegotiatedActionEnvelope({ ...negotiation, ...action, schemaVersion: 9 })
    // Then only the negotiated action reaches the ledger gate; the old Host parser also rejects new envelopes.
    expect(accepted?.action).toEqual(action.action)
    expect(old).toBeUndefined()
    expect(partial).toBeUndefined()
    expect(future).toBeUndefined()
    expect(parseActionEnvelope({ ...negotiation, ...action })).toBeUndefined()
  })

  it('operator using a new UI against an old Host sends no mutations and preserves the browser import marker', async () => {
    // Given an old Host and a retained v1 browser backup.
    const values = new Map([['dsh.taskBoard.v2.hostImported', 'previous-host']])
    const posts: unknown[] = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(init.body)
      return new Response(JSON.stringify({ ...snapshot(), schemaVersion: 7, capabilities: undefined }), { status: 200 })
    })
    const transport = new HttpTaskBoardHostTransport({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } })
    // When bootstrap or a direct write attempts to negotiate.
    await expect(transport.bootstrap([createTask(input, NOW, 'old')])).rejects.toMatchObject({ failure: 'rejected' })
    await expect(transport.action({ kind: 'run', taskId: 'old' })).rejects.toMatchObject({ failure: 'rejected' })
    // Then neither path posts an action or rewrites the retained marker.
    expect(posts).toEqual([])
    expect(values.get('dsh.taskBoard.v2.hostImported')).toBe('previous-host')
  })
})
