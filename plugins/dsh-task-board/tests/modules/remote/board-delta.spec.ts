import { describe, expect, it } from 'vitest'
// The delta rule set — base, token, cap, "smaller than a reset" — lives once, in
// the bridge (protocol v1 §15), and this row borrows it per connection. The
// suite drives the real engine rather than a second implementation of it: a
// double here would only assert the double. The sibling suite
// `packages/dsh-remote-bridge/tests/delta.spec.ts` owns the rule itself.
import { RemoteBridgeDeltas } from '../../../../dsh-remote-bridge/src/core/delta.ts'
import { createBoardMethods } from '../../../src/modules/remote/core/methods.ts'
import { BOARD_DELTA_MAX_ROWS, CAP_DELTA, METHOD_BOARD_SNAPSHOT } from '../../../src/modules/remote/protocol.ts'
import type { BoardCall, BoardMethodResult } from '../../../src/modules/remote/core/seam.ts'
import { FakeBoard } from './support/doubles.ts'

/** One task as the host writes it. */
function task(id: string, title = 'Plan the trip'): Record<string, unknown> {
  return { id, title, column: 'todo' }
}

/** The same card after a move, for a suite scripting a board change. */
function moved(id: string): Record<string, unknown> {
  return { ...task(id), column: 'doing' }
}

/** One board answer, as the wire carried it. */
interface SnapshotAnswer {
  readonly ok: boolean
  readonly r?: {
    readonly mode?: string
    readonly token?: string
    readonly revision?: number
    readonly tasks?: readonly { readonly id: string }[]
    readonly changed?: readonly { readonly id: string }[]
    readonly removed?: readonly string[]
    readonly snapshot?: { readonly revision: number }
  }
}

/** The three handlers over one board accessor. */
function methodsOf(board: () => FakeBoard | undefined) {
  return createBoardMethods({ board })
}

/** A call from a connection that declared `delta.v1`, over its own windows. */
function deltaCall(deltas: RemoteBridgeDeltas = new RemoteBridgeDeltas()): BoardCall {
  return { connectionId: 'c1', declares: capability => capability === CAP_DELTA, deltas }
}

/** A call from a connection that declared nothing. */
const PLAIN_CALL: BoardCall = { connectionId: 'c1', declares: () => false }

/** Ask one board for its snapshot under one call. */
async function read(board: () => FakeBoard | undefined, call: BoardCall, since?: string): Promise<SnapshotAnswer> {
  const answer = await methodsOf(board)[METHOD_BOARD_SNAPSHOT](since === undefined ? {} : { since }, call) as BoardMethodResult
  return answer.ok ? { ok: true, r: answer.r as SnapshotAnswer['r'] } : { ok: false }
}

/** @returns the ids one answer names as changed, or as the whole board. */
function idsOf(answer: SnapshotAnswer): string[] {
  const rows = answer.r?.mode === 'reset' ? answer.r.tasks ?? [] : answer.r?.changed ?? []
  return rows.map(row => row.id)
}

