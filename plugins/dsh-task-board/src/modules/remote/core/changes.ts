/**
 * One topic, one frame per wave.
 *
 * The board reports a change by calling a bare listener, and one user action can
 * produce several of those (a move settles an execution, a schedule rolls, power
 * state follows). A wave is therefore coalesced: the first notification schedules
 * the frame, the rest of the wave joins it, and the clients receive one
 * `board.changed` (`docs/protocol-v1.md` §12.4).
 *
 * The event carries the revision alone. The payload of a reload is the whole
 * snapshot, which the client fetches itself — the same policy the browser half
 * uses for its own event stream.
 * @module dsh-task-board-remote/core/changes
 */

/** What one coalesced change needs from its surroundings. */
export interface BoardChangeFeedOptions {
  /** The host's current revision, or undefined while it cannot be read. */
  readonly revision: () => number | undefined
  /** Publish one coalesced change. */
  readonly publish: (revision: number) => void
}

/** Coalesces a wave of board notifications into one published revision. */
export class BoardChangeFeed {
  readonly #options: BoardChangeFeedOptions
  #scheduled = false
  #disposed = false

  constructor(options: BoardChangeFeedOptions) {
    this.#options = options
  }

  /**
   * Note one board notification.
   *
   * The first call of a wave schedules the frame on the microtask queue; the
   * calls behind it are already represented by it, because the frame reads the
   * revision at delivery time rather than capturing the state at notification
   * time.
   */
  queue(): void {
    if (this.#scheduled || this.#disposed) return
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      if (this.#disposed) return
      const revision = this.#options.revision()
      if (revision === undefined) return
      this.#options.publish(revision)
    })
  }

  /** Stop publishing: a wave that has not been delivered yet is dropped. */
  dispose(): void {
    this.#disposed = true
  }
}
