/**
 * Every GitHub tool result must be lossless JSON.
 *
 * The host tool runtime snapshots a successful tool value before it reaches the
 * model and refuses the call outright when the snapshot is not lossless
 * (`value is not lossless JSON`). JSON.stringify hides the difference by
 * silently dropping an `undefined` member, so a projection that only ever
 * checks itself with JSON.stringify passes while the tool is unusable. These
 * cases assert the stricter rule the runtime actually applies, and they assert
 * that the fields a model reads survive the round trip rather than vanishing.
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { TaskBoardExtension, TaskBoardExtensionHost } from '../../../src/modules/github/core/contract.ts'
import { GitHubApiClient } from '../../../src/modules/github/host/client.ts'
import { GitHubSyncService } from '../../../src/modules/github/host/service.ts'
import { buildGitHubTools } from '../../../src/modules/github/host/tools.ts'
import { FakeBoard } from './support/fake-board.ts'
import { FakeGitHubBackend, issueFixture } from './support/fake-github.ts'

/**
 * Report the first value the host tool runtime could not snapshot.
 *
 * The rules mirror the harness `walkJsonValue` walk: only null, booleans,
 * finite non-negative-zero strings and numbers, plain objects and dense arrays
 * are lossless. In particular `typeof undefined === 'undefined'` is not one of
 * them, so an object member explicitly set to undefined is rejected however
 * plausible `JSON.stringify` makes it look.
 * @param value - the candidate tool value.
 * @param path - where this node sits, used to name the offending member.
 * @param ancestors - the object nodes on the current path, so a cycle is reported.
 * @returns a description of the first defect, or undefined when the value is lossless.
 */
function losslessDefect(
  value: unknown,
  path = '$',
  ancestors: Set<object> = new Set(),
): string | undefined {
  if (value === null) return undefined
  if (typeof value === 'boolean' || typeof value === 'string') return undefined
  if (typeof value === 'number') {
    return Number.isFinite(value) && !Object.is(value, -0)
      ? undefined
      : `${path} is the non-lossless number ${String(value)}`
  }
  if (typeof value !== 'object') {
    return `${path} is a ${value === undefined ? 'undefined' : typeof value} value`
  }
  if (ancestors.has(value)) return `${path} is a cycle`
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) return `${path} is a sparse or extended array`
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const defect = losslessDefect(value[index], `${path}[${String(index)}]`, ancestors)
        if (defect !== undefined) return defect
      }
      return undefined
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return `${path} is a class instance`
    if (Object.getOwnPropertySymbols(value).length > 0) return `${path} carries a symbol key`
    for (const key of Object.keys(value)) {
      const defect = losslessDefect(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        ancestors,
      )
      if (defect !== undefined) return defect
    }
    return undefined
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Report the first own member a JSON round trip would delete.
 *
 * JSON.stringify drops a member whose value is undefined and writes nothing
 * for it, so the member exists before the round trip and is gone after it. That
 * silent deletion is exactly the data loss a model would never see.
 * @param value - the candidate tool value.
 * @param path - where this node sits.
 * @returns a description of the first dropped member, or undefined when none is.
 */
function droppedMember(value: unknown, path = '$'): string | undefined {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const defect = droppedMember(value[index], `${path}[${String(index)}]`)
      if (defect !== undefined) return defect
    }
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const survived = JSON.parse(JSON.stringify(record)) as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(key in survived)) return `${path}.${key} does not survive the JSON round trip`
    const defect = droppedMember(record[key], `${path}.${key}`)
    if (defect !== undefined) return defect
  }
  return undefined
}

/** Admit a stub provider and hand back the capability face the board gives it. */
function faceOf(board: FakeBoard): TaskBoardExtensionHost {
  let face: TaskBoardExtensionHost | undefined
  const stub: TaskBoardExtension = { id: 'github', apiVersion: 1, start: host => { face = host } }
  board.admit(stub)
  if (face === undefined) throw new Error('the fake board did not start the provider')
  return face
}

/** Locate one registered tool by name; a missing tool is a wiring failure. */
function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  return tool
}

/** Run one tool and return its structured value. */
async function runTool(tool: ToolDefinition, args: Record<string, unknown>): Promise<unknown> {
  return await tool.execute(args, {} as never)
}

