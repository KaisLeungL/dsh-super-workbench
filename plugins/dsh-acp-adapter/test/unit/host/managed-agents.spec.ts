import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeTool, installToolRuntime } from '../../native-tools.ts'
import { installManagedAgents } from '../../../src/host/teams/managed-agents.ts'
import type { InstalledProfileRegistry } from '../../../src/host/composition/installed-profile-registry.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, {})
  await installToolRuntime(ctx)
  const providers = new Map<string, SubagentProvider>()
  const configs = new Map<string, { name: string; enabled?: boolean }>([
    ['codex', { name: 'Codex' }], ['claude', { name: 'Claude' }],
  ])
  const catalog = vi.fn(async () => [{ id: 'small', name: 'Small' }])
  ctx.provide('llm', { listModels: catalog } as never)
  ctx.provide('subagents', {
    registerProvider(provider: SubagentProvider) {
      providers.set(provider.name, provider)
      return () => { providers.delete(provider.name) }
    },
  } as never)
  const leads = new Set<Agent>()
  const makeLead = (id: string) => {
    const agent = { id, model: { current: () => ({ provider: 'acp-codex', model: 'small' }) } } as unknown as Agent
    leads.add(agent)
    return agent
  }
  const children: Agent[] = []
  let nextChild = 0
  let failAfterPrepare = false
  let gate: Promise<void> | undefined
  const entered = Promise.withResolvers<void>()
  const spawn = vi.fn(async (parent: Agent, request: {
    provider: string; signal: AbortSignal; name: string
  }) => {
    const provider = providers.get(request.provider)
    if (provider?.prepareContinuable === undefined) throw new Error('Provider missing')
    const id = `member-${++nextChild}`
    await provider.prepareContinuable({ parent, sessionId: id as never, cwd: process.cwd(), signal: request.signal })
    entered.resolve()
    await gate
    if (failAfterPrepare) throw new Error('Factory rejected')
    const select = vi.fn()
    const child = {
      id, model: { select },
      session: { header: { origin: 'subagent', parentSession: parent.id } },
    } as unknown as Agent
    await ctx.serial('agent/created', { agent: child, source: 'startup' })
    children.push(child)
    return { member: { id, name: request.name, status: 'inactive' } }
  })
  ctx.provide('agentTeams', {
    tryMembership: (agent: Agent) => leads.has(agent) ? { role: 'lead' } : { role: 'teammate' },
    spawnTeammate: spawn,
  } as never)
  const registry = { agents: () => configs } as unknown as InstalledProfileRegistry
  const fiber = await ctx.plugin((scope) => installManagedAgents(scope, registry))
  const lead = makeLead('lead')
  const invoke = async (agent = lead, agentId = 'claude', model = 'small') => {
    const signal = new AbortController().signal
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: agent.model.current()!, signal })
    try {
      return await executeTool(ctx.tools, {
        name: 'acp_spawn_agent', callId: ToolCallId('create-member'), agent, signal, toolSet,
        arguments: { agent_id: agentId, model, name: 'reviewer', description: '检查变更', prompt: '只检查指定文件。' },
      })
    } finally { toolSet.dispose() }
  }
  return { ctx, fiber, lead, makeLead, configs, catalog, providers, spawn, children, invoke, entered,
    fail: () => { failAfterPrepare = true }, gate: (value: Promise<void>) => { gate = value } }
}

describe('混合 Agent 团队派单', () => {
  it('在首条任务执行前把 Claude 路由写入 Codex 主 Agent 创建的原生成员', async () => {
    const h = await harness()
    const result = await h.invoke()
    expect(result.isError).toBe(false)
    expect(h.children[0]!.model.select).toHaveBeenCalledExactlyOnceWith({ provider: 'acp-claude', model: 'small' })
    expect(result.value).toMatchObject({ agent_id: 'claude', session_id: 'member-1', model: 'small' })
    expect(h.spawn.mock.calls[0]![1]).toMatchObject({ provider: 'dsh-acp-managed-spawn', context: 'fresh' })
  })

  it('拒绝不存在的 Agent 和模型，不创建成员', async () => {
    const h = await harness()
    expect((await h.invoke(h.lead, 'missing')).isError).toBe(true)
    expect((await h.invoke(h.lead, 'claude', 'missing')).isError).toBe(true)
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('两个主会话并行创建时各自保留目标 Agent 路由', async () => {
    const h = await harness()
    const gate = Promise.withResolvers<void>()
    h.gate(gate.promise)
    const other = h.makeLead('other-lead')
    const operations = [h.invoke(h.lead, 'claude'), h.invoke(other, 'codex')]
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(2))
    gate.resolve()
    expect((await Promise.all(operations)).every((result) => !result.isError)).toBe(true)
    const first = h.children.find((child) => child.session.header.parentSession === h.lead.id)!
    const second = h.children.find((child) => child.session.header.parentSession === other.id)!
    expect(first.model.select).toHaveBeenCalledExactlyOnceWith({ provider: 'acp-claude', model: 'small' })
    expect(second.model.select).toHaveBeenCalledExactlyOnceWith({ provider: 'acp-codex', model: 'small' })
  })

  it('子成员不可用派单工具，不能冒充主 Agent 扩张团队', async () => {
    const h = await harness()
    const member = h.makeLead('member')
    h.ctx.agentTeams.tryMembership = () => ({ role: 'teammate' }) as never
    expect((await h.invoke(member)).isError).toBe(true)
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('目录查询期间移除的 Agent 不得继续创建成员', async () => {
    const h = await harness()
    h.catalog.mockImplementationOnce(async () => { h.configs.delete('claude'); return [{ id: 'small', name: 'Small' }] })
    expect((await h.invoke()).isError).toBe(true)
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it.each([false, true])('停用实例不允许新派单，包含目录查询中的停用（等待中=%s）', async (duringCatalog) => {
    const h = await harness()
    const disable = () => h.configs.set('claude', { name: 'Claude', enabled: false })
    if (duringCatalog) h.catalog.mockImplementationOnce(async () => { disable(); return [{ id: 'small', name: 'Small' }] })
    else disable()
    expect((await h.invoke()).isError).toBe(true)
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('创建失败后清理待绑定路由，不改写后来复用相同 id 的会话', async () => {
    const h = await harness()
    h.fail()
    expect((await h.invoke()).isError).toBe(true)
    const select = vi.fn()
    const unrelated = { id: 'member-1', model: { select } } as unknown as Agent
    await h.ctx.serial('agent/created', { agent: unrelated, source: 'startup' })
    expect(select).not.toHaveBeenCalled()
  })

  it('卸载先等待已接收的创建完成，期间保留绑定监听和 provider', async () => {
    const h = await harness()
    const gate = Promise.withResolvers<void>()
    h.gate(gate.promise)
    const operation = h.invoke()
    await h.entered.promise
    let released = false
    const closing = h.fiber.dispose().then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)
    expect(h.providers.size).toBe(1)
    gate.resolve()
    expect((await operation).isError).toBe(false)
    await closing
    expect(h.children[0]!.model.select).toHaveBeenCalledOnce()
    expect(h.providers.size).toBe(0)
    expect(h.ctx.tools.get('acp_spawn_agent')).toBeUndefined()
  })
})
