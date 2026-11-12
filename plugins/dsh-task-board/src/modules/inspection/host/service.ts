import { randomUUID } from 'node:crypto'
import type { InspectionHost, RecommendationDraft } from '../core/contract.ts'
import { INSPECTION_ID, LIMITS, type InspectionRule, type RunStore, type ScanRun, type Workspace } from '../core/types.ts'
import { validRule } from '../core/recommendations.ts'
import { collectEvidence, digest } from './collector.ts'
import { withDeadline, type Analyzer } from './analyzer.ts'
import { appendSessionEvidence } from './session-evidence.ts'

export interface InspectionOptions {
  host: InspectionHost
  store: RunStore
  rules(): InspectionRule[]
  workspaces(): Workspace[]
  analyzer: Analyzer
  now?: () => number
}
export class InspectionService {
  private active = new Map<string, Promise<ScanRun>>()
  private abort = new AbortController()
  constructor(readonly options: InspectionOptions) {}
  dispose(): void { this.abort.abort(new Error('inspection-stopped')) }
  summary(): Record<string, unknown> {
    return {
      scheduleAvailable: !!this.options.host.inspectionSchedule,
      workspaces: this.options.workspaces().slice(0, 50).map(({ id, title, path }) => ({ id, title: title?.slice(0, 100), path: path?.slice(0, 500) })),
      runs: this.options.store.list().slice(-5).map(run => ({
        id: run.id, startedAt: run.startedAt, endedAt: run.endedAt, status: run.status,
        results: run.results.slice(0, 10).map(result => ({
          ruleId: result.ruleId, status: result.status, taskIds: result.taskIds, coverage: result.coverage, usage: result.usage, error: result.error?.slice(0, 160),
        })),
      })),
    }
  }
  run(ruleIds?: string[], occurrence?: number, manualRunId: string = randomUUID()): Promise<ScanRun> {
    const rules = structuredClone(this.options.rules().filter(rule => !ruleIds || ruleIds.includes(rule.id)))
    const key = digest(JSON.stringify({ rules: rules.map(rule => [rule.id, rule.revision, digest(JSON.stringify(rule))]), occurrence: occurrence ?? manualRunId }))
    const active = this.active.get(key)
    if (active) return active
    const operation = this.execute(key, rules).finally(() => { this.active.delete(key) })
    this.active.set(key, operation)
    return operation
  }
  private async execute(id: string, rules: InspectionRule[]): Promise<ScanRun> {
    const { host, store, analyzer } = this.options
    if (!host.tasks.upsertRecommendation) throw new Error('atomic-recommendation-api-unavailable')
    const previous = store.get(id)
    if (previous?.status === 'completed') return previous
    const now = this.options.now ?? Date.now
    const run: ScanRun = previous ?? { id, startedAt: now(), status: 'running', results: [] }
    await store.put(structuredClone(run))
    host.publish(this.summary())
    let remaining = Math.max(0, LIMITS.batchRecommendations - run.results.reduce((sum, result) => sum + result.taskIds.length, 0))
    let inspectedProjects = 0
    for (const rule of rules) {
      if (run.results.some(result => result.ruleId === rule.id && result.status !== 'failed')) continue
      const result: ScanRun['results'][number] = run.results.find(value => value.ruleId === rule.id)
        ?? { ruleId: rule.id, status: 'failed', taskIds: [] }
      delete result.error
      run.results = run.results.filter(value => value.ruleId !== rule.id)
      run.results.push(result)
      try {
        this.abort.signal.throwIfAborted()
        if (!rule.enabled || (remaining === 0 && !result.pending)) { result.status = 'skipped'; continue }
        if (inspectedProjects >= LIMITS.batchProjects) { result.status = 'skipped'; result.error = 'batch-project-budget-exhausted'; continue }
        inspectedProjects++
        if (!validRule(rule)) throw new Error('invalid-rule')
        const workspace = this.options.workspaces().find(value => value.id === rule.workspaceId)
        if (!workspace) throw new Error('workspace-missing')
        await withDeadline(async signal => {
          if (!result.pending) {
          const bundle = await collectEvidence(rule, workspace, signal)
          appendSessionEvidence(bundle, rule, host.tasks.list())
          result.coverage = bundle.coverage
          if (bundle.evidence.length === 0) { result.status = 'succeeded'; return }
          const existing = JSON.stringify(host.tasks.list().filter(task => (task.projectId === undefined ? task.workspaceId : task.projectId) === rule.workspaceId).slice(-100).map(task => ({ id: task.id, title: task.title, status: task.status, archived: !!task.archivedAt }))).slice(0, 16000)
          const analysis = await analyzer.analyze({ ...rule, maxRecommendations: Math.min(rule.maxRecommendations, remaining) }, bundle, existing, signal)
          signal.throwIfAborted()
          result.usage = analysis.usage
          result.pending = []
          for (const candidate of analysis.candidates) {
            signal.throwIfAborted()
            const evidence = bundle.evidence.filter(item => candidate.evidenceIds.includes(item.id))
            const sourceKey = digest(JSON.stringify([rule.workspaceId, evidence.map(item => item.path).sort(), candidate.category, candidate.scope]))
            const draft: RecommendationDraft = {
              projectId: rule.workspaceId, workspaceId: rule.workspaceId, title: candidate.title, description: candidate.reason,
              prompt: [candidate.reason, ...candidate.acceptance.map(item => '- ' + item)].join('\n'),
            }
            result.pending.push({ draft, options: {
              origin: { kind: INSPECTION_ID, ruleId: rule.id, batchId: id },
              recommendation: {
                sourceKey, fingerprint: digest(JSON.stringify([rule.revision, rule.goal, rule.root, rule.paths, evidence.map(item => item.fingerprint)])),
                reasonNow: candidate.reason, evidenceRefs: evidence.map(item => item.path + '#' + item.fingerprint),
                acceptanceCriteria: candidate.acceptance, scope: candidate.scope, effortBand: 'unknown', observedAt: now(), validUntil: now() + 24 * 60 * 60_000,
              },
              payload: { goalRevision: rule.revision, ruleFingerprint: digest(JSON.stringify(rule)), evidence: evidence.map(({ id, path, fingerprint }) => ({ id, path, fingerprint })) },
            } })
          }
          // Persist the validated model plan before any cross-domain commit.
          await store.put(structuredClone(run))
          }
          for (const pending of result.pending) {
            signal.throwIfAborted()
            const current = this.options.rules().find(value => value.id === rule.id)
            if (!current || JSON.stringify(current) !== JSON.stringify(rule) || this.options.workspaces().find(value => value.id === rule.workspaceId)?.path !== workspace.path) throw new Error('inspection-rule-changed')
            // Older pending records did not retain workspaceId. Rebind only to
            // this batch's still-validated rule, never the Host's recent workspace.
            const task = host.tasks.upsertRecommendation!({ ...pending.draft, workspaceId: rule.workspaceId }, pending.options)
            if (!result.taskIds.includes(task.id)) { result.taskIds.push(task.id); remaining-- }
            await store.put(structuredClone(run))
          }
          result.status = 'succeeded'
        }, this.abort.signal)
      } catch (error) {
        result.status = 'failed'
        result.error = error instanceof Error ? error.message : String(error)
      } finally {
        await store.put(structuredClone(run))
        host.publish(this.summary())
      }
    }
    run.status = run.results.some(result => result.status === 'failed') ? 'partial' : 'completed'
    run.endedAt = now()
    await store.put(structuredClone(run))
    host.publish(this.summary())
    return structuredClone(run)
  }
}