describe('board.snapshot byte-level increments over protocol v1', () => {
  it('user asking for the board with no token receives the whole board, the revision and a token', async () => {
    // Given a board whose ledger is at revision 4
    const board = new FakeBoard()
    board.tasks = [task('t-1'), task('t-2')]
    // When a delta-capable connection reads it without a token
    const answer = await read(() => board, deltaCall())
    // Then the whole board crosses with the host revision beside it
    expect(answer.r?.mode).toBe('reset')
    expect(idsOf(answer)).toEqual(['t-1', 't-2'])
    expect(answer.r?.revision).toBe(4)
    expect(answer.r?.snapshot?.revision).toBe(4)
    expect(answer.r?.token).not.toBe('')
  })

  it('user sending the token back with nothing changed receives an empty delta carrying the revision', async () => {
    // Given a connection holding the whole board
    const deltas = new RemoteBridgeDeltas()
    const board = new FakeBoard()
    const first = await read(() => board, deltaCall(deltas))
    // When the ledger revision moved but no task body did
    board.revision = 5
    const second = await read(() => board, deltaCall(deltas), first.r?.token)
    // Then nothing is resent, and the revision still says where the board stands
    expect(second.r?.mode).toBe('delta')
    expect(second.r?.changed).toEqual([])
    expect(second.r?.removed).toEqual([])
    expect(second.r?.revision).toBe(5)
    expect(second.r?.tasks).toBeUndefined()
    expect(second.r?.token).not.toBe(first.r?.token)
  })

  it('user is sent exactly the card whose body changed', async () => {
    // Given a board with three cards
    const deltas = new RemoteBridgeDeltas()
    const board = new FakeBoard()
    board.tasks = [task('t-1'), task('t-2'), task('t-3')]
    const first = await read(() => board, deltaCall(deltas))
    // When one card moves column
    board.tasks = [task('t-1'), { ...task('t-2'), column: 'doing' }, task('t-3')]
    board.revision = 6
    const second = await read(() => board, deltaCall(deltas), first.r?.token)
    // Then exactly that card is the increment
    expect(second.r?.mode).toBe('delta')
    expect(idsOf(second)).toEqual(['t-2'])
    expect(second.r?.removed).toEqual([])
    expect(second.r?.revision).toBe(6)
  })

  it('user is told which card was removed instead of having it silently dropped', async () => {
    // Given a board with three cards
    const deltas = new RemoteBridgeDeltas()
    const board = new FakeBoard()
    board.tasks = [task('t-1'), task('t-2'), task('t-3')]
    const first = await read(() => board, deltaCall(deltas))
    // When one card is deleted
    board.tasks = [task('t-1'), task('t-3')]
    board.revision = 7
    const second = await read(() => board, deltaCall(deltas), first.r?.token)
    // Then its id is named and the surviving cards are not resent
    expect(second.r?.mode).toBe('delta')
    expect(second.r?.removed).toEqual(['t-2'])
    expect(second.r?.changed).toEqual([])
  })

  it('user replaying another connection\'s token is answered a reset', async () => {
    // Given two connections on one bridge process, each with its own windows
    const one = new RemoteBridgeDeltas()
    const two = new RemoteBridgeDeltas()
    const board = new FakeBoard()
    const issued = await read(() => board, deltaCall(one))
    // When the second sends the first one's token
    const answer = await read(() => board, deltaCall(two), issued.r?.token)
    // Then the whole board crosses: a base is never borrowed
    expect(answer.r?.mode).toBe('reset')
    expect(idsOf(answer)).toEqual(['t-1'])
    expect(answer.r?.token).not.toBe(issued.r?.token)
  })

  it('user sending a garbage token is answered a reset', async () => {
    // Given a connection that already holds the board
    const deltas = new RemoteBridgeDeltas()
    const board = new FakeBoard()
    await read(() => board, deltaCall(deltas))
    // When it sends a token this window never issued
    // Then that token names no base
    const answer = await read(() => board, deltaCall(deltas), 'd1.0000000000000000.0000000000000000.9')
    expect(answer.r?.mode).toBe('reset')
    expect(idsOf(answer)).toEqual(['t-1'])
  })

  it('user is answered a reset past the board cap and no copy of it is retained', async () => {
    // Given a board one card past what a window may retain
    const deltas = new RemoteBridgeDeltas()
    const board = new FakeBoard()
    board.tasks = Array.from({ length: BOARD_DELTA_MAX_ROWS + 1 }, (_, index) => task(`t-${index}`))
    // When a delta-capable connection reads it
    const first = await read(() => board, deltaCall(deltas))
    // Then the whole board crosses and the empty token says nothing was kept
    expect(first.r?.mode).toBe('reset')
    expect(idsOf(first)).toHaveLength(BOARD_DELTA_MAX_ROWS + 1)
    expect(first.r?.token).toBe('')
    const second = await read(() => board, deltaCall(deltas), first.r?.token)
    expect(second.r?.mode).toBe('reset')
    expect(second.r?.token).toBe('')
  })

  it('user whose board mostly changed is answered a reset instead of a bigger delta', async () => {
    // Given a board of ten cards
    const deltas = new RemoteBridgeDeltas()
    const board = new FakeBoard()
    const ids = Array.from({ length: 10 }, (_, index) => `t-${index}`)
    board.tasks = ids.map(id => task(id))
    const first = await read(() => board, deltaCall(deltas))
    // When seven of them change, the answer is the whole board again
    board.tasks = ids.map((id, index) => (index < 7 ? moved(id) : task(id)))
    const second = await read(() => board, deltaCall(deltas), first.r?.token)
    // Then the whole board is the answer instead of a delta carrying seven cards
    expect(second.r?.mode).toBe('reset')
    expect(idsOf(second)).toHaveLength(10)
  })

  it('user who drops the capability sees the retained board base released', async () => {
    // Given a connection that held the board as an increment base
    const deltas = new RemoteBridgeDeltas()
    const board = new FakeBoard()
    const issued = await read(() => board, deltaCall(deltas))
    expect(issued.r?.token).not.toBe('')
    // When the same connection re-greets without the capability and reads again
    const plain = await read(() => board, { connectionId: 'c1', declares: () => false, deltas })
    expect(plain.r?.token).toBe('')
    // Then its earlier token names nothing: the base was dropped, not kept for a
    // client that can no longer continue from it
    const replay = await read(() => board, deltaCall(deltas), issued.r?.token)
    expect(replay.r?.mode).toBe('reset')
  })

  it('user who never declared delta.v1 is answered today\'s board with an empty token', async () => {
    // Given a board with one card
    const board = new FakeBoard()
    // When a connection that declared nothing reads it twice
    const first = await read(() => board, PLAIN_CALL)
    const second = await read(() => board, PLAIN_CALL, first.r?.token)
    // Then both are the whole board, and nothing was retained for it
    expect(first.r?.mode).toBe('reset')
    expect(first.r?.token).toBe('')
    expect(second.r?.mode).toBe('reset')
    expect(second.r?.token).toBe('')
  })

  it('user on a bridge that predates the delta seat is answered today\'s board', async () => {
    // Given a bridge whose call context carries no window seat at all
    const board = new FakeBoard()
    // When a delta-capable client reads it through that bridge
    const answer = await read(() => board, { connectionId: 'c1' })
    // Then the board crosses whole, exactly as it did before §15
    expect(answer.r?.mode).toBe('reset')
    expect(answer.r?.token).toBe('')
    expect(idsOf(answer)).toEqual(['t-1'])
  })
})
