/**
 * New-card defaults resolution: the one order every creator obeys — the
 * caller's own pick, then the value carried over from the card it is created
 * from, then the board's configured defaults — and the two bindings that ride
 * along with it (a parent's permission never travels, a reasoning level never
 * crosses to a model it was not chosen for).
 *
 * The rules live in one pure function both halves compile, so these cases are
 * the whole contract of what a new card starts from.
 */
import { describe, expect, it } from 'vitest'
import { resolveCardTargets, type CardDefaults, type CardTargetSource } from '../src/core/card-defaults.ts'

/** One card's execution targets, as the resolver reads them. */
type SourceTargets = CardTargetSource['task']

/** The four configured defaults a deployment may set. */
const CONFIGURED: CardDefaults = {
  mode: 'preset-team',
  permission: 'workspace-write',
  model: 'acme/reasoner',
  reasoningEffort: 'high',
}

/** A source card pinning all four targets. */
const PINNED: SourceTargets = {
  mode: 'preset-source',
  permission: 'danger-full-access',
  model: 'acme/source',
  reasoningEffort: 'low',
}

function source(kind: CardTargetSource['kind'], task: SourceTargets): CardTargetSource {
  return { kind, task }
}

describe('new-card default targets', () => {
  it('user creating a card on a board that configured no default pins nothing at all', () => {
    // Given a board whose new-card defaults are all unset
    // When the user creates a card without choosing any execution target
    const seed = resolveCardTargets(undefined, undefined)

    // Then every target stays unset, exactly as it did before the defaults existed
    expect(seed).toEqual({ mode: '', permission: '', model: '', reasoningEffort: '' })
  })

  it('user creating a card on a configured board adopts all four configured defaults', () => {
    // Given a board that configures one preset, permission, model and level
    // When the user creates a card without choosing any execution target
    const seed = resolveCardTargets(CONFIGURED, undefined)

    // Then the card starts from all four of them
    expect(seed).toEqual({ mode: 'preset-team', permission: 'workspace-write', model: 'acme/reasoner', reasoningEffort: 'high' })
  })

  it('user choosing targets in the dialog sees its own choice win over every configured default', () => {
    // Given a board with all four defaults configured
    // When the caller sends its own four values
    const seed = resolveCardTargets(CONFIGURED, undefined, {
      mode: 'preset-mine',
      permission: 'read-only',
      model: 'acme/mine',
      reasoningEffort: 'medium',
    })

    // Then not one default reaches the card
    expect(seed).toEqual({ mode: 'preset-mine', permission: 'read-only', model: 'acme/mine', reasoningEffort: 'medium' })
  })

  it('user picking a model with no level runs at that model default instead of the configured level', () => {
    // Given a board whose configured level belongs to its configured model
    // When the caller picks that very model but no level of its own
    const seed = resolveCardTargets(CONFIGURED, undefined, { model: 'acme/reasoner' })

    // Then the level is not borrowed: the picked model runs at its own default
    expect(seed).toEqual({ mode: 'preset-team', permission: 'workspace-write', model: 'acme/reasoner', reasoningEffort: '' })
  })

  it('operator leaving the default model blank makes the configured level inert', () => {
    // Given a hand-edited board that configures a level but no model to bind it to
    const defaults: CardDefaults = { mode: 'preset-team', reasoningEffort: 'high' }

    // When a card is created without choosing a model
    const seed = resolveCardTargets(defaults, undefined)

    // Then the level is dropped while the rest of the defaults still apply
    expect(seed).toEqual({ mode: 'preset-team', permission: '', model: '', reasoningEffort: '' })
  })

  it('user creating a subtask keeps the parent pins but never the parent permission', () => {
    // Given a parent card pinning all four targets
    // When a subtask of it is created without its own targets
    const seed = resolveCardTargets(undefined, source('parent', PINNED))

    // Then the parent's preset, model and level travel, and its binding does not:
    // the permission is resolved along the ancestor chain at launch instead
    expect(seed).toEqual({ mode: 'preset-source', permission: '', model: 'acme/source', reasoningEffort: 'low' })
  })

  it('user creating a subtask of an unconfigured parent starts from the board defaults', () => {
    // Given a parent that pins nothing and a board with all four defaults
    // When a subtask of it is created without its own targets
    const seed = resolveCardTargets(CONFIGURED, source('parent', {}))

    // Then every target comes from the defaults, the permission included
    expect(seed).toEqual(CONFIGURED)
  })

  it('user creating a subtask of a level-less parent sees the configured level apply to the default model', () => {
    // Given a parent pinned to the configured model but no level
    // When the subtask is created against a board whose level names that model
    const seed = resolveCardTargets(CONFIGURED, source('parent', { model: 'acme/reasoner' }))

    // Then the level applies, because the card's final model IS the configured one
    expect(seed).toEqual({ mode: 'preset-team', permission: 'workspace-write', model: 'acme/reasoner', reasoningEffort: 'high' })
  })

  it('user creating a subtask of a parent on another model drops the configured level entirely', () => {
    // Given a parent pinned to a model of its own with no level
    // When the subtask is created against a board whose level belongs to a different model
    const seed = resolveCardTargets(CONFIGURED, source('parent', { mode: 'preset-source', model: 'acme/other' }))

    // Then the card keeps that model and sends no level at all
    expect(seed).toEqual({ mode: 'preset-source', permission: 'workspace-write', model: 'acme/other', reasoningEffort: '' })
  })

  it('user duplicating a card copies every pinned target of its source, its permission included', () => {
    // Given a source card pinning all four targets
    // When the user duplicates it on a board that configures different defaults
    const seed = resolveCardTargets(CONFIGURED, source('duplicate', PINNED))

    // Then the copy carries the source's values, not the board's
    expect(seed).toEqual(PINNED)
  })

  it('user duplicating an unconfigured card fills exactly the fields the source left unset', () => {
    // Given a source card that pins only its preset
    // When the user duplicates it on a board with all four defaults
    const seed = resolveCardTargets(CONFIGURED, source('duplicate', { mode: 'preset-source' }))

    // Then the pinned preset survives and the other three come from the defaults
    expect(seed).toEqual({ mode: 'preset-source', permission: 'workspace-write', model: 'acme/reasoner', reasoningEffort: 'high' })
  })

  it('user duplicating a model-pinned card sees the source pair travel and no configured level', () => {
    // Given a source card pinned to a model with no level of its own
    // When the user duplicates it against a board whose level names another model
    const seed = resolveCardTargets(CONFIGURED, source('duplicate', { model: 'acme/source' }))

    // Then the copy keeps that model and runs at its own default
    expect(seed).toEqual({ mode: 'preset-team', permission: 'workspace-write', model: 'acme/source', reasoningEffort: '' })
  })

  it('member keeping an explicitly picked level with no model keeps that level as the caller chose it', () => {
    // Given a caller that sends a level without pinning a model for it (the card
    // form cannot produce this, the board's own create path can)
    // When the targets resolve on a configured board
    const seed = resolveCardTargets(CONFIGURED, undefined, { reasoningEffort: 'medium' })

    // Then the caller's own level stands rather than being replaced by the default
    expect(seed).toEqual({ mode: 'preset-team', permission: 'workspace-write', model: 'acme/reasoner', reasoningEffort: 'medium' })
  })

  it('member sending blank targets instead of omitting them sees the same resolution as an omitted field', () => {
    // Given a caller that sends empty and whitespace-only strings
    const blank = resolveCardTargets(CONFIGURED, source('parent', PINNED), {
      mode: '  ',
      permission: '',
      model: '\t',
      reasoningEffort: '',
    })
    // When the same create omits those fields entirely
    const omitted = resolveCardTargets(CONFIGURED, source('parent', PINNED))

    // Then both resolve to the same targets: blank text means "not set"
    expect(blank).toEqual(omitted)
    expect(blank).toEqual({ mode: 'preset-source', permission: 'workspace-write', model: 'acme/source', reasoningEffort: 'low' })
  })
})
