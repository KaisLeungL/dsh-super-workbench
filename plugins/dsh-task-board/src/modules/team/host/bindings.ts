/**
 * Which local agents this Host registers with the hub.
 *
 * dsh-agents owns the member definitions and writes them to
 * `$DSH_HOME/dsh-agents/ledger.json`; it serves no cordis service for them, so
 * this module reads that ledger file directly, read-only and tolerantly. A
 * missing file, an unreadable one, or a document from another revision leaves
 * the binding list empty and reports why — the Host keeps running, it simply
 * claims nothing, which is the safe direction for a machine that would
 * otherwise execute somebody else's work.
 *
 * The binding itself is a member id: the name, preset and workspace always come
 * from the member definition, never from the browser, so a settings edit can
 * point at a member but cannot invent one.
 *
 * @module dsh-task-board-team/host/bindings
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The plugin directory dsh-agents keeps under the DSH home. */
export const AGENTS_HOME_DIRECTORY = 'dsh-agents'

/** The ledger file dsh-agents writes its teams and members into. */
export const AGENTS_LEDGER_FILE = 'ledger.json'

/** One member definition, as the agents ledger stores it. */
export interface AgentsMemberDefinition {
  id: string
  teamId: string
  name: string
  preset?: string
  permission?: 'read-only' | 'workspace-write' | 'danger-full-access'
  model?: string
  reasoningEffort?: string
  brief?: string
}

/** One team in the agents ledger. */
export interface AgentsTeamDefinition {
  id: string
  name: string
  workspaceId?: string
  members: AgentsMemberDefinition[]
}

/** What this module reads out of the agents ledger. */
export interface AgentsLedgerView {
  teams: AgentsTeamDefinition[]
  /** Why the ledger could not be read, when it could not. */
  problem?: string
}

/** One member this Host binds as a team Agent. */
export interface BoundAgent {
  /** dsh-agents member id. */
  memberId: string
  /** Team the member belongs to. */
  teamId: string
  /** Team name, for the operator. */
  teamName: string
  /** Name the hub resolves mentions by. */
  name: string
  /** Agent preset the member definition pins. */
  preset?: string
  /** Model the member definition pins. */
  model?: string
  /** Reasoning effort the member definition pins for that model. */
  reasoningEffort?: string
  /** Workspace the member's team pins, so the mirror card runs where the member does. */
  workspaceId?: string
}

/** One configured binding, as the settings entry stores it. */
export interface TeamAgentBinding {
  /** dsh-agents member id to bind. */
  memberId: string
  /** Name the hub resolves mentions by; empty falls back to the member's own name. */
  name?: string
}

/**
 * Resolve the DSH home directory the way every other plugin does.
 * @param env - process environment.
 * @param home - platform home fallback (test seam).
 * @returns the absolute DSH home path.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const value = raw.trim()
    if (value.startsWith('~')) return join(home, value.slice(1))
    return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) ? value : join(process.cwd(), value)
  }
  return join(home, '.dsh')
}

/**
 * Resolve the path of the agents ledger file.
 * @param env - process environment.
 * @param home - platform home fallback (test seam).
 * @returns the absolute ledger path.
 */
export function agentsLedgerPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(resolveDshHome(env, home), AGENTS_HOME_DIRECTORY, AGENTS_LEDGER_FILE)
}

/**
 * Read the agents ledger as a member-definition view.
 *
 * Anything unexpected reads as an empty binding list with a reason instead of an
 * exception: this Host has to keep working when dsh-agents is not installed, and
 * a half-written ledger must never turn into a claim of somebody else's work.
 * @param read - file reader seam, defaulting to the filesystem.
 * @returns the teams it found, plus why it found none when that is the case.
 */
export async function readAgentsLedger(
  file: string,
  read: (path: string) => Promise<string> = async path => await readFile(path, 'utf8'),
): Promise<AgentsLedgerView> {
  let raw: string
  try {
    raw = await read(file)
  } catch {
    return { teams: [], problem: 'the dsh-agents ledger is not readable at ' + file }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { teams: [], problem: 'the dsh-agents ledger at ' + file + ' is not valid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { teams: [], problem: 'the dsh-agents ledger at ' + file + ' has an unknown shape' }
  }
  const rawTeams = (parsed as { teams?: unknown }).teams
  if (!Array.isArray(rawTeams)) return { teams: [], problem: 'the dsh-agents ledger at ' + file + ' lists no teams' }
  const teams: AgentsTeamDefinition[] = []
  for (const entry of rawTeams) {
    if (typeof entry !== 'object' || entry === null) continue
    const team = entry as Record<string, unknown>
    if (typeof team.id !== 'string' || typeof team.name !== 'string') continue
    const members: AgentsMemberDefinition[] = []
    for (const rawMember of Array.isArray(team.members) ? team.members : []) {
      if (typeof rawMember !== 'object' || rawMember === null) continue
      const member = rawMember as Record<string, unknown>
      if (typeof member.id !== 'string' || typeof member.name !== 'string') continue
      members.push({
        id: member.id,
        teamId: team.id,
        name: member.name,
        ...(typeof member.preset === 'string' && member.preset !== '' ? { preset: member.preset } : {}),
        ...(typeof member.brief === 'string' && member.brief !== '' ? { brief: member.brief } : {}),
        ...(typeof member.model === 'string' && member.model !== '' ? { model: member.model } : {}),
        ...(typeof member.reasoningEffort === 'string' && member.reasoningEffort !== '' ? { reasoningEffort: member.reasoningEffort } : {}),
      })
    }
    teams.push({
      id: team.id,
      name: team.name,
      ...(typeof team.workspaceId === 'string' && team.workspaceId !== '' ? { workspaceId: team.workspaceId } : {}),
      members,
    })
  }
  return teams.length === 0
    ? { teams, problem: 'the dsh-agents ledger at ' + file + ' defines no team' }
    : { teams }
}

/**
 * Project configured bindings onto the member definitions they name.
 *
 * A binding whose member no longer exists is reported and skipped: the hub keeps
 * the agent record it already has, and this Host simply stops claiming for it,
 * which is what an operator unpublishing a member means.
 * @param bindings - the configured member ids.
 * @param view - the members read out of the agents ledger.
 * @returns the resolved agents and one problem line per unusable binding.
 */
export function resolveBindings(
  bindings: readonly TeamAgentBinding[],
  view: AgentsLedgerView,
): { agents: BoundAgent[]; problems: string[] } {
  const agents: BoundAgent[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const binding of bindings) {
    const memberId = binding.memberId.trim()
    if (memberId === '' || seen.has(memberId)) continue
    seen.add(memberId)
    const team = view.teams.find(candidate => candidate.members.some(member => member.id === memberId))
    const member = team?.members.find(candidate => candidate.id === memberId)
    if (team === undefined || member === undefined) {
      problems.push('the bound member ' + memberId + ' is not defined in the dsh-agents ledger')
      continue
    }
    const name = binding.name !== undefined && binding.name.trim() !== '' ? binding.name.trim() : member.name
    agents.push({
      memberId,
      teamId: team.id,
      teamName: team.name,
      name,
      ...(member.preset === undefined ? {} : { preset: member.preset }),
      ...(member.model === undefined ? {} : { model: member.model }),
      ...(member.reasoningEffort === undefined ? {} : { reasoningEffort: member.reasoningEffort }),
      ...(team.workspaceId === undefined ? {} : { workspaceId: team.workspaceId }),
    })
  }
  return { agents, problems }
}