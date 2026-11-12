import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AcpSidecar } from '../../persistence/sidecar.ts'
import { modeIntentBindingKey } from '../../persistence/sidecar.ts'
import type { AcpProfileAdapter } from '../composition/profile-adapter.ts'
import { normalizeAcpConfigOptionKey } from '../../contract/config-options.ts'
import { readMemberRequestModel } from './member-model-facts.ts'
import { installTeamMemberModelFacts } from './member-model-tools.ts'

export interface MemberModelDependencies {
  sidecar: AcpSidecar
  adapterFor(provider: string): AcpProfileAdapter | undefined
}

/** Binding-scoped preference survives native cold continuation's fixed constructor model. */
export function createMemberModels(ctx: Context, { sidecar, adapterFor }: MemberModelDependencies) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('ACP_TEAM_MODELS_UNAVAILABLE')
  const hasContextCapacity = async (provider: string, model: string): Promise<boolean> => {
    const size = (await llm.resolveModelInfo(provider, model)).context?.contextWindow
    return size !== undefined && Number.isFinite(size) && size > 0
  }
  const selectionFor = async (id: string, provider: string) => {
    const binding = await sidecar.readLatestBinding(id as never)
    const saved = await sidecar.readMemberModelSelection(id as never)
    return binding?.status === 'ok' &&
      binding.binding.provider === provider &&
      saved?.bindingKey === modeIntentBindingKey(binding.binding)
      ? saved
      : undefined
  }
  const install = async (agent: Agent): Promise<void> => {
    if (ctx.get('agentTeams')?.tryMembership(agent)?.role !== 'teammate') return
    const provider = agent.model.current()?.provider ?? agent.options.provider
    if (provider === undefined || adapterFor(provider) === undefined) return
    const saved = await selectionFor(agent.id, provider)
    if (saved !== undefined && await hasContextCapacity(provider, saved.model) &&
      agent.status !== 'running' && ctx.get('agents', false)?.get(agent.id) === agent)
      agent.model.select({ provider, model: saved.model })
  }
  ctx.on('agent/created', async ({ agent }) => {
    await install(agent)
    return undefined
  })
  for (const agent of ctx.get('agents', false)?.list() ?? [])
    void install(agent).catch((error: unknown) => ctx.logger.warn(error))

  const facts = async (id: string, provider: string) => {
    const child = ctx.get('agents', false)?.get(id as never)
    const adapter = adapterFor(provider)
    const snapshot = await adapter?.agentSessionSnapshot(id).catch(() => undefined)
    const reported = snapshot?.configOptions?.find(
      (option) =>
        normalizeAcpConfigOptionKey(option.id) === 'model' ||
        normalizeAcpConfigOptionKey(option.category ?? '') === 'model',
    )
    const currentModel =
      (await readMemberRequestModel(ctx, id, provider).catch(() => undefined)) ??
      (reported?.type === 'select' ? reported.currentValue : null)
    const selected = await selectionFor(id, provider)
    return {
      currentModel,
      pendingModel: selected !== undefined && selected.model !== currentModel ? selected.model : null,
      // Native 0.2.2 requires a known destination capacity before switching
      // models. ACP does not universally report it; never invent a window.
      writable: snapshot?.modeWritable === true && child?.status !== 'running' &&
        currentModel !== null && await hasContextCapacity(provider, currentModel),
    }
  }
  installTeamMemberModelFacts(ctx, async (id, signal) => {
    const binding = await sidecar.readLatestBinding(id as never)
    if (binding?.status !== 'ok') return undefined
    const adapter = adapterFor(binding.binding.provider)
    if (adapter === undefined) return undefined
    const model = await readMemberRequestModel(ctx, id, binding.binding.provider, signal)
    const current = await sidecar.readLatestBinding(id as never)
    if (
      current?.status !== 'ok' ||
      modeIntentBindingKey(current.binding) !== modeIntentBindingKey(binding.binding) ||
      adapterFor(binding.binding.provider) !== adapter
    )
      return undefined
    return model === undefined ? undefined : { currentModel: model }
  })

  return {
    facts,
    async catalog(provider: string) {
      return (await llm.listModels(provider)).map((model) => ({ id: model.id, name: model.name }))
    },
    async save(id: string, provider: string, model: string, authorize: () => void) {
      if (!await hasContextCapacity(provider, model)) throw new Error('ACP_TEAM_MODEL_CONTEXT_UNAVAILABLE')
      const binding = await sidecar.readLatestBinding(id as never)
      if (binding?.status !== 'ok' || binding.binding.provider !== provider) throw new Error('ACP_BINDING_UNAVAILABLE')
      // Catalog and binding reads may yield while a mailbox wakes the member.
      // Recheck at the synchronous SQLite write boundary, not just on entry.
      authorize()
      await sidecar.writeMemberModelSelection(id as never, { bindingKey: modeIntentBindingKey(binding.binding), model })
      // The host projection can advertise next-request intent for a live
      // member. Dormant members receive the same selection through hydration.
      const child = ctx.get('agents', false)?.get(id as never)
      if (child !== undefined && child.status !== 'running')
        child.model.select({ provider, model })
    },
  }
}
