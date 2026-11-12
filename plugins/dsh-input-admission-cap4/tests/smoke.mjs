import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'input-admission-smoke'
export const inject = ['agents', 'agentLoop', 'llm']

/** 通过正式 Profile 加载完整驱动，仅模型适配器使用确定性测试实现。 */
export async function apply(ctx, config) {
  const requests = []
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      requests.push(request)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '完成' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['cap4-smoke'], new Adapter())
  const checks = []
  assert.equal(ctx.agentLoop.inputAdmissionVersion, 4)
  for (const mode of ['ordinary', 'missing-listener', 'allowed', 'revoked']) {
    const phases = []
    let current = true
    const handle = await ctx.agents.create({
      sessionId: 'cap4-' + randomUUID(),
      agentOptions: { provider: 'cap4-smoke', model: 'cap4-model', maxTokens: 64 },
      setup(agentCtx, agent) {
        assert.equal(agent.inputAdmissionVersion, 4)
        if (mode === 'ordinary') return
        agent.requireInputAdmission()
        if (mode === 'missing-listener') return
        agentCtx.on('agent/pre-claim', async () => ({ kind: 'claim', validate: () => current }))
        agentCtx.on('agent/pre-step', async (_payload, next) => ({
          ...await next(),
          validate(_resolved, phase) {
            phases.push({ phase: phase.phase, attempt: phase.attempt })
            if (phase.phase === 'request') {
              assert.ok(Object.isFrozen(phase.actualRequest))
              assert.ok(Object.isFrozen(phase.actualRequest.messages))
              if (mode === 'revoked') current = false
            }
            return current
          },
        }))
      },
    })
    try {
      const before = requests.length
      const input = createUserMessage({ content: [{ type: 'text', text: '验证输入准入' }], source: { kind: 'user' } })
      handle.agent.followup(input)
      await handle.agent.whenIdle()
      const sent = requests.length - before
      assert.equal(sent, mode === 'ordinary' || mode === 'allowed' ? 1 : 0)
      if (mode === 'missing-listener') assert.deepEqual(handle.agent.inbox.nextTurn.map(item => item.id), [input.id])
      if (mode === 'allowed') {
        assert.ok(phases.some(item => item.phase === 'request'))
        assert.ok(phases.some(item => item.phase === 'authorization'))
      }
      checks.push({ mode, sent, phases, passed: true })
    } finally {
      await handle.dispose()
    }
  }
  await writeFile(config.report, JSON.stringify({ version: ctx.agentLoop.inputAdmissionVersion, checks, passed: true }, null, 2) + '\n')
}
