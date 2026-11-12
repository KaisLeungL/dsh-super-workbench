/**
 * The board's outbound projection: a provider's integration credential never
 * leaves the Host.
 *
 * The ledger keeps the payload verbatim — a provider reads it back through its
 * in-process capability face, and a Host-side consumer reads the ledger itself —
 * while every read path that crosses the wire (the HTTP state and action
 * answers and the remote bridge's board.snapshot, all built from
 * TaskBoardHostService's snapshot) serializes the projected copy.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskBoardHostService } from '../src/host-service.ts'
import { TASK_BOARD_API_VERSION, type TaskBoardExtension, type TaskBoardExtensionHost } from '../src/core/extension.ts'
import type { NewTaskInput } from '../src/core/tasks.ts'

let scratchHome: string | undefined
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  scratchHome = mkdtempSync(join(tmpdir(), 'dsh-wire-projection-'))
  process.env.DSH_HOME = scratchHome
})

afterEach(() => {
  if (scratchHome !== undefined) rmSync(scratchHome, { recursive: true, force: true })
  scratchHome = undefined
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

function fakeGateway(): TypertGateway {
  return {
    invoke: async () => ({ presets: [], items: [] }),
    stream: async () => ({ async *[Symbol.asyncIterator]() {} }),
  } as unknown as TypertGateway
}

/** A board over a throwaway home directory. */
function makeBoard(): TaskBoardHostService {
  return new TaskBoardHostService(fakeGateway())
}

/** Admit one provider and hand back a getter for the capability face it received. */
function admitProvider(host: TaskBoardHostService): () => TaskBoardExtensionHost {
  let captured: TaskBoardExtensionHost | undefined
  const extension: TaskBoardExtension = {
    id: 'team',
    apiVersion: TASK_BOARD_API_VERSION,
    start(face) { captured = face },
  }
  host.registerExtension(extension)
  return () => {
    if (captured === undefined) throw new Error('provider was not started')
    return captured
  }
}

/** The non-credential half of a team integration entry, kept byte for byte. */
const TEAM_PAYLOAD = {
  issueId: 'I_kwDOAbCdEf',
  issueNumber: 1758,
  leaseExpiresAt: 1_760_000_000_000,
  agentId: 'agent-lease-holder',
}

/** A live mirror-card lease credential, the field this projection exists for. */
const LEASE_TOKEN = 'lease-token-1'

/** Every integration key the outbound projection removes, spelled as written. */
const CREDENTIAL_FIELDS = ['leaseToken', 'lease_token', 'token', 'Secret', 'APIKEY', 'credential', 'password']

function cardInput(title: string, extra: Partial<NewTaskInput> = {}): NewTaskInput {
  return { title, description: '', prompt: 'p', ...extra }
}

describe('outbound integration projection', () => {
  it('operator reads a card with its credentials stripped while the identifiers the provider renders stay', () => {
    // Given a card whose team integration carries a live lease credential beside
    // its issue identity, plus every other spelling a credential hides under
    const host = makeBoard()
    host.apply('c1', {
      kind: 'create',
      id: 't1',
      input: cardInput('Leased', {
        integrations: {
          team: {
            ...TEAM_PAYLOAD,
            leaseToken: LEASE_TOKEN,
            lease_token: 'snake-lease-1',
            token: 'bearer-2',
            Secret: 'mixed-case-3',
            APIKEY: 'api-key-4',
            credential: 'stored-cred-5',
            password: 'pass-6',
          },
        },
      }),
    })

    // When the wire snapshot is read
    const snapshot = host.snapshot()
    const card = snapshot.tasks.find(task => task.id === 't1')

    // Then the provider-visible half survives untouched and no stored
    // credential value appears anywhere in the serialized snapshot
    expect(card?.integrations).toEqual({ team: TEAM_PAYLOAD })
    const stored = host.ledger.getTask('t1')?.integrations?.team ?? {}
    const wire = JSON.stringify(snapshot)
    const leaked = CREDENTIAL_FIELDS.filter(field => wire.includes(String(stored[field])))
    expect(leaked).toEqual([])
    // And the ledger still holds every field the provider wrote
    expect(stored).toMatchObject({ leaseToken: LEASE_TOKEN })
    expect(Object.keys(stored)).toEqual(expect.arrayContaining(CREDENTIAL_FIELDS))
    host.dispose()
  })

  it('operator reads nested and repeated payloads with credentials removed at every depth', () => {
    // Given a provider entry that buries its credential in a nested object and in
    // two records of a list
    const host = makeBoard()
    host.apply('c1', {
      kind: 'create',
      id: 't1',
      input: cardInput('Nested', {
        integrations: {
          team: {
            wrapper: { password: 'pass-7', keep: 'outer' },
            history: [
              { token: 'bearer-8', actor: 'u1' },
              { credential: 'stored-cred-9', actor: 'u2' },
            ],
          },
        },
      }),
    })

    // When the wire snapshot is read
    const integrations = host.snapshot().tasks[0]?.integrations

    // Then every depth is stripped and every non-credential key is preserved
    expect(integrations).toEqual({
      team: {
        wrapper: { keep: 'outer' },
        history: [{ actor: 'u1' }, { actor: 'u2' }],
      },
    })
    host.dispose()
  })

  it('operator reads a card that stores no integrations exactly as the ledger holds it', () => {
    // Given a card created without any provider payload
    const host = makeBoard()
    host.apply('c1', { kind: 'create', id: 't1', input: cardInput('Plain') })

    // When the wire snapshot is read
    const card = host.snapshot().tasks.find(task => task.id === 't1')

    // Then the card is the ledger record, with no empty container invented
    expect(card).toEqual(host.ledger.getTask('t1'))
    expect(card?.integrations).toBeUndefined()
    host.dispose()
  })

  it('operator posts an action whose answer hides the credential, while the provider still reads it back in-process', () => {
    // Given a provider that keeps a lease credential in its own entry
    const host = makeBoard()
    const face = admitProvider(host)
    host.apply('c1', { kind: 'create', id: 't1', input: cardInput('Held') })
    face().integration.write('t1', { ...TEAM_PAYLOAD, leaseToken: LEASE_TOKEN })

    // When a board action answers with the resulting snapshot
    const answer = host.apply('c2', { kind: 'update', taskId: 't1', patch: { title: 'Held again' } })

    // Then the answer carries the projected card and no credential anywhere
    expect(answer.tasks.find(task => task.id === 't1')?.integrations).toEqual({ team: TEAM_PAYLOAD })
    expect(JSON.stringify(answer)).not.toContain(LEASE_TOKEN)
    // And the provider's own in-process read is the raw payload it wrote
    expect(face().integration.read('t1')).toEqual({ ...TEAM_PAYLOAD, leaseToken: LEASE_TOKEN })
    host.dispose()
  })
})
