import { UNIT_NAME_RE } from '@deepseek-ai/dsh-storage'
import { describe, expect, it, vi } from 'vitest'
import { openRunStore } from '../../../src/modules/inspection/host/store.ts'
describe('巡检独立存储域', () => {
  it('operator：给定 domain facility，当保存批次时，使用巡检域并验证记录', async () => {
    // Given:  domain facility
    // When: 保存批次
    // Then: 使用巡检域并验证记录
    const rows = new Map<string, unknown>()
    const close = vi.fn(async () => {})
    const open = vi.fn(async (spec: { name: string }) => {
      if (!UNIT_NAME_RE.test(spec.name)) throw new Error('invalid unit name')
      return { table: () => ({ get: (id: string) => rows.get(id), entries: () => rows.entries(), put: async (id: string, value: unknown) => { rows.set(id, value) } }), close }
    })
    const store = await openRunStore({ open })
    await store.put({ id: 'batch', startedAt: 100, status: 'completed', results: [] })
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ name: 'task_board_inspection', version: 1 }))
    expect(store.get('batch')).toEqual({ id: 'batch', startedAt: 100, status: 'completed', results: [] })
    expect(store.list()).toHaveLength(1)
    await store.put({ id: 'pending', startedAt: 200, status: 'partial', results: [{
      ruleId: 'rule', status: 'failed', taskIds: [], pending: [{
        draft: { projectId: 'A', workspaceId: 'A', title: '验收', description: '需要验收', prompt: '在 A 验收' },
        options: { origin: { kind: 'inspection', ruleId: 'rule', batchId: 'pending' }, recommendation: { sourceKey: 'source', fingerprint: 'v1', reasonNow: '待验收', evidenceRefs: ['progress.md#v1'], acceptanceCriteria: ['通过'], scope: 'progress.md', effortBand: 'unknown', observedAt: 200 } },
      }],
    }] })
    const reopened = await openRunStore({ open })
    expect(reopened.get('pending')?.results[0]?.pending?.[0]?.draft).toMatchObject({ projectId: 'A', workspaceId: 'A' })
    await expect(store.put({ id: 'invalid' } as never)).rejects.toThrow()
    await store.close()
    expect(close).toHaveBeenCalledTimes(1)
  })
})

