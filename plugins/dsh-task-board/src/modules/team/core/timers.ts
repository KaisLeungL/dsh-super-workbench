/**
 * Timer seat the team sync service schedules through.
 *
 * The extension never reaches for a global timer directly: the Host entry
 * injects the timer face, so heartbeats, lease renewals and reconnect backoff
 * are observable and cancellable under fake timers without patching globals.
 *
 * @module dsh-task-board-team/core/timers
 */

/** The timer operations this provider needs, each returning its own canceller. */
export interface HostTimerFace {
  /** Run `callback` once after `delay` ms. */
  timeout(callback: () => void, delay: number): () => void
  /** Run `callback` every `delay` ms. */
  interval(callback: () => void, delay: number): () => void
}

/** The process timer face: what a real Host mount uses. */
export const processTimers: HostTimerFace = {
  timeout(callback, delay) {
    const handle = setTimeout(callback, delay)
    handle.unref?.()
    return () => { clearTimeout(handle) }
  },
  interval(callback, delay) {
    const handle = setInterval(callback, delay)
    handle.unref?.()
    return () => { clearInterval(handle) }
  },
}

/** One clock the service reads; injectable so tests can pin time. */
export type Clock = () => number
