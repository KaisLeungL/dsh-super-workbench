/**
 * Why a stored credential reaches the mounted client immediately.
 *
 * Reported from the field: replacing the GitHub token in the settings card left
 * every write failing with the superseded token's 403 until the next five-minute
 * poll refreshed the client (or the Host was restarted). The store had the new
 * value the whole time — the provider had read the old one on its previous pass
 * and had no reason to look again.
 */
import { describe, expect, it } from 'vitest'
import { GitHubApiClient } from '../../../src/modules/github/host/client.ts'
import { GitHubSyncService } from '../../../src/modules/github/host/service.ts'
import { FakeBoard } from './support/fake-board.ts'
import { FakeGitHubBackend, issueFixture } from './support/fake-github.ts'
import type { TaskBoardExtension, TaskBoardExtensionHost } from '../../../src/modules/github/core/contract.ts'

/** Admit a stub provider and hand back the capability face the board gives it. */
function faceOf(board: FakeBoard): TaskBoardExtensionHost {
  let face: TaskBoardExtensionHost | undefined
  const stub: TaskBoardExtension = { id: 'github', apiVersion: 1, start: host => { face = host } }
  board.admit(stub)
  if (face === undefined) throw new Error('the fake board did not start the provider')
  return face
}

const REPO = { owner: 'deepseek-ai', repository: 'dsh', inclusionLabel: 'dsh', pollingIntervalMs: 300_000 }

describe('credential reload', () => {
  it('operator who stores a new credential has the next write use it, with no poll in between', async () => {
    // Given: a provider mounted while the store answered one token
    const board = new FakeBoard()
    const backend = new FakeGitHubBackend()
    backend.issues = [issueFixture(1, ['dsh'])]
    const seen: string[] = []
    const recording: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined)
      seen.push(headers.get('authorization') ?? '')
      return await backend.fetch(input as RequestInfo, init)
    }
    let stored = 'old-token'
    const service = new GitHubSyncService({
      host: faceOf(board),
      client: new GitHubApiClient({ token: 'old-token', fetch: recording }),
      repositories: [REPO],
      credential: async () => stored,
      now: () => 100,
    })
    await service.syncAll()
    const cardId = service.listTasks({})[0]?.id ?? ''

    // When: the operator stores another token and the Host reports the write
    stored = 'new-token'
    await service.reloadCredential()
    await service.postComment(cardId, 'probe')

    // Then: the write authenticated with the new value, and the comment landed
    expect(seen.at(-1)).toBe('Bearer new-token')
    expect(backend.comments).toHaveLength(1)
  })

  it('operator who switches account gets the @me rule resolved again, not from memory', async () => {
    // Given: a provider whose '@me' login was already resolved for one account
    const board = new FakeBoard()
    const backend = new FakeGitHubBackend()
    backend.issues = [issueFixture(1, ['dsh'])]
    backend.login = 'first-account'
    let stored = 'first-token'
    const service = new GitHubSyncService({
      host: faceOf(board),
      client: new GitHubApiClient({ token: 'first-token', fetch: backend.fetch }),
      repositories: [{ ...REPO, assignee: '@me' }],
      credential: async () => stored,
      now: () => 100,
    })
    await service.syncAll()

    // When: the credential is replaced by one that authenticates as somebody else
    backend.login = 'second-account'
    stored = 'second-token'
    await service.reloadCredential()
    const second = await service.syncAll()

    // Then: the second pass asks GitHub again instead of trusting the cached login
    expect(backend.userReads).toBeGreaterThan(1)
    expect(second.errors).toEqual([])
  })
})
