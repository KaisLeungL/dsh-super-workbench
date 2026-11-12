// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardController } from '../src/core/controller.ts'
import { InMemoryTaskStore } from '../src/core/store.ts'
import { createTask } from '../src/core/tasks.ts'
import type { TaskBoardClientFace, TaskBoardProviderView, TaskBoardProviderViewProps } from '../src/core/extension.ts'
import { TaskBoardClientService } from '../src/client/service.ts'
import { registerTaskBoardPanel, TaskBoardPanel } from '../src/client/native-panel.tsx'
import { t } from '../src/client/locales.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
const controllers: BoardController[] = []
const NOW = 1_700_000_000_000

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const controller of controllers.splice(0)) controller.dispose()
  document.body.replaceChildren()
  localStorage.clear()
  vi.restoreAllMocks()
})

function makeController(): BoardController {
  const store = new InMemoryTaskStore()
  store.save([createTask({ title: 'Native task', description: '', prompt: 'Work' }, NOW, 't1')])
  const controller = new BoardController({
    store, now: () => NOW,
    sessions: { current: () => undefined, open: () => {}, subscribe: () => () => {} },
  })
  controller.start()
  controllers.push(controller)
  return controller
}

function mount(service: TaskBoardClientService, controller = makeController()): HTMLElement {
  service.attach(controller)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(<TaskBoardPanel controller={controller} clientService={service} />))
  return container
}

function view(id: string, order?: number): TaskBoardProviderView {
  return { id, order, label: () => id, render: () => <p>{id} content</p> }
}

function tab(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent === label)
  if (!button) throw new Error(`Missing tab: ${label}`)
  return button
}

function click(button: HTMLElement): void { act(() => button.click()) }

describe('provider view registration', () => {
  it('provider registering before controller attach sees stable sorted views survive remount and stale disposal', () => {
    // Given contributions registered before the native board controller exists
    const service = new TaskBoardClientService()
    service.registerView(view('last', 20))
    const offOld = service.registerView(view('first', -1))
    const offCurrent = service.registerView({ ...view('first', -1), label: () => 'Replacement' })
    service.registerView(view('tie-a'))
    service.registerView(view('tie-b'))
    const before = service.getViews()

    // When an older registration disposes and the board controller remounts
    offOld()
    const controller = makeController()
    service.attach(controller)
    service.detach()
    service.attach(controller)

    // Then identity, replacement and deterministic ordering remain intact
    expect(service.getViews()).toBe(before)
    expect(service.getViews().map(entry => entry.id)).toEqual(['first', 'tie-a', 'tie-b', 'last'])
    expect(service.getViews()[0]!.label()).toBe('Replacement')
    offCurrent()
    offCurrent()
    expect(service.getViews().map(entry => entry.id)).toEqual(['tie-a', 'tie-b', 'last'])
    service.detach()
  })

  it('provider cannot replace the native board and failing UI subscribers do not block healthy subscribers', () => {
    // Given both a failing and a healthy registration subscriber
    const service = new TaskBoardClientService()
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {})
    const healthy = vi.fn()
    service.subscribeViews(() => { throw new Error('subscriber') })
    const unsubscribe = service.subscribeViews(healthy)

    // When a provider tries a reserved/invalid id or order, then registers and removes valid UI
    expect(() => service.registerView(view('board'))).toThrow(/invalid provider view id/)
    expect(() => service.registerView(view(' '))).toThrow(/invalid provider view id/)
    expect(() => service.registerView(view('invalid', NaN))).toThrow(/invalid provider view order/)
    const off = service.registerView(view('valid'))
    off()
    unsubscribe()
    service.registerBanner(() => null)

    // Then healthy subscribers saw the two committed changes and can withdraw
    expect(healthy).toHaveBeenCalledTimes(2)
    expect(failure).toHaveBeenCalled()
    expect(service.getViews()).toEqual([])
    expect(service.snapshot()).not.toHaveProperty('views')
    expect(service.snapshot()).not.toHaveProperty('banners')
  })

  it('an older API v1 provider face remains valid without the optional UI members', () => {
    // Given the original client capability shape
    const legacy: TaskBoardClientFace = {
      dispatch: async () => false, registerVisibility: () => () => {},
      subscribe: () => () => {}, snapshot: () => ({ enabled: true, tasks: [], extensions: {} }),
    }
    // When a provider probes additive UI capabilities
    // Then their absence is a supported older deployment
    expect(legacy.registerView).toBeUndefined()
    expect(legacy.registerBanner).toBeUndefined()
  })
})

