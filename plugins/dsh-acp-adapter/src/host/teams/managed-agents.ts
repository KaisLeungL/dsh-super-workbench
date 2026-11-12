import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InstalledProfileRegistry } from '../composition/installed-profile-registry.ts'

type Creation = {
  parent: Agent
  provider: string
  model: string
  active: boolean
  children: Set<string>
}

/** Create native durable Team members with an explicitly selected external Agent route. */
export function installManagedAgents(ctx: Context, registry: InstalledProfileRegistry): void {
  ctx.inject(['tools', 'agentTeams', 'subagents', 'llm'], (scope) => {
    const selections = new AsyncLocalStorage<Creation>()
    const pending = new Map<string, Creation>()
    const running = new Set<Promise<unknown>>()
    let accepting = true
    const providerName = 'dsh-acp-managed-spawn'
    const releaseProvider = scope.subagents.registerProvider({
      name: providerName,
      inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: true },
      async prepareContinuable(request) {
        request.signal.throwIfAborted()
        const creation = selections.getStore()
        if (!accepting || creation?.active !== true || creation.parent !== request.parent)
          throw new Error('ACP_MANAGED_CREATION_UNAVAILABLE')
        pending.set(request.sessionId, creation)
        creation.children.add(request.sessionId)
        return {}
      },
    })
    const releaseCreated = scope.on('agent/created', ({ agent }) => {
      const creation = pending.get(agent.id)
      if (creation === undefined) return undefined
      if (!creation.active || agent.session.header.parentSession !== creation.parent.id ||
        agent.session.header.origin !== 'subagent') throw new Error('ACP_MANAGED_CREATION_MISMATCH')
      // This awaited native lifecycle edge precedes initial inbox execution.
      // The durable selection also survives cold continuation and Host restart.
      agent.model.select({ provider: creation.provider, model: creation.model })
      pending.delete(agent.id)
      return undefined
    })
    const releaseCatalog = scope.tools.register(defineTool({
      name: 'acp_list_agents',
      description: '列出已配置的外部编程 Agent 及其可用模型，供手动选用或团队分工。',
      parameters: {},
      output: {
        schema: { type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true }, name: { type: 'string', required: true },
            models: { type: 'array', required: true, items: {
              type: 'object', additionalProperties: false,
              properties: { id: { type: 'string', required: true }, name: { type: 'string', required: true } },
            } },
          },
        } },
        render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        return await Promise.all([...registry.agents()].filter(([, config]) => config.enabled !== false).map(async ([id, config]) => ({
          id,
          name: config.name,
          models: (await scope.llm.listModels(`acp-${id}`)).map(({ id, name }) => ({ id, name })),
        })))
      },
    }))
    const releaseSpawn = scope.tools.register(defineTool({
      name: 'acp_spawn_agent',
      description: '为团队创建可持续对话的外部 Agent 成员。先用 acp_list_agents 查询 agent_id 和精确 model；可混合 Codex、Claude 等 Agent。成员使用 fresh 上下文并共享项目目录，后续使用原生 send_message、任务板和取消功能。',
      parameters: {
        agent_id: { type: 'string', required: true },
        model: { type: 'string', required: true },
        name: { type: 'string', required: true, description: '团队内唯一的 lower-kebab-case 名称。' },
        description: { type: 'string', required: true },
        prompt: { type: 'string', required: true, description: '独立、完整的首个任务，注明负责的文件范围。' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          session_id: { type: 'string', required: true }, name: { type: 'string', required: true },
          agent_id: { type: 'string', required: true }, model: { type: 'string', required: true },
          status: { type: 'string', required: true },
        } },
        render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const parent = exec.agent
        if (!accepting || parent === undefined || scope.agentTeams.tryMembership(parent)?.role !== 'lead')
          throw new Error('ACP_MANAGED_LEAD_REQUIRED')
        if ((registry.agents().get(args.agent_id) === undefined || registry.agents().get(args.agent_id)?.enabled === false)) throw new Error('ACP_MANAGED_AGENT_UNAVAILABLE')
        const provider = `acp-${args.agent_id}`
        const models = await scope.llm.listModels(provider)
        if (!models.some((model) => model.id === args.model)) throw new Error('ACP_MANAGED_MODEL_UNAVAILABLE')
        exec.signal.throwIfAborted()
        // Recheck after asynchronous catalog discovery; removal cannot create a stale member.
        if (!accepting || (registry.agents().get(args.agent_id) === undefined || registry.agents().get(args.agent_id)?.enabled === false)) throw new Error('ACP_MANAGED_AGENT_UNAVAILABLE')
        const creation: Creation = { parent, provider, model: args.model, active: true, children: new Set() }
        const operation = selections.run(creation, async () => {
          try {
            const { member } = await scope.agentTeams.spawnTeammate(parent, {
              name: args.name, description: args.description,
              prompt: [{ type: 'text', text: args.prompt }],
              context: 'fresh', provider: providerName, signal: exec.signal,
            })
            return { session_id: member.id, name: member.name, agent_id: args.agent_id, model: args.model, status: member.status }
          } finally {
            creation.active = false
            for (const id of creation.children) pending.delete(id)
          }
        })
        running.add(operation)
        try { return await operation } finally { running.delete(operation) }
      },
    }), { when: ({ agent }) => scope.agentTeams.tryMembership(agent)?.role === 'lead' })
    scope.effect(function* () {
      yield releaseProvider
      yield releaseCreated
      yield () => { pending.clear(); selections.disable() }
      yield async () => {
        accepting = false
        await Promise.allSettled([...running])
      }
      yield releaseCatalog
      yield releaseSpawn
    })
  })
}
