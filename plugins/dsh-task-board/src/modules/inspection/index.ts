import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { BoardService, Extension, InspectionHost } from './core/contract.ts'
import { INSPECTION_ID, type InspectionRule, type Workspace } from './core/types.ts'
import { createAnalyzer } from './host/analyzer.ts'
import { InspectionService } from './host/service.ts'
import { openRunStore, type DomainFacility } from './host/store.ts'
import { validRule } from './core/recommendations.ts'
import { digest } from './host/collector.ts'
import { mountOnce } from './mount-once.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}
export interface Config {
  enabled?: Volatile<boolean>
  rules?: Volatile<InspectionRule[]>
}
export const Config: z<{ enabled?: boolean; rules?: InspectionRule[] }, Config> = z.object({
  enabled: z.boolean().default(true).volatile(),
  rules: z.array(z.object({
    id: z.string(), workspaceId: z.string(), enabled: z.boolean().default(false), root: z.string(),
    goal: z.string(), revision: z.number().default(1), paths: z.array(z.string()).default(['README.md']),
    model: z.string(), daily: z.boolean().default(false), cron: z.string().default('0 9 * * *'),
    timeZone: z.string().default('Asia/Shanghai'), maxRecommendations: z.number().default(3), includeGit: z.boolean().default(false), sessionIds: z.array(z.string()).default([]),
  })).default([]).volatile(),
})
const read = <T,>(field: Volatile<T> | undefined, fallback: T): T => field === undefined ? fallback : field.get() as T
export const inject = ['storageDomain', 'workspaceRegistry']
export function createExtension(options: {
  rules(): InspectionRule[]
  workspaces(): Workspace[]
  service(host: InspectionHost): InspectionService
}): Extension {
  let service: InspectionService | undefined
  let schedules: Array<() => void> = []
  return {
    id: INSPECTION_ID, apiVersion: 1,
    start(host) {
      service = options.service(host)
      const rules = options.rules()
      const errors: string[] = []
      const groups = new Map<string, InspectionRule[]>()
      for (const rule of rules.filter(value => value.enabled && value.daily)) {
        if (!validRule(rule)) { errors.push(rule.id + ':invalid-rule'); continue }
        const key = JSON.stringify([rule.cron, rule.timeZone])
        groups.set(key, [...(groups.get(key) ?? []), rule])
      }
      for (const group of groups.values()) {
        const first = group[0]!
        if (!host.inspectionSchedule) { errors.push(first.id + ':schedule-adapter-unavailable'); continue }
        const ids = group.map(rule => rule.id).sort()
        try {
          schedules.push(host.inspectionSchedule.register({
            id: digest(JSON.stringify(ids)).slice(0, 24), cron: first.cron, timeZone: first.timeZone,
            run: async occurrence => {
              if (!service) throw new Error('inspection-not-running')
              const result = await service.run(ids, occurrence)
              if (result.status === 'partial') throw new Error('inspection-batch-partial; see inspection results')
            },
          }))
        } catch { errors.push(first.id + ':schedule-refused') }
      }
      host.publish({ ...service.summary(), scheduleErrors: errors.slice(0, 20) })
    },
    stop() {
      for (const dispose of schedules) dispose()
      schedules = []
      service?.dispose()
      service = undefined
    },
    validateRecommendation(task) {
      const rule = options.rules().find(value => value.id === task.origin?.ruleId)
      if (!rule?.enabled || !validRule(rule) || task.integrations?.[INSPECTION_ID]?.goalRevision !== rule.revision || task.integrations?.[INSPECTION_ID]?.ruleFingerprint !== digest(JSON.stringify(rule))) throw new Error('inspection-goal-changed; inspect again before accepting')
    },
    async handleAction(request) {
      if (!service) throw new Error('inspection-not-running')
      if (request.action !== 'run') throw new Error('unsupported-inspection-action')
      const ruleId = request.payload?.ruleId
      if (typeof ruleId !== 'string') throw new Error('rule-required')
      return service.run([ruleId])
    },
  }
}
export const apply = mountOnce('@linxin666/dsh-task-board-inspection', async (ctx: Context, config: Config) => {
  const store = await openRunStore(ctx.get('storageDomain') as unknown as DomainFacility)
  ctx.effect(() => () => store.close())
  const registry = ctx.get('workspaceRegistry') as unknown as { list(): Workspace[] }
  let injection: ReturnType<Context['inject']> | undefined
  const sync = (): void => {
    if (injection) { void injection.dispose(); injection = undefined }
    if (!read(config.enabled, true)) return
    injection = ctx.inject(['taskBoard'], scope => {
      const board = scope.get('taskBoard') as unknown as BoardService
      scope.effect(() => board.registerExtension(createExtension({
        rules: () => read(config.rules, []), workspaces: () => registry.list(),
        service: host => new InspectionService({ host, store, rules: () => read(config.rules, []), workspaces: () => registry.list(), analyzer: createAnalyzer(() => ctx.get('llm') as LlmRuntime | undefined) }),
      })))
    })
  }
  sync()
  ctx.on('loader/volatile-update', sync)
  ctx.effect(() => () => { if (injection) void injection.dispose() })
})
