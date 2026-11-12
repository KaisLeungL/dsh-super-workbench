// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardController, type TaskBoardTransport } from '../src/core/controller.ts'
import { InMemoryTaskStore } from '../src/core/store.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { assignProjects } from '../src/core/assign-projects.ts'
import { TASK_BOARD_SCHEMA_VERSION, type TaskBoardAction, type TaskBoardSnapshot } from '../src/protocol.ts'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import { CollaborationSection } from '../src/client/board/planning-view.tsx'
import { t } from '../src/client/locales.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
const controllers: BoardController[] = []
afterEach(() => {
  roots.splice(0).forEach(root => act(() => { root.unmount() }))
  controllers.splice(0).forEach(controller => { controller.dispose() })
  document.body.replaceChildren()
  localStorage.clear()
})
function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: id, description: '', prompt: 'work', workspaceId: 'a' }, 1, id), ...patch }
}
function snapshot(tasks: TaskRecord[], revision = 2): TaskBoardSnapshot {
  return { schemaVersion: TASK_BOARD_SCHEMA_VERSION, revision, tasks, scheduler: { timeZone: 'UTC', ledgerId: 'batch-ui-test' },
    power: { platform: 'linux', phase: 'unsupported', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true } }
}
async function controller(cards: TaskRecord[]) {
  let state = snapshot(cards)
  let conflict = false
  const actions: TaskBoardAction[] = []
  const transport: TaskBoardTransport = {
    bootstrap: async () => state,
    state: async () => state,
    subscribe: () => () => {},
    action: async action => {
      actions.push(action)
      if (conflict) { state = { ...state, revision: state.revision + 1 }; throw new Error('revision conflict') }
      if (action.kind === 'assign-projects') state = { ...state, revision: state.revision + 1, tasks: assignProjects(state.tasks, action.taskIds, action.projectId, 2) }
      if (action.kind === 'rework') state = { ...state, revision: state.revision + 1, tasks: state.tasks.map(card => card.id === action.taskId
        ? { ...card, status: 'running', executions: [...card.executions, { id: 'next', startedAt: 3, endedAt: undefined, result: undefined, sessionId: undefined, error: undefined, rework: { instructions: action.instructions } }] } : card) }
      return state
    },
  }
  const board = new BoardController({ store: new InMemoryTaskStore(), sessions: { current: () => 'reviewer', open: () => {}, subscribe: () => () => {} }, transport })
  board.start()
  await board.retryHostSync()
  board.setExecutionOptions({ workspaces: [{ workspaceId: 'a', title: 'Alpha' }, { workspaceId: 'b', title: 'Beta' }] })
  controllers.push(board)
  return { board, actions, fail: () => { conflict = true } }
}
function mount(node: React.ReactNode) {
  const div = document.createElement('div')
  document.body.append(div)
  const root = createRoot(div); roots.push(root)
  act(() => { root.render(node) })
  return { div, root }
}
function button(root: HTMLElement, label: string) {
  const result = [...root.querySelectorAll('button')].find(button => button.textContent === label)
  if (result === undefined) throw new Error('missing button: ' + label)
  return result
}
function click(root: HTMLElement, label: string) { act(() => { button(root, label).click() }) }
function choose(select: HTMLSelectElement, value: string) {
  act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
function type(textarea: HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('batch assignment UI', () => {
  it('user previews both ownership changes before sending one atomic action', async () => {
    // Given two cards executing in Alpha and a project filter already selected.
    const { board, actions } = await controller([task('one'), task('two', { projectId: null })])
    const { div } = mount(<TaskBoard controller={board} />)
    const filter = div.querySelector<HTMLSelectElement>('[data-dsh-part="project-filter"]')!
    choose(filter, 'a')
    click(div, t('project.batch.title'))
    act(() => { div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
    choose(filter, '')
    const boxes = div.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    act(() => { boxes[1]!.click() })
    choose(div.querySelector<HTMLSelectElement>('[data-dsh-part="batch-project-assignment"] select')!, 'b')
    // When the operator previews, no task has changed and no request was sent.
    click(div, t('project.batch.preview'))
    const preview = div.querySelector('[data-dsh-part="batch-project-assignment"]')!
    expect(preview.querySelectorAll('li')).toHaveLength(2)
    expect(preview.textContent).toContain('Alpha → Beta')
    expect(preview.textContent).toContain(t('project.unassigned') + ' → Beta')
    expect(actions).toEqual([])
    expect(board.getSnapshot().tasks.map(task => task.projectId)).toEqual([undefined, null])
    await act(async () => { click(div, t('project.batch.commit')) })
    // Then a single complete request changes ownership, retaining independent execution workspaces.
    expect(actions).toEqual([{ kind: 'assign-projects', taskIds: ['one', 'two'], projectId: 'b', expectedRevision: 2 }])
    expect(board.getSnapshot().tasks.map(task => [task.projectId, task.workspaceId])).toEqual([['b', 'a'], ['b', 'a']])
    expect(div.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(0)
    expect(board.getSnapshot().pendingTaskIds).toEqual([])
    expect(filter.value).toBe('')
  })

  it('user gets a refreshed conflict and must review a new preview before retrying', async () => {
    // Given one selected card and a Host that rejects this revision.
    const { board, fail } = await controller([task('one')])
    fail()
    const { div } = mount(<TaskBoard controller={board} />)
    click(div, t('project.batch.title'))
    act(() => { div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
    click(div, t('project.batch.preview'))
    // When the commit conflicts, Then no optimistic assignment appears and a new preview is required.
    await act(async () => { click(div, t('project.batch.commit')) })
    expect(board.getSnapshot().tasks[0]?.projectId).toBeUndefined()
    expect(board.getSnapshot().host?.revision).toBe(3)
    expect(div.textContent).toContain(t('project.batch.conflict'))
    expect(button(div, t('project.batch.preview')).disabled).toBe(false)
    expect([...div.querySelectorAll('button')].some(button => button.textContent === t('project.batch.commit'))).toBe(false)
  })

  it('user changing the selection invalidates the previous preview and keeps the project filter', async () => {
    // Given one selected card in a project-scoped board.
    const { board, actions } = await controller([task('one'), task('two')])
    const { div } = mount(<TaskBoard controller={board} />)
    const filter = div.querySelector<HTMLSelectElement>('[data-dsh-part="project-filter"]')!
    choose(filter, 'a'); click(div, t('project.batch.title'))
    act(() => { div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
    click(div, t('project.batch.preview'))
    // When the second card joins the selection, Then the old preview cannot be submitted.
    act(() => { div.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click() })
    expect(button(div, t('project.batch.preview')).disabled).toBe(false)
    expect(actions).toEqual([])
    expect(filter.value).toBe('a')
  })
})

describe('review rework UI and waiting visibility', () => {
  it('user requests rework with the exact successful execution and sees the new run', async () => {
    // Given a settled review in its own session.
    const card = task('review', { status: 'review', executions: [{ id: 'e', startedAt: 1, endedAt: 2, result: 'succeeded', sessionId: 's', error: undefined }] })
    const { board, actions } = await controller([card])
    const { div, root } = mount(<CollaborationSection task={card} controller={board} pending={false} />)
    expect(button(div, t('review.rework')).disabled).toBe(true)
    // When the reviewer supplies specific instructions, Then the new run carries them with the reviewed id.
    type(div.querySelector('textarea')!, '  cover the failure path  ')
    await act(async () => { click(div, t('review.rework')) })
    expect(actions).toEqual([{ kind: 'rework', taskId: 'review', instructions: 'cover the failure path', executionId: 'e' }])
    expect(board.getSnapshot().tasks[0]?.status).toBe('running')
    expect(board.getSnapshot().tasks[0]?.executions.at(-1)?.rework?.instructions).toBe('cover the failure path')
    const current = board.getSnapshot().tasks[0]!
    act(() => { root.render(<CollaborationSection task={current} controller={board} pending={false} />) })
    expect(div.querySelector('[data-dsh-part="human-review"]')).toBeNull()
    expect(await board.reworkTask('review', 'stale instructions', 'e')).toBe(false)
  })

  it('user entering a new review cannot reuse instructions or confirmation from the old run', async () => {
    // Given a review with text and an open approval confirmation.
    const card = task('review', { status: 'review', executions: [{ id: 'e', startedAt: 1, endedAt: 2, result: 'succeeded', sessionId: 's', error: undefined }] })
    const { board } = await controller([card])
    const { div, root } = mount(<CollaborationSection task={card} controller={board} pending={false} />)
    type(div.querySelector('textarea')!, 'old instructions'); click(div, t('review.accept'))
    // When another execution becomes the current successful review, Then both old decisions are cleared.
    const next = { ...card, executions: [...card.executions, { ...card.executions[0]!, id: 'new' }] }
    act(() => { root.render(<CollaborationSection task={next} controller={board} pending={false} />) })
    expect(div.querySelector('textarea')!.value).toBe('')
    expect(button(div, t('review.rework')).disabled).toBe(true)
    expect([...div.querySelectorAll('button')].some(button => button.textContent === t('review.confirmAccept'))).toBe(false)
  })

  it('user sees waiting and review columns while only actionable waits count once', async () => {
    // Given an input card, a review also marked waiting, and external/dependency waits.
    const cards = [task('input', { status: 'needs_input' }),
      task('review', { status: 'review', waiting: { kind: 'permission', since: 1, executionId: 'e' } }),
      task('external', { waiting: { kind: 'external', since: 1, executionId: 'x' } }),
      task('dependency', { waiting: { kind: 'dependency', since: 1, executionId: 'd' } })]
    const { board } = await controller(cards)
    const { div } = mount(<TaskBoard controller={board} />)
    // When attention is selected, Then the two actionable cards remain in their actual columns.
    expect(div.querySelectorAll('article[data-status="needs_input"]')).toHaveLength(1)
    expect(div.querySelectorAll('article[data-status="review"]')).toHaveLength(1)
    click(div, t('waiting.filter', { count: '2' }))
    expect(div.querySelectorAll('article')).toHaveLength(2)
    expect(div.querySelector('article[data-status="needs_input"]')?.textContent).toContain('input')
    expect(div.querySelector('article[data-status="review"]')?.textContent).toContain('review')
  })
})
