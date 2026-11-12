import { describe, expect, it } from 'vitest'
import { inject } from '../src/client/index.ts'
import type { ExecutionModelOption } from '../src/core/controller.ts'
import { modelChoiceRows, modelDisplayLabel, modelOptionsFromCatalog, modelOptionsFromDiscoveredModels, reasoningEffortsFor, reasoningHintKey, reasoningOfModel, reasoningPickerEnabled, reconcileReasoningEffort } from '../src/client/board/model-options.ts'

describe('task-board client inject', () => {
  it('declares remote.session in inject to avoid Cordis proxy property access refusal', () => {
    expect(inject).toContain('remote')
    expect(inject).toContain('remote.session')
  })
})

/** One `session/modelCatalog` reply in the official wire shape. */
function catalog(...groups: Array<{ id: string; models: Array<Record<string, unknown>> }>): unknown {
  return {
    default: { provider: 'acme', model: 'fast' },
    routableProviders: groups.map(group => group.id),
    groups: groups.map(group => ({ id: group.id, name: group.id, models: group.models })),
    failures: [],
  }
}

describe('execution model options read from the official catalog', () => {
  it('operator sees every catalog model as a provider-qualified picker row', () => {
    // Given a deployment whose catalog lists two providers
    const reply = catalog(
      { id: 'acme', models: [{ id: 'fast', name: 'Fast' }] },
      { id: 'other', models: [{ id: 'slow', name: 'Slow' }] },
    )

    // When the client turns the reply into picker rows
    const options = modelOptionsFromCatalog(reply)

    // Then each row carries the route the execution pins, id and display name
    expect(options).toEqual([
      { id: 'acme/fast', name: 'Fast', provider: 'acme', reasoning: { supported: false } },
      { id: 'other/slow', name: 'Slow', provider: 'other', reasoning: { supported: false } },
    ])
  })

  it('operator picking a model that declares reasoning gets exactly the declared efforts', () => {
    // Given a catalog whose model publishes its own effort levels
    const reply = catalog({
      id: 'acme',
      models: [{ id: 'reasoner', name: 'Reasoner', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }],
    })

    // When the client turns the reply into picker rows
    const options = modelOptionsFromCatalog(reply)

    // Then the declared capabilities travel with the row, not a guessed list
    expect(options).toEqual([
      { id: 'acme/reasoner', name: 'Reasoner', provider: 'acme', reasoning: { supported: true, efforts: ['low', 'high'] } },
    ])
  })

  it('operator picking a catalog model without reasoning metadata is told it supports none', () => {
    // Given a catalog that describes a model and publishes no reasoning block
    const reply = catalog({ id: 'acme', models: [{ id: 'plain', name: 'Plain' }] })

    // When the client turns the reply into picker rows
    const options = modelOptionsFromCatalog(reply)

    // Then the row states "no reasoning" instead of leaving the question open
    expect(options[0].reasoning).toEqual({ supported: false })
  })

  it('operator on the fallback discovery path gets rows whose capability stays unknown', () => {
    // Given a flat discovery list, which carries no capability metadata at all
    const discovered = [{ id: 'bare', name: 'Bare' }]

    // When the client turns the list into picker rows
    const options = modelOptionsFromDiscoveredModels(discovered)

    // Then the row is offered without claiming anything about its reasoning
    expect(options).toEqual([{ id: 'bare', name: 'Bare' }])
  })

  it('operator reading a malformed catalog gets no rows instead of a crash', () => {
    // Given replies whose group level is unusable in two different ways
    // When the client turns each of them into picker rows
    const missing = modelOptionsFromCatalog(undefined)
    const mistyped = modelOptionsFromCatalog({ groups: 'nope' })
    const idless = modelOptionsFromCatalog({ groups: [{ models: [{ id: 'orphan' }] }] })

    // Then unusable replies yield nothing, and a row without a provider still lands
    expect(missing).toEqual([])
    expect(mistyped).toEqual([])
    expect(idless).toEqual([{ id: 'orphan', name: 'orphan', reasoning: { supported: false } }])
  })
})

