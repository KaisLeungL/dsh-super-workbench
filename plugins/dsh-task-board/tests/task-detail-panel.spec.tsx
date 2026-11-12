// @vitest-environment jsdom
/**
 * The detail panel's information hierarchy: what the card says reads on one
 * track and what the board does with it on another, the execution history
 * folds after five rows, the acceptance report folds to a verdict, and the
 * detail footer holds the edit and run actions, with deletion in the header's
 * More Actions menu. Escape and an outside press close a menu. Escape returns
 * focus to the trigger and never reaches the panel's own close handler.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskDetail } from '../src/client/board/TaskDetail.tsx'
import { t, zh } from '../src/client/locales.ts'
import { openDetailTab, openFormSection } from './form-sections.ts'
import { VISIBLE_EXECUTIONS } from '../src/client/board/ExecutionLog.tsx'
import { OVERLAY_EXIT_MS } from '../src/client/board/overlay.tsx'
import { MISSING_WORKSPACE_REASON } from '../src/core/workspace-target.ts'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import { createTask, type ExecutionRecord, type TaskRecord } from '../src/core/tasks.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
  vi.useRealTimers()
})

/** One card with the fields the detail view reads. */
function card(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTask({ title: 'Panel card', description: 'body', prompt: 'do the thing' }, 0, 'card-1'),
    ...overrides,
  }
}

/** One settled execution record. */
function run(id: string, startedAt: number): ExecutionRecord {
  return { id, sessionId: `session-${id}`, startedAt, endedAt: startedAt + 1000, result: 'succeeded', error: undefined }
}

/** The host face of one board snapshot. */
function hostState(overrides: Record<string, unknown> = {}): ControllerSnapshot['host'] {
  return {
    revision: 1,
    scheduler: { timeZone: 'UTC' },
    power: { platform: 'linux', phase: 'unsupported', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
    sessionDefaultPermission: 'read-only',
    goalRunEnabled: true,
    ...overrides,
  } as ControllerSnapshot['host']
}

/** A controller whose snapshot is the one board state the test needs. */
function controller(task: TaskRecord, hostOverrides: Record<string, unknown> = {}): BoardController {
  const state: ControllerSnapshot = {
    tasks: [task],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: task.id,
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
    host: hostState(hostOverrides),
  }
  return {
    getSnapshot: () => state,
    isHostBacked: () => false,
    subscribe: () => () => {},
    closeTask: vi.fn(),
    retryHostSync: vi.fn(async () => true),
    openSession: vi.fn(),
    confirmPermission: vi.fn(async () => true),
    reconcileUncertain: vi.fn(async () => true),
    updateTask: vi.fn(async () => true),
    moveTask: vi.fn(),
    deleteTask: vi.fn(),
    archiveTask: vi.fn(),
    restoreTask: vi.fn(),
    rerunTask: vi.fn(async () => {}),
    setSchedule: vi.fn(() => true),
    setParent: vi.fn(async () => true),
    openTask: vi.fn(),
    dispatchExtension: vi.fn(async () => true),
  } as unknown as BoardController
}

/** Render the detail panel over one card. */
function renderDetail(task: TaskRecord, hostOverrides: Record<string, unknown> = {}): { container: HTMLElement; controller: BoardController } {
  const board = controller(task, hostOverrides)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(<TaskDetail controller={board} task={task} />) })
  return { container, controller: board }
}

/** The first button whose text is exactly one label. */
function buttonOf(container: ParentNode, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === label)
  if (found === undefined) throw new Error('no button labelled ' + label)
  return found
}

