/**
 * Same-shape restatement of the task board's external-provider contract.
 *
 * The board owns this contract (`packages/dsh-task-board/src/core/extension.ts`)
 * and this package may not import the board's internals, so every type and
 * constant the extension consumes is restated here with an identical shape and
 * resolved at runtime through the shared cordis service name. Nothing in this
 * module is a value import of a board package: the declarations are erased and
 * the service lookup is a plain property read.
 *
 * Two capabilities ride the contract as OPTIONAL members (the API version stays
 * 1): `sessions.followUp` and `tasks.rework`. A provider probes for them and
 * degrades visibly where a deployment serves neither, which is what
 * {@link probeTaskBoardCapabilities} reports.
 *
 * @module dsh-task-board-team/core/contract
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ExecutionOutcome, TaskRecord, TaskStatus } from './task-record.ts'

/** Cordis service name the board's host and browser halves each publish. */
export const TASK_BOARD_SERVICE_NAME = 'taskBoard'

/** Contract version this extension was built against. */
export const TASK_BOARD_API_VERSION = 1

/** Child seat a provider registers its task-detail section into. */
export const TASK_BOARD_DETAIL_SECTION = 'task-board.detail.section'
/** Child seat a provider registers its settings section into. */
export const TASK_BOARD_SETTINGS_SECTION = 'task-board.settings.section'
/** Child seat a provider registers its card decoration into. */
export const TASK_BOARD_CARD_DECORATION = 'task-board.card.decoration'

/** Largest free text one provider call pushes into an execution, in characters. */
export const TASK_BOARD_MESSAGE_MAX_LENGTH = 4_000

/** One opaque provider payload the board stores without interpreting. */
export type TaskBoardExtensionPayload = Record<string, unknown>

/** One action the browser half dispatches over the board's same-origin channel. */
export interface TaskBoardExtensionActionRequest {
  /** Id of the extension the action belongs to. */
  extensionId: string
  /** Provider-owned action name, routed back to this extension's handleAction. */
  action: string
  /** Task the action targets, when it targets one. */
  taskId?: string
  /** Opaque provider payload. */
  payload?: TaskBoardExtensionPayload
}

/** Deliver one extension action through the board's same-origin action channel. */
export type TaskBoardExtensionDispatch = (request: TaskBoardExtensionActionRequest) => Promise<boolean>

/** Draft one provider creates a task from. */
export interface TaskBoardTaskDraft {
  title: string
  description: string
  prompt: string
  /** Column the created card opens in; absent means the board default. */
  status?: TaskStatus
  /** Parent card id, when the provider materializes a subtask. */
  parentId?: string
  /** Workspace the execution must run in; absent leaves the board's own rules. */
  workspaceId?: string
  /**
   * Agent preset the created card's execution must be composed from.
   *
   * Optional in the contract like the two capability members, so a provider
   * passes it and then CHECKS it survived: a board revision that serves no draft
   * preset drops the field silently, and a card that fell back to the deployment
   * default must not be started as if the member's own preset had been pinned.
   */
  mode?: string
  /** Pinned model for the created card's execution. */
  model?: string
  /** Reasoning effort for that model route. */
  reasoningEffort?: string
}

/** Options of {@link TaskBoardTasksFace.create}. */
export interface TaskBoardCreateOptions {
  /** Opaque payload stored under the creating extension's id. */
  payload?: TaskBoardExtensionPayload
  /** Create the card off-board: it exists in the ledger but is never shown. */
  hidden?: boolean
}

/** One task linked to an extension, with that extension's own payload. */
export interface TaskBoardLinkedTask {
  task: TaskRecord
  payload: TaskBoardExtensionPayload
}

