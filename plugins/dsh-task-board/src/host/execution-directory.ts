import { realpathSync } from 'node:fs'
import type { TaskRecord } from '../core/tasks.ts'
import { mostRecentWorkspaceId, workspaceOwningSession, MISSING_WORKSPACE_REASON } from '../core/workspace-target.ts'
import type { TaskBoardWorkspaceRegistry } from '../host-runner.ts'
import type { HostTaskLedger } from '../host-ledger.ts'

/** Resolve the actual execution target, including a reused session's directory. */
export function executionWorkspace(task: TaskRecord, registry: TaskBoardWorkspaceRegistry | undefined, sessionId?: string): { workspaceId: string; directory: string } {
  const items = registry?.list() ?? []
  const workspaceId = sessionId === undefined
    ? task.handover?.workspaceId ?? task.workspaceId ?? mostRecentWorkspaceId(items)
    : workspaceOwningSession(items, sessionId)
  if (workspaceId === undefined) throw new Error(MISSING_WORKSPACE_REASON)
  const workspace = items.find(item => item.id === workspaceId)
  if (workspace === undefined) throw new Error('execution workspace directory cannot be verified: ' + workspaceId)
  return { workspaceId, directory: realpathSync(workspace.path) }
}

/** Recover observed legacy ownership before admitting another directory writer. */
export function restoreExecutionDirectories(ledger: HostTaskLedger, registry: TaskBoardWorkspaceRegistry | undefined): void {
  for (const task of ledger.allTasks()) {
    const execution = task.executions.at(-1)
    if (execution === undefined || execution.endedAt !== undefined || execution.executionDirectory !== undefined || execution.sessionId === undefined) continue
    const { directory } = executionWorkspace(task, registry, execution.sessionId)
    ledger.claimExecutionDirectory(task.id, execution.id, directory)
  }
}
