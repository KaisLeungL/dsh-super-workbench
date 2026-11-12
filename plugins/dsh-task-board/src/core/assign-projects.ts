import { isProjectId, resolveProjectId } from './planning.ts'
import { hasOpenExecution, type TaskRecord } from './tasks.ts'

/** One validation pass before any card changes; callers persist the result once. */
export function assignProjects(
  tasks: readonly TaskRecord[],
  taskIds: readonly string[],
  projectId: string | null,
  now: number,
): TaskRecord[] {
  if (projectId === undefined || !isProjectId(projectId)) throw new Error('invalid project id')
  if (taskIds.length === 0 || taskIds.length > 500 || taskIds.some(id => typeof id !== 'string' || id.trim() === '' || id.length > 256)
    || new Set(taskIds).size !== taskIds.length) throw new Error('invalid task selection')
  const selected = new Set(taskIds)
  const found = tasks.filter(task => selected.has(task.id))
  if (found.length !== selected.size) throw new Error('task not found')
  for (const task of found) {
    if (task.taskKind === 'inspection') throw new Error('inspection controls are managed by their provider')
    if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
    if (hasOpenExecution(task) || task.status === 'running') throw new Error('running task scope is read-only')
  }
  return tasks.map(task => {
    if (!selected.has(task.id)) return task
    const changed = resolveProjectId(task) !== projectId
    const recommendation = task.origin !== undefined || task.recommendation !== undefined || task.planning !== undefined
    return {
      ...task, projectId, updatedAt: now,
      ...(changed && recommendation ? {
        status: 'backlog' as const,
        planning: { state: 'proposed' as const },
        schedule: task.schedule === undefined ? undefined : { ...task.schedule, enabled: false, nextRunAt: undefined },
      } : {}),
    }
  })
}
