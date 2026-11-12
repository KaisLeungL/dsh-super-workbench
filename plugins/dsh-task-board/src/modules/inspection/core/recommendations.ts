import type { Candidate, Evidence, InspectionRule } from './types.ts'

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max
/** 严格拒绝无证据、虚构引用和超额输出；零条推荐是成功结果。 */
export function parseCandidates(reply: string, evidence: readonly Evidence[], maximum: number): Candidate[] {
  const parsed: unknown = JSON.parse(reply)
  if (!object(parsed) || !Array.isArray(parsed.candidates) || parsed.candidates.length > maximum) throw new Error('invalid-candidates')
  const known = new Set(evidence.map(item => item.id))
  const seen = new Set<string>()
  return parsed.candidates.map((value: unknown) => {
    if (!object(value) || !bounded(value.title, 160) || !bounded(value.reason, 1200) || !bounded(value.category, 80) || !bounded(value.scope, 300)
      || !Array.isArray(value.evidenceIds) || value.evidenceIds.length < 1 || value.evidenceIds.length > 6
      || !value.evidenceIds.every(id => typeof id === 'string' && known.has(id))
      || !Array.isArray(value.acceptance) || value.acceptance.length < 1 || value.acceptance.length > 5
      || !value.acceptance.every(item => bounded(item, 500))) throw new Error('invalid-evidence-or-candidate')
    const candidate = value as unknown as Candidate
    const key = [candidate.category, candidate.scope, ...[...candidate.evidenceIds].sort()].join('|')
    if (seen.has(key)) throw new Error('duplicate-candidate')
    seen.add(key)
    return candidate
  })
}
export function validRule(rule: InspectionRule): boolean {
  return typeof rule.id === 'string' && rule.id.length > 0 && typeof rule.workspaceId === 'string' && rule.workspaceId.length > 0
    && typeof rule.root === 'string' && rule.root.length > 0 && typeof rule.goal === 'string' && rule.goal.trim().length > 0 && rule.goal.length <= 4000
    && Number.isSafeInteger(rule.revision) && rule.revision > 0 && Array.isArray(rule.paths) && rule.paths.length > 0 && rule.paths.length <= 24
    && rule.paths.every(path => typeof path === 'string' && path.length > 0 && path.length <= 500)
    && Number.isInteger(rule.maxRecommendations) && rule.maxRecommendations >= 0 && rule.maxRecommendations <= 3
    && typeof rule.model === 'string' && /^[^/]+\/.+/.test(rule.model)
    && typeof rule.daily === 'boolean' && typeof rule.enabled === 'boolean'
    && typeof rule.cron === 'string' && typeof rule.timeZone === 'string'
    && (rule.sessionIds === undefined || (Array.isArray(rule.sessionIds) && rule.sessionIds.length <= 5
      && rule.sessionIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id))))
}
