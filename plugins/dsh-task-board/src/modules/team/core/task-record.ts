/**
 * Structural view of the task-board vocabulary this extension reads.
 *
 * The extension is a separate bundle and may not import the board's internals,
 * so it restates the record shape the provider contract hands it. These are
 * read-only structural declarations: the board's own values satisfy them and
 * nothing here is constructed by the board.
 *
 * @module dsh-task-board-team/core/task-record
 */

/** Column a card occupies. */
export type TaskStatus = import('../../../core/tasks.ts').TaskStatus

/** Settlement of one execution. */
export type ExecutionOutcome = 'succeeded' | 'failed' | 'cancelled'

/** One execution of a card, as a provider reads it. */
export interface ExecutionRecord {
  /** Stable execution id. */
  id: string
  /** Session the execution runs in, once one was opened. */
  sessionId?: string | undefined
  /** Instant the execution started (ms epoch). */
  startedAt: number
  /** Instant the execution settled (ms epoch), absent while it runs. */
  endedAt?: number | undefined
  /** Settlement, absent while the execution is still running. */
  result?: ExecutionOutcome | undefined
  /** Human failure text when the run failed. */
  error?: string | undefined
  /** Rework instructions this execution carries, when a run was sent back. */
  rework?: { instructions?: string } | undefined
}

/** One card, as a provider reads it through the capability face. */
export interface TaskRecord {
  id: string
  title: string
  description: string
  prompt: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  parentId?: string
  workspaceId?: string
  /** Agent preset the card's execution must be composed from. */
  mode?: string
  hidden?: boolean
  archivedAt?: number
  executions: ExecutionRecord[]
  tags?: ReadonlyArray<{ name: string }>
  /** Opaque provider payloads, keyed by extension id. */
  integrations?: Record<string, unknown>
}

/** Whether one card still occupies a column the board calls unfinished. */
export function isOpenTask(task: TaskRecord): boolean {
  return task.archivedAt === undefined && task.status !== 'done' && task.status !== 'failed'
}

/** Whether one card currently has an execution the board has not settled. */
export function hasOpenExecution(task: TaskRecord): boolean {
  return task.executions.some(execution => execution.result === undefined)
}
