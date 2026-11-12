import { describe, expect, it } from 'vitest'
import { appendSessionEvidence } from '../../../src/modules/inspection/host/session-evidence.ts'
import type { EvidenceBundle, InspectionRule } from '../../../src/modules/inspection/core/types.ts'

const rule: InspectionRule = { id: 'r', workspaceId: 'workspace', enabled: true, root: '/fixture', goal: '目标', revision: 1, paths: ['README.md'], model: 'p/m', daily: false, cron: '0 9 * * *', timeZone: 'UTC', maxRecommendations: 3 }
const bundle = (): EvidenceBundle => ({ evidence: [], coverage: { files: 0, bytes: 0, visited: 0, omitted: 0, truncated: false, git: 'not-requested' } })

describe('显式会话摘要证据', () => {
  it('operator only reads selected settled summaries from the execution workspace', () => {
    // Given explicit session selection and records from several workspaces.
    const evidence = bundle()
    const tasks = [
      { id: 'one', title: '', status: 'done', workspaceId: 'workspace', executions: [{ id: 'run', sessionId: 'selected', endedAt: 10, result: 'succeeded', summary: { text: '已完成文档', seq: 2 } }] },
      { id: 'other', title: '', status: 'done', workspaceId: 'other', executions: [{ id: 'else', sessionId: 'foreign', endedAt: 12, summary: { text: '不属于本工作区', seq: 3 } }] },
    ]
    // When only selected and foreign are authorized.
    appendSessionEvidence(evidence, { ...rule, sessionIds: ['selected', 'foreign'] }, tasks)
    // Then cross-workspace data stays absent and coverage reports the gap.
    expect(evidence.evidence).toHaveLength(1)
    expect(evidence.evidence[0].path).toBe('dsh-session/selected/run#2')
    expect(evidence.evidence[0].text).toContain('已完成文档')
    expect(evidence.coverage.sessions).toEqual({ requested: 2, collected: 1, omitted: 1 })
  })

  it('operator excludes secret summaries and reads nothing without explicit selection', () => {
    // Given a recorded summary containing a credential pattern.
    const tasks = [{ id: 'one', title: '', status: 'done', workspaceId: 'workspace', executions: [{ id: 'run', sessionId: 'selected', endedAt: 10, summary: { text: 'api_key=fixture-secret-value', seq: 2 } }] }]
    const selected = bundle()
    const unselected = bundle()
    // When the credential-bearing record is selected or selection is absent.
    appendSessionEvidence(selected, { ...rule, sessionIds: ['selected'] }, tasks)
    appendSessionEvidence(unselected, rule, tasks)
    // Then neither becomes model evidence.
    expect(selected.evidence).toEqual([])
    expect(selected.coverage.sessions).toEqual({ requested: 1, collected: 0, omitted: 1 })
    expect(unselected.evidence).toEqual([])
    expect(unselected.coverage.sessions).toBeUndefined()
  })
})
