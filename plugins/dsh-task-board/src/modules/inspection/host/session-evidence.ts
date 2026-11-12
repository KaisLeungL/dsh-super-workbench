import type { InspectionHost } from '../core/contract.ts'
import { LIMITS, type EvidenceBundle, type InspectionRule } from '../core/types.ts'
import { containsSecret, digest } from './collector.ts'

/** Only selected, settled summaries already held by the board; never enumerate session history. */
export function appendSessionEvidence(bundle: EvidenceBundle, rule: InspectionRule, tasks: ReturnType<InspectionHost['tasks']['list']>): void {
  const selected = [...new Set(rule.sessionIds ?? [])]
  if (selected.length === 0) return
  const coverage = { requested: selected.length, collected: 0, omitted: 0 }
  bundle.coverage.sessions = coverage
  for (const id of selected) {
    const matches = tasks.filter(task => task.workspaceId === rule.workspaceId)
      .flatMap(task => (task.executions ?? []).filter(run => run.sessionId === id && run.endedAt !== undefined && run.summary !== undefined))
      .sort((a, b) => b.endedAt! - a.endedAt!)
    const run = matches[0]
    const summary = run?.summary
    if (!run || !summary || !summary.text.trim() || containsSecret(summary.text)) { coverage.omitted++; continue }
    const text = JSON.stringify({ result: run.result, endedAt: run.endedAt, seq: summary.seq, text: summary.text.slice(0, 4000) })
    const bytes = Buffer.byteLength(text)
    if (bundle.evidence.length >= LIMITS.files || bundle.coverage.bytes + bytes > LIMITS.totalBytes) {
      bundle.coverage.truncated = true
      coverage.omitted++
      continue
    }
    const path = 'dsh-session/' + id + '/' + run.id + '#' + summary.seq
    bundle.evidence.push({ id: digest(path), path, text, fingerprint: digest(text) })
    bundle.coverage.bytes += bytes
    coverage.collected++
  }
}
