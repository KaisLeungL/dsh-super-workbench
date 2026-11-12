/** Validated Agent configuration shared by Loader and the ACP settings editor. */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { posix, win32 } from 'node:path'
import { ACP_AGENT_IDS, ACP_AGENT_ID_PATTERN, acpRouteId, effectiveRuntimeOf } from '../../domain/session/agent-config.ts'
import type { AcpAgentConfig, AcpAgentId } from '../../domain/session/agent-config.ts'

export type AcpToolApprovalPolicy = 'auto' | 'ask'
export interface AcpSettings {
  agents: Record<string, AcpAgentConfig>
  toolApprovalDefault: AcpToolApprovalPolicy
}
export interface Config {
  agents: Volatile<Record<string, AcpAgentConfig>>
  toolApprovalDefault: Volatile<AcpToolApprovalPolicy>
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Paths are passed literally as argv[0], including spaces and shell punctuation.
 * Recognize both platforms because the client and Agent host may differ.
 * Bare commands still reject likely pasted command lines; arguments belong in args.
 */
function validExecutableCommand(command: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(command)) return false
  if (posix.isAbsolute(command) || win32.isAbsolute(command) || /^\.{1,2}[\\/]/.test(command)) return true
  return !/[\s|&;<>()$`"']/.test(command)
}

/** Validate one agent entry; unknown keys are dropped (schemastery strip semantics). */
function agentConfigOf(id: string, raw: unknown): AcpAgentConfig {
  if (!ACP_AGENT_ID_PATTERN.test(id)) {
    throw new TypeError(
      `dsh-acp settings: agent id "${id}" must match ${String(ACP_AGENT_ID_PATTERN)} (it becomes LLM route "${acpRouteId(id)}")`,
    )
  }
  if (!isPlainObject(raw)) throw new TypeError(`dsh-acp settings: agents.${id} must be an object`)
  const name = raw['name']
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(`dsh-acp settings: agents.${id}.name must be a non-empty string`)
  }
  const command = raw['command']
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError(`dsh-acp settings: agents.${id}.command must be a non-empty string`)
  }
  if (!validExecutableCommand(command)) {
    throw new TypeError(
      `dsh-acp settings: agents.${id}.command must be an executable name or path without control characters; enter paths directly without surrounding quotes and put arguments in "args"`,
    )
  }
  const args = raw['args'] ?? []
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new TypeError(`dsh-acp settings: agents.${id}.args must be an array of strings`)
  }
  const env = raw['env'] ?? {}
  if (!isPlainObject(env) || !Object.values(env).every((value) => typeof value === 'string')) {
    throw new TypeError(`dsh-acp settings: agents.${id}.env must be a map of string values`)
  }
  const enabled = raw['enabled']
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new TypeError(`dsh-acp settings: agents.${id}.enabled must be a boolean`)
  }
  const loginHint = raw['loginHint']
  if (loginHint !== undefined && typeof loginHint !== 'string') {
    throw new TypeError(`dsh-acp settings: agents.${id}.loginHint must be a string`)
  }
  // 边界：runtime 是专有行为绑定，只收已声明的合法值——非法值拒绝写入
  // （普通 profile 不允许拼出宿主 path/env ref，也不允许指定未知的 runtime）
  const catalogId = raw['catalogId']
  if (catalogId !== undefined && (typeof catalogId !== 'string' || !ACP_AGENT_ID_PATTERN.test(catalogId))) {
    throw new TypeError(`dsh-acp settings: agents.${id}.catalogId must be a registry identifier`)
  }
  const runtime = raw['runtime']
  if (runtime !== undefined && !ACP_AGENT_IDS.includes(runtime as AcpAgentId)) {
    throw new TypeError(
      `dsh-acp settings: agents.${id}.runtime must be one of ${ACP_AGENT_IDS.map((value) => JSON.stringify(value)).join(', ')} (it binds the profile to a specialized runtime)`,
    )
  }
  const authentication = raw['authentication']
  const authBinding = raw['authBinding']
  if (authentication !== undefined && (authentication !== 'chatgpt-managed' || effectiveRuntimeOf(id, { ...(runtime === undefined ? {} : { runtime: runtime as AcpAgentId }) }) !== 'codex')) throw new TypeError('托管 ChatGPT 授权仅支持 Codex runtime。')
  if (authBinding !== undefined && (authentication !== 'chatgpt-managed' || typeof authBinding !== 'string' || !/^[a-f0-9]{64}$/.test(authBinding))) throw new TypeError('托管授权绑定无效。')
  return {
    ...(authentication === undefined ? {} : { authentication }),
    ...(authBinding === undefined ? {} : { authBinding }),
    ...(enabled === undefined ? {} : { enabled }),
    name,
    command,
    args: [...args] as string[],
    env: { ...env } as Record<string, string>,
    ...(loginHint === undefined ? {} : { loginHint }),
    ...(runtime === undefined ? {} : { runtime: runtime as AcpAgentId }),
    ...(catalogId === undefined ? {} : { catalogId }),
  }
}

/**
 * Validating resolver for the `dsh-acp` namespace: an absent section resolves
 * to zero agents; an invalid one throws, which is how the settings service
 * refuses the write (or keeps the last good value on an external edit).
 */
export const acpSettingsSchema: ((value: unknown) => AcpSettings) & { toJSON(): unknown } = Object.assign(
  (value: unknown): AcpSettings => {
    if (value === undefined) return { agents: {}, toolApprovalDefault: 'auto' }
    if (!isPlainObject(value))
      throw new TypeError('dsh-acp settings: the section must be an object with an "agents" map')
    // Deliberately ignore the retired preference so existing settings remain readable.
    const toolApprovalDefault = value['toolApprovalDefault'] === undefined ? 'auto' : value['toolApprovalDefault']
    if (toolApprovalDefault !== 'auto' && toolApprovalDefault !== 'ask')
      throw new TypeError('dsh-acp settings: "toolApprovalDefault" must be "auto" or "ask"')
    const rawAgents = value['agents'] ?? {}
    if (!isPlainObject(rawAgents)) throw new TypeError('dsh-acp settings: "agents" must be a map of agent id → config')
    const agents: Record<string, AcpAgentConfig> = {}
    for (const [id, raw] of Object.entries(rawAgents)) agents[id] = agentConfigOf(id, raw)
    return { agents, toolApprovalDefault }
  },
  { toJSON: () => SettingsSchema.toJSON() },
)

const AgentSchema = z.object({
  authentication: z.union(['chatgpt-managed']),
  authBinding: z.string(),
  enabled: z.boolean(),
  name: z.string().required(),
  command: z.string().required(),
  args: z.array(z.string()).default([]),
  env: z.dict(z.string()).default({}),
  loginHint: z.string(),
  catalogId: z.string(),
  runtime: z.union([...ACP_AGENT_IDS]),
})
const AgentsSchema = z.dict(AgentSchema)
const SettingsSchema = z.object({
  agents: AgentsSchema.default({}),
  toolApprovalDefault: z.union(['auto', 'ask']).default('auto'),
})
/** Native volatile fields; Loader validates before publishing an atomic live update. */
const NativeConfig = z.object({
  agents: AgentsSchema.default({}).volatile(),
  toolApprovalDefault: z.union(['auto', 'ask']).default('auto').volatile(),
})
// Business validation belongs to Loader, not to a serialized browser callback.
// Keep the native schema/prototype intact so forms can rehydrate its plain JSON.
export const Config = new Proxy(NativeConfig, {
  get(target, key, receiver) {
    if (key !== '~standard') return Reflect.get(target, key, receiver)
    return {
      ...target['~standard'],
      validate(value: unknown) {
        return target['~standard'].validate(acpSettingsSchema(value))
      },
    }
  },
  apply(target, thisArg, args: Parameters<typeof NativeConfig>) {
    const validated = acpSettingsSchema(args[0])
    return Reflect.apply(target, thisArg, [validated, args[1]])
  },
}) as unknown as z<unknown, Config>
export type AcpSettingsSchema = typeof acpSettingsSchema
