/**
 * The one hub question an `ask_user_question` request becomes.
 *
 * The Host's question event carries a batch, and the hub's schema stores a
 * single question with options and a multi-select flag. The bridge between them
 * is explicit: the FIRST question is the one the team is asked, the rest stay on
 * the machine, and an answer that names the reported question is mapped back
 * onto it. That keeps the mapping total in both directions instead of guessing
 * which of several questions a free-text team answer meant.
 *
 * @module dsh-task-board-team/core/question-report
 */
import { QUESTION_TTL_MS } from './hub-protocol.ts'

/** One selectable answer offered by the asker. */
export interface QuestionOption {
  readonly label: string
  readonly description?: string
}

/** One question, in the shape the Host's question event publishes. */
export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly QuestionOption[]
  readonly multiSelect?: boolean
}

/** The fields of a Host question request this provider reads. */
export interface QuestionRequestShape {
  readonly questions: readonly QuestionItem[]
  /** The agent asking; its id IS the session id (the event carries no session field). */
  readonly agent?: { readonly id: string }
  readonly signal?: AbortSignal
}

/** One item of the answer batch the Host settles its ask with. */
export interface QuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** The whole answer batch the Host's ask is settled with. */
export interface QuestionAnswer {
  readonly answers: readonly QuestionAnswerItem[]
}

/** The body one question report sends to the hub. */
export interface QuestionReportBody {
  question_text: string
  /** Selectable answers, in the wire shape the hub stores and serves. */
  options?: readonly QuestionOption[]
  multi_select?: boolean
}

/**
 * Build the hub question one Host question request reports.
 * @param item - the first question of the batch.
 * @returns the report body.
 */
export function buildQuestionReport(item: QuestionItem): QuestionReportBody {
  const text = item.header === undefined || item.header.trim() === ''
    ? item.question
    : `${item.header.trim()}: ${item.question}`
  // The asker's own options travel as objects, label and description included:
  // a description is what tells a reviewer which choice is which.
  const options = (item.options ?? [])
    .filter(option => option.label.trim() !== '')
    .map(option => ({
      label: option.label,
      ...(option.description === undefined || option.description.trim() === '' ? {} : { description: option.description }),
    }))
  return {
    question_text: text,
    ...(options.length === 0 ? {} : { options }),
    ...(item.multiSelect === true ? { multi_select: true } : {}),
  }
}

/**
 * Map one team answer back onto the question the Host asked.
 * @param item - the reported question item (whose id the answer addresses).
 * @param answer - the hub's answer payload: the selected labels and optional custom text.
 * @returns the answer batch the Host settles its ask with.
 */
export function answerToHost(
  item: QuestionItem,
  answer: { selected: readonly string[]; custom?: string },
): QuestionAnswer {
  const selected = [...answer.selected]
  const custom = answer.custom !== undefined && answer.custom.trim() !== '' ? answer.custom : undefined
  return {
    answers: [{
      id: item.id,
      selected,
      ...(custom === undefined ? {} : { custom }),
    }],
  }
}

/**
 * The answer batch that ends a question nobody answered.
 *
 * The protocol resolves an expired question as unanswered so the agent can
 * proceed on its own assumptions or pause; the Host's answer vocabulary has no
 * "expired" outcome, so the ask settles with an empty batch — a defined answer
 * that selected nothing — instead of a fabricated choice a human never made.
 * @returns the empty answer batch.
 */
export function unansweredAnswer(): QuestionAnswer {
  return { answers: [] }
}

/** Longest question text one report may carry, derived from the hub's own TTL budget. */
export const QUESTION_REPORT_MAX_LENGTH = 4_000

/** Whether a question request still fits the hub's question schema. */
export function isReportable(item: QuestionItem): boolean {
  return item.question.trim() !== '' && item.question.length <= QUESTION_REPORT_MAX_LENGTH
}

/** Deadline one pending question expires at, measured from the moment it was asked. */
export function questionExpiry(askedAt: number): number {
  return askedAt + QUESTION_TTL_MS
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask composed answerers one decision question. Returning an answer claims the
     * request; calling \`next()\` delegates to the rest of the chain.
     * @param request - the pending question batch.
     * @param next - the rest of the answerer chain.
     * @mode waterfall
     */
    'user-questions/request'(
      this: unknown,
      request: QuestionRequestShape,
      next: () => Promise<QuestionAnswer>,
    ): Promise<QuestionAnswer>
  }
}