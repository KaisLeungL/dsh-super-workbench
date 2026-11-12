/**
 * Host half of the task-board team provider extension.
 *
 * This package is an EXTERNAL PROVIDER EXTENSION for the task board
 * (@linxin666/dsh-client-ui-task-board). It owns the team-hub configuration,
 * the Host Token custody, the claim and lease lifecycle, the question routing
 * and the comment tool; it reaches the board through the board's provider
 * service and imports no board module.
 *
 * Two boundaries are load-bearing here: the Host Token is a credential (read
 * host-side only, never part of a snapshot, a published summary or an agent
 * payload, and the browser sends a pasted value exactly once), and only
 * user-questions/request is ever claimed. Tool permission approvals
 * (approval/request) belong to this machine's own security domain, so this file
 * registers no listener for them at all (team-hub/PROTOCOL.md section 6).
 *
 * @module dsh-task-board-team
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installTeamWaterfall } from './host/waterfall.ts'
import { resolveTaskBoardActionSeat, resolveTaskBoardHostFace } from './core/contract.ts'
import { processTimers } from './core/timers.ts'
import {
  agentsLedgerPath,
  readAgentsLedger,
  resolveBindings,
  type BoundAgent,
  type TeamAgentBinding,
} from './host/bindings.ts'
import { platformSocket, teamSocketHeaders, teamSocketUrl, type SocketHandlers, type SocketLike } from './host/channel.ts'
import { DEFAULT_TOKEN_REF, resolveHostToken } from './host/credentials.ts'
import { createTeamExtension } from './host/extension.ts'
import { HubClient } from './host/hub-client.ts'
import { normalizeBindings, TeamSetup } from './host/setup.ts'
import type { TeamExtensionSummary, TeamSyncService } from './host/service.ts'

/** npm identity shared by every install source of this package. */
export const PACKAGE_NAME = '@linxin666/dsh-client-ui-task-board-team'

/** Order of this extension's announcement section, just after the board's own. */
const SECTION_ORDER = 260

/** The tool this extension registers, named in its announcement. */
export const TEAM_TOOL_NAME = 'team_comment'

/** Model-facing announcement: what the extension does and the words that name it. */
export const TEAM_GUIDANCE = '本机已安装 dsh-task-board-team 扩展（DSH Web GUI 任务看板的团队协作提供方）：把云端 team-hub 上指派给本机 dsh-agents 成员的 issue 领取为看板镜像卡并在本机执行，执行结算写回 hub，执行会话里的 ask_user_question 会转给团队审阅人回答；另注册 team_comment 工具供模型发表评论，评论里 @ 到本机 Agent 时会作为后续消息投递进会话。工具权限审批一律只在本机处理，绝不进入 hub。用户提到「团队任务 / team-hub / 领取团队 issue / 给团队留言」时即指本扩展，请据此协作。'

/** The single-instance guard key; two install sources must not double register. */
const MOUNTED_KEY = Symbol.for('dsh-task-board-team:mounted')

/** One configured member binding. */
export interface TeamAgentBindingInput {
  /** dsh-agents member id to bind as a team Agent. */
  memberId: string
  /** Name the hub resolves mentions by; empty falls back to the member's own name. */
  name?: string
}

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the extension. */
  enabled?: Volatile<boolean>
  /** Whether this extension announces itself in every agent system prompt. */
  announceToAgent?: Volatile<boolean>
  /** Team-hub base URL, e.g. https://hub.example.com. */
  hubUrl?: Volatile<string>
  /** Team id the Host registers into. */
  teamId?: Volatile<string>
  /**
   * Workspace this mount runs its mirror cards in; empty falls back to the
   * workspace the member's dsh-agents team pins.
   *
   * A card with neither cannot be started by the board, and the hub keeps its
   * issue `running` for as long as this Host holds the lease, so this Host claims
   * nothing until one resolves and reports that in its summary instead.
   */
  workspaceId?: Volatile<string>
  /** Credential reference the Host Token is stored under. */
  hostTokenRef?: Volatile<string>
  /** dsh-agents members bound as team Agents on this machine. */
  agents?: Volatile<TeamAgentBindingInput[]>
  /** Hostname this Host registers under; empty means the platform hostname. */
  hostname?: Volatile<string>
  /**
   * Optional local fallback wait for a claimed question, in minutes.
   *
   * Zero (the default) waits for the hub's own terminal state — answered,
   * expired or withdrawn — which is what lets a member answer from a lock-screen
   * push hours later. A positive value withdraws the question after that long and
   * hands the ask back to the local answerer.
   */
  questionWaitMinutes?: Volatile<number>
}

