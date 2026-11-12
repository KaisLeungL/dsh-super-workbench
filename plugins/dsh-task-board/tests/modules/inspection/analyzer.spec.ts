import { describe, expect, it, vi } from 'vitest'
import type { LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createAnalyzer } from '../../../src/modules/inspection/host/analyzer.ts'
import type { InspectionRule } from '../../../src/modules/inspection/core/types.ts'
const rule: InspectionRule = { id: 'r', workspaceId: 'w', root: '/fixture', goal: '核对交付', revision: 1, enabled: true, paths: ['README.md'], model: 'provider/model', daily: false, cron: '0 9 * * *', timeZone: 'Asia/Shanghai', maxRecommendations: 3 }
const bundle = { evidence: [{ id: 'e', path: 'README.md', text: '项目进度', fingerprint: 'v1' }], coverage: { files: 1, visited: 1, bytes: 12, omitted: 0, truncated: false, git: 'not-requested' as const } }
describe('受限模型请求', () => {
  it('operator：给定项目文本，当调用模型时，无工具且限制输出并记录本次 usage', async () => {
    // Given: 项目文本
    // When: 调用模型
    // Then: 无工具且限制输出并记录本次 usage
    const stream = vi.fn(async function* (_request: unknown) {
      yield { type: 'text-delta', index: 0, text: '{"candidates":[]}' } as StreamChunk
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } as StreamChunk
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
    })
    const prepareCall = vi.fn(async () => ({ config: {}, stream }))
    const result = await createAnalyzer(() => ({ prepareCall } as unknown as LlmRuntime)).analyze(rule, bundle, '[]', new AbortController().signal)
    expect(result).toEqual({ candidates: [], usage: { inputTokens: 10, outputTokens: 5 } })
    expect(prepareCall).toHaveBeenCalledWith({ provider: 'provider', model: 'model' }, expect.any(AbortSignal))
    expect(stream.mock.calls[0]?.[0]).toMatchObject({ maxTokens: 4096 })
    expect(stream.mock.calls[0]?.[0]).not.toHaveProperty('tools')
  })
  it('operator：给定虚构引用的模型响应，当解析时，拒绝候选', async () => {
    // Given: 虚构引用的模型响应
    // When: 解析
    // Then: 拒绝候选
    const llm = { prepareCall: async () => ({ config: {}, stream: async function* () {
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ candidates: [{ title: '建议', reason: '理由', category: 'fix', scope: 'README.md', evidenceIds: ['invented'], acceptance: ['测试通过'] }] }) }
    } }) }
    await expect(createAnalyzer(() => llm as unknown as LlmRuntime).analyze(rule, bundle, '', AbortSignal.timeout(1000))).rejects.toThrow('invalid-evidence')
  })
  it('operator：给定超长模型响应，当达到输出字符预算时，拒绝而不截取为有效建议', async () => {
    // Given: 超长模型响应
    // When: 达到输出字符预算
    // Then: 拒绝而不截取为有效建议
    const llm = { prepareCall: async () => ({ config: {}, stream: async function* () { yield { type: 'text-delta', text: 'x'.repeat(16001) } } }) }
    await expect(createAnalyzer(() => llm as unknown as LlmRuntime).analyze(rule, bundle, '', AbortSignal.timeout(1000))).rejects.toThrow('model-output-budget')
  })
})

