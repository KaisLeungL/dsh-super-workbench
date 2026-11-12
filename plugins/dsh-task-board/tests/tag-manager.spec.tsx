// @vitest-environment jsdom
/**
 * The label manager as an operator uses it: the labels in use with their usage
 * counts, the ledger-wide rename it dispatches, and the confirmation a delete
 * has to pass through before anything is rewritten.
 */
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TagManagerModal, tagUsage } from '../src/client/board/TagManagerModal.tsx'
import { t } from '../src/client/locales.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
const NOW = 1_700_000_000_000

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
})

/** One task carrying the given labels. */
function task(id: string, tags?: TaskRecord['tags']): TaskRecord {
  return { ...createTask({ title: id, description: '', prompt: id }, NOW, id), ...(tags === undefined ? {} : { tags }) }
}

/** One task in a finished column carrying the given labels. */
function settled(id: string, status: 'done' | 'failed', tags?: TaskRecord['tags']): TaskRecord {
  return { ...task(id, tags), status }
}

/** Controller double recording every ledger-wide label edit it is asked for. */
function fakeController(tasks: TaskRecord[]) {
  const calls: string[] = []
  const controller = {
    getSnapshot: () => ({ tasks, pendingTaskIds: [], transportError: undefined } as unknown as ControllerSnapshot),
    renameTag: async (from: string, to: string) => { calls.push('rename ' + from + '->' + to); return true },
    deleteTag: async (name: string) => { calls.push('delete ' + name); return true },
  } as unknown as BoardController
  return { controller, calls }
}

/** Mount one element into a fresh container attached to the document. */
function render(element: ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(element) })
  return container
}

