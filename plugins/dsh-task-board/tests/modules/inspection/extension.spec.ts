import { describe, expect, it, vi } from 'vitest'
import { digest } from '../../../src/modules/inspection/host/collector.ts'
import { createExtension } from '../../../src/modules/inspection/index.ts'
import type { InspectionHost } from '../../../src/modules/inspection/core/contract.ts'
import type { InspectionRule } from '../../../src/modules/inspection/core/types.ts'
import type { InspectionService } from '../../../src/modules/inspection/host/service.ts'

const rule: InspectionRule = { id: 'r', workspaceId: 'w', root: '/fixture', goal: '目标', revision: 1, enabled: true, paths: ['README.md'], model: 'p/m', daily: true, cron: '0 9 * * *', timeZone: 'Asia/Shanghai', maxRecommendations: 3 }
describe('看板巡检策略协商', () => {
  it('operator rejects acceptance after the selected goal or scope changes', () => {
    // Given a proposal carrying the rule fingerprint used to collect evidence.
    let current = { ...rule }
    const extension = createExtension({ rules: () => [current], workspaces: () => [], service: () => { throw new Error('not started') } })
    const task = { origin: { ruleId: rule.id }, integrations: { inspection: { goalRevision: rule.revision, ruleFingerprint: digest(JSON.stringify(rule)) } } }
    expect(() => extension.validateRecommendation!(task)).not.toThrow()
    // When the current scope changes without incrementing its revision.
    current = { ...rule, paths: ['other.md'] }
    // Then the exact prior candidate cannot be accepted.
    expect(() => extension.validateRecommendation!(task)).toThrow(/goal-changed/)
  })

  it('operator：给定缺少宿主 Cron 能力，当启用扩展时，仅报告不可用且不运行', () => {
    // Given: 缺少宿主 Cron 能力
    // When: 启用扩展
    // Then: 仅报告不可用且不运行
    const run = vi.fn()
    const service = { run, dispose: vi.fn(), summary: () => ({}) } as unknown as InspectionService
    const publish = vi.fn()
    const host: InspectionHost = { tasks: { list: () => [] }, publish }
    const extension = createExtension({ rules: () => [rule], workspaces: () => [], service: () => service })
    extension.start(host)
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ scheduleErrors: ['r:schedule-adapter-unavailable'] }))
    expect(run).not.toHaveBeenCalled()
  })
  it('operator：给定同一时区和 Cron 的多个项目，当注册策略时，合成单个批次并回收注册', async () => {
    // Given: 同一时区和 Cron 的多个项目
    // When: 注册策略
    // Then: 合成单个批次并回收注册
    const run = vi.fn(async () => ({ status: 'completed' }))
    const dispose = vi.fn()
    let trigger: ((occurrence: number) => Promise<void>) | undefined
    const register = vi.fn((request: { run(occurrence: number): Promise<void> }) => { trigger = request.run; return dispose })
    const service = { run, dispose: vi.fn(), summary: () => ({}) } as unknown as InspectionService
    const host: InspectionHost = { tasks: { list: () => [] }, publish: vi.fn(), inspectionSchedule: { register } }
    const extension = createExtension({ rules: () => [rule, { ...rule, id: 'second' }], workspaces: () => [], service: () => service })
    extension.start(host)
    expect(register).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
    await trigger!(1000)
    expect(run).toHaveBeenCalledWith(['r', 'second'], 1000)
    extension.stop()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(service.dispose).toHaveBeenCalledTimes(1)
  })
})

