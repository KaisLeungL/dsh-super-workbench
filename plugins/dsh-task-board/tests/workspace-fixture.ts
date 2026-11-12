/**
 * The deployment's workspace service for spec fixtures.
 *
 * `src/index.ts` injects `workspaceRegistry`, so every real deployment serves
 * one: a run that pins no workspace resolves the deployment's most recently
 * used workspace and is refused only when there is none at all. Specs that
 * launch a card therefore model that service instead of the bare Host.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import type { TaskBoardWorkspaceRegistry } from '../src/host-runner.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A workspace service listing exactly these workspaces, newest first.
 * @param ids - workspace ids, the first one being the most recently used.
 * @returns the registry a runner or the Host service is constructed with.
 */
export function fixtureWorkspaces(ids: readonly string[] = ['workspace-fixture'], sessionIds: readonly string[] = []): TaskBoardWorkspaceRegistry {
  const workspaces = ids.map((id, index) => {
    const path = mkdtempSync(join(tmpdir(), 'dsh-workspace-fixture-'))
    directories.push(path)
    return { id, path, updatedAt: new Date(Date.UTC(2026, 8, 30) - index * 60_000).toISOString(), sessionIds }
  })
  return { list: () => workspaces } as unknown as TaskBoardWorkspaceRegistry
}
