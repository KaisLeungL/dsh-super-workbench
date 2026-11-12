import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InspectionService } from '../../../src/modules/inspection/host/service.ts'
import { withDeadline } from '../../../src/modules/inspection/host/analyzer.ts'
import { runSchema } from '../../../src/modules/inspection/host/store.ts'
import type { InspectionRule, ScanRun, RunStore } from '../../../src/modules/inspection/core/types.ts'
import type { RecommendationDraft, RecommendationOptions, InspectionHost } from '../../../src/modules/inspection/core/contract.ts'

describe('巡检批次与原子推荐服务', () => {
  let root: string
  let rules: InspectionRule[]
  let store: RunStore
  let records: Map<string, ScanRun>
  let writes: Array<RecommendationDraft & RecommendationOptions>
  let host: InspectionHost
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-inspection-service-'))
    await writeFile(join(root, 'progress.md'), '交付需要验收')
    rules = [{ id: 'r', workspaceId: 'w', enabled: true, root, goal: '完成交付', revision: 1, paths: ['progress.md'], model: 'p/m', daily: false, cron: '0 9 * * *', timeZone: 'Asia/Shanghai', maxRecommendations: 3 }]
    records = new Map()
    store = { get: id => records.get(id), list: () => [...records.values()], put: async run => { records.set(run.id, structuredClone(run)) } }
    writes = []
    host = { tasks: { list: () => [], upsertRecommendation: (draft, options) => { writes.push({ ...draft, ...options }); return { id: options.recommendation.sourceKey } } }, publish: vi.fn() }
  })
  afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }) })
  const analyzer = () => ({
    analyze: vi.fn(async (_rule, bundle) => ({ candidates: [{ title: '验收', reason: '进度尚缺验收', category: 'verification', scope: 'progress.md', evidenceIds: [bundle.evidence[0].id], acceptance: ['测试通过'] }] })),
  })
  it('operator：给定授权规则，当手动巡检时，先持久化批次再原子提交推荐且不建普通卡', async () => {
    // Given: 授权规则
    // When: 手动巡检
    // Then: 先持久化批次再原子提交推荐且不建普通卡
    const model = analyzer()
    const service = new InspectionService({ host, store, rules: () => rules, workspaces: () => [{ id: 'w', path: root }], analyzer: model, now: () => 123 })
    const run = await service.run(['r'], undefined, 'manual-one')
    expect(run.status).toBe('completed')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ projectId: 'w', workspaceId: 'w', payload: { goalRevision: 1 }, origin: { kind: 'inspection', ruleId: 'r', batchId: run.id } })
    expect(writes[0]?.recommendation.evidenceRefs[0]).toContain('progress.md#')
    expect(store.get(run.id)?.endedAt).toBe(123)
  })
  it('operator discards candidates when authorization changes during analysis', async () => {
    // Given a valid rule captured before the model starts.
    const model = analyzer()
    model.analyze.mockImplementationOnce(async (_rule, bundle) => {
      rules = [{ ...rules[0], revision: 2, goal: '新目标' }]
      return { candidates: [{ title: '旧建议', reason: '旧目标', category: 'verification', scope: 'progress.md', evidenceIds: [bundle.evidence[0].id], acceptance: ['旧验收'] }] }
    })
    const service = new InspectionService({ host, store, rules: () => rules, workspaces: () => [{ id: 'w', path: root }], analyzer: model })
    // When the rule changes while evidence is being analyzed.
    const run = await service.run(['r'])
    // Then stale candidates are retained as a failed batch and never committed.
    expect(run.status).toBe('partial')
    expect(run.results[0].error).toBe('inspection-rule-changed')
    expect(writes).toEqual([])
  })

  it('operator：给定相同 occurrence 与配置 revision，当重复触发时，复用持久化批次不再调用模型', async () => {
    // Given: 相同 occurrence 与配置 revision
    // When: 重复触发
    // Then: 复用持久化批次不再调用模型
    const model = analyzer()
    const options = { host, store, rules: () => rules, workspaces: () => [{ id: 'w', path: root }], analyzer: model }
    const first = await new InspectionService(options).run(['r'], 1000)
    const second = await new InspectionService(options).run(['r'], 1000)
    expect(second.id).toBe(first.id)
    expect(model.analyze).toHaveBeenCalledTimes(1)
    expect(writes).toHaveLength(1)
  })
  it('operator：给定原子契约缺失，当巡检时，拒绝且不调用采集模型', async () => {
    // Given: 原子契约缺失
    // When: 巡检
    // Then: 拒绝且不调用采集模型
    delete host.tasks.upsertRecommendation
    const model = analyzer()
    const service = new InspectionService({ host, store, rules: () => rules, workspaces: () => [], analyzer: model })
    await expect(service.run()).rejects.toThrow('atomic-recommendation-api-unavailable')
    expect(model.analyze).not.toHaveBeenCalled()
    expect(records.size).toBe(0)
  })
  it('operator：给定已提交卡片但批次失败，当重试时，以稳定来源去重且改标题不改变身份', async () => {
    // Given: 已提交卡片但批次失败
    // When: 重试
    // Then: 以稳定来源去重且改标题不改变身份
    let failed = true
    host.tasks.upsertRecommendation = (draft, options) => {
      writes.push({ ...draft, ...options })
      if (failed) { failed = false; throw new Error('unknown-commit-outcome') }
      return { id: options.recommendation.sourceKey }
    }
    const model = analyzer()
    const service = new InspectionService({ host, store, rules: () => rules, workspaces: () => [{ id: 'w', path: root }], analyzer: model })
    expect((await service.run(['r'], 2000)).status).toBe('partial')
    expect((await service.run(['r'], 2000)).status).toBe('completed')
    expect(writes).toHaveLength(2)
    expect(model.analyze).toHaveBeenCalledTimes(1)
    expect(writes[0]?.recommendation.sourceKey).toBe(writes[1]?.recommendation.sourceKey)
  })
  it.each([false, true])('operator resumes a persisted pending draft in its authorized workspace (legacy=%s)', async legacy => {
    // Given a failed cross-domain commit serialized by the actual persistence schema.
    store.put = async run => { records.set(run.id, runSchema.parse(structuredClone(run))) }
    const model = analyzer()
    host.tasks.upsertRecommendation = () => { throw new Error('commit interrupted') }
    const options = { host, store, rules: () => rules, workspaces: () => [{ id: 'w', path: root }], analyzer: model }
    const first = await new InspectionService(options).run(['r'], 3000)
    expect(first.status).toBe('partial')
    if (legacy) delete records.get(first.id)!.results[0].pending![0].draft.workspaceId
    host.tasks.upsertRecommendation = (draft, options) => { writes.push({ ...draft, ...options }); return { id: 'recovered' } }
    // When a new service resumes that stored batch, with no further model call.
    const recovered = await new InspectionService(options).run(['r'], 3000)
    // Then both new and legacy pending records remain pinned to the rule's workspace.
    expect(recovered.status).toBe('completed')
    expect(writes[0]).toMatchObject({ projectId: 'w', workspaceId: 'w' })
    expect(model.analyze).toHaveBeenCalledTimes(1)
  })

  it('operator bounds model calls even when every project produces zero recommendations', async () => {
    // Given more authorized projects than one batch may analyze.
    rules = Array.from({ length: 6 }, (_, index) => ({ ...rules[0], id: 'rule-' + index }))
    const analyze = vi.fn(async () => ({ candidates: [] }))
    const service = new InspectionService({ host, store, rules: () => rules, workspaces: () => [{ id: 'w', path: root }], analyzer: { analyze } })
    // When a batch has no suggestions to consume its card budget.
    const run = await service.run()
    // Then the project budget still limits scans and model calls.
    expect(analyze).toHaveBeenCalledTimes(5)
    expect(run.results[5]).toMatchObject({ status: 'skipped', error: 'batch-project-budget-exhausted', taskIds: [] })
  })

  it('operator：给定模型零建议，当巡检时，仍记录覆盖和成功且不写卡', async () => {
    // Given: 模型零建议
    // When: 巡检
    // Then: 仍记录覆盖和成功且不写卡
    const service = new InspectionService({ host, store, rules: () => rules, workspaces: () => [{ id: 'w', path: root }], analyzer: { analyze: async () => ({ candidates: [] }) } })
    const run = await service.run(['r'])
    expect(run.results[0]).toMatchObject({ status: 'succeeded', taskIds: [], coverage: { files: 1 } })
    expect(writes).toEqual([])
  })
  it('operator：给定失效工作区与另一项目，当巡检时，逐项目保存错误且继续其他项目', async () => {
    // Given: 失效工作区与另一项目
    // When: 巡检
    // Then: 逐项目保存错误且继续其他项目
    rules = [{ ...rules[0], id: 'missing', workspaceId: 'deleted' }, ...rules]
    const service = new InspectionService({ host, store, rules: () => rules, workspaces: () => [{ id: 'w', path: root }], analyzer: analyzer() })
    const run = await service.run()
    expect(run.status).toBe('partial')
    expect(run.results.map(result => [result.ruleId, result.status])).toEqual([['missing', 'failed'], ['r', 'succeeded']])
    expect(run.results[0]?.error).toBe('workspace-missing')
  })
  it('operator：给定 provider 忽略取消，当到达预算时，仍按时拒绝', async () => {
    // Given:  provider 忽略取消
    // When: 到达预算
    // Then: 仍按时拒绝
    vi.useFakeTimers()
    const result = withDeadline(() => new Promise<never>(() => {}), undefined, 100)
    const assertion = expect(result).rejects.toThrow('inspection-timeout')
    await vi.advanceTimersByTimeAsync(100)
    await assertion
  })
})

