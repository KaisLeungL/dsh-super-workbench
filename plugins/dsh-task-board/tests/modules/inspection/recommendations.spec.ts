import { describe, expect, it } from 'vitest'
import { parseCandidates } from '../../../src/modules/inspection/core/recommendations.ts'
const evidence = [{ id: 'e', path: 'progress.md', text: '尚未验收', fingerprint: 'v1' }]
const candidate = { title: '补齐验收', reason: '进度文件记录尚未验收', category: 'verification', scope: 'progress.md', evidenceIds: ['e'], acceptance: ['运行对应验收并记录结果'] }
describe('结构化推荐证据门', () => {
  it('operator：给定证据充分的建议，当解析时，保留可核对引用', () => {
    // Given: 证据充分的建议
    // When: 解析
    // Then: 保留可核对引用
    expect(parseCandidates(JSON.stringify({ candidates: [candidate] }), evidence, 3)).toEqual([candidate])
  })
  it('operator：给定没有建议的有效模型输出，当解析时，成功返回零条', () => {
    // Given: 没有建议的有效模型输出
    // When: 解析
    // Then: 成功返回零条
    expect(parseCandidates('{"candidates":[]}', evidence, 3)).toEqual([])
  })
  it('operator：给定虚构引用或空证据，当解析时，拒绝整份响应', () => {
    // Given: 虚构引用或空证据
    // When: 解析
    // Then: 拒绝整份响应
    for (const evidenceIds of [['missing'], []]) {
      expect(() => parseCandidates(JSON.stringify({ candidates: [{ ...candidate, evidenceIds }] }), evidence, 3)).toThrow('invalid-evidence')
    }
  })
  it('operator：给定相同来源换标题或超额输出，当解析时，拒绝重复与超额', () => {
    // Given: 相同来源换标题或超额输出
    // When: 解析
    // Then: 拒绝重复与超额
    expect(() => parseCandidates(JSON.stringify({ candidates: [candidate, { ...candidate, title: '不同标题' }] }), evidence, 3)).toThrow('duplicate')
    expect(() => parseCandidates(JSON.stringify({ candidates: [candidate] }), evidence, 0)).toThrow('invalid-candidates')
  })
  it('operator：给定缺失验收标准和超长字段，当解析时，拒绝不完整建议', () => {
    // Given: 缺失验收标准和超长字段
    // When: 解析
    // Then: 拒绝不完整建议
    expect(() => parseCandidates(JSON.stringify({ candidates: [{ ...candidate, acceptance: [] }] }), evidence, 3)).toThrow()
    expect(() => parseCandidates(JSON.stringify({ candidates: [{ ...candidate, title: 'a'.repeat(161) }] }), evidence, 3)).toThrow()
  })
})