/** Click one button by its visible label. */
function click(container: HTMLElement, label: string): void {
  const found = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label)
  if (found === undefined) throw new Error('no button labelled ' + label)
  act(() => { found.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** Type into a React-controlled input (the native setter defeats React's value tracker). */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('label manager', () => {
  it('user opening the label manager sees each label with the number of tasks carrying it', () => {
    // Given a board where one label is on two cards and another on one
    const { controller } = fakeController([
      task('a', [{ name: 'ship' }, { name: 'keep' }]),
      task('b', [{ name: 'ship' }]),
      task('c'),
    ])

    // When the manager opens
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)

    // Then every label in use is listed with its usage count
    const rows = [...container.querySelectorAll('li')].map(row => row.textContent ?? '')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('ship')
    expect(rows[0]).toContain(t('tags.usage', { count: '2' }))
    expect(rows[1]).toContain('keep')
    expect(rows[1]).toContain(t('tags.usage', { count: '1' }))
  })

  it('user renaming a label from its row dispatches one ledger-wide rename', async () => {
    // Given a label carried by one card
    const { controller, calls } = fakeController([task('a', [{ name: 'ship' }]), task('b', [{ name: 'ship' }])])
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)

    // When the user opens the row editor, types a new name and saves it
    click(container, t('tags.rename'))
    const input = container.querySelector('li input') as HTMLInputElement
    typeInto(input, 'release')
    await act(async () => {
      const save = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === t('tags.save'))
      save?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Then the controller was asked once for the ledger-wide rename
    expect(calls).toEqual(['rename ship->release'])
  })

  it('user deleting a label is asked first, and the question names the usage count', () => {
    // Given a label carried by two cards
    const { controller, calls } = fakeController([task('a', [{ name: 'ship' }]), task('b', [{ name: 'ship' }])])
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)

    // When the user asks to delete it
    click(container, t('tags.delete'))

    // Then nothing was written yet and the confirmation names the label and its usage
    expect(calls).toEqual([])
    const question = document.querySelector('[role="alertdialog"]')
    expect(question?.textContent).toContain('ship')
    expect(question?.textContent).toContain(t('tags.deleteConfirm', { name: 'ship', count: '2' }))
  })

  it('user confirming the delete rewrites the label off every card', async () => {
    // Given a label carried by two cards
    const { controller, calls } = fakeController([task('a', [{ name: 'ship' }]), task('b', [{ name: 'ship' }])])
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)
    click(container, t('tags.delete'))

    // When the user confirms in the dialog
    await act(async () => {
      const dialog = document.querySelector('[role="alertdialog"]')
      const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(candidate => candidate.textContent === t('tags.deleteOk'))
      confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Then the controller was asked to remove it once
    expect(calls).toEqual(['delete ship'])
  })

  it('operator reading the usage of a label counts every card that carries it', () => {
    // Given an archived card and an on-board card sharing a label, plus one without it
    const tasks = [
      task('a', [{ name: 'ship' }]),
      { ...task('b', [{ name: 'ship' }]), archivedAt: NOW - 1 },
      task('c', [{ name: 'other' }]),
    ]

    // When the manager reads the usage counts
    const usage = tagUsage(tasks)

    // Then both cards count towards the shared label and the unrelated one is separate
    expect(usage).toEqual([{ name: 'ship', count: 2 }, { name: 'other', count: 1 }])
  })

  it('user with an empty board sees the manager explain that no label is in use', () => {
    // Given a board with no labels at all
    const { controller } = fakeController([task('a')])

    // When the manager opens
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)

    // Then it says so instead of rendering an empty list
    expect(container.textContent).toContain(t('tags.empty'))
    expect(container.querySelectorAll('li')).toHaveLength(0)
  })

  it('user pressing Escape while renaming cancels the edit instead of closing the manager', () => {
    // Given an open manager with a row editor open
    const { controller } = fakeController([task('a', [{ name: 'ship' }])])
    const onClose = vi.fn()
    const container = render(<TagManagerModal controller={controller} onClose={onClose} />)
    click(container, t('tags.rename'))
    expect(container.querySelectorAll('li input')).toHaveLength(1)

    // When Escape is pressed
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })

    // Then the editor is gone, the manager is still open and nothing was closed
    expect(container.querySelectorAll('li input')).toHaveLength(0)
    expect(container.textContent).toContain(t('tags.title'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('user closing the manager asks the board to close it', () => {
    // Given an open manager and a close recorder
    const { controller } = fakeController([task('a', [{ name: 'ship' }])])
    const onClose = vi.fn()
    const container = render(<TagManagerModal controller={controller} onClose={onClose} />)

    // When the user closes it from the footer
    click(container, t('tags.done'))

    // Then the board was asked to close the surface
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('label manager action hierarchy', () => {
  it('user renaming one label sees one filled action, and it is that row commit', () => {
    // Given two cards carrying one label
    const { controller } = fakeController([task('a', [{ name: 'ship' }]), task('b', [{ name: 'ship' }])])
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)

    // When the user opens the row editor
    click(container, t('tags.rename'))
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
    const save = buttons.find(button => button.textContent === t('tags.save'))
    // The row commit is an operable plain button, never the dialog's form submit
    expect(save?.disabled).toBe(false)
    expect(save?.getAttribute('type')).toBe('button')
    expect(save?.closest('li')?.querySelector('input')?.value).toBe('ship')
    const saveClass = save?.className ?? ''

    // Then the row commit is the only filled control in the dialog, because
    // only one row can be in its edit state at a time
    expect(buttons.filter(button => button.className === saveClass)).toEqual([save])

    // And the row's dismiss and the dialog's Done stay secondary
    for (const label of [t('new.cancel'), t('tags.done')]) {
      expect(buttons.find(button => button.textContent === label)?.className).not.toBe(saveClass)
    }
  })

  it('user confirming a label delete sees a destructive control apart from the dismiss', () => {
    // Given a label the user asked to delete
    const { controller } = fakeController([task('a', [{ name: 'ship' }])])
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)
    click(container, t('tags.delete'))

    // When the confirmation opens
    const question = document.querySelector('[role="alertdialog"]')
    const buttons = [...(question?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const confirm = buttons.find(button => button.textContent === t('tags.deleteOk'))
    const cancel = buttons.find(button => button.textContent === t('delete.cancel'))

    // Then the destructive commit wears its own role and the dismiss beside it
    // is a secondary control
    // The footer offers exactly the dismiss and then the destructive commit
    expect(buttons.map(button => button.textContent)).toEqual([t('delete.cancel'), t('tags.deleteOk')])
    expect(confirm?.className).not.toBe(cancel?.className)
  })
})

describe('label manager cleanup', () => {
  it('user opening the label manager sees the clear control on a threshold of 5', () => {
    // Given a board where one label is in use
    const { controller } = fakeController([task('a', [{ name: 'ship' }])])

    // When the manager opens
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)

    // Then the rule lives on the corner question mark, not as body prose, and the
    // clear control starts at five tasks
    expect(container.textContent).toContain(t('tags.cleanupHint'))
    expect(container.textContent).toContain(t('tags.hint'))
    expect(container.textContent).toContain(t('tags.cleanupThreshold'))
    const field = container.querySelector('input[type="number"]') as HTMLInputElement
    expect(field.value).toBe('5')
    expect(field.min).toBe('1')
    expect(field.max).toBe('99')
    expect(field.step).toBe('1')
    expect(field.getAttribute('inputmode')).toBe('numeric')
    expect(field.getAttribute('aria-label')).toBe(t('tags.cleanupThreshold'))

    // And one commit offers to run it
    expect([...container.querySelectorAll('button')].some(button => button.textContent === t('tags.cleanup'))).toBe(true)

    // And the rule rides on a question mark instead of a paragraph. The bubble is a
    // real element, not a native title: Electron does not paint the title, and this
    // is also the description assistive technology reads.
    const rule = t('tags.hint') + '\n\n' + t('tags.cleanupHint')
    const help = [...container.querySelectorAll('button')]
      .find(button => button.getAttribute('aria-label') === t('tags.help'))
    if (help === undefined) throw new Error('the tags help control did not render')
    expect(help.textContent).toBe('?')
    // No native title: the bubble below is the only carrier.
    expect(help!.getAttribute('title')).toBeNull()
    const describedBy = help.getAttribute('aria-describedby')
    if (describedBy === null) throw new Error('the tags help control names no description')
    const described = [...container.querySelectorAll('[id]')].find(node => node.id === describedBy)
    expect(described?.textContent).toBe(rule)
    expect(described?.getAttribute('role')).toBe('tooltip')
    // And neither sentence is painted in the body any more: the copy stays in the
    // DOM only as the question mark's visually hidden description, so no rendered
    // paragraph carries it.
    const paintedParagraphs = [...container.querySelectorAll('p')].map(node => node.textContent ?? '')
    expect(paintedParagraphs.some(text => text.includes('标签是顶栏筛选'))).toBe(false)
    expect(paintedParagraphs.some(text => text.includes('任务数少于阈值'))).toBe(false)

    // And the clear control lives in the card's header — the corner — rather than
    // trailing the label list it does not belong to.
    const header = container.querySelector('header')
    if (header === null) throw new Error('the tags card paints no header')
    expect(header.contains(help)).toBe(true)
    const commit = [...container.querySelectorAll('button')]
      .find(button => button.textContent === t('tags.cleanup'))
    expect(header!.contains(commit!)).toBe(true)
  })

  it('user typing a threshold the field would refuse judges at the field ceiling, not the raw number', () => {
    // Given one label carried by 99 finished cards and another carried by three
    const tasks = [
      ...Array.from({ length: 99 }, (_, index) => settled('bulk-' + index, 'done', [{ name: 'bulk' }])),
      settled('small-a', 'failed', [{ name: 'small' }]),
      settled('small-b', 'done', [{ name: 'small' }]),
      settled('small-c', 'done', [{ name: 'small' }]),
    ]
    const { controller, calls } = fakeController(tasks)
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)

    // When the user types a threshold past the field ceiling and presses clear
    const field = container.querySelector('input[type="number"]') as HTMLInputElement
    typeInto(field, '5000')
    click(container, t('tags.cleanup'))

    // Then the judgement used the ceiling, so the 99-card label stays and only
    // the three-card label is offered — nothing was deleted on the way
    expect(calls).toEqual([])
    const question = document.querySelector('[role="alertdialog"]')
    expect(question?.textContent).toContain('small (3)')
    expect(question?.textContent).not.toContain('bulk (99)')
  })
  it('user pressing clear with nothing to clear is told so and nothing is deleted', () => {
    // Given a label that only unfinished work still carries
    const { controller, calls } = fakeController([task('a', [{ name: 'ship' }])])
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)

    // When the user presses clear
    click(container, t('tags.cleanup'))

    // Then nothing was asked for, no confirmation opened, and the manager says why
    expect(calls).toEqual([])
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(container.textContent).toContain(t('tags.cleanupEmpty'))
  })

  it('user clearing matching labels confirms first, then deletes each judged label once', async () => {
    // Given two labels carried only by finished cards
    const { controller, calls } = fakeController([
      settled('a', 'done', [{ name: 'ship' }, { name: 'keep' }]),
      settled('b', 'failed', [{ name: 'ship' }]),
    ])
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)

    // When the user presses clear
    click(container, t('tags.cleanup'))

    // Then nothing was written yet, and the question names both labels with their sizes
    expect(calls).toEqual([])
    const question = document.querySelector('[role="alertdialog"]')
    expect(question?.textContent).toContain('ship (2)')
    expect(question?.textContent).toContain('keep (1)')

    // And confirming writes one ledger edit per label, in listing order
    await act(async () => {
      const confirm = [...(question?.querySelectorAll('button') ?? [])].find(candidate => candidate.textContent === t('tags.cleanupOk'))
      confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(calls).toEqual(['delete ship', 'delete keep'])
  })

  it('user cancelling the clear confirmation deletes nothing', () => {
    // Given two labels the threshold would clear
    const { controller, calls } = fakeController([
      settled('a', 'done', [{ name: 'ship' }, { name: 'keep' }]),
      settled('b', 'failed', [{ name: 'ship' }]),
    ])
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)
    click(container, t('tags.cleanup'))

    // When the user cancels the question
    const question = document.querySelector('[role="alertdialog"]')
    act(() => {
      const cancel = [...(question?.querySelectorAll('button') ?? [])].find(candidate => candidate.textContent === t('delete.cancel'))
      cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Then no ledger edit was asked for
    expect(calls).toEqual([])
  })

  it('user whose clear was partly refused sees how many labels stayed', async () => {
    // Given a board whose second label delete is refused by the authority
    const calls: string[] = []
    const tasks = [
      settled('a', 'done', [{ name: 'ship' }, { name: 'keep' }]),
      settled('b', 'failed', [{ name: 'ship' }]),
    ]
    const controller = {
      getSnapshot: () => ({ tasks, pendingTaskIds: [], transportError: undefined } as unknown as ControllerSnapshot),
      deleteTag: async (name: string) => { calls.push('delete ' + name); return name !== 'keep' },
      renameTag: async () => true,
    } as unknown as BoardController
    const container = render(<TagManagerModal controller={controller} onClose={() => {}} />)
    click(container, t('tags.cleanup'))

    // When the user confirms and one of the two edits is refused
    const question = document.querySelector('[role="alertdialog"]')
    await act(async () => {
      const confirm = [...(question?.querySelectorAll('button') ?? [])].find(candidate => candidate.textContent === t('tags.cleanupOk'))
      confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Then both were attempted and the manager reports the stayed label count
    expect(calls).toEqual(['delete ship', 'delete keep'])
    expect(container.textContent).toContain(t('tags.cleanupFailed', { count: '1' }))
  })
})
