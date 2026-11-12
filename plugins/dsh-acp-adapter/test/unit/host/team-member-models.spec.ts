import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AcpBindingData, AcpSidecar } from '../../../src/persistence/sidecar.ts'
import { modeIntentBindingKey } from '../../../src/persistence/sidecar.ts'
import { createMemberModels } from '../../../src/host/teams/member-models.ts'
import { createTeamManagement } from '../../../src/host/teams/management.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function binding(provider = 'acp-demo'): AcpBindingData {
  return {
    provider,
    agentSessionId: 'native-member',
    generation: 1,
    bindingEpoch: 1,
    launchFingerprint: 'launch-1',
  } as unknown as AcpBindingData
}

function session(model = 'model-default') {
  return {
    requestHeader: () => ({ config: { provider: 'acp-demo', model } }),
    append: vi.fn(),
  }
}

type HarnessOptions = {
  binding?: { status: 'ok'; binding: AcpBindingData } | { status: 'outdated' }
  saved?: { bindingKey: string; model: string }
  status?: string
  role?: string
  initialList?: boolean
  contextKnown?: boolean
}

async function harness(options: HarnessOptions = {}) {
  const ctx = new Context()
  const agentCtx = new Context()
  contexts.push(ctx, agentCtx)
  const memberSession = session()
  const agent = {
    id: 'member-1',
    options: { provider: 'acp-demo', model: 'model-default' },
    status: options.status ?? 'idle',
    model: {
      current: () => ({ provider: 'acp-demo', model: 'model-default' }),
      select: vi.fn((selection: { provider: string; model: string }) => memberSession.append('model/selection', selection)),
    },
    session: memberSession,
    ctx: agentCtx,
  } as unknown as Agent
  let live = options.initialList === true ? agent : undefined
  const agents = {
    get: vi.fn((id: string) => (id === agent.id ? live : undefined)),
    list: vi.fn(() => (live === undefined ? [] : [live])),
  }
  const teams = {
    tryMembership: vi.fn(() => ({ role: options.role ?? 'teammate', root: agent, id: agent.id })),
    listMembers: vi.fn(() => [
      {
        id: agent.id,
        name: 'worker',
        role: 'teammate',
        status: 'inactive',
        model: 'model-default',
        diagnostics: [],
      },
    ]),
  }
  const llm = {
    listModels: vi.fn(async () => [
      { id: 'model-default', name: 'Default' },
      { id: 'model-next', name: 'Next' },
    ]),
    resolveCallConfig: vi.fn(async ({ provider, model }: { provider: string; model: string }) => ({
      provider,
      model,
      reasoningEffort: 'medium',
    })),
    resolveModelInfo: vi.fn(async () => options.contextKnown === false ? {} : { context: { contextWindow: 100_000 } }),
  }
  const currentBinding = options.binding ?? { status: 'ok' as const, binding: binding() }
  const sidecar = {
    readLatestBinding: vi.fn(async () => currentBinding),
    readMemberModelSelection: vi.fn(async () => options.saved),
    writeMemberModelSelection: vi.fn(async () => undefined),
  }
  const adapter = {
    agentSessionSnapshot: vi.fn(async () => ({
      modeWritable: true,
      configOptions: [{ id: 'model', type: 'select', currentValue: 'model-default' }],
    })),
  }
  ctx.provide('llm', llm)
  ctx.provide('agents', agents)
  ctx.provide('agentTeams', teams)
  const models = createMemberModels(ctx, {
    sidecar: sidecar as unknown as AcpSidecar,
    adapterFor: vi.fn(() => adapter as never),
  })
  if (options.initialList !== true) {
    live = agent
    await ctx.serial('agent/created', { agent, source: 'startup' })
  }
  return { ctx, agentCtx, agent, memberSession, agents, teams, llm, sidecar, adapter, models }
}