/** Profile-patch shape of {@link Config}. */
export interface ConfigInput {
  enabled?: boolean
  announceToAgent?: boolean
  hubUrl?: string
  teamId?: string
  workspaceId?: string
  hostTokenRef?: string
  agents?: TeamAgentBindingInput[]
  hostname?: string
  questionWaitMinutes?: number
}

/** Schema default of the announcement switch. */
export const DEFAULT_ANNOUNCE_TO_AGENT = false

/** Schema default of the Host Token reference. */
export const DEFAULT_HOST_TOKEN_REF = DEFAULT_TOKEN_REF

const AgentBindingSchema = z.object({
  memberId: z.string(),
  name: z.string().default(''),
})

export const Config: z<ConfigInput, Config> = z.object({
  enabled: z.boolean().default(true).volatile(),
  announceToAgent: z.boolean().default(false).volatile(),
  hubUrl: z.string().default('').volatile(),
  teamId: z.string().default('').volatile(),
  workspaceId: z.string().default('').volatile(),
  hostTokenRef: z.string().default(DEFAULT_TOKEN_REF).volatile(),
  agents: z.array(AgentBindingSchema).default([]).volatile(),
  hostname: z.string().default('').volatile(),
  questionWaitMinutes: z.number().default(0).volatile(),
})
/**
 * Read one config field's live value.
 * @param field - the field as the Loader handed it.
 * @param fallback - value when the field is absent.
 * @returns the effective value.
 */
export function readConfigField<T>(field: Volatile<T> | T | undefined, fallback: T): T {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof (field as { get?: unknown }).get === 'function') {
    return (field as Volatile<T>).get() as T
  }
  return field as T
}

/** The effective settings of one mount. */
export interface TeamProviderSettings {
  enabled: boolean
  announceToAgent: boolean
  hubUrl: string
  teamId: string
  workspaceId: string
  hostTokenRef: string
  agents: readonly TeamAgentBinding[]
  hostname: string
  questionWaitMinutes: number
}

/**
 * Resolve the effective settings of one mount.
 * @param config - the row's config as the Host handed it.
 * @param hostname - platform hostname fallback.
 * @returns the settings the registration consumes.
 */
export function resolveProviderSettings(config?: Config, hostname = ''): TeamProviderSettings {
  const bindings = readConfigField<TeamAgentBindingInput[]>(config?.agents, []).map(entry => ({
    memberId: typeof entry?.memberId === 'string' ? entry.memberId : '',
    ...(typeof entry?.name === 'string' && entry.name !== '' ? { name: entry.name } : {}),
  }))
  const configured = readConfigField(config?.hostname, '').trim()
  return {
    enabled: readConfigField(config?.enabled, true),
    announceToAgent: readConfigField(config?.announceToAgent, DEFAULT_ANNOUNCE_TO_AGENT),
    hubUrl: readConfigField(config?.hubUrl, '').trim(),
    teamId: readConfigField(config?.teamId, '').trim(),
    workspaceId: readConfigField(config?.workspaceId, '').trim(),
    hostTokenRef: readConfigField(config?.hostTokenRef, DEFAULT_TOKEN_REF).trim(),
    agents: normalizeBindings(bindings),
    hostname: configured === '' ? hostname : configured,
    questionWaitMinutes: Math.max(0, Math.trunc(readConfigField(config?.questionWaitMinutes, 0))),
  }
}

/** The slice of the system-prompt service this extension announces through. */
interface SystemPromptFace {
  section(spec: { name: string; order: number; text: string | ((context: { scope?: unknown }) => string) }): () => void
}

/** The lookup face of the tool registry, when this deployment serves one. */
interface ToolLookupFace {
  get(name: string, scope?: unknown): unknown
}

/**
 * Resolve an optional service by name.
 * @param ctx - host context.
 * @param name - service name.
 * @returns the service, or undefined when this deployment serves none.
 */
