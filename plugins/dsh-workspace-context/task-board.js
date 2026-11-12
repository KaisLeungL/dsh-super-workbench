export const inject = ['workspaceContext', 'taskBoard'];

const statuses = ['backlog', 'todo', 'running', 'needs_input', 'review', 'done', 'failed'];

/** 用看板的扩展生命周期跟踪其主开关。 */
export function apply(ctx) {
  let unregister;
  ctx.effect(() => ctx.taskBoard.registerExtension({
    id: 'workspace-context-task-board', apiVersion: 1,
    start() {
      unregister = ctx.workspaceContext.register(ctx, {
        protocol: 1, id: 'task-board.list', source: '任务看板', scope: 'project',
        description: '按当前授权读取任务看板的卡片摘要。默认排除已归档卡片。待规划列使用 backlog。',
        filters: {
          status: { type: 'string', description: '卡片当前状态。', enum: statuses },
          projectId: { type: 'string', description: '只查询指定的已授权项目 ID。' },
          archived: { type: 'boolean', description: 'true 查询已归档，false 查询未归档。省略时查询未归档。' },
          createdFrom: { type: 'integer', description: '卡片创建时间下界（含），Unix 毫秒。' },
          createdBefore: { type: 'integer', description: '卡片创建时间上界（不含），Unix 毫秒。' },
        },
        read({ scope, filter, offset, limit }) {
          const { tasks, revision } = ctx.taskBoard.snapshot();
          const visible = tasks.filter(task => {
            const projectId = task.projectId === undefined ? task.workspaceId ?? null : task.projectId;
            return task.hidden !== true &&
              (scope.allBoardProjects === true || task.workspaceId === scope.workspaceId && scope.projectIds.includes(projectId)) &&
              (filter.projectId === undefined || projectId === filter.projectId) &&
              (task.archivedAt != null) === (filter.archived ?? false) &&
              (filter.status === undefined || task.status === filter.status) &&
              (filter.createdFrom === undefined || task.createdAt >= filter.createdFrom) &&
              (filter.createdBefore === undefined || task.createdAt < filter.createdBefore);
          });
          visible.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
          return {
            revision: String(revision), more: visible.length > offset + limit,
            items: visible.slice(offset, offset + limit).map(task => ({
              workspaceId: task.workspaceId ?? null, projectId: task.projectId === undefined ? task.workspaceId ?? null : task.projectId,
              ref: { kind: 'task-board.task', id: task.id }, title: task.title.slice(0, 160), status: task.status,
              createdAt: task.createdAt, updatedAt: task.updatedAt, archived: task.archivedAt != null,
            })),
          };
        },
      });
    },
    stop() { unregister?.(); unregister = undefined; },
  }));
}
