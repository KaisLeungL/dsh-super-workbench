import { describe, expect, it } from 'vitest'
import { apply } from '../../../src/modules/remote/index.ts'
import {
  BOARD_SERVICE,
  REMOTE_BRIDGE_SERVICE,
} from '../../../src/modules/remote/core/seam.ts'
import {
  CAP_BOARD,
  METHOD_BOARD_APPLY,
  METHOD_BOARD_OPTIONS,
  METHOD_BOARD_SNAPSHOT,
  TOPIC_BOARD_CHANGED,
} from '../../../src/modules/remote/protocol.ts'
import { FakeBoard, FakeBridge, makeHost } from './support/doubles.ts'

/** Mount the row over a host that serves the given services. */
function mount(board: FakeBoard | undefined, bridge: FakeBridge | undefined) {
  const host = makeHost({
    ...(board === undefined ? {} : { [BOARD_SERVICE]: board }),
    ...(bridge === undefined ? {} : { [REMOTE_BRIDGE_SERVICE]: bridge }),
  })
  apply(host.ctx)
  return host
}

describe('the mounted row', () => {
  it('operator mounts the row with both services and the board surface is registered under its capability', () => {
    // Given a host with the bridge seam and the task board face
    const board = new FakeBoard()
    const bridge = new FakeBridge()
    // When the row mounts
    const host = mount(board, bridge)
    // Then one table carries the three methods, gated by the board capability
    expect(host.effectCount).toBe(2)
    expect(bridge.tables).toHaveLength(1)
    expect(bridge.tables[0]?.capability).toBe(CAP_BOARD)
    expect(Object.keys(bridge.tables[0]?.methods ?? {}).sort()).toEqual([
      METHOD_BOARD_APPLY,
      METHOD_BOARD_OPTIONS,
      METHOD_BOARD_SNAPSHOT,
    ].sort())
    // And the change feed holds exactly one subscription on the board
    expect(board.listeners.size).toBe(1)
  })

  it('operator mounts the row on a host without the bridge and it keeps starting with nothing registered', () => {
    // Given a host with the board but no bridge seam
    const board = new FakeBoard()
    // When the row mounts
    const host = mount(board, undefined)
    // Then nothing was registered, nothing subscribed, and the mount did not throw
    expect(host.effectCount).toBe(0)
    expect(board.listeners.size).toBe(0)
  })

  it('operator mounts the row on a host without the board and every method answers unavailable', async () => {
    // Given a host with the bridge but no task board
    const bridge = new FakeBridge()
    const host = mount(undefined, bridge)
    // When the row mounts and a paired phone calls the surface
    expect(host.effectCount).toBe(1)
    const answers = await Promise.all([
      bridge.handler(METHOD_BOARD_SNAPSHOT)({}, { connectionId: 'c1' }),
      bridge.handler(METHOD_BOARD_OPTIONS)({}, { connectionId: 'c1' }),
      bridge.handler(METHOD_BOARD_APPLY)({ requestId: 'r-1', action: { kind: 'move' } }, { connectionId: 'c1' }),
    ])
    // Then every method reports the missing board rather than an unknown method
    for (const answer of answers) expect(answer).toEqual({ ok: false, code: 'board-unavailable', msg: 'the task board is not mounted on this host' })
  })

  it('operator unmounts the row and the methods are withdrawn with the subscription', () => {
    // Given a mounted row
    const board = new FakeBoard()
    const bridge = new FakeBridge()
    const host = mount(board, bridge)
    // When the row is unmounted
    host.unmount()
    // Then every registered method is withdrawn and the board subscription is gone
    expect(bridge.withdrawn.sort()).toEqual([METHOD_BOARD_APPLY, METHOD_BOARD_OPTIONS, METHOD_BOARD_SNAPSHOT].sort())
    expect(board.listeners.size).toBe(0)
  })

  it('user receives one revision frame for a wave of two board notifications', async () => {
    // Given a mounted row and a board that changed twice for one action
    const board = new FakeBoard()
    const bridge = new FakeBridge()
    mount(board, bridge)
    // When the wave is delivered
    board.changed()
    board.changed()
    await Promise.resolve()
    await Promise.resolve()
    // Then one frame crossed, carrying the revision alone under the board capability
    expect(bridge.broadcasts).toEqual([
      { topic: TOPIC_BOARD_CHANGED, payload: { revision: board.revision }, capability: CAP_BOARD },
    ])
  })

  it('user receives nothing for a change queued before the row was unmounted', async () => {
    // Given a changed board and a row that is unmounted in the same turn
    const board = new FakeBoard()
    const bridge = new FakeBridge()
    const host = mount(board, bridge)
    board.changed()
    host.unmount()
    // When the microtask queue runs
    await Promise.resolve()
    await Promise.resolve()
    // Then nothing was published for the row that no longer exists
    expect(bridge.broadcasts).toEqual([])
  })

  it('user receives no frame when the board can no longer be read', async () => {
    // Given a mounted row whose board can no longer be read
    const board = new FakeBoard()
    const bridge = new FakeBridge()
    mount(board, bridge)
    board.snapshotError = new Error('ledger is locked')
    // When the board reports a change
    board.changed()
    await Promise.resolve()
    await Promise.resolve()
    // Then no revision is invented: the client keeps what it has
    expect(bridge.broadcasts).toEqual([])
  })
})
