import { z } from 'zod'
import type { RunStore, ScanRun } from '../core/types.ts'

const resultSchema = z.object({
  ruleId: z.string(), status: z.enum(['succeeded', 'failed', 'skipped']), taskIds: z.array(z.string()),
  coverage: z.object({ files: z.number(), bytes: z.number(), visited: z.number(), omitted: z.number(), truncated: z.boolean(), git: z.enum(['not-requested', 'collected', 'unavailable']), sessions: z.object({ requested: z.number(), collected: z.number(), omitted: z.number() }).optional() }).optional(),
  error: z.string().optional(), usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), totalTokens: z.number().optional(), cacheReadTokens: z.number().optional(), cacheWriteTokens: z.number().optional(), reasoningTokens: z.number().optional() }).optional(),
  pending: z.array(z.object({
    draft: z.object({ projectId: z.string(), workspaceId: z.string().optional(), title: z.string(), description: z.string(), prompt: z.string() }),
    options: z.object({
      origin: z.object({ kind: z.literal('inspection'), ruleId: z.string(), batchId: z.string() }),
      recommendation: z.object({
        sourceKey: z.string(), fingerprint: z.string(), reasonNow: z.string(), evidenceRefs: z.array(z.string()),
        acceptanceCriteria: z.array(z.string()), scope: z.string(), effortBand: z.string(), observedAt: z.number(), validUntil: z.number().optional(),
      }),
      payload: z.record(z.string(), z.unknown()).optional(),
    }),
  })).optional(),
})
export const runSchema = z.object({
  id: z.string(), startedAt: z.number(), endedAt: z.number().optional(), status: z.enum(['running', 'completed', 'partial']), results: z.array(resultSchema),
})
interface Domain {
  table(name: string): { get(id: string): unknown; entries(): IterableIterator<[string, unknown]>; put(id: string, value: unknown): Promise<void> }
  close(): Promise<void>
}
export interface DomainFacility { open(spec: unknown): Promise<Domain> }
/** 批次属于插件域，卡片与推荐去重属于看板；不假装跨域原子。 */
export async function openRunStore(facility: DomainFacility): Promise<RunStore & { close(): Promise<void> }> {
  const domain = await facility.open({ name: 'task_board_inspection', version: 1, tables: { runs: { valueSchema: runSchema } }, layout: 'per-record' })
  const table = domain.table('runs')
  return {
    get: id => { const value = table.get(id); return value === undefined ? undefined : runSchema.parse(value) },
    list: () => [...table.entries()].map(([, value]) => runSchema.parse(value)).sort((a, b) => a.startedAt - b.startedAt),
    put: async (run: ScanRun) => { await table.put(run.id, runSchema.parse(run)) },
    close: () => domain.close(),
  }
}
