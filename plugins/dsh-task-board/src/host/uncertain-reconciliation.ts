import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { SessionSummary } from '../host-runner.ts'

/** Only the owner gateway's complete, unpaginated official roster is evidence. */
function directorySessions(value: unknown, directory: string): SessionSummary[] {
  if (value === null || typeof value !== 'object' || Object.keys(value).some(key => key !== 'items')
    || !Array.isArray((value as { items?: unknown }).items)) throw new Error('Session roster is incomplete or unreadable')
  const matches: SessionSummary[] = []
  const ids = new Set<string>()
  for (const row of (value as { items: unknown[] }).items) {
    const item = row as Partial<SessionSummary> | null
    if (item === null || typeof item !== 'object' || typeof item.sessionId !== 'string' || item.sessionId.trim() === ''
      || ids.has(item.sessionId) || typeof item.cwd !== 'string' || !isAbsolute(item.cwd)
      || typeof item.running !== 'boolean' || typeof item.agentAvailable !== 'boolean') {
      throw new Error('Session roster contains an unknown session or execution directory')
    }
    ids.add(item.sessionId)
    // Resolve every directory: an unreadable alias cannot safely be excluded.
    const canonical = realpathSync(item.cwd)
    if (canonical !== directory) continue
    if (item.formatStatus !== undefined && item.formatStatus !== 'current') throw new Error('Session format requires migration: ' + item.sessionId)
    if (item.running) throw new Error('Execution directory still has a running session: ' + item.sessionId)
    matches.push(item as SessionSummary)
  }
  return matches
}

/**
 * Prove all possible sessions in the canonical directory quiescent. A second
 * complete roster rejects additions or directory changes during the state walk.
 * Neither a title, a prompt nor a user-selected session establishes ownership.
 */
export async function assertUncertainDirectoryStopped(
  directory: string,
  list: () => Promise<unknown>,
  stopped: (sessionId: string) => Promise<boolean>,
): Promise<void> {
  if (!isAbsolute(directory) || realpathSync(directory) !== directory) throw new Error('Execution directory is no longer canonical')
  const before = directorySessions(await list(), directory)
  for (const session of before) {
    if (!await stopped(session.sessionId)) throw new Error('Session is active, queued, awaiting input or its state is unknown: ' + session.sessionId)
  }
  const after = directorySessions(await list(), directory)
  const signature = (items: SessionSummary[]) => items.map(item => JSON.stringify([item.sessionId, item.agentAvailable])).sort().join('\n')
  if (signature(before) !== signature(after)) throw new Error('Session roster changed during reconciliation; retry')
}