/** Dispatch one keydown the way the browser reports it: from the focused node up. */
function pressKey(node: EventTarget, key: string): void {
  act(() => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

describe('detail panel hierarchy', () => {
  it('operator checks an unknown launch using the exact execution shown in the detail panel', () => {
    // Given a card whose create outcome is unknown and still owns its directory.
    const execution: ExecutionRecord = { id: 'uncertain-run', startedAt: 1000, sessionId: undefined, endedAt: undefined, result: undefined, error: undefined, launchUncertain: true, executionDirectory: '/work', cancellation: { requestedAt: 1001, error: 'roster unavailable' } }
    const task = card({ status: 'running', executions: [execution] })
    const { container, controller: board } = renderDetail(task)
    // When the operator clicks the recovery action.
    const button = buttonOf(container, t('detail.reconcileUncertain'))
    act(() => { button.click() })
    // Then the visible card and epoch are submitted with the fail-closed explanation.
    expect(board.reconcileUncertain).toHaveBeenCalledWith(task.id, execution.id)
    expect(container.textContent).toContain(t('detail.reconcileUncertainHint'))
    expect(container.textContent).toContain('roster unavailable')
    expect(container.textContent).not.toContain(t('detail.retryCancellation'))
  })

  it('user opening a card reads its content and its execution on two tracks', () => {
    // Given a card with a prompt and a settled run
    const { container } = renderDetail(card({ executions: [run('e1', 1_000)] }))

    // When the panel renders
    const columns = container.querySelectorAll('[data-detail-layout] > [data-detail-column]')

    // Then the two tracks exist, in reading order, and each owns its half
    expect([...columns].map(column => column.getAttribute('data-detail-column'))).toEqual(['content', 'execution'])
    expect(columns[0]!.textContent).toContain('do the thing')
    expect(columns[0]!.textContent).toContain(t('detail.execution'))
    expect(columns[1]!.textContent).not.toContain(t('detail.execution'))
    expect(columns[1]!.textContent).toContain('执行设置')
    expect(columns[0]!.textContent).not.toContain('执行设置')
  })

  it('user scanning a long history sees the five latest runs until they ask for all of them', () => {
    // Given a card with eight settled runs
    const executions = Array.from({ length: 8 }, (_, index) => run(`e${index}`, 1_000 + index))
    const { container } = renderDetail(card({ executions }))

    // When the reader switches from content to execution history
    const rows = (): number => container.querySelectorAll('[role="tabpanel"]:not([hidden]) [data-execution-id]').length
    expect(rows()).toBe(0)
    openDetailTab(container, t('detail.execution'))
    const panel = container.querySelector('[role="tabpanel"]:not([hidden])')!
    const disclosure = buttonOf(panel, '显示全部 8 条')

    // Then the panel echoes the ledger and lists only the latest runs
    expect(panel.textContent).toContain('8 次')
    expect(panel.textContent).toContain(t('detail.result.succeeded'))

    // Then only the five latest rows are on screen, behind one disclosure
    expect(VISIBLE_EXECUTIONS).toBe(5)
    expect(rows()).toBe(5)
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    const controlled = disclosure.getAttribute('aria-controls') ?? ''
    expect(document.getElementById(controlled)?.id).toBe(controlled)

    // When the reader opens it
    act(() => { disclosure.click() })

    // Then every run is listed
    expect(rows()).toBe(8)

    // When they close it again the extra rows play their exit leg first
    vi.useFakeTimers()
    try {
      act(() => { buttonOf(container, '收起').click() })
      expect(rows()).toBe(8)
      expect(container.querySelectorAll('[data-execution-fold="closing"]')).toHaveLength(1)
      act(() => { vi.advanceTimersByTime(OVERLAY_EXIT_MS + 1) })
      expect(rows()).toBe(5)
      expect(buttonOf(container, '显示全部 8 条').getAttribute('aria-expanded')).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('status moves behind one menu', () => {
  it('user moving a card opens one menu instead of five same-weight buttons and picks a column', () => {
    // Given a card in the to-do column
    const task = card()
    const { container, controller: board } = renderDetail(task)

    // When the panel renders
    const trigger = buttonOf(container, t('detail.moveTo'))

    // Then the five moves are no longer five buttons on the panel
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[role="menu"]')).toBeNull()

    // When the reader opens the menu
    act(() => { trigger.click() })

    // Then it lists exactly the manual columns
    const items = [...container.querySelectorAll('[role="menuitem"]')]
    expect(items.map(item => item.textContent)).toEqual(['移到待规划与积压', '移到待办', '移到进行中', '移到待输入', '移到待人工验收', '移到已完成', '移到已失败'])
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    // And picking one moves the card through the controller and closes the menu
    act(() => { buttonOf(container.querySelector('[role="menu"]') as HTMLElement, '移到已完成').click() })
    expect(board.moveTask).toHaveBeenCalledWith(task.id, 'done')
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('user pressing Escape closes the menu without closing the whole detail panel', () => {
    // Given an open move menu
    const { container, controller: board } = renderDetail(card())
    const trigger = buttonOf(container, t('detail.moveTo'))
    act(() => { trigger.click() })
    const item = container.querySelector('[role="menuitem"]') as HTMLButtonElement

    // When Escape is pressed from inside the menu
    pressKey(item, 'Escape')

    // Then the menu closes, focus returns to the trigger, and the panel's own
    // Escape handler never ran
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(board.closeTask).not.toHaveBeenCalled()
  })

  it('user pressing anywhere outside the menu closes it', () => {
    // Given an open move menu
    const { container } = renderDetail(card())
    const trigger = buttonOf(container, t('detail.moveTo'))
    act(() => { trigger.click() })
    expect(container.querySelectorAll('[role="menu"]')).toHaveLength(1)

    // When the reader presses outside it
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })

    // Then it closes
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('detail footer actions', () => {
  it('user sees edit and run actions in the footer', () => {
    // Given a card that has settled
    const { container } = renderDetail(card({ executions: [run('e1', 1_000)], status: 'done' }))

    // When the footer renders
    const footer = container.querySelector('footer')

    // Then the edit and run actions are the only footer buttons, in that order.
    expect([...footer!.querySelectorAll('button')].map(button => button.textContent?.trim())).toEqual(['编辑标签', '重新执行'])
  })

  it('user finding the secondary actions uses the header menu instead of extra footer buttons', () => {
    // Given a settled card that can still be duplicated and archived
    const task = card({ executions: [run('e1', 1_000)], status: 'done' })
    const { container, controller: board } = renderDetail(task)

    // When the header renders
    const trigger = buttonOf(container.querySelector('header') as HTMLElement, '更多操作')

    // Then duplicate, archive and delete are one press away.
    expect(container.querySelector('footer')!.textContent).not.toContain('归档')
    act(() => { trigger.click() })
    expect([...container.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['修改并新建副本', '归档', '删除'])

    // And archiving goes through the same controller call as before
    act(() => { buttonOf(container.querySelector('[role="menu"]') as HTMLElement, '归档').click() })
    expect(board.archiveTask).toHaveBeenCalledWith(task.id)
  })

  it('user can cancel or confirm deletion of an archived card from the header menu', () => {
    // Given an archived card, whose only header action is Delete.
    vi.useFakeTimers()
    const task = card({ archivedAt: 1_000 })
    const { container, controller: board } = renderDetail(task)
    const trigger = buttonOf(container.querySelector('header')!, t('detail.more'))

    // When the user selects Delete and cancels the confirmation.
    act(() => { trigger.click() })
    expect([...container.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual([t('detail.delete')])
    act(() => { buttonOf(container.querySelector('[role="menu"]')!, t('detail.delete')).click() })
    const confirmation = container.querySelector('[role="alertdialog"]')!
    expect(confirmation.textContent).toContain(t('delete.confirm', { name: task.title }))
    act(() => { buttonOf(confirmation, t('delete.cancel')).click() })
    act(() => { vi.advanceTimersByTime(OVERLAY_EXIT_MS + 1) })

    // Then cancellation leaves the card intact and returns focus to More Actions.
    expect(board.deleteTask).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)

    // When the user reopens the menu and confirms deletion, only that card is submitted.
    act(() => { trigger.click() })
    act(() => { buttonOf(container.querySelector('[role="menu"]')!, t('detail.delete')).click() })
    act(() => { buttonOf(container.querySelector('[role="alertdialog"]')!, t('delete.ok')).click() })
    expect(board.deleteTask).toHaveBeenCalledExactlyOnceWith(task.id)
  })
})

describe('folded execution column', () => {
  /** The execution column of the panel. */
  function rightColumn(container: HTMLElement): HTMLElement {
    const column = container.querySelector('[data-detail-column="execution"]')
    if (column === null) throw new Error('no execution column')
    return column as HTMLElement
  }

  /** The fold header whose title is one label. */
  function foldHeader(container: HTMLElement, title: string): HTMLButtonElement {
    const header = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
      .find(button => (button.textContent ?? '').startsWith(title))
    if (header === undefined) throw new Error('no folded region titled ' + title)
    return header
  }

  it('user opening a card sees no long explanation paragraph in the execution column', () => {
    // Given a card with two advanced switches already on
    const { container } = renderDetail(card({ reuseSession: true, goalRun: true }))

    // When the panel renders in its default state
    const right = rightColumn(container)

    // Then only the project selector is visible and the execution settings
    // summarize the inherited permission without displaying the long explanations
    expect(right.querySelectorAll('select')).toHaveLength(1)
    expect(foldHeader(right, t('detail.executionSettings')).textContent).toContain(t('exec.permission.default'))
    expect(right.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(right.textContent).not.toContain(t('exec.hint'))
    expect(right.textContent).not.toContain(t('exec.reuseSessionHint'))
    expect(right.textContent).not.toContain(t('exec.goalRunHint'))
    expect(right.textContent).not.toContain(t('exec.skipVerificationHint'))
  })

  it('user reading a closed fold sees which switches are on, in the short form the view allows', () => {
    // Given: every advanced switch on, on a card whose switches read in one line
    const { container } = renderDetail(card({ reuseSession: true, goalRun: true, skipVerification: true }))

    // When the closed region renders
    openFormSection(container, t('detail.executionSettings'))
    const summary = foldHeader(container, t('detail.settings.advanced')).textContent ?? ''

    // Then it echoes the switches that are on, and never one that is off
    expect(summary).toContain(t('detail.settings.summary.reuseSession'))
    expect(summary).toContain(t('detail.settings.summary.goal'))
    expect(summary).toContain(t('detail.settings.summary.skipVerification'))

    // And every short explanation the panel shows stays inside one meta line
    for (const key of ['exec.hint.short', 'exec.reuseSessionHint.short', 'exec.goalRunHint.short', 'exec.skipVerificationHint.short', 'exec.goalRunGlobalOff'] as const) {
      expect([...zh[key]].length).toBeLessThanOrEqual(30)
    }
  })

  it('user opening the advanced fold reaches the same three switches and they still save immediately', () => {
    // Given a card with nothing switched on
    const { container, controller: board } = renderDetail(card())

    // When the reader opens the advanced region
    openFormSection(container, t('detail.executionSettings'))
    const header = openFormSection(container, t('detail.settings.advanced'))

    // Then the three switches and their one-line explanations are there, and the
    // retired team-run option is not one of them
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(header.getAttribute('aria-controls') ?? '')?.id).toBe(header.getAttribute('aria-controls'))
    const boxes = [...rightColumn(container).querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes).toHaveLength(3)
    expect(container.textContent).toContain(t('exec.reuseSessionHint.short'))
    expect(container.textContent).toContain(t('exec.skipVerificationHint.short'))

    // And toggling one writes through the controller exactly as before
    act(() => { boxes[0]!.click() })
    expect(board.updateTask).toHaveBeenCalledWith('card-1', { reuseSession: true })
  })

  it('user reading the closed schedule fold sees whether it is armed and what it will do', () => {
    // Given an armed recurring rule with a future run
    const now = Date.now()
    const { container } = renderDetail(card({
      schedule: {
        enabled: true,
        mode: 'cron',
        cron: '0 9 * * *',
        nextRunAt: now + 60 * 60 * 1000,
        lastTriggeredAt: undefined,
        runCount: 2,
      },
    }))

    // When the panel renders in its default state
    const summary = foldHeader(container, t('detail.schedule')).textContent ?? ''

    // Then the row says it is armed and when it fires next, and the rule that
    // produced that instant is not on the row at all
    expect(summary).toContain('已启用')
    expect(summary).not.toContain('0 9 * * *')
    expect(container.querySelector('input[aria-label="' + t('detail.schedule.cron') + '"]')).toBeNull()

    // And the rule rides the row's tooltip instead, so hovering the row still
    // reads the whole line the folded summary had to drop
    const hint = foldHeader(container, t('detail.schedule')).getAttribute('title') ?? ''
    expect(hint).toContain(t('detail.schedule.summary.planCron', { cron: '0 9 * * *' }))
    expect(hint).toContain('已启用')

    // And a card without a rule says so in one line
    const { container: idle } = renderDetail(card())
    expect(foldHeader(idle, t('detail.schedule')).textContent).toContain(t('detail.schedule.summary.off'))
  })

  it('user finds execution settings and schedule together with full summaries', () => {
    // Given a new task detail with its default settings
    const { container } = renderDetail(card())
    const settings = foldHeader(container, t('detail.executionSettings'))
    const schedule = foldHeader(container, t('detail.schedule'))

    // When the panel paints the closed rows
    const group = schedule.parentElement?.parentElement

    // Then both rows share the settings column and each shows its full summary on hover
    expect(group).toBe(settings.parentElement?.parentElement)
    expect(group?.parentElement).toBe(rightColumn(container))
    expect(settings.title).toContain(t('exec.permission.default'))
    expect(schedule.title).toContain(t('detail.schedule.summary.off'))
  })

  it('user changing the workspace opens settings and lands on its selector', () => {
    // Given a task pinned to a work area
    const { container, controller: board } = renderDetail(card({ workspaceId: 'pinned' }))
    const settings = foldHeader(container, t('detail.executionSettings'))

    // When the user chooses Change from the workspace summary
    const change = container.querySelector<HTMLButtonElement>(`[aria-label="${t('detail.changeWorkspace')}"]`)!
    act(() => { change.click() })

    // Then the expanded selector is focused and changes go through the controller
    const workspace = document.activeElement as HTMLSelectElement
    expect(settings.getAttribute('aria-expanded')).toBe('true')
    expect(workspace.tagName).toBe('SELECT')
    expect(workspace.value).toBe('pinned')
    act(() => {
      workspace.value = ''
      workspace.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(board.updateTask).toHaveBeenCalledWith('card-1', { workspaceId: '' })
  })

  it('user opening the schedule fold gets the editor with every field it always had', () => {
    // Given an armed recurring rule
    const { container } = renderDetail(card({
      schedule: { enabled: true, mode: 'cron', cron: '0 9 * * *', nextRunAt: Date.now() + 60_000, lastTriggeredAt: undefined, runCount: 1, maxRuns: 2 },
    }))

    // When the reader opens the region
    openFormSection(container, t('detail.schedule'))

    // Then the cron field, the plan kind, the cap, the zone and the cancel
    // action are all reachable again
    expect((container.querySelector('input[aria-label="' + t('detail.schedule.cron') + '"]') as HTMLInputElement).value).toBe('0 9 * * *')
    const labels = [...container.querySelectorAll('select')].map(select => select.getAttribute('aria-label'))
    expect(labels).toContain(t('detail.schedule.mode'))
    expect(labels).toContain(t('detail.schedule.maxRuns'))
    expect(labels).toContain(t('detail.schedule.timeZone'))
    expect(buttonOf(container, t('detail.schedule.cancel')).textContent?.trim()).toBe(t('detail.schedule.cancel'))
    expect(container.textContent).toContain(t('detail.schedule.runs', { done: '1', total: '2' }))
  })

  it('user collapsing a fold from inside its body gets the focus back on the region row', () => {
    // Given an open advanced region with one of its switches focused
    const { container } = renderDetail(card())
    openFormSection(container, t('detail.executionSettings'))
    const header = openFormSection(container, t('detail.settings.advanced'))
    const box = rightColumn(container).querySelector('input[type="checkbox"]') as HTMLInputElement
    act(() => { box.focus() })
    expect(document.activeElement).toBe(box)

    // When the reader closes the region from its row
    act(() => { header.click() })

    // Then the focus is on the row that owns the folded body, not on the body
    expect(document.activeElement).toBe(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
  })

  it('user reading a run refused for pinning no workspace sees the fix, not the Host wording', () => {
    // Given a card whose latest run was refused because it pins no workspace
    const refused: ExecutionRecord = { ...run('e1', 1_000), result: 'failed', error: MISSING_WORKSPACE_REASON }
    const { container } = renderDetail(card({ executions: [refused] }))

    // When the reader opens the history region
    openDetailTab(container, t('detail.execution'))

    // Then the row states what to do in the reader's language, never the raw
    // Host text that the ledger stored
    const row = container.querySelector('[data-execution-id="e1"]')
    expect(row?.textContent).toContain(t('exec.error.noWorkspace'))
    expect(row?.textContent).not.toContain(MISSING_WORKSPACE_REASON)
  })

  it('user switches tabs with the keyboard and reads the full Prompt in task content', () => {
    // Given a card with a long Markdown prompt
    const prompt = Array.from({ length: 30 }, (_, index) => `Paragraph ${index}`).join('\n\n')
    const { container } = renderDetail(card({ prompt }))
    const visible = () => container.querySelector('[role="tabpanel"]:not([hidden])')
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(visible()?.textContent).toContain('Paragraph 29')

    // When the user advances to execution history and jumps to the last tab
    act(() => { tabs[0]!.focus() })
    pressKey(tabs[0]!, 'ArrowRight')
    expect(document.activeElement).toBe(tabs[1])
    expect(visible()?.textContent).toContain(t('detail.noExecution'))
    pressKey(tabs[1]!, 'End')

    // Then activity is the only visible panel and Home returns to content
    expect(document.activeElement).toBe(tabs[2])
    expect(visible()?.textContent).toContain(t('timeline.empty'))
    expect(visible()?.id).toBe(tabs[2]?.getAttribute('aria-controls'))
    expect(tabs.map(tab => tab.tabIndex)).toEqual([-1, -1, 0])
    pressKey(tabs[2]!, 'Home')
    expect(document.activeElement).toBe(tabs[0])
    expect(visible()?.textContent).toContain('Paragraph 29')
  })
})
