import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostTaskLedger } from '../../../src/host-ledger.ts'
import { createExtension } from '../../../src/modules/inspection/index.ts'
import { digest } from '../../../src/modules/inspection/host/collector.ts'
import type { InspectionRule } from '../../../src/modules/inspection/core/types.ts'

describe('巡检与真实看板账本的推荐刷新', () => {
  it('operator accepts refreshed evidence after changing a goal without creating a duplicate card', () => {
    // Given a real isolated board and a recommendation from the old goal.
    const root = mkdtempSync(join(tmpdir(), 'dsh-inspection-board-'))
    const ledger = new HostTaskLedger(root, () => 1000)
    let rule: InspectionRule = { id: 'r', workspaceId: 'a', enabled: true, root, goal: '旧目标', revision: 1, paths: ['README.md'], model: 'p/m', daily: false, cron: '0 9 * * *', timeZone: 'UTC', maxRecommendations: 3 }
    const extension = createExtension({ rules: () => [rule], workspaces: () => [], service: () => { throw new Error('not started') } })
    const propose = (requestId: string, fingerprint: string) => ledger.applyRequest(requestId, {
      kind: 'upsert-recommendation', id: requestId,
      input: { title: rule.goal, description: rule.goal, prompt: rule.goal, projectId: 'a', workspaceId: 'a', integrations: { inspection: { goalRevision: rule.revision, ruleFingerprint: digest(JSON.stringify(rule)) } } },
      origin: { kind: 'inspection', ruleId: rule.id, batchId: requestId },
      recommendation: { sourceKey: 'same-file-issue', fingerprint, reasonNow: rule.goal, evidenceRefs: ['README.md'], acceptanceCriteria: ['完成'], scope: 'README.md', effortBand: 'small', observedAt: 1000 },
    })
    try {
      propose('first', 'old')
      // When the goal changes and the same source is inspected again.
      rule = { ...rule, goal: '新目标', revision: 2 }
      expect(() => extension.validateRecommendation!(ledger.getTask('first')!)).toThrow(/goal-changed/)
      propose('second', 'new')
      const refreshed = ledger.getTask('first')!
      // Then content, validation payload and evidence update atomically on the original card.
      expect(ledger.allTasks()).toHaveLength(1)
      expect(refreshed).toMatchObject({ prompt: '新目标', workspaceId: 'a', integrations: { inspection: { goalRevision: 2 } }, recommendation: { fingerprint: 'new' } })
      expect(() => extension.validateRecommendation!(refreshed)).not.toThrow()
      ledger.applyRequest('accept', { kind: 'planning', taskId: 'first', decision: 'accept', fingerprint: 'new' }, undefined, true)
      expect(ledger.getTask('first')!.planning!.state).toBe('accepted')
    } finally {
      ledger.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
