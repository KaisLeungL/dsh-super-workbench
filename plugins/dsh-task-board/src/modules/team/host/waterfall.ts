/**
 * The single claim this provider makes on the Host's process-wide answerer
 * waterfalls.
 *
 * Exactly one event is subscribed: `user-questions/request`, the decision
 * question a session asks through `ask_user_question`. `approval/request` — the
 * tool permission question — is deliberately absent, because it belongs to the
 * local machine's own security domain (`team-hub/PROTOCOL.md` section 6): a
 * remote reviewer must never be able to authorize a tool on this host. Keeping
 * the subscription list in one function is what makes that absence reviewable
 * and testable instead of an implicit property of a large entry file.
 *
 * @module dsh-task-board-team/host/waterfall
 */
import type { QuestionAnswer, QuestionRequestShape } from '../core/question-report.ts'
import type { QuestionRouter } from './questions.ts'

/** The event names this provider may subscribe to. */
export const CLAIMED_EVENTS = ['user-questions/request'] as const

/** The event this provider must never subscribe to. */
export const NEVER_CLAIMED_EVENTS = ['approval/request'] as const

/** The cordis slice the installer needs. */
export interface WaterfallSeat {
  /** Subscribe one waterfall listener; the returned disposer unsubscribes. */
  on(
    event: 'user-questions/request',
    listener: (request: QuestionRequestShape, next: () => Promise<QuestionAnswer>) => Promise<QuestionAnswer>,
    options?: { prepend?: boolean },
  ): () => void
}

/**
 * Install the provider's one waterfall claim.
 *
 * The listener is prepended so the team routing is consulted before the desktop
 * answerer for a team card's session; every request that is not such a session's
 * is delegated straight back down the chain, so the local surface keeps working
 * exactly as it did before this provider existed.
 * @param seat - the host context's event seat.
 * @param router - resolves the question router of the live mount, if any.
 * @returns disposer removing the subscription.
 */
export function installTeamWaterfall(seat: WaterfallSeat, router: () => QuestionRouter | undefined): () => void {
  return seat.on('user-questions/request', (request, next) => {
    const live = router()
    if (live === undefined) return next()
    return live.request(request, next)
  }, { prepend: true })
}