/** Task reads and writes the board grants an extension. */
export interface TaskBoardTasksFace {
  /** Every task in the ledger, most recent mutation last. */
  list(): readonly TaskRecord[]
  /** One task by id, or undefined. */
  get(taskId: string): TaskRecord | undefined
  /** Create a task through the board's own creation gate. Throws on refusal. */
  create(draft: TaskBoardTaskDraft, options?: TaskBoardCreateOptions): TaskRecord
  /** Patch a task's content through the board's content gate. Throws when frozen. */
  patchContent(taskId: string, patch: { title?: string; description?: string; prompt?: string }): void
  /** Move a task through the board's status gates. Throws on refusal. */
  setStatus(taskId: string, status: TaskStatus, initiator?: string): void
  /** Every task carrying this extension's payload. */
  linked(): readonly TaskBoardLinkedTask[]
  /**
   * Re-run an executed card in its ORIGINAL session with rework instructions.
   *
   * Optional in the contract: a board built against the earlier shape serves
   * none, so a provider probes before using it.
   */
  rework?(taskId: string, instructions: string, initiator?: string): void
}

/** Execution-session face: delivery into a run the board already has. */
export interface TaskBoardSessionsFace {
  /** Queue one follow-up user message into the card's current or latest session. */
  followUp(taskId: string, text: string): Promise<void>
}

/** Storage face for one extension's own payload on a task. */
export interface TaskBoardIntegrationFace {
  /** Read this extension's payload, or undefined when the task carries none. */
  read(taskId: string): TaskBoardExtensionPayload | undefined
  /** Shallow-merge this extension's payload into the task. */
  write(taskId: string, payload: TaskBoardExtensionPayload): void
}

/** Status-change notification. */
export interface TaskBoardStatusChangedEvent {
  taskId: string
  status: TaskStatus
  previous: TaskStatus
  initiator?: string
}

/** Execution-settlement notification. */
export interface TaskBoardExecutionSettledEvent {
  taskId: string
  executionId: string
  outcome: ExecutionOutcome
  error?: string
}

/** Task-deletion notification. */
export interface TaskBoardTaskDeletedEvent {
  taskId: string
}

/** Event subscriptions an extension registers for; every callback runs isolated. */
export interface TaskBoardEventFace {
  onStatusChanged(callback: (event: TaskBoardStatusChangedEvent) => void): () => void
  onExecutionSettled(callback: (event: TaskBoardExecutionSettledEvent) => void): () => void
  onTaskDeleted(callback: (event: TaskBoardTaskDeletedEvent) => void): () => void
}

/** Host capability face handed to one extension while it is started. */
export interface TaskBoardExtensionHost {
  tasks: TaskBoardTasksFace
  /** Delivery into a card's execution session; optional member of the contract. */
  sessions?: TaskBoardSessionsFace
  integration: TaskBoardIntegrationFace
  events: TaskBoardEventFace
  /** Publish this extension's read-only summary into the board snapshot. */
  publish(summary: TaskBoardExtensionPayload): void
  /** Register one model-visible tool; the returned disposer unregisters it. */
  registerTool(definition: ToolDefinition): () => void
}

/** One external provider contributed to the task board. */
export interface TaskBoardExtension {
  /** Stable extension id; also the key of this extension's integration payload. */
  readonly id: string
  /** Contract version this extension was built against. */
  readonly apiVersion: number
  /** Volatile per-extension switch; absent means enabled. Read at use time. */
  enabled?(): boolean
  /** Acquire the capability face and start any provider-side work. */
  start?(host: TaskBoardExtensionHost): void
  /** Release provider-side work. Never clears stored data. */
  stop?(): void
  /** Route one dispatched action; the returned value goes back to the dispatcher. */
  handleAction?(request: TaskBoardExtensionActionRequest): unknown | Promise<unknown>
}

/** Which optional capabilities the board serving this deployment really has. */
export interface TaskBoardCapabilities {
  /** The board can deliver a follow-up message into an execution session. */
  followUp: boolean
  /** The board can re-run an executed card in its own session. */
  rework: boolean
  /** The host process exposes the board's own action surface (see {@link TaskBoardActionSeat}). */
  run: boolean
}

/**
 * The board's in-process action seat.
 *
 * The provider contract covers everything this extension does EXCEPT starting an
 * execution: the capability face has create, patch, move, follow-up and rework,
 * and no member that runs a card. The board's host face does carry the action
 * applier the browser and the remote bridge drive it through, so the row probes
 * for it and records the capability as absent when a deployment serves none —
 * the mirror card is still created and the settings card says this Host cannot
 * start it.
 */
export interface TaskBoardActionSeat {
  /** Apply one board action through every gate the board already has. */
  apply(requestId: string, action: Record<string, unknown>, initiator?: string): unknown
}