describe('createMemberModels()', () => {
  it('未知容量时保留当前模型并拒绝保存切换，不伪造上下文窗口', async () => {
    const { models, sidecar, agent } = await harness({ contextKnown: false })
    expect(await models.facts('member-1', 'acp-demo')).toMatchObject({ writable: false })
    await expect(models.save('member-1', 'acp-demo', 'model-next', vi.fn())).rejects.toThrow('ACP_TEAM_MODEL_CONTEXT_UNAVAILABLE')
    expect(sidecar.writeMemberModelSelection).not.toHaveBeenCalled()
    expect(agent.model.select).not.toHaveBeenCalled()
  })
  it('hydrates a valid saved member choice through the native Agent model API', async () => {
    const current = binding()
    const { agent, llm, sidecar } = await harness({
      binding: { status: 'ok', binding: current },
      saved: { bindingKey: modeIntentBindingKey(current), model: 'model-next' },
    })
    expect(agent.model.select).toHaveBeenCalledWith({ provider: 'acp-demo', model: 'model-next' })
    expect(llm.resolveCallConfig).not.toHaveBeenCalled()
    expect(sidecar.writeMemberModelSelection).not.toHaveBeenCalled()
  })

  it('ignores saved intent from another external binding', async () => {
    const old = binding('acp-demo')
    const { agent } = await harness({
      binding: { status: 'ok', binding: binding('acp-other') },
      saved: { bindingKey: modeIntentBindingKey(old), model: 'model-next' },
    })
    expect(agent.model.select).not.toHaveBeenCalled()
  })

  it('writes only binding-scoped intent and appends projection without touching a global default', async () => {
    const current = binding()
    const { models, memberSession, sidecar } = await harness({
      binding: { status: 'ok', binding: current },
      saved: { bindingKey: modeIntentBindingKey(current), model: 'model-default' },
    })
    const authorize = vi.fn()

    await models.save('member-1', 'acp-demo', 'model-next', authorize)

    expect(authorize).toHaveBeenCalledOnce()
    expect(sidecar.writeMemberModelSelection).toHaveBeenCalledWith('member-1', {
      bindingKey: modeIntentBindingKey(current),
      model: 'model-next',
    })
    expect(memberSession.append).toHaveBeenCalledWith('model/selection', { provider: 'acp-demo', model: 'model-next' })
  })

  it('does not alter the model of a non-teammate', async () => {
    const { agent } = await harness({ role: 'lead' })
    expect(agent.model.select).not.toHaveBeenCalled()
  })

  it.each(['valid', 'outdated', 'rebound'] as const)(
    'projects only current request facts while the ACP binding stays %s',
    async (state) => {
      const { ctx, agent, teams, sidecar } = await harness()
      ctx.provide('sessionProjections', {
        stateOf: () => ({
          lastUsed: { provider: 'acp-demo', model: 'model-used' },
          pending: { provider: 'acp-demo', model: 'model-pending' },
        }),
      } as never)
      if (state === 'outdated') sidecar.readLatestBinding.mockResolvedValue({ status: 'outdated' })
      if (state === 'rebound') {
        sidecar.readLatestBinding
          .mockResolvedValueOnce({ status: 'ok', binding: binding() })
          .mockResolvedValueOnce({ status: 'ok', binding: { ...binding(), bindingEpoch: 2 } })
      }
      const value = teams.listMembers().map(({ id: _id, name, ...row }) => ({ target: name, ...row }))
      const decision = await ctx.waterfall(
        'tools/post-execute',
        { name: 'list_agents', arguments: {}, agent, signal: new AbortController().signal } as never,
        { isError: false, value, content: [] } as never,
        async () => ({ kind: 'accept' as const }),
      )
      expect(decision).toEqual(
        state === 'valid' ? { kind: 'accept', value: [{ ...value[0], model: 'model-used' }] } : { kind: 'accept' },
      )
      expect(agent.options.model).toBe('model-default')
      expect(sidecar.writeMemberModelSelection).not.toHaveBeenCalled()
    },
  )

  it('keeps team permission and busy checks in the real management facade', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const leadSession = session()
    const member = {
      id: 'member-1',
      role: 'teammate',
      status: 'inactive',
      name: 'Member',
      options: { provider: 'acp-demo' },
      session: session(),
      ctx: new Context(),
    }
    const lead = { id: 'lead-1', options: { provider: 'acp-demo' }, session: leadSession, ctx: new Context() }
    contexts.push(member.ctx, lead.ctx)
    const agents = {
      get: vi.fn((id: string) => (id === 'lead-1' ? lead : id === 'member-1' ? member : undefined)),
      list: vi.fn(() => [lead, member]),
    }
    const teams = {
      tryMembership: vi.fn((agent: unknown) => (agent === lead ? { role: 'lead' } : { role: 'teammate' })),
      listMembers: vi.fn(() => [member]),
    }
    const llm = {
      listModels: vi.fn(async () => [{ id: 'model-next', name: 'Next' }]),
      resolveModelInfo: vi.fn(async () => ({ context: { contextWindow: 100_000 } })),
      resolveCallConfig: vi.fn(async ({ provider, model }: { provider: string; model: string }) => ({
        provider,
        model,
      })),
    }
    ctx.provide('agents', agents)
    ctx.provide('agentTeams', teams)
    ctx.provide('llm', llm)
    let bindingReads = 0
    const sidecar = {
      readLatestBinding: vi.fn(async () => {
        bindingReads++
        if (bindingReads >= 2) member.status = 'running'
        return { status: 'ok' as const, binding: binding() }
      }),
      readMemberModelSelection: vi.fn(async () => undefined),
      writeMemberModelSelection: vi.fn(async () => undefined),
    }
    const adapter = {
      agentSessionSnapshot: vi.fn(async () => ({
        modeWritable: true,
        configOptions: [{ id: 'model', type: 'select', currentValue: 'model-default' }],
      })),
    }
    const management = createTeamManagement(
      ctx,
      (provider) => provider === 'acp-demo',
      async () => 'acp-demo',
      { sidecar: sidecar as unknown as AcpSidecar, adapterFor: () => adapter as never },
    )

    if (management.selectModel === undefined) throw new Error('missing selectModel helper')
    await expect(management.selectModel('lead-1', 'member-1', 'model-next')).rejects.toThrow('ACP_TEAM_MEMBER_BUSY')
    expect(sidecar.writeMemberModelSelection).not.toHaveBeenCalled()
  })
})
