/**
 * The team provider assembled as one task-board extension.
 *
 * Everything team-specific lives behind this factory: the board admits it
 * through the cordis `taskBoard` service, hands it the capability face, and
 * never learns what the provider does with it. The factory imports no board
 * internals — only the same-shape contract in `../core/contract.ts` — and it
 * probes the two optional capabilities instead of assuming them, so a board
 * revision without follow-up or rework loses those deliveries and reports the
 * loss rather than failing to mount.
 *
 * @module dsh-task-board-team/host/extension
 */
import {
  TASK_BOARD_API_VERSION,
  probeTaskBoardCapabilities,
  type TaskBoardCapabilities,
  type TaskBoardExtension,
  type TaskBoardExtensionActionRequest,
  type TaskBoardExtensionHost,
} from '../core/contract.ts'
import { TEAM_EXTENSION_ID } from '../core/identity.ts'
import { processTimers, type HostTimerFace } from '../core/timers.ts'
import type { SocketHandlers, SocketLike } from './channel.ts'
import type { BoundAgent } from './bindings.ts'
import type { TeamRuntimeSettings, TeamSyncService } from './service.ts'
import { TeamSyncService as SyncService } from './service.ts'
import type { TeamSetup, TeamSetupPatch } from './setup.ts'
import { buildTeamTools } from './tools.ts'
import type { HubClient } from './hub-client.ts'

export { TEAM_EXTENSION_ID }

export interface TeamExtensionOptions {
  /** Hub REST client. */
  hub: HubClient
  /** Live settings of this mount. */
  settings: () => TeamRuntimeSettings
  /** Resolve the bound members out of the dsh-agents ledger. */
  resolveAgents: () => Promise<{ agents: BoundAgent[]; problems: string[] }>
  /** Open the team channel. */
  connect: (sinceSeq: number, handlers: SocketHandlers) => Promise<SocketLike | undefined>
  /** Ask the board to run a card; absent means this Host cannot start executions. */
  requestRun?: (taskId: string) => void
  /** Configuration surface the settings section drives through these actions. */
  setup?: TeamSetup
  /** Non-secret configuration the settings section renders, read at publish time. */
  configuration?: () => Record<string, unknown>
  /** Called with the live service on start and with undefined on stop. */
  onService?: (service: TeamSyncService | undefined) => void
  /** Volatile master switch, read at use time. Absent means enabled. */
  enabled?: () => boolean
  /** Whether the deployment exposes the board's action seat (the run capability). */
  actionSeat?: () => boolean
  timers?: HostTimerFace
  now?: () => number
  uuid?: () => string
  log?: (message: string, detail?: unknown) => void
}

/** One identifier per run action the board's applier expects. */
function requestId(): string {
  return 'team-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36)
}

/**
 * Build the team provider extension.
 * @param options - deployment configuration for the integration.
 * @returns the extension the board registers.
 */
export function createTeamExtension(options: TeamExtensionOptions): TaskBoardExtension {
  let service: TeamSyncService | undefined
  let capabilities: TaskBoardCapabilities = { followUp: false, rework: false, run: false }
  const disposers: Array<() => void> = []
  const log = options.log ?? ((message: string, detail?: unknown) => {
    if (detail === undefined) console.error('[dsh-task-board-team] ' + message)
    else console.error('[dsh-task-board-team] ' + message, detail)
  })

  const start = (host: TaskBoardExtensionHost): void => {
    capabilities = probeTaskBoardCapabilities(host, options.actionSeat?.() === true)
    // The settings section renders the configured hub, team and agent bindings,
    // and those are not execution state: they ride the same published summary so
    // the browser reads one document instead of opening a second surface.
    const publishing: TaskBoardExtensionHost = options.configuration === undefined
      ? host
      : {
          ...host,
          publish: (summary) => { host.publish({ ...summary, configuration: options.configuration?.() ?? {} }) },
        }
    const live = new SyncService({
      host: publishing,
      hub: options.hub,
      settings: options.settings,
      resolveAgents: options.resolveAgents,
      connect: options.connect,
      capabilities,
      timers: options.timers ?? processTimers,
      now: options.now ?? (() => Date.now()),
      uuid: options.uuid ?? requestId,
      log,
      ...(options.requestRun === undefined ? {} : { requestRun: options.requestRun }),
    })
    service = live
    options.onService?.(live)
    disposers.push(host.events.onExecutionSettled(event => {
      void live.handleExecutionSettled(event).catch(error => { log('settlement write-back failed', error) })
    }))
    for (const tool of buildTeamTools(live)) {
      try {
        disposers.push(host.registerTool(tool))
      } catch (error) {
        // A missing tool registry costs the comment tool, not the provider.
        log('team_comment could not register', error)
      }
    }
    try {
      host.publish(live.summary() as unknown as Record<string, unknown>)
    } catch (error) {
      log('initial summary was refused', error)
    }
    void live.start().catch(error => { log('provider start failed', error) })
  }

  return {
    id: TEAM_EXTENSION_ID,
    apiVersion: TASK_BOARD_API_VERSION,
    enabled: () => options.enabled?.() ?? true,
    start,
    stop() {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* best-effort */ }
      }
      options.onService?.(undefined)
      service?.stop()
      service = undefined
    },
    async handleAction(request: TaskBoardExtensionActionRequest) {
      const live = service
      if (live === undefined) throw new Error('the team extension is not running')
      switch (request.action) {
        case 'set-token': {
          const setup = options.setup
          if (setup === undefined) throw new Error('this mount serves no configuration surface')
          const value = typeof request.payload?.token === 'string' ? request.payload.token : ''
          if (value.trim() === '') throw new Error('the Host Token must be a non-empty value')
          await setup.saveToken(value)
          return { ok: true, status: await setup.status() }
        }
        case 'clear-token': {
          const setup = options.setup
          if (setup === undefined) throw new Error('this mount serves no configuration surface')
          await setup.clearToken()
          return { ok: true, status: await setup.status() }
        }
        case 'setup-status': {
          const setup = options.setup
          if (setup === undefined) throw new Error('this mount serves no configuration surface')
          return { ok: true, status: await setup.status() }
        }
        case 'setup-save': {
          const setup = options.setup
          if (setup === undefined) throw new Error('this mount serves no configuration surface')
          const payload = request.payload ?? {}
          const patch: TeamSetupPatch = {}
          if (typeof payload.hubUrl === 'string') patch.hubUrl = payload.hubUrl
          if (typeof payload.teamId === 'string') patch.teamId = payload.teamId
          if (typeof payload.hostname === 'string') patch.hostname = payload.hostname
          if (typeof payload.questionWaitMinutes === 'number' && Number.isFinite(payload.questionWaitMinutes)) {
            patch.questionWaitMinutes = payload.questionWaitMinutes
          }
          if (Array.isArray(payload.agents)) {
            patch.agents = payload.agents.flatMap(entry => {
              if (typeof entry !== 'object' || entry === null) return []
              const row = entry as Record<string, unknown>
              if (typeof row.memberId !== 'string') return []
              return [{ memberId: row.memberId, ...(typeof row.name === 'string' ? { name: row.name } : {}) }]
            })
          }
          return { ok: true, status: await setup.save(patch) }
        }
        case 'refresh':
          return { ok: true, claimed: await live.sweep() }
        case 'comment': {
          const text = typeof request.payload?.text === 'string' ? request.payload.text : ''
          if (text.trim() === '') throw new Error('a comment needs non-empty text')
          return { ok: true, ...(await live.postComment({
            text,
            ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
          })) }
        }
        default:
          throw new Error('unknown team action "' + request.action + '"')
      }
    },
  }
}