/**
 * Probe the optional capabilities of the capability face one board handed over.
 * @param host - the capability face a provider was started with.
 * @param run - whether the row found the board's action seat.
 * @returns which optional capabilities this deployment really serves.
 */
export function probeTaskBoardCapabilities(host: TaskBoardExtensionHost, run: boolean): TaskBoardCapabilities {
  return {
    followUp: typeof host.sessions?.followUp === 'function',
    rework: typeof host.tasks.rework === 'function',
    run,
  }
}

/** Host-half service face published under {@link TASK_BOARD_SERVICE_NAME}. */
export interface TaskBoardHostFace {
  /** Admit one provider extension; the returned disposer releases it. */
  registerExtension(extension: TaskBoardExtension): () => void
  /** Whether the board currently runs a given extension. */
  isExtensionEnabled(extensionId: string): boolean
  /** The board's in-process action seat, when this board revision serves one. */
  apply?(requestId: string, action: Record<string, unknown>, initiator?: string): unknown
}

/** The narrow context seat the resolvers need. */
export interface ContextSeat {
  get(name: string): unknown
}

/**
 * Resolve the board's host-half face by service name.
 * @param ctx - host context.
 * @returns the host face, or undefined when the board is not loaded.
 */
export function resolveTaskBoardHostFace(ctx: ContextSeat): TaskBoardHostFace | undefined {
  try {
    const face = ctx.get(TASK_BOARD_SERVICE_NAME) as TaskBoardHostFace | undefined
    return face !== undefined && typeof (face as { registerExtension?: unknown }).registerExtension === 'function'
      ? face
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the board's in-process action seat from the same service.
 * @param ctx - host context.
 * @returns the seat, or undefined when this board revision serves no applier.
 */
export function resolveTaskBoardActionSeat(ctx: ContextSeat): TaskBoardActionSeat | undefined {
  try {
    const face = ctx.get(TASK_BOARD_SERVICE_NAME) as TaskBoardActionSeat | undefined
    return face !== undefined && typeof (face as { apply?: unknown }).apply === 'function' ? face : undefined
  } catch {
    return undefined
  }
}
/** Owner props of the task-detail seat. */
export interface TaskBoardDetailSectionProps {
  task: TaskRecord
  dispatch: TaskBoardExtensionDispatch
}

/** Owner props of the settings seat. */
export interface TaskBoardSettingsSectionProps {
  dispatch: TaskBoardExtensionDispatch
}

/** Owner props of the card-decoration seat. */
export interface TaskBoardCardDecorationProps {
  task: TaskRecord
}

/** Board mirror an extension's browser half observes. */
export interface TaskBoardClientMirror {
  /** Whether the board's master switch currently runs the extension faces. */
  enabled: boolean
  /** Tasks the board currently holds. */
  tasks: readonly TaskRecord[]
  /** Published extension summaries, keyed by extension id. */
  extensions: Readonly<Record<string, unknown>>
}

/** Whether a task should be shown on the board; false hides it. */
export type TaskBoardVisibilityPredicate = (task: TaskRecord) => boolean

/** Client capability face the board's browser half provides. */
export interface TaskBoardClientFace {
  /** Deliver one action through the board's same-origin action channel. */
  dispatch(request: TaskBoardExtensionActionRequest): Promise<boolean>
  /** Register one card visibility predicate; the returned disposer removes it. */
  registerVisibility(predicate: TaskBoardVisibilityPredicate): () => void
  /** Subscribe to the board mirror. */
  subscribe(callback: (mirror: TaskBoardClientMirror) => void): () => void
  /** Read the current board mirror. */
  snapshot(): TaskBoardClientMirror
}

/**
 * Resolve the board's browser-half client face by service name.
 * @param ctx - browser context.
 * @returns the client face, or undefined when the board is not loaded.
 */
export function resolveTaskBoardClientFace(ctx: ContextSeat): TaskBoardClientFace | undefined {
  try {
    const face = ctx.get(TASK_BOARD_SERVICE_NAME) as TaskBoardClientFace | undefined
    return face !== undefined && typeof (face as { dispatch?: unknown }).dispatch === 'function' ? face : undefined
  } catch {
    return undefined
  }
}