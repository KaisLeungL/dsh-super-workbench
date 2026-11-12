import { describe, expect, it } from 'vitest'
import { MISSING_WORKSPACE_REASON, isMissingWorkspaceReason, mostRecentWorkspaceId, workspaceOwningSession, type WorkspaceCandidate } from '../src/core/workspace-target.ts'

function workspace(id: string, updatedAt: string, sessionIds: readonly string[] = []): WorkspaceCandidate {
  return { id, updatedAt, sessionIds }
}

describe('workspaceOwningSession', () => {
  it('operator sees the workspace that owns a session', () => {
    // Given two workspaces, each owning one session
    const items = [workspace('ws-a', '2026-09-30T10:00:00.000Z', ['session-a']), workspace('ws-b', '2026-09-30T09:00:00.000Z', ['session-b'])]

    // When one session's workspace is asked for
    const found = workspaceOwningSession(items, 'session-b')

    // Then its owning workspace answers, regardless of recency
    expect(found).toBe('ws-b')
  })

  it('operator sees no owner for a session no workspace claims', () => {
    // Given a registry that does not know the session
    const items = [workspace('ws-a', '2026-09-30T10:00:00.000Z', ['session-a'])]

    // When an unknown session is asked for
    // Then nothing is claimed
    expect(workspaceOwningSession(items, 'session-elsewhere')).toBeUndefined()
  })
})

describe('mostRecentWorkspaceId', () => {
  it('operator sees the most recently changed workspace win', () => {
    // Given workspaces listed oldest-first and newest-first
    const oldestFirst = [workspace('ws-old', '2026-09-29T10:00:00.000Z'), workspace('ws-new', '2026-09-30T10:00:00.000Z')]
    const newestFirst = [...oldestFirst].reverse()

    // When the most recent workspace is resolved
    // Then the newest durable mutation wins in either listing order
    expect(mostRecentWorkspaceId(oldestFirst)).toBe('ws-new')
    expect(mostRecentWorkspaceId(newestFirst)).toBe('ws-new')
  })

  it('user sees the missing-workspace refusal recognized and no other failure rewritten', () => {
    // Given the refusal the Host records for a card that names no workspace
    // When it and unrelated failure texts are classified
    // Then only that refusal is claimed, so no other failure is reworded
    expect(isMissingWorkspaceReason(MISSING_WORKSPACE_REASON)).toBe(true)
    expect(isMissingWorkspaceReason('workspace not found: ws-a')).toBe(false)
    expect(isMissingWorkspaceReason('')).toBe(false)
  })

  it('operator sees list order decide equal and unreadable stamps', () => {
    // Given two workspaces with the same stamp, and a registry with none readable
    const tied = [workspace('ws-first', '2026-09-30T10:00:00.000Z'), workspace('ws-second', '2026-09-30T10:00:00.000Z')]
    const unreadable = [workspace('ws-first', 'not-a-timestamp'), workspace('ws-second', '')]

    // When the most recent workspace is resolved
    // Then the deployment's own order decides, and an empty registry means none
    expect(mostRecentWorkspaceId(tied)).toBe('ws-first')
    expect(mostRecentWorkspaceId(unreadable)).toBe('ws-first')
    expect(mostRecentWorkspaceId([])).toBeUndefined()
  })
})