describe('execution model options read from a partly unreadable roster', () => {
  it('operator on a catalog that mixes unreadable provider groups still gets every readable model', () => {
    // Given a catalog whose groups array holds entries that are not provider groups
    const reply = { groups: ['acme', null, { id: 'other', models: [{ id: 'slow', name: 'Slow' }] }] }

    // When the client turns the reply into picker rows
    const options = modelOptionsFromCatalog(reply)

    // Then the unreadable entries are skipped and the readable group still lands
    expect(options).toEqual([{ id: 'other/slow', name: 'Slow', provider: 'other', reasoning: { supported: false } }])
  })

  it('operator on a provider group that publishes no model list gets no rows for it', () => {
    // Given a catalog where one provider group carries no models array at all
    const reply = { groups: [{ id: 'empty', name: 'Empty' }, { id: 'acme', models: [{ id: 'fast', name: 'Fast' }] }] }

    // When the client turns the reply into picker rows
    const options = modelOptionsFromCatalog(reply)

    // Then the group without models contributes nothing and the readable one is unaffected
    expect(options).toEqual([{ id: 'acme/fast', name: 'Fast', provider: 'acme', reasoning: { supported: false } }])
  })

  it('operator on a group whose model list holds unreadable entries still gets the readable models', () => {
    // Given a group whose models array mixes one model with entries that are not models
    const reply = { groups: [{ id: 'acme', models: ['fast', null, { id: 'slow', name: 'Slow' }] }] }

    // When the client turns the reply into picker rows
    const options = modelOptionsFromCatalog(reply)

    // Then only the model-shaped entry becomes a row
    expect(options).toEqual([{ id: 'acme/slow', name: 'Slow', provider: 'acme', reasoning: { supported: false } }])
  })

  it('operator on catalog entries the adapter published without a usable id gets no route for them', () => {
    // Given models described without an id, with an empty id and with a non-string id
    const reply = { groups: [{ id: 'acme', models: [{ name: 'No id' }, { id: '' }, { id: 42 }, { id: 'fast', name: 'Fast' }] }] }

    // When the client turns the reply into picker rows
    const options = modelOptionsFromCatalog(reply)

    // Then only the entry carrying a real id is offered, so no row claims an unrunnable route
    expect(options).toEqual([{ id: 'acme/fast', name: 'Fast', provider: 'acme', reasoning: { supported: false } }])
  })

  it('operator picking a model that declares reasoning without publishing levels is offered none', () => {
    // Given a model whose adapter publishes a reasoning block but no effort list
    const reply = catalog({ id: 'acme', models: [{ id: 'quiet', name: 'Quiet', reasoning: { defaultEffort: 'low' } }] })

    // When the client turns the reply into picker rows and the picker reads that model
    const options = modelOptionsFromCatalog(reply)
    const offered = reasoningEffortsFor(options, 'acme/quiet')

    // Then the route is known to reason, and no level is invented for it
    expect(options).toEqual([{ id: 'acme/quiet', name: 'Quiet', provider: 'acme', reasoning: { supported: true } }])
    expect(offered).toEqual([])
    expect(reasoningHintKey(options, 'acme/quiet')).toBe('exec.reasoning.hint.noEfforts')
  })

  it('operator picking a model whose adapter repeats or mistypes a level gets each real level once', () => {
    // Given an effort list that repeats an id and carries entries with no usable id
    const reply = catalog({ id: 'acme', models: [{ id: 'reasoner', name: 'Reasoner', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'low' }, { name: 'Junk' }, 'high'] } }] })

    // When the client turns the reply into picker rows
    const options = modelOptionsFromCatalog(reply)

    // Then the declared level is offered exactly once and nothing unusable is offered at all
    expect(options).toEqual([{ id: 'acme/reasoner', name: 'Reasoner', provider: 'acme', reasoning: { supported: true, efforts: ['low'] } }])
    expect(reasoningEffortsFor(options, 'acme/reasoner')).toEqual(['low'])
  })
})

describe('execution model options read from the fallback discovery list', () => {
  it('operator on a deployment whose fallback reply is not a model list gets no rows', () => {
    // Given a fallback discovery reply that has the wrong shape entirely
    // When the client turns each of them into picker rows
    const missing = modelOptionsFromDiscoveredModels(undefined)
    const mistyped = modelOptionsFromDiscoveredModels({ models: [{ id: 'bare' }] })

    // Then nothing is offered instead of a crash
    expect(missing).toEqual([])
    expect(mistyped).toEqual([])
  })

  it('operator on a discovery list that mixes unreadable entries still gets the readable models', () => {
    // Given a flat list holding non-model entries and a model the reply gave no id
    const discovered = ['bare', null, { name: 'No id' }, { id: 'ok', name: 'Ok' }]

    // When the client turns the list into picker rows
    const options = modelOptionsFromDiscoveredModels(discovered)

    // Then only the identified model becomes a row, and it claims nothing about reasoning
    expect(options).toEqual([{ id: 'ok', name: 'Ok' }])
  })
})

/** Picker rows as the controller would hand them to the form. */
const ROSTER: ExecutionModelOption[] = [
  { id: 'acme/reasoner', name: 'Reasoner', reasoning: { supported: true, efforts: ['low', 'high'] } },
  { id: 'acme/plain', name: 'Plain', reasoning: { supported: false } },
  { id: 'acme/silent', name: 'Silent', reasoning: { supported: true } },
]

