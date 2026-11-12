/**
 * The configuration surface this extension's settings section drives.
 *
 * One module owns every write, so the settings section, a profile patch and an
 * agent all produce the same stored value: the hub URL, the team id and the
 * member bindings are volatile fields of this plugin's own settings entry, and
 * the Host Token goes to the credential store instead (`credentials.ts`). The
 * read half reports status only — never a token, never a value a browser could
 * replay.
 *
 * @module dsh-task-board-team/host/setup
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TeamAgentBinding } from './bindings.ts'
import { clearHostToken, describeHostToken, setHostToken } from './credentials.ts'
import type { TeamExtensionSummary } from './service.ts'

/** Settings entry ids this package's rows carry, most specific first. */
export const TEAM_ENTRY_IDS: readonly string[] = ['web-ui-task-board-team', 'ui-task-board-team', 'task-board-team']

/** One entry the settings surface reports. */
interface SettingsDescriptor {
  ns?: unknown
  value?: unknown
  revision?: unknown
}

/** One path-addressed edit the settings surface accepts. */
type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

/** The slice of the Host settings surface this extension uses. */
export interface SettingsFace {
  readonly writable: boolean
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/**
 * Resolve the optional settings service.
 * @param ctx - host context.
 * @returns the surface, or undefined when this deployment serves none.
 */
export function resolveSettingsFace(ctx: Context): SettingsFace | undefined {
  try {
    const get = (ctx as { get?: (name: string) => unknown }).get
    if (typeof get !== 'function') return undefined
    const face = get.call(ctx, 'settings') as SettingsFace | undefined
    if (face === undefined) return undefined
    return typeof face.describe === 'function' && typeof face.mutate === 'function' ? face : undefined
  } catch {
    return undefined
  }
}

/**
 * Find this extension's own entry in the settings surface.
 * @param face - the settings surface.
 * @returns the entry id and its current revision, or undefined.
 */
export function findTeamSettingsEntry(face: SettingsFace): { ns: string; revision: number } | undefined {
  let descriptors: SettingsDescriptor[]
  try {
    descriptors = face.describe({ redactSecrets: true })
  } catch {
    return undefined
  }
  for (const wanted of TEAM_ENTRY_IDS) {
    const hit = descriptors.find(descriptor => descriptor.ns === wanted)
    if (hit !== undefined) {
      return { ns: wanted, revision: typeof hit.revision === 'number' ? hit.revision : 0 }
    }
  }
  return undefined
}

/** What the settings section renders. */
export interface TeamSetupStatus {
  /** Configured hub base URL. */
  hubUrl: string
  /** Configured team id. */
  teamId: string
  /** Whether a Host Token is configured; never the value. */
  token: { configured: boolean; writable: boolean; ref: string; source?: string }
  /** Configured member bindings. */
  agents: readonly TeamAgentBinding[]
  /** Hostname this Host registers under. */
  hostname: string
  /** Optional local fallback wait for a claimed question, in minutes; 0 means none. */
  questionWaitMinutes: number
  /** The live connection and capability summary, when the provider is mounted. */
  provider?: TeamExtensionSummary
  /** Whether this deployment exposes a settings form for this extension. */
  writable: boolean
}

/** The settings a caller may write. */
export interface TeamSetupPatch {
  hubUrl?: string
  teamId?: string
  agents?: readonly TeamAgentBinding[]
  hostname?: string
  questionWaitMinutes?: number
}

export interface TeamSetupOptions {
  ctx: Context
  /** Current configured values, read live from the plugin config. */
  current: () => {
    hubUrl: string
    teamId: string
    agents: readonly TeamAgentBinding[]
    hostname: string
    tokenRef: string
    questionWaitMinutes?: number
  }
  /** The live provider summary, when the extension is mounted. */
  provider: () => TeamExtensionSummary | undefined
  /** Called after a successful write so the mount can follow it immediately. */
  reload?: () => void
}

/** The configuration surface one mount owns. */
export class TeamSetup {
  readonly #options: TeamSetupOptions
  /** Last known credential facts; refreshed on mount and after every write. */
  #token: { configured: boolean; writable: boolean; ref: string; source?: string } | undefined
  /** Called after any write so the live mount can republish its summary. */
  onWrite: (() => void) | undefined

  constructor(options: TeamSetupOptions) {
    this.#options = options
  }

  /** Whether a Host Token is currently configured, as of the last refresh. */
  tokenConfigured(): boolean {
    return this.#token?.configured === true
  }

