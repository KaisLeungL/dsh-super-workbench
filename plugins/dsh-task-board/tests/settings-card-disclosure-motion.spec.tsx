// @vitest-environment jsdom
/**
 * Motion lifecycle of a card body: opening mounts the body before the motion
 * ends, closing keeps it mounted until the motion has run out, and reopening
 * mid-close cancels that unmount. Only the lifecycle is asserted here, never
 * the transition itself.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginSettingsCard } from '../src/client/PluginSettingsCard.tsx'
import { zh } from '../src/client/locales.ts'
import {
  SHELL_BODY_MARKER,
  headers,
  mount,
  setupCardEnvironment,
  shellProps,
  teardownCardEnvironment,
} from './settings-card-harness.tsx'

/** The card's body disclosure motion; the spec advances timers by exactly this. */
const BODY_MOTION_MS = 180

/** What the card body holds while it is mounted, or null while none is. */
const BODY_COPY = zh['settings.enabledHintBrief']

beforeEach(() => {
  setupCardEnvironment()
  vi.useFakeTimers()
})

afterEach(() => {
  teardownCardEnvironment()
  vi.useRealTimers()
})

/** The copy the mounted card body holds, or null while the card renders no body. */
function bodyCopy(container: HTMLElement): string | null {
  return container.querySelector(`[data-testid="${SHELL_BODY_MARKER}"]`)?.textContent ?? null
}

/** The phase the body's disclosure region reports, or null while none is mounted. */
function regionPhase(container: HTMLElement): string | null {
  return container.querySelector('[data-state]')?.getAttribute('data-state') ?? null
}

/** Click the card's one disclosure header. */
function toggle(container: HTMLElement): void {
  const button = headers(container)[0]
  if (button === undefined) throw new Error('the card rendered no disclosure header')
  act(() => { button.click() })
}

/** Let the clock reach the end of one body motion, as the browser would. */
function advanceMotion(): void {
  act(() => { vi.advanceTimersByTime(BODY_MOTION_MS) })
}

describe('plugin settings card body motion', () => {
  it('operator opening a collapsed card sees the body mounted before the motion ends and settled after it', () => {
    // Given a card that starts collapsed, so it renders no body at all
    const container = mount(<PluginSettingsCard {...shellProps()} />)
    expect(bodyCopy(container)).toBeNull()

    // When the operator opens it
    toggle(container)

    // Then the body is in the document already, still moving through its enter
    // leg, and it settles exactly when the motion runs out
    expect(bodyCopy(container)).toBe(BODY_COPY)
    expect(regionPhase(container)).toBe('entering')
    act(() => { vi.advanceTimersByTime(BODY_MOTION_MS - 1) })
    expect(regionPhase(container)).toBe('entering')
    act(() => { vi.advanceTimersByTime(1) })
    expect(regionPhase(container)).toBe('shown')
    expect(bodyCopy(container)).toBe(BODY_COPY)
  })

  it('operator closing an open card sees the body stay mounted until the motion runs out', () => {
    // Given a card whose body is open and settled
    const container = mount(<PluginSettingsCard {...shellProps({ defaultOpen: true })} />)
    expect(bodyCopy(container)).toBe(BODY_COPY)
    expect(regionPhase(container)).toBe('shown')

    // When the operator closes it
    toggle(container)

    // Then the body keeps its place in the document through the closing leg,
    // and only the end of the motion takes it out
    expect(regionPhase(container)).toBe('closing')
    expect(bodyCopy(container)).toBe(BODY_COPY)
    act(() => { vi.advanceTimersByTime(BODY_MOTION_MS - 1) })
    expect(bodyCopy(container)).toBe(BODY_COPY)
    act(() => { vi.advanceTimersByTime(1) })
    expect(bodyCopy(container)).toBeNull()
    expect(regionPhase(container)).toBeNull()
  })

  it('operator reopening a closing card sees the body stay mounted past the first unmount deadline', () => {
    // Given a card whose body is open and settled
    const container = mount(<PluginSettingsCard {...shellProps({ defaultOpen: true })} />)

    // When the operator closes it, reopens halfway through, and the clock passes
    // the moment the first close would have finished on
    toggle(container)
    act(() => { vi.advanceTimersByTime(BODY_MOTION_MS / 2) })
    expect(regionPhase(container)).toBe('closing')
    toggle(container)
    advanceMotion()

    // Then the body never left the document: the reopen cancelled the pending
    // unmount and ran a fresh enter leg to its settled state
    expect(bodyCopy(container)).toBe(BODY_COPY)
    expect(regionPhase(container)).toBe('shown')

    // ...and no leftover timer takes it out afterwards
    advanceMotion()
    expect(bodyCopy(container)).toBe(BODY_COPY)
  })
})