describe('native panel provider navigation', () => {
  it('operator sees the original native header and no tabs until a provider contributes a view', () => {
    // Given a native panel with no view providers
    const service = new TaskBoardClientService()
    const container = mount(service)
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(container.querySelector('[data-dsh-taskboard-board] h2')?.textContent).toBe(t('board.title'))
    expect(container.textContent).toContain('Native task')

    // When a view registers live
    act(() => { service.registerView(view('alternate')) })

    // Then the switcher appears while the native board stays the default
    expect([...container.querySelectorAll('[role="tab"]')].map(node => node.textContent)).toEqual([t('board.tab'), 'alternate'])
    expect(tab(container, t('board.tab')).getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[data-dsh-taskboard-board] h2')?.textContent).toBe(t('board.title'))
    for (const node of container.querySelectorAll('[role="tab"]')) {
      expect(document.getElementById(node.getAttribute('aria-controls')!)).not.toBeNull()
    }
  })

  it('operator opens a native task through a provider and hidden dialogs release their keyboard handlers', () => {
    // Given a provider with navigation callbacks and the native board
    const service = new TaskBoardClientService()
    let navigation!: TaskBoardProviderViewProps
    service.registerView({ id: 'one', label: () => 'One', render: props => { navigation = props; return <p>Provider one</p> } })
    service.registerView(view('two'))
    const controller = makeController()
    const container = mount(service, controller)
    click(tab(container, 'One'))

    // When the provider navigates to an unknown id, then another registered view
    act(() => navigation.navigate('missing'))
    expect(tab(container, 'One').getAttribute('aria-selected')).toBe('true')
    act(() => navigation.navigate('two'))
    expect(tab(container, 'two').getAttribute('aria-selected')).toBe('true')

    // When its retained callback opens a native task
    act(() => navigation.openTask('t1'))

    // Then the board is selected and its existing controller opened the native detail
    expect(tab(container, t('board.tab')).getAttribute('aria-selected')).toBe('true')
    expect(controller.getSnapshot().selectedTaskId).toBe('t1')
    const headingId = container.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')
    expect(document.getElementById(headingId ?? '')?.textContent).toBe('Native task')

    // When a retained provider callback navigates away while the detail is open
    act(() => navigation.navigate('two'))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

    // Then no hidden board modal consumes Escape; the controller keeps its selection
    expect(controller.getSnapshot().selectedTaskId).toBe('t1')
    expect(tab(container, 'two').getAttribute('aria-selected')).toBe('true')
  })

  it('operator unloading the active view falls back to board and re-registering does not reopen it', () => {
    // Given an active provider view
    const service = new TaskBoardClientService()
    const off = service.registerView(view('alternate'))
    const container = mount(service)
    click(tab(container, 'alternate'))

    // When it unloads and later registers again
    act(() => off())
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(container.querySelector<HTMLElement>('[data-dsh-taskboard-board]')!.closest('[hidden]')).toBeNull()
    act(() => { service.registerView(view('alternate')) })

    // Then the native board remains selected
    expect(tab(container, t('board.tab')).getAttribute('aria-selected')).toBe('true')
    expect(tab(container, 'alternate').getAttribute('aria-selected')).toBe('false')
  })

  it('operator sees banners only on board and independent banner disposal preserves the remaining component state', () => {
    // Given two registrations of the same hook-using banner component
    const service = new TaskBoardClientService()
    const Banner = () => {
      const [value, setValue] = useState(0)
      return <button data-banner="" onClick={() => setValue(value + 1)}>Banner {value}</button>
    }
    const offFirst = service.registerBanner(Banner)
    const offSecond = service.registerBanner(Banner)
    const container = mount(service)
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    click(container.querySelectorAll<HTMLElement>('[data-banner]')[1]!)

    // When the first registration withdraws
    act(() => offFirst())
    expect(container.querySelectorAll('[data-banner]')).toHaveLength(1)
    expect(container.querySelector('[data-banner]')!.textContent).toBe('Banner 1')

    // When another view is selected, then the banner withdraws
    act(() => { service.registerView(view('alternate')) })
    click(tab(container, 'alternate'))
    expect(container.querySelector('[data-banner]')).toBeNull()
    click(tab(container, t('board.tab')))
    expect(container.querySelector('[data-banner]')).not.toBeNull()
    act(() => { offSecond(); offSecond() })

    // Then no banner wrapper remains and ordinary board content is still present
    expect(container.querySelector('[data-banner]')).toBeNull()
    expect(container.textContent).toContain('Native task')
  })

  it('operator can switch views with arrow keys and return to board through the provider navigation callback', () => {
    // Given two views and a focused board tab
    const service = new TaskBoardClientService()
    let navigation!: TaskBoardProviderViewProps
    service.registerView({ ...view('one'), render: props => { navigation = props; return <p>One content</p> } })
    service.registerView(view('two'))
    const container = mount(service)
    const boardTab = tab(container, t('board.tab'))
    boardTab.focus()

    // When the operator uses the tabs' keyboard navigation
    act(() => boardTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(document.activeElement).toBe(tab(container, 'one'))
    expect(tab(container, 'one').getAttribute('tabindex')).toBe('0')
    act(() => navigation.navigate('board'))

    // Then provider navigation selects board through the same path
    expect(boardTab.getAttribute('aria-selected')).toBe('true')
  })

  it('operator retains usable native navigation when a provider label, view or banner throws', () => {
    // Given broken provider contributions beside the native board
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const suppressExpected = (event: ErrorEvent): void => {
      if (event.error instanceof Error && ['banner', 'view'].includes(event.error.message)) event.preventDefault()
    }
    window.addEventListener('error', suppressExpected)
    try {
      const service = new TaskBoardClientService()
      service.registerBanner(() => { throw new Error('banner') })
      service.registerView({ id: 'broken', label: () => { throw new Error('label') }, render: () => { throw new Error('view') } })
      const container = mount(service)

      // When the broken view is selected
      click(tab(container, 'broken'))

      // Then the native navigation survives, and replacing the failed contribution recovers
      const back = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === t('board.backToBoard'))!
      click(back)
      expect(container.textContent).toContain('Native task')
      act(() => { service.registerView(view('broken')) })
      click(tab(container, 'broken'))
      expect(container.textContent).toContain('broken content')
    } finally {
      window.removeEventListener('error', suppressExpected)
    }
  })

  it('native slot registration injects the browser service without changing shell navigation or requiring it', () => {
    // Given the native slot seat and this package's browser service
    const service = new TaskBoardClientService()
    const controller = makeController()
    const options: Array<Record<string, unknown>> = []
    const context = {
      get: (name: string) => name === 'taskBoard' ? service : undefined,
      slots: { inject: (_key: string, callback: () => () => void) => callback(), register: (entry: Record<string, unknown>) => { options.push(entry); return () => {} } },
    }

    // When the board registers its usual main seat
    const dispose = registerTaskBoardPanel(context as never, controller)
    const main = options.find(entry => entry.name === 'main')!

    // Then its injected face includes the service and the stable main key
    expect((main.inject as () => unknown)()).toEqual({ controller, clientService: service })
    expect(main.key).toBe('task-board')
    dispose()
  })
})