  /** Re-read the credential facts without exposing the value. */
  async refreshToken(): Promise<void> {
    const current = this.#options.current()
    this.#token = await describeHostToken(this.#options.ctx, current.tokenRef)
  }

  /**
   * Store one pasted Host Token.
   *
   * This is the only path a token value travels: the browser sends it once, the
   * host half stores it in the credential seam, and nothing ever reads it back
   * out to a client.
   * @param value - the token the operator pasted.
   */
  async saveToken(value: string): Promise<void> {
    const trimmed = value.trim()
    if (trimmed === '') throw new Error('the Host Token must be a non-empty value')
    const current = this.#options.current()
    await setHostToken(this.#options.ctx, current.tokenRef, trimmed)
    await this.refreshToken()
    this.onWrite?.()
  }

  /** Remove the stored Host Token. */
  async clearToken(): Promise<void> {
    const current = this.#options.current()
    await clearHostToken(this.#options.ctx, current.tokenRef)
    await this.refreshToken()
    this.onWrite?.()
  }

  /** Read the current configuration status. */
  async status(): Promise<TeamSetupStatus> {
    const current = this.#options.current()
    const token = await describeHostToken(this.#options.ctx, current.tokenRef)
    this.#token = token
    return {
      hubUrl: current.hubUrl,
      teamId: current.teamId,
      agents: current.agents.map(binding => ({ ...binding })),
      hostname: current.hostname,
      questionWaitMinutes: current.questionWaitMinutes ?? 0,
      token,
      writable: resolveSettingsFace(this.#options.ctx)?.writable !== false,
      ...(this.#options.provider() === undefined ? {} : { provider: this.#options.provider() as TeamExtensionSummary }),
    }
  }

  /**
   * Store the hub URL, the team id, the member bindings or the hostname.
   *
   * Every field is written in one batch against the revision just read, so a
   * hub URL and the team it belongs to cannot be stored split by a concurrent
   * edit, and the Loader commits the result into the running mount without a
   * restart.
   * @param patch - the fields to replace.
   * @returns the status after the write.
   */
  async save(patch: TeamSetupPatch): Promise<TeamSetupStatus> {
    const operations: SettingsPathOp[] = []
    if (patch.hubUrl !== undefined) operations.push({ op: 'set', path: ['hubUrl'], value: normalizeHubUrl(patch.hubUrl) })
    if (patch.teamId !== undefined) operations.push({ op: 'set', path: ['teamId'], value: patch.teamId.trim() })
    if (patch.hostname !== undefined) operations.push({ op: 'set', path: ['hostname'], value: patch.hostname.trim() })
    if (patch.agents !== undefined) operations.push({ op: 'set', path: ['agents'], value: normalizeBindings(patch.agents) })
    if (patch.questionWaitMinutes !== undefined) {
      operations.push({ op: 'set', path: ['questionWaitMinutes'], value: Math.max(0, Math.trunc(patch.questionWaitMinutes)) })
    }
    if (operations.length > 0) {
      const face = resolveSettingsFace(this.#options.ctx)
      if (face === undefined) throw new Error('this deployment serves no settings surface, so the team settings cannot be written')
      if (face.writable === false) throw new Error('this deployment serves configuration read-only')
      const entry = findTeamSettingsEntry(face)
      if (entry === undefined) throw new Error('this deployment exposes no settings form for the team extension')
      await face.mutate(entry.ns, operations, entry.revision)
    }
    this.#options.reload?.()
    this.onWrite?.()
    return await this.status()
  }
}

/**
 * Normalize one hub URL to an absolute http(s) base without a trailing slash.
 * @param raw - the value the operator typed.
 * @returns the normalized URL.
 * @throws when the value is not a usable absolute URL.
 */
export function normalizeHubUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('the hub URL must be an absolute http(s) URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('the hub URL must be an absolute http(s) URL')
  }
  return trimmed
}

/**
 * Keep only bindings that name a member, dropping duplicates.
 * @param raw - the bindings one caller proposed.
 * @returns the normalized list.
 */
export function normalizeBindings(raw: readonly TeamAgentBinding[]): TeamAgentBinding[] {
  const seen = new Set<string>()
  const result: TeamAgentBinding[] = []
  for (const binding of raw) {
    const memberId = typeof binding?.memberId === 'string' ? binding.memberId.trim() : ''
    if (memberId === '' || seen.has(memberId)) continue
    seen.add(memberId)
    const name = typeof binding.name === 'string' ? binding.name.trim() : ''
    result.push({ memberId, ...(name === '' ? {} : { name }) })
  }
  return result
}