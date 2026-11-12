import { describe, expect, it } from 'vitest'
import { createBoardMethods } from '../../../src/modules/remote/core/methods.ts'
import { BOARD_SCHEMA_VERSION, BOARD_WRITE_CAPABILITIES, METHOD_BOARD_APPLY, METHOD_BOARD_SNAPSHOT } from '../../../src/modules/remote/protocol.ts'
import { FakeBoard } from './support/doubles.ts'
import type { BoardFace } from '../../../src/modules/remote/core/seam.ts'

const call = { connectionId: 'compat' }
const negotiation = { schemaVersion: BOARD_SCHEMA_VERSION, capabilities: BOARD_WRITE_CAPABILITIES }
const action = { kind: 'move', taskId: 't-1', status: 'done' }

describe('remote write schema negotiation', () => {
  it('operator reading with an old phone retains business markers while its writes are refused', async () => {
    // Given a new Host publishing a waiting recommendation and an inspection control.
    const board = new FakeBoard()
    board.tasks = [{ id: 'proposal', projectId: null, status: 'needs_input', origin: { kind: 'inspection' }, planning: { state: 'proposed' }, waiting: { kind: 'permission', executionId: 'run' } }, { id: 'control', taskKind: 'inspection', control: { extensionId: 'inspection', ruleId: 'daily' } }]
    const methods = createBoardMethods({ board: () => board })
    // When an old phone reads and attempts a write without negotiating.
    const read = await methods[METHOD_BOARD_SNAPSHOT]({}, call)
    const write = await methods[METHOD_BOARD_APPLY]({ requestId: 'old', action }, call)
    // Then all opaque markers survive the read and no write reaches the board.
    expect(read).toMatchObject({ ok: true, r: { snapshot: { schemaVersion: 8, capabilities: BOARD_WRITE_CAPABILITIES, tasks: board.tasks } } })
    expect(write).toMatchObject({ ok: false, code: 'invalid-args' })
    expect(board.applied).toEqual([])
  })

  it('operator using a new phone against an old Host receives a refusal before any mutation', async () => {
    // Given a Host face whose snapshot predates the new schema and capability contract.
    const current = new FakeBoard()
    const legacy: BoardFace = { snapshot: () => ({ ...current.snapshot(), schemaVersion: 7, capabilities: undefined }), apply: (...args) => current.apply(...args), subscribe: listener => current.subscribe(listener), verificationOptions: () => current.verificationOptions() }
    const methods = createBoardMethods({ board: () => legacy })
    // When the new phone submits its negotiated action.
    const answer = await methods[METHOD_BOARD_APPLY]({ ...negotiation, requestId: 'new', action }, call)
    // Then the bridge refuses the unsupported Host instead of stripping fields and forwarding.
    expect(answer).toMatchObject({ ok: false, code: 'board-unavailable' })
    expect(current.applied).toEqual([])
  })

  it('operator must declare every write capability and the exact schema on every retry', async () => {
    // Given a current Host and an action that was already acknowledged.
    const board = new FakeBoard()
    const methods = createBoardMethods({ board: () => board })
    const payload = { ...negotiation, requestId: 'write', action }
    const first = await methods[METHOD_BOARD_APPLY](payload, call)
    // When a connection retransmits the key with a missing capability or a future version.
    const partial = await methods[METHOD_BOARD_APPLY]({ ...payload, capabilities: ['planning.v1'] }, call)
    const future = await methods[METHOD_BOARD_APPLY]({ ...payload, schemaVersion: 9 }, call)
    // Then a replay never bypasses negotiation and the first action remains the sole write.
    expect(first).toMatchObject({ ok: true, r: { revision: 5 } })
    expect(partial).toMatchObject({ ok: false, code: 'invalid-args' })
    expect(future).toMatchObject({ ok: false, code: 'invalid-args' })
    expect(board.applied).toEqual([{ requestId: 'write', action, initiator: undefined }])
  })
})