describe('the display form of one model row', () => {
  it('operator sees two providers publishing one model name as two different rows', () => {
    // Given a roster where two providers publish the same model name
    const roster: ExecutionModelOption[] = [
      { id: 'alpha/shared', name: 'Shared', provider: 'alpha' },
      { id: 'beta/shared', name: 'Shared', provider: 'beta' },
    ]

    // When the picker builds its choice rows from that roster
    const rows = modelChoiceRows(roster)

    // Then each row names its own provider, and the stored route is untouched
    expect(rows).toEqual([
      { value: 'alpha/shared', label: 'Shared · alpha' },
      { value: 'beta/shared', label: 'Shared · beta' },
    ])
  })

  it('operator on a row that names no provider sees the bare model name', () => {
    // Given a roster row from the flat discovery list, which names no provider
    const roster: ExecutionModelOption[] = [{ id: 'bare', name: 'Bare' }]

    // When the picker builds its choice rows from that roster
    const rows = modelChoiceRows(roster)

    // Then the row keeps its name alone instead of claiming a provider
    expect(rows).toEqual([{ value: 'bare', label: 'Bare' }])
  })

  it('operator on a row that names no model sees the model part of its own route', () => {
    // Given a row whose only name is its qualified route
    const roster: ExecutionModelOption[] = [{ id: 'alpha/fast', provider: 'alpha' }]

    // When the picker builds its choice rows from that roster
    const rows = modelChoiceRows(roster)

    // Then the provider is named once, beside the model it publishes
    expect(rows).toEqual([{ value: 'alpha/fast', label: 'fast · alpha' }])
  })

  it('operator reading one row directly sees the same form the pickers render', () => {
    // Given a row carrying a provider and a row carrying none
    const labelled = modelDisplayLabel({ id: 'alpha/shared', name: 'Shared', provider: 'alpha' })
    const bare = modelDisplayLabel({ id: 'bare', name: 'Bare' })

    // When the label is read for each of them
    // Then the labelled row names both halves and the bare row only its name
    expect(labelled).toBe('Shared · alpha')
    expect(bare).toBe('Bare')
  })
})

describe('reasoning effort offered for the picked model', () => {
  it('operator pinning a reasoning model gets its declared efforts and keeps a listed one', () => {
    // Given a roster that declares two levels for a model
    // When the picker asks what that pinned model offers
    const offered = reasoningEffortsFor(ROSTER, 'acme/reasoner')
    const kept = reconcileReasoningEffort(ROSTER, 'acme/reasoner', 'high')

    // Then exactly the declared levels are offered and a listed one survives
    expect(offered).toEqual(['low', 'high'])
    expect(kept).toBe('high')
    expect(reasoningOfModel(ROSTER, 'acme/reasoner')).toEqual({ supported: true, efforts: ['low', 'high'] })
    expect(reasoningPickerEnabled(ROSTER, 'acme/reasoner')).toBe(true)
  })

  it('operator switching to a model that does not reason never keeps the old effort', () => {
    // Given a level picked for a reasoning model
    // When the operator switches the card to a model declared as reasoning-free
    const kept = reconcileReasoningEffort(ROSTER, 'acme/plain', 'high')

    // Then the stale level is dropped and the picker is closed
    expect(kept).toBe('')
    expect(reasoningPickerEnabled(ROSTER, 'acme/plain')).toBe(false)
  })

  it('operator switching to a model whose efforts are unlisted drops the stale choice', () => {
    // Given a level that the newly picked reasoning model does not declare
    // When the picker reconciles the stored value against that model
    const kept = reconcileReasoningEffort(ROSTER, 'acme/reasoner', 'medium')

    // Then nothing is carried over
    expect(kept).toBe('')
  })

  it('operator leaving the model unpinned clears the effort with it', () => {
    // Given a level stored while a model was pinned
    // When the operator returns the card to the Host default model
    const kept = reconcileReasoningEffort(ROSTER, '', 'high')

    // Then the level goes with the model it was bound to
    expect(kept).toBe('')
    expect(reasoningOfModel(ROSTER, '')).toBeUndefined()
    expect(reasoningPickerEnabled(ROSTER, '')).toBe(false)
  })

  it('operator on a model the roster cannot describe keeps the stored effort as it is', () => {
    // Given a card pinned to a model the current deployment no longer lists
    // When the picker looks that model up
    const lookup = reasoningOfModel(ROSTER, 'acme/gone')
    const kept = reconcileReasoningEffort(ROSTER, 'acme/gone', 'high')

    // Then nothing is offered — and the stored value is not silently dropped
    expect(lookup).toBeUndefined()
    expect(reasoningPickerEnabled(ROSTER, 'acme/gone')).toBe(false)
    expect(kept).toBe('high')
  })

  it('operator on a reasoning model that publishes no effort levels is offered none', () => {
    // Given a model declared as reasoning-capable with no selectable level
    // When the picker asks what it offers and what survives on it
    const offered = reasoningEffortsFor(ROSTER, 'acme/silent')
    const kept = reconcileReasoningEffort(ROSTER, 'acme/silent', 'high')

    // Then there is nothing to choose, so no stale level is carried either
    expect(offered).toEqual([])
    expect(reasoningPickerEnabled(ROSTER, 'acme/silent')).toBe(false)
    expect(kept).toBe('')
  })
})