/** One GitHub-backed card payload, as a synchronized card would carry it. */
function githubIntegration(owner: string, repository: string, issueNumber: number): Record<string, unknown> {
  return {
    github: {
      provider: 'github',
      owner,
      repository,
      issueNumber,
      issueUrl: `https://github.com/${owner}/${repository}/issues/${String(issueNumber)}`,
      remoteLabels: ['dsh'],
      remoteState: 'open',
    },
  }
}

/** A sync service over one configured repository, with a deterministic backend. */
function serviceOver(board: FakeBoard, backend: FakeGitHubBackend): GitHubSyncService {
  return new GitHubSyncService({
    host: faceOf(board),
    client: new GitHubApiClient({ token: 'test-token', fetch: backend.fetch }),
    repositories: [{ owner: 'deepseek-ai', repository: 'dsh', inclusionLabel: 'dsh' }],
  })
}

describe('GitHub tool results are lossless JSON', () => {
  it('operator reads the whole issue list without one member being rejected', async () => {
    // Given a board holding a card whose sync left the optional fields unset
    const board = new FakeBoard()
    board.seed({
      id: 'task-1',
      title: 'dsh issue 1',
      integrations: githubIntegration('deepseek-ai', 'dsh', 1),
    })
    const service = new GitHubSyncService({ host: faceOf(board), repositories: [] })
    const listTool = findTool(buildGitHubTools(service), 'task_board_github_list')

    // When the model lists the GitHub-backed cards
    const listed = await runTool(listTool, {})

    // Then the runtime can snapshot the value and no member is dropped by it
    expect(losslessDefect(listed)).toBeUndefined()
    expect(droppedMember(listed)).toBeUndefined()
  })

  it('operator reads the issue number, title and state the list promised', async () => {
    // Given one linked card carrying a remote title, state and label
    const board = new FakeBoard()
    const integration = githubIntegration('deepseek-ai', 'dsh', 7)
    Object.assign(integration.github as Record<string, unknown>, {
      remoteTitle: 'Remote title',
      remoteLabels: ['dsh', 'bug'],
    })
    board.seed({ id: 'task-7', title: 'board title', integrations: integration })
    const service = new GitHubSyncService({ host: faceOf(board), repositories: [] })
    const listTool = findTool(buildGitHubTools(service), 'task_board_github_list')

    // When the model lists them and the value makes a JSON round trip
    const listed = await runTool(listTool, {})
    const roundTripped = JSON.parse(JSON.stringify(listed)) as {
      tasks: Array<{
        title: string
        github: { issueNumber: number; remoteTitle: string; remoteState: string; remoteLabels: string[] }
      }>
    }

    // Then every field the tool description advertises is still there
    expect(roundTripped.tasks).toHaveLength(1)
    expect(roundTripped.tasks[0]?.title).toBe('board title')
    expect(roundTripped.tasks[0]?.github.issueNumber).toBe(7)
    expect(roundTripped.tasks[0]?.github.remoteTitle).toBe('Remote title')
    expect(roundTripped.tasks[0]?.github.remoteState).toBe('open')
    expect(roundTripped.tasks[0]?.github.remoteLabels).toEqual(['dsh', 'bug'])
  })

  it('operator refreshes one card and reads its GitHub summary back', async () => {
    // Given a card linked to an issue the backend answers deterministically
    const board = new FakeBoard()
    const backend = new FakeGitHubBackend()
    backend.issues = [issueFixture(40, ['dsh'], 'Task for PR tool testing')]
    const service = serviceOver(board, backend)
    board.seed({
      id: 'task-40',
      title: 'dsh issue 40',
      integrations: githubIntegration('deepseek-ai', 'dsh', 40),
    })
    const refreshTool = findTool(buildGitHubTools(service), 'task_board_github_refresh')

    // When the model refreshes that one card
    const refreshed = await runTool(refreshTool, { taskId: 'task-40' })

    // Then the value is snapshot-able and still carries the card's issue identity
    expect(losslessDefect(refreshed)).toBeUndefined()
    const value = refreshed as { ok: boolean; task?: { github?: { issueNumber: number } } }
    expect(value.ok).toBe(true)
    expect(JSON.parse(JSON.stringify(value)).task?.github?.issueNumber).toBe(40)
  })

  it('operator refreshes every repository and reads the synced count', async () => {
    // Given a configured repository whose issues answer without error
    const board = new FakeBoard()
    const backend = new FakeGitHubBackend()
    backend.issues = [issueFixture(41, ['dsh'])]
    const service = serviceOver(board, backend)
    const refreshTool = findTool(buildGitHubTools(service), 'task_board_github_refresh')

    // When the model refreshes every configured repository
    const refreshed = await runTool(refreshTool, {})

    // Then the clean run is snapshot-able rather than rejected for an absent error list
    expect(losslessDefect(refreshed)).toBeUndefined()
    expect(droppedMember(refreshed)).toBeUndefined()
    expect((refreshed as { ok: boolean }).ok).toBe(true)
    expect((refreshed as { synced: number }).synced).toBeGreaterThanOrEqual(0)
  })

  it('operator reports an unconfigured channel as a plain refusal', async () => {
    // Given a provider with no repository at all
    const board = new FakeBoard()
    const service = new GitHubSyncService({ host: faceOf(board), repositories: [] })
    const refreshTool = findTool(buildGitHubTools(service), 'task_board_github_refresh')

    // When the model asks to refresh anyway
    const refused = await runTool(refreshTool, {})

    // Then the refusal is itself snapshot-able
    expect(losslessDefect(refused)).toBeUndefined()
    expect(refused).toEqual({
      ok: false,
      code: 'not-configured',
      message: 'GitHub integration is not configured',
    })
  })

  it('operator creates and links a pull request without one member being rejected', async () => {
    // Given a card whose issue the backend answers with a branch and no PR yet
    const board = new FakeBoard()
    const backend = new FakeGitHubBackend()
    backend.issues = [issueFixture(40, ['dsh'], 'Task for PR tool testing')]
    backend.branches = ['feature/pr-40']
    backend.pulls = [{
      number: 99,
      html_url: 'https://github.com/deepseek-ai/dsh/pull/99',
      state: 'open',
      head: { ref: 'existing-branch' },
      base: { ref: 'main' },
    }]
    const service = serviceOver(board, backend)
    board.seed({
      id: 'task-40',
      title: 'dsh issue 40',
      integrations: githubIntegration('deepseek-ai', 'dsh', 40),
    })
    const tools = buildGitHubTools(service)

    // When the model creates a pull request and then links an existing one
    const created = await runTool(findTool(tools, 'task_board_github_create_pr'), {
      taskId: 'task-40',
      headBranch: 'feature/pr-40',
    })
    const linked = await runTool(findTool(tools, 'task_board_github_link_pr'), {
      taskId: 'task-40',
      pullRequestNumber: 99,
    })

    // Then both values are snapshot-able, and the unmerged PR keeps its identity
    expect(losslessDefect(created)).toBeUndefined()
    expect(droppedMember(created)).toBeUndefined()
    expect(losslessDefect(linked)).toBeUndefined()
    expect(droppedMember(linked)).toBeUndefined()
    const value = linked as { ok: boolean; pullRequest: { number: number; state: string; headBranch: string } }
    expect(value.ok).toBe(true)
    expect(value.pullRequest.number).toBe(99)
    expect(value.pullRequest.state).toBe('open')
    expect(value.pullRequest.headBranch).toBe('existing-branch')
  })

  it('operator reads one card in full without one member being rejected', async () => {
    // Given a linked card and a card that carries no GitHub payload
    const board = new FakeBoard()
    board.seed({
      id: 'task-10',
      title: 'dsh issue 10',
      description: 'Body',
      prompt: 'Prompt',
      integrations: githubIntegration('deepseek-ai', 'dsh', 10),
    })
    board.seed({ id: 'task-plain', title: 'Plain task' })
    const service = new GitHubSyncService({ host: faceOf(board), repositories: [] })
    const getTool = findTool(buildGitHubTools(service), 'task_board_github_get')

    // When the model reads both
    const linked = await runTool(getTool, { taskId: 'task-10' })
    const plain = await runTool(getTool, { taskId: 'task-plain' })

    // Then both answers are snapshot-able
    expect(losslessDefect(linked)).toBeUndefined()
    expect(droppedMember(linked)).toBeUndefined()
    expect(losslessDefect(plain)).toBeUndefined()
    expect(droppedMember(plain)).toBeUndefined()
  })
})