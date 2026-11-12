// @vitest-environment jsdom
/**
 * L2 semantic attributes of the board view (issue #506): the mounted board
 * container, the board root, every status column, and every task card opt
 * into the semantic-attrs/v1 enum (data-dsh-plugin / data-dsh-part) so skins
 * can target them without hash-class selectors.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskBoardPanel } from '../src/client/native-panel.tsx'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { TaskRecord } from '../src/core/tasks.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
  document.documentElement.removeAttribute('data-dsh-taskboard-active')
  globalThis.localStorage?.removeItem('dsh.taskBoard.compactColumns.v1')
})

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    title: 'Task A',
    description: '',
    prompt: 'do it',
    status: 'todo',
    createdAt: 0,
    updatedAt: Date.now(),
    executions: [],
    ...overrides,
  }
}

function fakeController(
  snapshot?: Partial<ControllerSnapshot>,
  overrides?: Partial<BoardController>,
): BoardController {
  const state: ControllerSnapshot = {
    tasks: [task()],
    boardOpen: false,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
    ...snapshot,
  }
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    closeBoard: () => {},
    toggleArchiveView: () => {},
    retryHostSync: async () => {},
    openTask: () => {},
    moveTask: () => {},
    ...overrides,
  } as unknown as BoardController
}

describe('TaskBoard L2 semantic attributes (#506)', () => {
  it('tags the board root, the status columns, and the task cards', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController()} />) })

    const board = container.querySelector('[data-dsh-taskboard-board]')
    expect(board).not.toBeNull()
    expect(board!.getAttribute('data-dsh-plugin')).toBe('task-board')

    const columns = container.querySelectorAll('section[data-status]')
    expect(columns.length).toBeGreaterThan(0)
    for (const column of columns) {
      expect(column.getAttribute('data-dsh-part')).toBe('column')
    }

    const card = container.querySelector('[data-dsh-part="card"]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Task A')
  })

  it('tags the archive column as a column too', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const controller = fakeController({
      archiveView: true,
      tasks: [task({ archivedAt: Date.now(), status: 'done' })],
    })
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const archive = container.querySelector('section[data-status="archived"]')
    expect(archive).not.toBeNull()
    expect(archive!.getAttribute('data-dsh-part')).toBe('column')
  })
})

describe('TaskBoard card drag-and-drop status changes (#1195)', () => {
  const openExecution = () => ({
    id: 'e-open', sessionId: undefined, startedAt: 0, endedAt: undefined, result: undefined, error: undefined,
  })

  it('operator sees cards draggable unless the runner is executing them or the board is pending', async () => {
    // Given a board holding a todo card, an executing card, a card parked in
    // the running column by hand, and a card awaiting a Host reply
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const controller = fakeController({
      tasks: [
        task({ id: 't-todo', status: 'todo', title: 'Todo card' }),
        task({ id: 't-executing', status: 'running', title: 'Executing card', executions: [openExecution()] }),
        task({ id: 't-parked', status: 'running', title: 'Parked card' }),
        task({ id: 't-pending', status: 'todo', title: 'Pending card' }),
      ],
      pendingTaskIds: ['t-pending'],
    })
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const cardOf = (title: string) => Array.from(
      container.querySelectorAll('article[data-dsh-part="card"]'),
    ).find(card => card.textContent?.includes(title))

    // Then only the executing and the pending card refuse the drag
    expect(cardOf('Todo card')?.getAttribute('draggable')).toBe('true')
    expect(cardOf('Parked card')?.getAttribute('draggable')).toBe('true')
    expect(cardOf('Executing card')?.getAttribute('draggable')).toBe('false')
    expect(cardOf('Pending card')?.getAttribute('draggable')).toBe('false')
  })

  it.each([
    ['backlog', 'todo', 'now'],
    ['todo', 'backlog', 'clear'],
  ] as const)('operator drops a card from %s to %s and updates its plan', async (from, to, planning) => {
    // Given a card in the source column
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const moveCalls: Array<Parameters<BoardController['moveTask']>> = []
    const controller = fakeController(
      {
        tasks: [task({ id: 't-plan', status: from, title: 'Task Plan' })],
      },
      {
        moveTask: (...args) => { moveCalls.push(args) },
      },
    )
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const targetColumn = container.querySelector(`section[data-status="${to}"]`)
    expect(targetColumn).not.toBeNull()

    // When the card is dropped in the destination column
    const dataTransfer = {
      data: { 'text/plain': 't-plan' } as Record<string, string>,
      setData(type: string, val: string) { this.data[type] = val },
      getData(type: string) { return this.data[type] ?? '' },
      dropEffect: 'none',
    }

    await act(async () => {
      targetColumn!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }),
      )
    })

    // Then the move asks the Host to assign or clear the target time.
    expect(moveCalls).toEqual([['t-plan', to, planning]])
  })

  it('operator cannot drop a card on its own column or drop an executing card', async () => {
    // Given a board holding a todo card and a card the runner is executing
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const moveCalls: Array<{ id: string; status: string }> = []
    const controller = fakeController(
      {
        tasks: [
          task({ id: 't-todo', status: 'todo' }),
          task({ id: 't-running', status: 'running', executions: [openExecution()] }),
        ],
      },
      {
        moveTask: (id, status) => { moveCalls.push({ id, status }) },
      },
    )
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const todoColumn = container.querySelector('section[data-status="todo"]')

    // Dropping on the same column does nothing
    const sameColTransfer = {
      getData: (type: string) => (type === 'text/plain' ? 't-todo' : ''),
    }
    await act(async () => {
      todoColumn!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: sameColTransfer }),
      )
    })
    expect(moveCalls).toHaveLength(0)

    // Dropping a card the runner is executing does nothing
    const runningTransfer = {
      getData: (type: string) => (type === 'text/plain' ? 't-running' : ''),
    }
    await act(async () => {
      todoColumn!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: runningTransfer }),
      )
    })
    expect(moveCalls).toHaveLength(0)
  })

  it('operator drops a todo card onto the done column and the board dispatches the move', async () => {
    // Given a board holding a todo card
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const moveCalls: Array<{ id: string; status: string }> = []
    const controller = fakeController(
      {
        tasks: [task({ id: 't-todo', status: 'todo', title: 'Task Todo' })],
      },
      {
        moveTask: (id, status) => { moveCalls.push({ id, status }) },
      },
    )
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const doneColumn = container.querySelector('section[data-status="done"]')
    expect(doneColumn).not.toBeNull()

    // When the operator drops the card on the Done column
    const dataTransfer = {
      getData: (type: string) => (type === 'text/plain' ? 't-todo' : ''),
    }
    await act(async () => {
      doneColumn!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }),
      )
    })

    // Then the board asks the controller for the done column
    expect(moveCalls).toEqual([{ id: 't-todo', status: 'done' }])
  })

  it('operator drops a todo card onto the running column and the board dispatches the move', async () => {
    // Given a board holding a todo card
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const moveCalls: Array<{ id: string; status: string }> = []
    const controller = fakeController(
      { tasks: [task({ id: 't-todo', status: 'todo', title: 'Task Todo' })] },
      { moveTask: (id, status) => { moveCalls.push({ id, status }) } },
    )
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const runningColumn = container.querySelector('section[data-status="running"]')

    // When the operator parks the card in the running column by hand
    const dataTransfer = {
      getData: (type: string) => (type === 'text/plain' ? 't-todo' : ''),
    }
    await act(async () => {
      runningColumn!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }),
      )
    })

    // Then the board dispatches the manual move without opening a run
    expect(moveCalls).toEqual([{ id: 't-todo', status: 'running' }])
  })
})

describe('TaskBoard panel page lifecycle & interaction (#506, #1233)', () => {
  it('tags the panel page container with the L2 semantic anchor and plugin id', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    // The layout mounts this component as the keyed 'main' page; it carries the
    // container-query context the board's responsive rules read, so the board
    // lays out against the center column instead of the viewport.
    await act(async () => { root.render(<TaskBoardPanel controller={fakeController()} />) })

    const view = container.querySelector('[data-dsh-taskboard-view]')
    expect(view).not.toBeNull()
    expect(view!.getAttribute('data-dsh-plugin')).toBe('task-board')
    expect(view!.querySelector('[data-dsh-taskboard-board]')).not.toBeNull()
  })

  it('operator sees the board title and new-task action in the header', async () => {
    // Given the native board view
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    // When it renders, then the title leads the header and creation is its only button
    await act(async () => { root.render(<TaskBoard controller={fakeController()} />) })
    const header = container.querySelector('[data-dsh-taskboard-board] > header')!
    expect(header.firstElementChild?.textContent).toBe('任务看板')
    expect([...header.querySelectorAll('button')].map(button => button.textContent)).toEqual(['新建任务'])
  })
})

describe('TaskBoard settled-column density and recency groups', () => {
  const settledRun = (endedAt: number) => ({ id: 'e-' + String(endedAt), sessionId: 's', startedAt: endedAt - 1, endedAt, result: 'succeeded' as const, error: undefined })

  it('operator reads full recent completion records and can compact the expanded history', async () => {
    // Given 31 done cards: one settled now and thirty settled a month ago, and no saved density
    globalThis.localStorage?.removeItem('dsh.taskBoard.compactColumns.v1')
    const now = Date.now()
    const old = now - 30 * 24 * 60 * 60 * 1000
    const tasks = [
      task({ id: 'fresh', title: 'Fresh card', status: 'done', executions: [settledRun(now)] }),
      ...Array.from({ length: 30 }, (_, index) => task({ id: 'old-' + String(index), title: 'Old card ' + String(index), status: 'done', executions: [settledRun(old - index)] })),
    ]
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController({ tasks })} />) })
    const done = container.querySelector('section[data-status="done"]')!
    const cards = () => [...done.querySelectorAll('article[data-dsh-part="card"]')]

    // When the board renders
    // Then the done column shows the full recent card and folds the earlier group
    expect(cards().map(card => card.getAttribute('data-compact'))).toEqual([null])
    expect(cards()[0]?.querySelector('[data-dsh-part="card-session"]')?.textContent).toBe('会话记录')
    expect([...done.querySelectorAll('[data-dsh-part="card-group"][data-group]')].map(group => group.getAttribute('data-group'))).toEqual(['today', 'earlier'])
    const toggle = done.querySelector<HTMLButtonElement>('[data-group="earlier"] [data-dsh-part="card-group-toggle"]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    // When the operator expands the folded group and switches the column to compact cards
    await act(async () => { toggle.click() })
    await act(async () => { done.querySelector<HTMLButtonElement>('[data-dsh-part="density-toggle"]')!.click() })

    // Then every card renders compact and the choice is stored
    expect(cards()).toHaveLength(31)
    expect(cards().every(card => card.getAttribute('data-compact') === 'true')).toBe(true)
    expect(globalThis.localStorage?.getItem('dsh.taskBoard.compactColumns.v1')).toBe('["done"]')
  })
})

describe('TaskBoard main columns and card reading order', () => {
  it('operator can expand the optional empty columns and sees them appear when a task arrives', async () => {
    // Given an empty board and a host subscription
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    let snapshot = fakeController({ tasks: [] }).getSnapshot()
    let notify = () => {}
    const controller = fakeController(undefined, {
      getSnapshot: () => snapshot,
      subscribe: listener => { notify = listener; return () => {} },
    })
    await act(async () => { root.render(<TaskBoard controller={controller} />) })
    const columns = () => [...container.querySelectorAll('section[data-status]')].map(column => column.getAttribute('data-status'))
    const toggle = () => [...container.querySelectorAll('button')].find(button => button.textContent?.includes('空列'))!
    expect(columns()).toEqual(['backlog', 'todo', 'running', 'done'])
    expect(toggle().textContent).toBe('展开空列 (2)')

    // When the operator expands and collapses the empty columns
    await act(async () => { toggle().click() })
    expect(columns()).toEqual(['backlog', 'todo', 'running', 'needs_input', 'review', 'done'])
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    await act(async () => { toggle().click() })
    expect(columns()).toEqual(['backlog', 'todo', 'running', 'done'])

    // Then an incoming review card reveals its own column while input stays collapsed
    await act(async () => {
      snapshot = { ...snapshot, tasks: [task({ status: 'review', title: 'Review the release' })] }
      notify()
    })
    expect(columns()).toEqual(['backlog', 'todo', 'running', 'review', 'done'])
    expect(container.querySelector('section[data-status="review"] [data-dsh-part="card-title"]')?.textContent).toBe('Review the release')
    expect(toggle().textContent).toBe('展开空列 (1)')
  })

  it('operator reads the title, tags, excerpt, project and time in order', async () => {
    // Given an idle task with a title, label and description
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const controller = fakeController({
      tasks: [
        task({ id: 't-todo', status: 'todo', title: 'Todo card', tags: [{ name: 'release' }], description: 'Release summary' }),
      ],
    })
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    // When the board renders, then the key elements follow the reading order
    const parts = ['card-title', 'tag-badge', 'card-excerpt', 'project-badge', 'card-time']
    const content = [...container.querySelectorAll(`article :is(${parts.map(part => `[data-dsh-part="${part}"]`).join(',')})`)]
    expect(content.map(node => node.getAttribute('data-dsh-part'))).toEqual(parts)
  })

  it('operator finds one density switch in every board column header, and none in the archive header', async () => {
    // Given the board view
    const board = document.createElement('div')
    document.body.appendChild(board)
    const boardRoot = createRoot(board)
    roots.push(boardRoot)
    await act(async () => { boardRoot.render(<TaskBoard controller={fakeController()} />) })

    // When each column header paints
    // Then every board column offers exactly one density switch
    const boardColumns = [...board.querySelectorAll('section[data-status]')]
    expect(boardColumns.length).toBeGreaterThan(0)
    for (const column of boardColumns) {
      const header = column.querySelector('header')!
      // The header is the column's own: the count it paints is the number of
      // cards the column just rendered, so the switch sits on that column
      expect(header.querySelector('h3 + span')?.textContent).toBe(String(column.querySelectorAll('article[data-dsh-part="card"]').length))
      expect(header.querySelectorAll('button[data-dsh-part="density-toggle"]')).toHaveLength(1)
    }

    // And the archive column keeps its header without a density switch, so the
    // header height is the only thing the two views have to agree on
    const archive = document.createElement('div')
    document.body.appendChild(archive)
    const archiveRoot = createRoot(archive)
    roots.push(archiveRoot)
    await act(async () => {
      archiveRoot.render(<TaskBoard controller={fakeController({
        archiveView: true,
        tasks: [task({ archivedAt: Date.now(), status: 'done' })],
      })} />)
    })
    const archiveColumn = archive.querySelector('section[data-status="archived"]')!
    // The archive keeps the column header shape and counts its one card, while
    // the density switch stays out of it
    expect(archiveColumn.querySelector('header h3 + span')?.textContent).toBe('1')
    expect(archiveColumn.querySelectorAll('button[data-dsh-part="density-toggle"]')).toHaveLength(0)
  })
})
