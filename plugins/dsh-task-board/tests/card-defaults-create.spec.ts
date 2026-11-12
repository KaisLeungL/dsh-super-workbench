/**
 * The create path's opt-in to the board's new-card defaults: the create action
 * gains the boolean `applyCardDefaults`, and only a create that carries it
 * fills the targets its caller omitted. The extension provider's own create and
 * the legacy import never carry it, so they keep storing exactly what they pass.
 *
 * These cases drive the real ledger and the strict action gate over a scratch
 * directory, and read the defaults through the live reader the settings card
 * commits into, so what they observe is the shipped behavior rather than a
 * re-implementation of it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostTaskLedger, type LedgerState } from '../src/host-ledger.ts'
import { parseActionEnvelope } from '../src/protocol.ts'
import type { CardDefaults } from '../src/core/card-defaults.ts'
import type { NewTaskInput, TaskRecord } from '../src/core/tasks.ts'

const roots: string[] = []
const NOW = new Date(2026, 7, 16, 10, 0, 30).getTime()

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-card-defaults-'))
  roots.push(root)
  return root
}

/** Monotonic request ids: the ledger deduplicates by request id. */
let requestSeq = 0
function nextRequestId(kind: string): string {
  requestSeq += 1
  return kind + '-' + String(requestSeq)
}

/** The one card with `id`, or a failure when the board does not hold it. */
function cardOf(state: LedgerState, id: string): TaskRecord {
  const task = state.tasks.find(candidate => candidate.id === id)
  if (task === undefined) throw new Error('no card ' + id)
  return task
}

/** The four execution targets of one card, as a card read them back. */
function targetsOf(task: TaskRecord): Record<string, unknown> {
  return {
    mode: task.mode,
    permission: task.permission,
    model: task.model,
    reasoningEffort: task.reasoningEffort,
  }
}

/** Create one card through the strict gate, exactly as a caller does. */
function createCard(ledger: HostTaskLedger, id: string, input: Partial<NewTaskInput> = {}): LedgerState {
  const parsed = parseActionEnvelope({
    requestId: nextRequestId('create'),
    action: { kind: 'create', id, input: { title: id, description: '', prompt: 'do work', ...input } },
  })
  if (parsed === undefined) throw new Error('the create action was refused by the gate')
  return ledger.applyRequest(parsed.requestId, parsed.action).state
}

describe('the applyCardDefaults gate', () => {
  it('user creating a card sees the opt-in flag accepted in both of its states', () => {
    // Given two create envelopes, one opting in and one opting out
    const optedIn = parseActionEnvelope({
      requestId: nextRequestId('create'),
      action: { kind: 'create', id: 'opt-in', input: { title: 'T', description: '', prompt: '', applyCardDefaults: true } },
    })
    const optedOut = parseActionEnvelope({
      requestId: nextRequestId('create'),
      action: { kind: 'create', id: 'opt-out', input: { title: 'T', description: '', prompt: '', applyCardDefaults: false } },
    })

    // When the gate parses them
    // Then both survive with the flag intact, and an absent flag stays absent
    expect(optedIn?.action).toEqual({ kind: 'create', id: 'opt-in', input: { title: 'T', description: '', prompt: '', applyCardDefaults: true } })
    expect(optedOut?.action).toEqual({ kind: 'create', id: 'opt-out', input: { title: 'T', description: '', prompt: '', applyCardDefaults: false } })
    expect(createActionInput({ title: 'T', description: '', prompt: '' })).toEqual({ title: 'T', description: '', prompt: '' })
  })

  it('user creating a card with a non-boolean opt-in flag is refused by the gate', () => {
    // Given create envelopes whose flag is not a boolean
    // When the gate parses them
    // Then each one is refused outright rather than coerced
    expect(createActionInput({ title: 'T', description: '', prompt: '', applyCardDefaults: 1 })).toBeUndefined()
    expect(createActionInput({ title: 'T', description: '', prompt: '', applyCardDefaults: 'true' })).toBeUndefined()
    expect(createActionInput({ title: 'T', description: '', prompt: '', applyCardDefaults: null })).toBeUndefined()
  })
})

/** The create input the gate accepted, or undefined when it refused the envelope. */
function createActionInput(input: Record<string, unknown>): unknown {
  const parsed = parseActionEnvelope({ requestId: nextRequestId('create'), action: { kind: 'create', id: 'task-gate', input } })
  return parsed === undefined ? undefined : (parsed.action as { input: unknown }).input
}

