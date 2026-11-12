// @vitest-environment jsdom
/**
 * The card's power block as an operator reads it: the live host facts are four
 * label/value rows of one description list, fed by the host's event frames, and
 * the battery caveat stays a paragraph of its own instead of running into them.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TaskBoardPowerSnapshot } from '../src/protocol.ts'
import { zh } from '../src/client/locales.ts'
import {
  cardProps,
  deliverFrame,
  header,
  render,
  setupCardEnvironment,
  teardownCardEnvironment,
} from './settings-card-harness.tsx'

beforeEach(setupCardEnvironment)
afterEach(teardownCardEnvironment)

/** The power facts list, read as label/value rows in document order. */
function powerRows(container: HTMLElement): Array<[string, string]> {
  const list = container.querySelector('dl')
  if (list === null) throw new Error('the power facts list did not render')
  const terms = [...list.querySelectorAll('dt')].map(node => node.textContent ?? '')
  const values = [...list.querySelectorAll('dd')].map(node => node.textContent ?? '')
  return terms.map((term, index) => [term, values[index] ?? ''])
}

/** One host frame carrying a power snapshot, as the event channel delivers it. */
function powerFrame(overrides: Partial<TaskBoardPowerSnapshot> = {}): { power: TaskBoardPowerSnapshot } {
  return {
    power: {
      platform: 'darwin',
      phase: 'active',
      enabled: true,
      runningSessions: 2,
      armedSchedules: 1,
      sessionStateKnown: true,
      ...overrides,
    },
  }
}

describe('task-board settings card power facts', () => {
  it('operator opening the card before any host frame reads four labelled rows of fallbacks', () => {
    // Given the settings card expanded while the host has pushed no power frame
    const container = render(cardProps())
    act(() => { header(container, zh['settings.title']).click() })

    // When the operator reads the power block
    // Then the four terms label four values and each value still holds the
    // card's fallback for a host that has not spoken yet, so the block reads as
    // labelled facts instead of one run-on sentence
    expect(powerRows(container)).toEqual([
      [zh['settings.powerPlatform'], zh['settings.powerUnknown']],
      [zh['settings.powerPhase'], zh['settings.powerUnknown']],
      [zh['settings.powerRunning'], '0'],
      [zh['settings.powerSchedules'], '0'],
    ])
    expect(container.querySelector('dl')?.children).toHaveLength(8)
  })

  it('operator reading the card after a host power frame sees the pushed facts in the rows', () => {
    // Given the card mounted on a host that reports its power state over events
    const container = render(cardProps())

    // When the host pushes a power frame and the operator expands the card
    deliverFrame(powerFrame())
    act(() => { header(container, zh['settings.title']).click() })

    // Then the rows hold the platform, phase, running session count and armed
    // schedule count that frame carried, in that order
    expect(powerRows(container)).toEqual([
      [zh['settings.powerPlatform'], 'darwin'],
      [zh['settings.powerPhase'], 'active'],
      [zh['settings.powerRunning'], '2'],
      [zh['settings.powerSchedules'], '1'],
    ])

    // ...and the battery caveat is still its own paragraph beside the list
    const caveat = [...container.querySelectorAll('p')].find(node => node.textContent === zh['settings.powerBoundary'])
    expect(caveat).toBeInstanceOf(HTMLParagraphElement)
    expect(caveat?.closest('dl')).toBeNull()
  })
})
