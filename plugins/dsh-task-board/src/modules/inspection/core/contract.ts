/** 跨插件只使用服务；不值导入原看板，不持有其账本。 */
export interface RecommendationDraft {
  workspaceId?: string
  projectId: string
  title: string
  description: string
  prompt: string

}
export interface RecommendationOptions {
  origin: { kind: 'inspection'; ruleId: string; batchId: string }
  recommendation: {
    sourceKey: string
    fingerprint: string
    reasonNow: string
    evidenceRefs: string[]
    acceptanceCriteria: string[]
    scope: string
    effortBand: string
    observedAt: number
    validUntil?: number
  }
  payload?: Record<string, unknown>
}
export interface InspectionHost {
  tasks: {
    list(): readonly { id: string; title: string; status: string; projectId?: string | null; workspaceId?: string; archivedAt?: number; executions?: readonly { id: string; sessionId?: string; endedAt?: number; result?: string; summary?: { text: string; seq: number } }[] }[]
    upsertRecommendation?(draft: RecommendationDraft, options: RecommendationOptions): { id: string }
  }
  publish(value: Record<string, unknown>): void
  inspectionSchedule?: {
    register(rule: { id: string; cron: string; timeZone: string; run(occurrence: number): Promise<void> }): () => void
  }
}
export interface Extension {
  id: string
  apiVersion: number
  start(host: InspectionHost): void
  stop(): void
  validateRecommendation?(task: { origin?: { ruleId: string }; integrations?: Record<string, Record<string, unknown>> }): void
  handleAction(request: { action: string; payload?: Record<string, unknown> }): Promise<unknown>
}
export interface BoardService { registerExtension(extension: Extension): () => void }