function resolveOptional<T>(ctx: Context, name: string): T | undefined {
  try {
    const get = (ctx as { get?: (service: string) => unknown }).get
    if (typeof get !== 'function') return undefined
    return get.call(ctx, name) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the announcement text, or undefined when the tool it names is not
 * reachable: guidance for a tool the session cannot see only wastes context.
 * @param ctx - host context.
 * @returns the text to publish, or undefined.
 */
export function resolveAnnouncement(ctx: Context): string | undefined {
  const tools = resolveOptional<ToolLookupFace>(ctx, 'tools')
  if (tools === undefined || typeof tools.get !== 'function') return undefined
  try {
    return tools.get(TEAM_TOOL_NAME) === undefined ? undefined : TEAM_GUIDANCE
  } catch {
    return undefined
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Volatile config values were committed into the running fiber without a
     * remount; dispatched to the owning fiber only.
     * @param paths - changed config paths as key arrays.
     * @mode emit
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/**
 * Mount the plugin once per Host process, whichever install source loaded it.
 * @param key - the process-wide guard key.
 * @param apply - the real entry.
 * @returns the guarded entry.
 */
export function mountOnce<T extends (ctx: Context, config?: Config) => void>(key: symbol, apply: T): T {
  return ((ctx: Context, config?: Config) => {
    const global = globalThis as unknown as Record<symbol, unknown>
    if (global[key] === true) return
    global[key] = true
    try {
      apply(ctx, config)
    } catch (error) {
      global[key] = false
      throw error
    }
  }) as T
}

/**
 * Resolve the local agents the configured bindings name.
 * @param settings - live settings of this mount.
 * @returns the resolved agents and one problem line per unusable binding.
 */
async function resolveBoundAgents(settings: TeamProviderSettings): Promise<{ agents: BoundAgent[]; problems: string[] }> {
  const view = await readAgentsLedger(agentsLedgerPath())
  const resolved = resolveBindings(settings.agents, view)
  return {
    agents: resolved.agents,
    problems: [...(view.problem === undefined ? [] : [view.problem]), ...resolved.problems],
  }
}
export const apply = mountOnce(MOUNTED_KEY, applyImpl)

/**
 * Activate the extension's host half.
 *
 * The provider is admitted through the board's own registration service, so it
 * follows the board's master switch as well as this extension's. Registration
 * lives behind a cordis dependency scope (ctx.inject) because the Host loads
 * plugin rows in an order this package does not own: the board's service may
 * genuinely not exist yet when this row activates, and the scope mounts when it
 * appears and unloads when it is withdrawn.
 * @param ctx - the plugin context.
 * @param config - resolved plugin config.
 */
function applyImpl(ctx: Context, config?: Config): void {
  const fallbackHostname = platformHostname()
  const settings = (): TeamProviderSettings => resolveProviderSettings(config, fallbackHostname)

  let injection: ReturnType<Context['inject']> | undefined
  let mounted: string | undefined
  let liveService: TeamSyncService | undefined
  let disposeSection: (() => void) | undefined
  let announceLive = false
  let disposed = false

  const provider = (): TeamExtensionSummary | undefined => liveService?.summary()

  const setup = new TeamSetup({
    ctx,
    current: () => {
      const current = settings()
      return {
        hubUrl: current.hubUrl,
        teamId: current.teamId,
        agents: current.agents,
        hostname: current.hostname,
        tokenRef: current.hostTokenRef,
        questionWaitMinutes: current.questionWaitMinutes,
      }
    },
    provider,
    reload: () => { requestSync() },
  })

  /** The socket factory: the token is resolved per connection, so a rotation works. */
  const connect = async (sinceSeq: number, handlers: SocketHandlers): Promise<SocketLike | undefined> => {
    const current = settings()
    if (current.hubUrl === '' || current.teamId === '') return undefined
    const token = await resolveHostToken(ctx, current.hostTokenRef)
    if (token === undefined) return undefined
    return platformSocket(teamSocketUrl(current.hubUrl, current.teamId, sinceSeq), handlers, teamSocketHeaders(token))
  }

  /** Ask the board to run one card through its own action applier. */
  const requestRun = (taskId: string): void => {
    const seat = resolveTaskBoardActionSeat(ctx)
    if (seat === undefined) throw new Error('this board revision serves no action applier, so a claimed card cannot be started')
    seat.apply('team-run-' + taskId + '-' + String(Date.now()), { kind: 'run', taskId }, 'team-hub')
  }

  // A configuration write from the settings section republishes the summary, so
  // the card renders what was just stored instead of a stale document.
  setup.onWrite = () => { liveService?.publishNow() }

  const teardownProvider = (): void => {
    const current = injection
    injection = undefined
    mounted = undefined
    if (current !== undefined) void current.dispose()
  }

  const sync = async (): Promise<void> => {
    if (disposed) return
    const next = settings()
    const wantAnnounce = next.enabled && next.announceToAgent
    if (wantAnnounce !== announceLive) {
      announceLive = wantAnnounce
      try { disposeSection?.() } catch { /* best-effort */ }
      disposeSection = undefined
      if (wantAnnounce) {
        const systemPrompt = resolveOptional<SystemPromptFace>(ctx, 'systemPrompt')
        const text = resolveAnnouncement(ctx)
        if (systemPrompt !== undefined && text !== undefined) {
          try {
            disposeSection = systemPrompt.section({ name: 'plugin:task-board-team', order: SECTION_ORDER, text })
          } catch {
            // A refused section costs the announcement only.
          }
        }
      }
    }
    if (!next.enabled) {
      teardownProvider()
      return
    }
    const desired = JSON.stringify({
      hubUrl: next.hubUrl,
      teamId: next.teamId,
      hostTokenRef: next.hostTokenRef,
      agents: next.agents,
      hostname: next.hostname,
    })
    if (desired === mounted) return
    teardownProvider()
    mounted = desired
    injection = ctx.inject(['taskBoard'], (scope: Context) => {
      scope.effect(() => {
        const face = resolveTaskBoardHostFace(scope)
        if (face === undefined) {
          console.error('[dsh-task-board-team] the taskBoard service does not answer the registration contract')
          return () => {}
        }
        void setup.refreshToken().then(() => { liveService?.publishNow() }).catch(() => {})
        const dispose = face.registerExtension(createTeamExtension({
          hub: new HubClient({
            hubUrl: () => settings().hubUrl,
            teamId: () => settings().teamId,
            token: async () => await resolveHostToken(ctx, settings().hostTokenRef),
          }),
          settings: () => ({
            enabled: settings().enabled,
            hostname: settings().hostname,
            bindings: settings().agents,
            workspaceId: settings().workspaceId,
            questionWaitMinutes: settings().questionWaitMinutes,
          }),
          resolveAgents: async () => await resolveBoundAgents(settings()),
          connect,
          requestRun,
          actionSeat: () => resolveTaskBoardActionSeat(scope) !== undefined,
          configuration: () => ({
            hubUrl: settings().hubUrl,
            teamId: settings().teamId,
            hostname: settings().hostname,
            tokenConfigured: setup.tokenConfigured(),
            questionWaitMinutes: settings().questionWaitMinutes,
          }),
          timers: processTimers,
          enabled: () => settings().enabled,
          setup,
          onService: service => { liveService = service },
          log: (message, detail) => {
            if (detail === undefined) console.error('[dsh-task-board-team] ' + message)
            else console.error('[dsh-task-board-team] ' + message, detail)
          },
        }))
        return () => {
          liveService = undefined
          dispose()
        }
      }, 'task-board-team: provider registration')
    })
  }

  /** Serialize sync requests: a config write and a volatile commit can arrive together. */
  let chain: Promise<void> = Promise.resolve()
  const requestSync = (): void => {
    chain = chain.then(() => sync()).catch(error => { console.error('[dsh-task-board-team] sync failed', error) })
  }

  ctx.on('loader/volatile-update', () => { requestSync() })
  ctx.on('credentials/reference-updated', () => { requestSync() })

  // The one waterfall this extension claims (see host/waterfall.ts). Tool
  // permission approvals have no listener here by design.
  installTeamWaterfall(ctx, () => liveService?.questions)

  ctx.effect(() => {
    requestSync()
    return () => {
      disposed = true
      teardownProvider()
      try { disposeSection?.() } catch { /* best-effort */ }
      disposeSection = undefined
    }
  }, 'task-board-team: provider lifecycle')
}

/** The platform hostname this Host registers under. */
function platformHostname(): string {
  return process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? 'dsh-host'
}