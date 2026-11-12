// @vitest-environment jsdom
/**
 * A typed field inside a settings card reaches the card's own apply without
 * its plugin wiring keys: Enter writes the draft now, Escape puts the stored
 * value back, and leaving the field writes it as well.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginSettingsCard, ValueField } from '../src/client/PluginSettingsCard.tsx'
import { mount, setupCardEnvironment, shellProps, teardownCardEnvironment } from './settings-card-harness.tsx'

beforeEach(setupCardEnvironment)
afterEach(teardownCardEnvironment)

/**
 * Mount an open card holding one typed field, recording what the card is asked to do.
 * @returns the field's input and the record of commits and reverts.
 */
function typedField() {
  const calls: string[] = []
  const container = mount(
    <PluginSettingsCard
      {...shellProps({ defaultOpen: true })}
      onSave={() => { calls.push('commit') }}
      onDiscard={() => { calls.push('revert') }}
    >
      <ValueField
        id="settings-typed"
        label="label"
        hint="hint"
        text="draft"
        overridden={false}
        invalid={false}
        overriddenLabel="overridden"
        resetLabel="reset"
        invalidLabel="invalid"
        disabled={false}
        onEdit={() => {}}
        onReset={() => {}}
      />
    </PluginSettingsCard>,
  )
  const input = container.querySelector('#settings-typed')
  if (!(input instanceof HTMLInputElement)) throw new Error('the typed field did not render')
  return { input, calls }
}

/** Press one key on the input as the browser delivers it. */
function press(input: HTMLInputElement, key: string): void {
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
}

describe('settings card typed field', () => {
  it('operator pressing Enter writes the draft now and leaves the field', () => {
    // Given a focused typed field
    const { input, calls } = typedField()
    act(() => { input.focus() })

    // When the operator presses Enter
    press(input, 'Enter')

    // Then the card writes the draft and focus leaves the field
    expect(calls[0]).toBe('commit')
    expect(document.activeElement).not.toBe(input)
  })

  it('operator pressing Escape puts the stored value back and leaves the field', () => {
    // Given a focused typed field
    const { input, calls } = typedField()
    act(() => { input.focus() })

    // When the operator presses Escape
    press(input, 'Escape')

    // Then the card drops the draft before anything else
    expect(calls[0]).toBe('revert')
    expect(document.activeElement).not.toBe(input)
  })

  it('operator leaving the field writes the draft', () => {
    // Given a focused typed field
    const { input, calls } = typedField()
    act(() => { input.focus() })

    // When focus moves elsewhere
    act(() => { input.blur() })

    // Then the card writes the draft
    expect(calls).toEqual(['commit'])
  })
})

describe('settings card bounded number field', () => {
  it('operator dragging the coarse slider fills the field live and writes it on release', () => {
    // Given an open card holding a number field over 1..300
    const calls: string[] = []
    const container = mount(
      <PluginSettingsCard
        {...shellProps({ defaultOpen: true })}
        onSave={() => { calls.push('commit') }}
        onDiscard={() => { calls.push('revert') }}
      >
        <ValueField
          id="settings-bounded"
          label="label"
          hint="hint"
          text="5"
          numeric
          range={{ min: 1, max: 300, step: 1 }}
          overridden={false}
          invalid={false}
          overriddenLabel="overridden"
          resetLabel="reset"
          invalidLabel="invalid"
          disabled={false}
          onEdit={(text) => { calls.push('edit ' + text) }}
          onReset={() => {}}
        />
      </PluginSettingsCard>,
    )
    const slider = container.querySelector('input[type="range"]')
    if (!(slider instanceof HTMLInputElement)) throw new Error('the coarse slider did not render')

    // When the operator drags the thumb to 120 and lets go (this jsdom has no
    // PointerEvent; React dispatches on the event name alone)
    act(() => { slider.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(slider, '120')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { slider.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })) })

    // Then the field took the dragged value as its draft, and the release wrote it
    expect(calls).toEqual(['edit 120', 'edit 120', 'commit'])
  })
})
