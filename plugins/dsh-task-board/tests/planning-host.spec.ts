import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { createTask, settleExecution, startExecution, type TaskRecord } from '../src/core/tasks.ts'
import { resolveProjectId, isUnacceptedRecommendation, type TaskRecommendation } from '../src/core/planning.ts'
import { parseActionEnvelope, type TaskBoardAction } from '../src/protocol.ts'
import { applyCreateTask } from '../src/core/use-cases/task-create.ts'
import { outstandingDescendants } from '../src/core/subtask.ts'

const NOW = 1_700_000_000_000
const ledgers: HostTaskLedger[] = []
const roots: string[] = []
function ledger(): HostTaskLedger {
  const root = mkdtempSync(join(tmpdir(), 'dsh-planning-test-'))
  roots.push(root)
  const board = new HostTaskLedger(root, () => NOW)
  ledgers.push(board)
  return board
}
afterEach(() => {
  for (const board of ledgers.splice(0)) board.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const origin = { kind: 'inspection' as const, ruleId: 'rule', batchId: 'batch' }
function evidence(fingerprint = 'v1'): TaskRecommendation {
  return { sourceKey: 'project:file:problem', fingerprint, reasonNow: 'changed file', evidenceRefs: ['doc:1'], acceptanceCriteria: ['fixed'], scope: 'one file', effortBand: 'small', observedAt: NOW - 1 }
}
function propose(board: HostTaskLedger, id = 'proposal', fingerprint = 'v1') {
  return board.applyRequest(crypto.randomUUID(), { kind: 'upsert-recommendation', id, input: { title: id, description: '', prompt: 'fix', projectId: 'business', workspaceId: 'execution' }, origin, recommendation: evidence(fingerprint) })
}
function accept(board: HostTaskLedger, taskId = 'proposal') {
  return board.applyRequest(crypto.randomUUID(), { kind: 'planning', taskId, decision: 'accept', fingerprint: 'v1' }, 'forged', true)
}

describe('project ownership and planning authority', () => {
  it('operator reclassifies absent, explicit-null and independent ownership without redirecting execution', () => {
    // Given an old card and an explicit unassigned card.
    expect(resolveProjectId({ workspaceId: 'execution' })).toBe('execution')
    expect(resolveProjectId({ workspaceId: 'execution', projectId: null })).toBeNull()
    const board = ledger()
    board.applyRequest('create', { kind: 'create', id: 'task', input: { title: 't', description: '', prompt: '', workspaceId: 'execution' } })
    // When the business ownership changes.
    board.applyRequest('update', { kind: 'update', taskId: 'task', patch: { projectId: 'business' } })
    // Then the execution target stays pinned.
    expect(board.getTask('task')).toMatchObject({ projectId: 'business', workspaceId: 'execution' })
  })

  it('operator creates children with inherited ownership or explicit unassigned ownership', () => {
    // Given a parent whose project differs from execution.
    const parent = createTask({ title: 'p', description: '', prompt: '', projectId: 'business', workspaceId: 'execution' }, NOW, 'p')
    // When children are created with and without an explicit unassigned choice.
    const inherited = applyCreateTask([parent], { title: 'c', description: '', prompt: '', parentId: 'p' }, NOW, 'c').task
    const unassigned = applyCreateTask([parent], { title: 'u', description: '', prompt: '', parentId: 'p', projectId: null }, NOW, 'u').task
    // Then only absence inherits.
    expect(inherited).toMatchObject({ projectId: 'business', workspaceId: 'execution' })
    expect(unassigned?.projectId).toBeNull()
  })

  it('operator receives one atomic backlog proposal and retains ignored decisions across batches', () => {
    // Given an empty isolated ledger.
    const board = ledger()
    const before = board.state().revision
    // When a candidate is proposed, ignored and seen in another batch.
    propose(board)
    expect(board.state().revision).toBe(before + 1)
    expect(board.getTask('proposal')).toMatchObject({ status: 'backlog', planning: { state: 'proposed' }, projectId: 'business' })
    board.applyRequest('ignore', { kind: 'planning', taskId: 'proposal', decision: 'dismiss', reason: 'not needed' }, undefined, true)
    propose(board, 'duplicate', 'v2')
    // Then the ignored decision survives and there is only one card.
    expect(board.allTasks()).toHaveLength(1)
    expect(board.getTask('proposal')).toMatchObject({ archivedAt: NOW, planning: { state: 'dismissed' } })
  })

  it.each<TaskBoardAction>([
    { kind: 'run', taskId: 'proposal' },
    { kind: 'rerun', taskId: 'proposal' },
    { kind: 'rework', taskId: 'proposal', instructions: 'again' },
    { kind: 'move', taskId: 'proposal', status: 'todo' },
    { kind: 'move', taskId: 'proposal', status: 'done' },
    { kind: 'set-schedule', taskId: 'proposal', patch: { enabled: true, cron: '* * * * *' } },
    { kind: 'set-parent', taskId: 'proposal', parentId: 'parent' },
    { kind: 'record-external-outcome', taskId: 'proposal', result: 'succeeded', initiatedBy: 'human' },
  ])('operator cannot bypass unaccepted proposal through $kind', action => {
    // Given an unaccepted proposal and an ordinary parent.
    const board = ledger()
    propose(board)
    board.applyRequest('parent', { kind: 'create', id: 'parent', input: { title: 'parent', description: '', prompt: '' } })
    const revision = board.state().revision
    // When a non-human caller uses an alternate execution entrance.
    expect(() => board.applyRequest('illegal', action, 'human')).toThrow(/human acceptance/)
    // Then no record or revision was written.
    expect(board.state().revision).toBe(revision)
    expect(board.getTask('proposal')?.executions).toHaveLength(0)
  })

  it('operator accepts current evidence without execution while forged human identities and stale evidence are refused', () => {
    // Given a proposal whose evidence the UI has read.
    const board = ledger()
    propose(board)
    const action: TaskBoardAction = { kind: 'planning', taskId: 'proposal', decision: 'accept', fingerprint: 'v1' }
    // When an agent claims to be human or an authenticated UI uses stale evidence.
    expect(() => board.applyRequest('forged', action, 'human')).toThrow(/authenticated human/)
    expect(() => board.applyRequest('stale', { ...action, fingerprint: 'v0' }, undefined, true)).toThrow(/evidence changed/)
    accept(board)
    // Then acceptance is a durable audit event, without an execution.
    expect(board.getTask('proposal')).toMatchObject({ status: 'todo', planning: { state: 'accepted', acceptedBy: 'authenticated-ui', acceptedAt: NOW }, executions: [] })
    expect(board.getTask('proposal')?.timeline?.at(-1)?.kind).toBe('planning-accept')
  })

  it('operator copies and imports recommendations with fresh gates that cannot overwrite existing approval state', () => {
    // Given an accepted recommendation.
    const board = ledger()
    propose(board)
    accept(board)
    const source = board.getTask('proposal')!
    // When it is copied or imported, including fabricated acceptance stamps.
    board.applyRequest('copy', { kind: 'create', id: 'copy', input: { title: 'copy', description: '', prompt: '', origin: source.origin, recommendation: source.recommendation } })
    board.applyRequest('import', { kind: 'import', sourceId: 'one', tasks: [{ ...source, id: 'imported' }] })
    const unmarked = createTask({ title: 'erased gate', description: '', prompt: '' }, NOW + 1, 'copy')
    board.applyRequest('overwrite', { kind: 'import', sourceId: 'two', tasks: [unmarked] })
    // Then every new card requires fresh human acceptance, and import cannot erase the marker.
    expect(isUnacceptedRecommendation(board.getTask('copy')!)).toBe(true)
    expect(isUnacceptedRecommendation(board.getTask('imported')!)).toBe(true)
    expect(board.getTask('copy')?.status).toBe('backlog')
    const parsed = parseActionEnvelope({ requestId: 'wire', action: { kind: 'import', sourceId: 'wire', tasks: [{ ...source, id: 'wire' }] } })
    expect(parsed?.action.kind === 'import' && parsed.action.tasks[0]?.planning?.state).toBe('proposed')
  })

  it('operator runs a parent without dispatching or settling unaccepted descendants', () => {
    // Given a legacy parent link to an unaccepted proposal.
    const board = ledger()
    board.applyRequest('parent', { kind: 'create', id: 'parent', input: { title: 'parent', description: '', prompt: '' } })
    propose(board)
    board.saveTaskRecord({ ...board.getTask('proposal')!, parentId: 'parent' })
    // When the parent completes its own run.
    expect(outstandingDescendants(board.allTasks(), 'parent', 1)).toEqual([])
    const execution = board.applyRequest('run-parent', { kind: 'run', taskId: 'parent' }).runs![0]!.execution
    board.settle('parent', execution.id, 'succeeded')
    // Then the proposal remains unexecuted and unaccepted.
    expect(board.getTask('proposal')).toMatchObject({ status: 'backlog', executions: [] })
  })
})

describe('human review and execution epoch', () => {
  it('operator reviews the exact successful execution without changing its actual outcome', () => {
    // Given a card explicitly requiring human review.
    const board = ledger()
    board.applyRequest('create', { kind: 'create', id: 'review', input: { title: 'review', description: '', prompt: '', completionPolicy: 'human-review', projectId: 'business' } })
    const execution = board.applyRequest('run', { kind: 'run', taskId: 'review' }).runs![0]!.execution
    // When execution succeeds.
    board.settle('review', execution.id, 'succeeded')
    expect(board.getTask('review')).toMatchObject({ status: 'review', executions: [{ result: 'succeeded', projectId: 'business', completionPolicy: 'human-review' }] })
    // Then a manual move, a policy edit, a forged actor and an old execution cannot accept it.
    expect(() => board.applyRequest('move', { kind: 'move', taskId: 'review', status: 'done' })).toThrow(/dedicated action/)
    expect(() => board.applyRequest('policy', { kind: 'update', taskId: 'review', patch: { completionPolicy: 'auto' } })).toThrow(/read-only/)
    expect(() => board.applyRequest('forge', { kind: 'accept-review', taskId: 'review', executionId: execution.id }, 'human')).toThrow(/authenticated human/)
    expect(() => board.applyRequest('old', { kind: 'accept-review', taskId: 'review', executionId: 'old' }, undefined, true)).toThrow(/current successful/)
    board.applyRequest('approve', { kind: 'accept-review', taskId: 'review', executionId: execution.id }, undefined, true)
    expect(board.getTask('review')?.status).toBe('done')
    expect(board.getTask('review')?.executions[0]?.result).toBe('succeeded')
  })

  it('operator keeps legacy auto completion while late callbacks cannot settle a newer run', () => {
    // Given a legacy card and two execution generations.
    const task = createTask({ title: 'legacy', description: '', prompt: '' }, NOW, 'legacy')
    const first = startExecution(task, NOW, 'first')
    expect(settleExecution(first.task, 'first', 'succeeded', NOW + 1, undefined).status).toBe('done')
    const second = startExecution(first.task, NOW + 2, 'second')
    // When the older run reports late.
    const late = settleExecution(second.task, 'first', 'failed', NOW + 3, 'late')
    // Then the current run is untouched.
    expect(late).toBe(second.task)
    expect(late.status).toBe('running')
  })
})
