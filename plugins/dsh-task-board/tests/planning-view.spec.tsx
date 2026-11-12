// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { TaskRecord } from '../src/core/tasks.ts'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import { TaskDetail } from '../src/client/board/TaskDetail.tsx'
import { NewTaskModal } from '../src/client/board/NewTaskModal.tsx'
import { BusinessTimeline, CollaborationSection, PlanningActions, RecommendationDetails } from '../src/client/board/planning-view.tsx'
import { UNASSIGNED_PROJECT } from '../src/client/board/project-view.tsx'
import { t } from '../src/client/locales.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
afterEach(() => {
  roots.splice(0).forEach(root => act(() => { root.unmount() }))
  document.body.replaceChildren()
  vi.useRealTimers()
})
function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return { id: 't', title: 'Test task', description: '', prompt: '', status: 'todo', createdAt: 0, updatedAt: 0, executions: [], ...patch }
}
const workspaces = [{ workspaceId: 'a', title: 'Alpha' }, { workspaceId: 'b', title: 'Beta' }]
function controller(tasks: TaskRecord[], overrides: Partial<BoardController> = {}) {
  const snapshot: ControllerSnapshot = { tasks, boardOpen: true, archiveView: false, selectedTaskId: undefined, pendingTaskIds: [], executionOptions: { workspaces, presets: [] } }
  return { getSnapshot: () => snapshot, subscribe: () => () => {}, closeBoard: () => {}, closeTask: () => {}, openTask: vi.fn(), openSession: vi.fn(),
    isHostBacked: () => true, ...overrides } as unknown as BoardController
}
function mount(node: React.ReactNode) {
  const div = document.createElement('div')
  document.body.append(div)
  const root = createRoot(div)
  roots.push(root)
  act(() => { root.render(node) })
  return div
}
function choose(select: HTMLSelectElement, value: string) {
  act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
function click(root: HTMLElement, label: string) {
  const button = [...root.querySelectorAll('button')].find(button => button.textContent === label)
  if (button === undefined) throw new Error('missing button: ' + label)
  act(() => { button.click() })
}
const recommendation = {
  sourceKey: 'src', fingerprint: 'fp', reasonNow: 'Evidence changed', evidenceRefs: ['src/example.ts:5', 'https://example.test/evidence'],
  acceptanceCriteria: ['Check the result'], scope: 'Client only', effortBand: 'small', observedAt: 1,
}
describe('project assignment and recommendation UI', () => {
  it('user filters independent project ownership by clicking its badge', () => {
    // Given one legacy card, one explicitly unassigned card, and one independent assignment
    const cards = [task({ id: 'legacy', workspaceId: 'a' }), task({ id: 'none', projectId: null, workspaceId: 'a' }), task({ id: 'separate', projectId: 'b', workspaceId: 'a' })]
    const c = controller(cards)
    const root = mount(<TaskBoard controller={c} />)
    const filter = root.querySelector<HTMLSelectElement>('[data-dsh-part="project-filter"]')!
    // When the user chooses unassigned, only the explicit null is visible
    choose(filter, UNASSIGNED_PROJECT)
    expect(root.querySelectorAll('article')).toHaveLength(1)
    expect(root.querySelector('article [data-dsh-part="project-badge"]')?.textContent).toContain(t('project.unassigned'))
    choose(filter, '')
    const beta = [...root.querySelectorAll<HTMLButtonElement>('[data-dsh-part="project-badge"]')].find(button => button.textContent === 'Beta')!
    act(() => { beta.click() })
    // Then a badge filters without opening a card or executing a task
    expect(root.querySelectorAll('article')).toHaveLength(1)
    expect(filter.value).toBe('b')
    expect(c.openTask).not.toHaveBeenCalled()
  })
  it('user switches project and source grouping without losing cards', () => {
    // Given two differently assigned cards, When grouping changes, Then both remain accessible
    const root = mount(<TaskBoard controller={controller([task({ id: 'one', projectId: 'b' }), task({ id: 'two', projectId: null })])} />)
    const grouping = root.querySelector<HTMLSelectElement>('[data-dsh-part="grouping-select"]')!
    choose(grouping, 'project')
    expect(root.querySelectorAll('article')).toHaveLength(2)
    expect([...root.querySelectorAll('[data-dsh-part="card-group"]')].map(group => group.textContent).join()).toContain('Beta')
    choose(grouping, 'none')
    expect(root.querySelectorAll('article')).toHaveLength(2)
    expect(root.querySelector('[data-dsh-part="card-group"]')).toBeNull()
  })
  it('user creates an explicitly unassigned task with an independent execution workspace', async () => {
    // Given an unassigned default and a separate execution workspace
    const created: unknown[] = []
    const c = controller([], { createTaskConfirmed: async input => { created.push(input); return task() } })
    const root = mount(<NewTaskModal controller={c} defaultProjectId={null} defaultWorkspaceId="a" onClose={() => {}} />)
    expect(root.querySelector<HTMLSelectElement>('[data-dsh-part="project-field"]')?.value).toBe('')
    // When the user saves the task, Then null remains explicit and workspace Alpha is retained
    await act(async () => { root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(created).toMatchObject([{ projectId: null, workspaceId: 'a' }])
  })
  it('user reassigns a task without changing its execution workspace', () => {
    // Given a task assigned to Alpha, When it moves to Beta, Then the execution workspace is untouched
    const updateTask = vi.fn(async () => true)
    const card = task({ projectId: 'a', workspaceId: 'a' })
    const root = mount(<TaskDetail task={card} controller={controller([card], { updateTask })} />)
    choose(root.querySelector<HTMLSelectElement>('[data-dsh-part="project-field"]')!, 'b')
    expect(updateTask).toHaveBeenCalledWith('t', { projectId: 'b' })
  })
  it('user accepts the displayed recommendation or snoozes it without running', () => {
    // Given a proposed recommendation, When its planning actions are selected, Then only planning requests are sent
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
    const planTask = vi.fn(async () => true)
    const card = task({ status: 'backlog', recommendation, planning: { state: 'proposed' } })
    const c = controller([card], { planTask })
    const root = mount(<PlanningActions task={card} controller={c} pending={false} />)
    click(root, t('planning.accept'))
    expect(planTask).toHaveBeenLastCalledWith('t', 'accept', { fingerprint: 'fp' })
    click(root, t('planning.snoozeDay'))
    expect(planTask).toHaveBeenLastCalledWith('t', 'snooze', { snoozedUntil: Date.now() + 86400000 })
    click(root, t('planning.dismiss'))
    expect(planTask).toHaveBeenLastCalledWith('t', 'dismiss', {})
  })
  it('user reads stale evidence and cannot accept it', () => {
    // Given expired evidence, When the recommendation renders, Then acceptance is disabled and references remain readable
    const card = task({ recommendation: { ...recommendation, validUntil: 1 }, planning: { state: 'stale' } })
    const c = controller([card])
    const root = mount(<><RecommendationDetails task={card} /><PlanningActions task={card} controller={c} pending={false} /></>)
    expect(root.textContent).toContain('src/example.ts:5')
    expect(root.querySelectorAll('a')).toHaveLength(1)
    expect(root.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
    expect([...root.querySelectorAll('button')].find(button => button.textContent === t('planning.accept'))?.disabled).toBe(true)
  })
  it('user sees a snoozed recommendation reappear at expiry without polling', async () => {
    // Given a recommendation hidden until one minute after the current instant
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
    const card = task({ recommendation, status: 'backlog', planning: { state: 'snoozed', snoozedUntil: Date.now() + 60000 } })
    const root = mount(<TaskBoard controller={controller([card])} />)
    expect(root.querySelectorAll('article')).toHaveLength(0)
    // When that instant arrives, Then the browser wakes once and reveals the same card
    await act(async () => { vi.advanceTimersByTime(60001) })
    expect(root.querySelectorAll('article')).toHaveLength(1)
    expect(root.querySelector('article')?.getAttribute('data-status')).toBe('backlog')
  })
  it('user sees each waiting review counted once and can reveal its subtask', () => {
    // Given one subtask with both a review status and a waiting marker
    const card = task({ parentId: 'parent', status: 'review', waiting: { kind: 'user', since: 1, executionId: 'e' } })
    const root = mount(<TaskBoard controller={controller([card])} />)
    const attention = root.querySelector<HTMLButtonElement>('[data-dsh-part="attention-filter"]')!
    expect(attention.textContent).toBe(t('waiting.filter', { count: '1' }))
    // When the operator selects attention, hidden subtasks are included
    act(() => { attention.click() })
    // Then the same card remains findable in the review column
    expect(root.querySelectorAll('article')).toHaveLength(1)
  })
  it('user confirms the exact settled execution awaiting human review', async () => {
    // Given a settled execution awaiting human review
    const acceptReview = vi.fn(async () => true)
    const card = task({ status: 'review', executions: [{ id: 'e', startedAt: 1, endedAt: 2, result: 'succeeded', sessionId: 's', error: undefined }] })
    const root = mount(<CollaborationSection task={card} controller={controller([card], { acceptReview })} pending={false} />)

    // When the user starts approval and confirms
    click(root, t('review.accept'))
    expect(acceptReview).not.toHaveBeenCalled()
    await act(async () => { click(root, t('review.confirmAccept')) })

    // Then approval targets the settled execution
    expect(acceptReview).toHaveBeenCalledWith('t', 'e')
  })

  it('user pages the activity log grouped by day in the host time zone', () => {
    // Given events spanning midnight in Shanghai within a single UTC date
    const start = Date.UTC(2026, 0, 4, 15, 58)
    const card = task({
      timeline: Array.from({ length: 21 }, (_, i) => ({
        id: String(i), kind: 'move', at: start + i * 60_000, detail: 'Event ' + i,
        actor: i === 20 ? 'session-1' : 'authenticated-ui',
      })),
    })
    const root = mount(<BusinessTimeline task={card} timeZone="Asia/Shanghai" />)

    // When the activity opens
    const groups = [...root.querySelectorAll('ol')]

    // Then newer days and events come first, with their stored details and actors
    expect(groups.map(group => group.children.length)).toEqual([19, 1])
    expect(groups[0]?.firstElementChild?.textContent).toContain('Event 20')
    expect(groups[0]?.firstElementChild?.textContent).toContain('session-1')
    expect(groups[1]?.textContent).toContain(t('timeline.actor.board'))
    expect(groups[0]?.querySelector('time')?.dateTime).toBe(new Date(start + 20 * 60_000).toISOString())

    // And the earlier page still shows the oldest event
    click(root, t('timeline.next'))
    expect(root.querySelectorAll('li')).toHaveLength(1)
    expect(root.textContent).toContain('Event 0')
  })
})
