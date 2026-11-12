import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { parseActionEnvelope, type TaskBoardAction } from '../src/protocol.ts'
import { isUnacceptedRecommendation } from '../src/core/planning.ts'

const NOW = 1_700_000_000_000
const boards: { board: HostTaskLedger; root: string }[] = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-batch-project-'))
  const board = new HostTaskLedger(root, () => NOW)
  boards.push({ board, root })
  for (const id of ['a', 'b']) board.applyRequest('create-' + id, { kind: 'create', id, input: { title: id, description: '', prompt: 'work', workspaceId: 'execution' } })
  return { board, root }
}
afterEach(() => { for (const { board, root } of boards.splice(0)) { board.dispose(); rmSync(root, { recursive: true, force: true }) } })
function assign(board: HostTaskLedger, projectId: string | null = 'business', expectedRevision = board.state().revision, taskIds = ['a', 'b']) {
  return board.applyRequest('batch', { kind: 'assign-projects', taskIds, projectId, expectedRevision })
}

describe('atomic project assignment', () => {
  it('operator assigns the complete selection in one revision and preserves execution targets', () => {
    // Given two legacy cards sharing an execution workspace.
    const { board, root } = setup()
    const before = board.state().revision
    // When the complete selection is assigned in one transaction and retried.
    assign(board)
    assign(board, 'business', before)
    // Then exactly one revision persists both assignments with their own audit.
    expect(board.state().revision).toBe(before + 1)
    expect(board.allTasks().map(task => [task.projectId, task.workspaceId, task.timeline?.at(-1)?.kind]))
      .toEqual([['business', 'execution', 'assign-projects'], ['business', 'execution', 'assign-projects']])
    const persisted = JSON.parse(readFileSync(join(root, 'ledger-v2.json'), 'utf8')) as { tasks: TaskRecord[] }
    expect(persisted.tasks.map(task => task.projectId)).toEqual(['business', 'business'])
  })

  it('operator reclassifies settled cards without rewriting recorded execution scope', () => {
    // Given a completed execution that captured its original business project.
    const { board } = setup()
    const execution = { id: 'old', startedAt: NOW - 2, endedAt: NOW - 1, sessionId: 'session', result: 'succeeded' as const, error: undefined, projectId: 'original' }
    board.saveTaskRecord({ ...board.getTask('b')!, status: 'done', executions: [execution] })
    // When the user changes only current ownership through the batch action.
    assign(board)
    // Then execution history, prompt and execution workspace remain unchanged.
    expect(board.getTask('b')).toMatchObject({ projectId: 'business', workspaceId: 'execution', prompt: 'work', status: 'done', executions: [execution] })
  })

  it.each(['missing', 'running', 'open', 'archived', 'inspection', 'revision'] as const)(
    'operator sees the whole batch rejected for a %s conflict without a partial write', conflict => {
      // Given a valid first card and an ineligible second participant or stale revision.
      const { board, root } = setup()
      const second = board.getTask('b')!
      let selection = ['a', 'b']
      if (conflict === 'missing') board.applyRequest('delete', { kind: 'delete', taskId: 'b' })
      if (conflict === 'running') board.saveTaskRecord({ ...second, status: 'running' })
      if (conflict === 'open') board.saveTaskRecord({ ...second, executions: [{ id: 'open', startedAt: NOW, sessionId: undefined, endedAt: undefined, result: undefined, error: undefined }] })
      if (conflict === 'archived') board.saveTaskRecord({ ...second, archivedAt: NOW })
      if (conflict === 'inspection') selection = ['a', board.upsertInspectionControl('inspection', 'test', '0 9 * * *', 'UTC').id]
      const before = board.state()
      const bytes = readFileSync(join(root, 'ledger-v2.json'), 'utf8')
      // When the atomic action encounters the conflict.
      expect(() => assign(board, 'business', before.revision - (conflict === 'revision' ? 1 : 0), selection)).toThrow()
      // Then neither the first card, the revision nor the on-disk document changes.
      expect(board.state()).toEqual(before)
      expect(board.getTask('a')?.projectId).toBeUndefined()
      expect(readFileSync(join(root, 'ledger-v2.json'), 'utf8')).toBe(bytes)
    },
  )

  it('operator reassigns a recommendation with a fresh acceptance gate and retained audit', () => {
    // Given an accepted recommendation and its scheduled future work.
    const { board } = setup()
    board.applyRequest('proposal', { kind: 'upsert-recommendation', id: 'r',
      input: { title: 'r', description: '', prompt: 'work', projectId: 'old', workspaceId: 'execution' },
      origin: { kind: 'inspection', ruleId: 'rule', batchId: 'batch' },
      recommendation: { sourceKey: 'key', fingerprint: 'fp', reasonNow: 'change', evidenceRefs: ['file:1'], acceptanceCriteria: ['works'], scope: 'file', effortBand: 'small', observedAt: NOW },
    })
    board.applyRequest('accept', { kind: 'planning', taskId: 'r', decision: 'accept', fingerprint: 'fp' }, undefined, true)
    board.applyRequest('schedule', { kind: 'set-schedule', taskId: 'r', patch: { enabled: true, cron: '0 9 * * *' } })
    const before = board.state().revision
    // When the recommendation moves to another business project.
    board.applyRequest('reassign', { kind: 'assign-projects', taskIds: ['r', 'a'], projectId: null, expectedRevision: before })
    // Then the old approval cannot authorize the new scope, while evidence and timeline survive.
    const card = board.getTask('r')!
    expect(card).toMatchObject({ projectId: null, workspaceId: 'execution', status: 'backlog', planning: { state: 'proposed' }, schedule: { enabled: false }, recommendation: { fingerprint: 'fp' } })
    expect(isUnacceptedRecommendation(card)).toBe(true)
    expect(card.timeline?.map(event => event.kind)).toContain('planning-accept')
    expect(card.timeline?.at(-1)).toMatchObject({ kind: 'assign-projects', detail: JSON.stringify({ fromProjectId: 'old', toProjectId: null, acceptanceReset: true }) })
    expect(() => board.applyRequest('run-unaccepted', { kind: 'run', taskId: 'r' })).toThrow(/human acceptance/)
    expect(board.state().revision).toBe(before + 1)
  })

  it('operator submits only strict bounded selections and whole revisions', () => {
    // Given the complete wire action.
    const action = { kind: 'assign-projects', taskIds: ['a', 'b'], projectId: null, expectedRevision: 3 }
    // When it is decoded, Then its exact selection is retained and malformed variants are rejected.
    expect(parseActionEnvelope({ requestId: 'wire', action })?.action).toEqual(action)
    for (const patch of [{ taskIds: [] }, { taskIds: ['a', 'a'] }, { taskIds: [' '] }, { taskIds: Array(501).fill('a') }, { projectId: undefined }, { projectId: 3 }, { expectedRevision: -1 }, { expectedRevision: 1.5 }, { extra: true }]) {
      expect(parseActionEnvelope({ requestId: 'wire', action: { ...action, ...patch } })).toBeUndefined()
    }
  })
})