describe('the create path without the opt-in', () => {
  it('user creating a subtask of a pinned parent keeps exactly the targets it inherited before', () => {
    // Given a parent pinning a preset, a binding, a model and its level
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    createCard(ledger, 'root', { mode: 'preset-1', permission: 'workspace-write', model: 'acme/a', reasoningEffort: 'high' })

    // When a subtask of it is created without the opt-in flag
    const state = createCard(ledger, 'child', { parentId: 'root' })

    // Then the preset, model and level travel and the binding still does not
    expect(targetsOf(cardOf(state, 'child'))).toEqual({ mode: 'preset-1', permission: undefined, model: 'acme/a', reasoningEffort: 'high' })
  })

  it('user creating a subtask that picks its own model never drags the parent level onto it', () => {
    // Given a parent at one model and level
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    createCard(ledger, 'root', { model: 'acme/a', reasoningEffort: 'high' })

    // When the subtask pins a model of its own and no level
    const state = createCard(ledger, 'child', { parentId: 'root', model: 'acme/b' })

    // Then it keeps that model and no level at all
    expect(targetsOf(cardOf(state, 'child'))).toEqual({ mode: undefined, permission: undefined, model: 'acme/b', reasoningEffort: undefined })
  })

  it('user creating a card on a configured board gets no default without the opt-in flag', () => {
    // Given a board whose settings configure all four new-card defaults
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, {
      cardDefaults: () => ({ mode: 'preset-team', permission: 'workspace-write', model: 'acme/reasoner', reasoningEffort: 'high' }),
    })

    // When a card is created without the flag
    const state = createCard(ledger, 'plain')

    // Then the card pins nothing: absence keeps meaning "resolved at run time"
    expect(targetsOf(cardOf(state, 'plain'))).toEqual({ mode: undefined, permission: undefined, model: undefined, reasoningEffort: undefined })
  })
})

describe('the create path with the opt-in', () => {
  it('user opting in on a configured board sees all four omitted targets filled', () => {
    // Given a board configuring one preset, permission, model and level
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, {
      cardDefaults: () => ({ mode: 'preset-team', permission: 'workspace-write', model: 'acme/reasoner', reasoningEffort: 'high' }),
    })

    // When a caller opts in and omits every target
    const state = createCard(ledger, 'filled', { applyCardDefaults: true })

    // Then the card starts from all four of them
    expect(targetsOf(cardOf(state, 'filled'))).toEqual({
      mode: 'preset-team',
      permission: 'workspace-write',
      model: 'acme/reasoner',
      reasoningEffort: 'high',
    })
  })

  it('member opting in keeps every value it passed itself', () => {
    // Given a board configuring all four defaults
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, {
      cardDefaults: () => ({ mode: 'preset-team', permission: 'workspace-write', model: 'acme/reasoner', reasoningEffort: 'high' }),
    })

    // When the caller opts in but passes its own preset, binding and model
    const state = createCard(ledger, 'mine', {
      applyCardDefaults: true,
      mode: 'preset-mine',
      permission: 'read-only',
      model: 'acme/mine',
    })

    // Then the caller's own values survive and, because it picked a model of
    // its own, no configured level is borrowed onto that model either
    expect(targetsOf(cardOf(state, 'mine'))).toEqual({
      mode: 'preset-mine',
      permission: 'read-only',
      model: 'acme/mine',
      reasoningEffort: undefined,
    })
  })

  it('operator editing the configured defaults sees the next opted-in card adopt the new value', () => {
    // Given a board whose settings the operator can still change
    let configured: CardDefaults = { mode: 'preset-one' }
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, { cardDefaults: () => configured })
    const first = createCard(ledger, 'first', { applyCardDefaults: true })

    // When the operator changes the configured preset and another card is created
    configured = { mode: 'preset-two' }
    const second = createCard(ledger, 'second', { applyCardDefaults: true })

    // Then the first card kept the value it was created with and the second one
    // adopted the edit: the defaults are read at creation, never frozen
    expect(cardOf(first, 'first').mode).toBe('preset-one')
    expect(cardOf(second, 'second').mode).toBe('preset-two')
  })

  it('user creating a subtask of a pinned confirmed parent never adopts the parent binding', () => {
    // Given a parent pinned above the session default and already confirmed
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, {
      sessionDefaultPermission: 'read-only',
      cardDefaults: () => ({ mode: 'preset-team', permission: 'workspace-write' }),
    })
    createCard(ledger, 'root', { permission: 'danger-full-access' })
    const confirmed = ledger.applyRequest(nextRequestId('confirm'), { kind: 'confirm-permission', taskId: 'root' })
    expect(cardOf(confirmed.state, 'root').permissionConfirmedAt).toBe(NOW)

    // When a subtask of it opts in and omits its own binding
    const state = createCard(ledger, 'child', { parentId: 'root', applyCardDefaults: true })

    // Then it takes the configured default instead of the parent's binding, and
    // that default is still unconfirmed
    expect(targetsOf(cardOf(state, 'child'))).toEqual({
      mode: 'preset-team',
      permission: 'workspace-write',
      model: undefined,
      reasoningEffort: undefined,
    })
    expect(cardOf(state, 'child').permissionConfirmedAt).toBeUndefined()
  })

  it('operator running a card created from an above-baseline default binding is refused until a human confirms it', () => {
    // Given a board whose configured default permission sits above the baseline
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, {
      sessionDefaultPermission: 'read-only',
      cardDefaults: () => ({ permission: 'danger-full-access' }),
    })
    createCard(ledger, 'elevated', { applyCardDefaults: true })

    // When the card is run without a confirmation
    // Then the pre-execution gate refuses it, exactly as for a hand-pinned one
    expect(() => ledger.applyRequest(nextRequestId('run'), { kind: 'run', taskId: 'elevated' })).toThrow('confirmation-required')
    expect(cardOf(ledger.state(), 'elevated').status).toBe('todo')
  })
})
