/** 巡检规则仅引用 DSH 工作区，不维护第二份项目目录。 */
export interface InspectionRule {
  id: string
  workspaceId: string
  enabled: boolean
  root: string
  goal: string
  revision: number
  paths: string[]
  model: string
  daily: boolean
  cron: string
  timeZone: string
  maxRecommendations: number
  includeGit?: boolean
  /** Explicitly selected sessions already recorded by this board in this execution workspace. */
  sessionIds?: string[]
}
export interface Workspace { id: string; path?: string; title?: string }
export interface Evidence {
  id: string
  path: string
  text: string
  fingerprint: string
}
export interface Coverage {
  files: number
  bytes: number
  visited: number
  omitted: number
  truncated: boolean
  git: 'not-requested' | 'collected' | 'unavailable'
  sessions?: { requested: number; collected: number; omitted: number }
}
export interface EvidenceBundle { evidence: Evidence[]; coverage: Coverage }
export interface Candidate {
  title: string
  reason: string
  category: string
  scope: string
  evidenceIds: string[]
  acceptance: string[]
}
export interface Analysis {
  candidates: Candidate[]
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
}
export interface ProjectResult {
  ruleId: string
  status: 'succeeded' | 'failed' | 'skipped'
  taskIds: string[]
  coverage?: Coverage
  error?: string
  usage?: Analysis['usage']
  pending?: Array<{ draft: import('./contract.ts').RecommendationDraft; options: import('./contract.ts').RecommendationOptions }>
}
export interface ScanRun {
  id: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'completed' | 'partial'
  results: ProjectResult[]
}
export interface RunStore {
  get(id: string): ScanRun | undefined
  list(): ScanRun[]
  put(run: ScanRun): Promise<void>
}
export const INSPECTION_ID = 'inspection'
export const LIMITS = { files: 24, visited: 256, fileBytes: 16_384, totalBytes: 96_000, outputChars: 16_000, timeoutMs: 90_000, batchRecommendations: 5, batchProjects: 5, outputTokens: 4096 } as const