describe('review rework execution guard', () => {
  it('operator reworks only the current successful execution and ignores its late outcome', () => {
    // Given a successful run awaiting human review.
    const { board } = setup()
    const base = createTask({ title: 'review', description: 'frozen description', prompt: 'frozen prompt', completionPolicy: 'human-review' }, NOW, 'review')
    board.saveTaskRecord({ ...base, status: 'review', executions: [{ id: 'e', startedAt: NOW - 2, endedAt: NOW - 1, sessionId: 'session', result: 'succeeded', error: undefined }] })
    const action: TaskBoardAction = { kind: 'rework', taskId: 'review', instructions: 'cover failure path', executionId: 'e' }
    const revision = board.state().revision
    // When a stale or unbound reviewer requests rework, nothing is opened.
    expect(() => board.applyRequest('old', { ...action, executionId: 'old' })).toThrow(/current successful/)
    expect(() => board.applyRequest('unbound', { ...action, executionId: undefined })).toThrow(/current successful/)
    expect(board.state().revision).toBe(revision)
    const run = board.applyRequest('current', action).runs![0]!.execution
    board.settle('review', 'e', 'failed', 'late old callback')
    // Then the new run retains its instructions and immutable card text.
    expect(board.getTask('review')).toMatchObject({ status: 'running', prompt: 'frozen prompt', description: 'frozen description' })
    expect(board.getTask('review')?.executions.at(-1)).toMatchObject({ id: run.id, rework: { instructions: 'cover failure path' } })
    board.attachSession('review', run.id, 'session')
    board.settle('review', run.id, 'succeeded')
    expect(() => board.applyRequest('stale-reviewer', action)).toThrow(/current successful/)
    expect(board.getTask('review')?.status).toBe('review')
  })

  it.each(['failed', 'sessionless'] as const)('operator cannot rework a %s review as if it were a current successful conversation', mode => {
    // Given a malformed review with a failed result or no current session.
    const { board } = setup()
    board.saveTaskRecord({ ...createTask({ title: 'review', description: '', prompt: '' }, NOW, 'r'), status: 'review',
      executions: [{ id: 'e', startedAt: NOW - 2, endedAt: NOW - 1, result: mode === 'failed' ? 'failed' : 'succeeded', sessionId: mode === 'sessionless' ? undefined : 'session', error: undefined }] })
    const before = board.state()
    // When that review is returned for rework, Then no execution or revision is written.
    expect(() => board.applyRequest('bad', { kind: 'rework', taskId: 'r', instructions: 'fix', executionId: 'e' })).toThrow(/current successful/)
    expect(board.state()).toEqual(before)
  })
})
