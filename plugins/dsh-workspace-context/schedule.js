import { createHash } from 'node:crypto';

export const inject = ['workspaceContext', 'schedule', 'workspaceRegistry'];

function belongsToWorkspace(target, workspace, workspaces) {
  if (target?.kind === 'session' || target?.kind === 'new_once') {
    const matches = workspaces.filter(candidate => candidate.sessionIds.includes(target.sessionId));
    if (matches.length || target.kind === 'session') return matches.length === 1 && matches[0].id === workspace.id;
  }
  return (target?.kind === 'new' || target?.kind === 'new_once') && target.create?.cwd === workspace.path;
}

/** 从原生自动化目录读取能确认目标工作区的任务。 */
export function apply(ctx) {
  if (typeof ctx.schedule.catalog !== 'function') return;
  ctx.effect(() => ctx.workspaceContext.register(ctx, {
    protocol: 1, id: 'schedule.upcoming', source: '自动化任务', scope: 'workspace',
    description: '查询当前工作区的自动化任务及其下一次触发时间。默认查询启用中的任务。',
    filters: {
      status: { type: 'string', description: '任务状态，省略时只查询 active。', enum: ['active', 'paused', 'ended'] },
      from: { type: 'integer', description: '触发时间下界（含），Unix 毫秒。' },
      before: { type: 'integer', description: '触发时间上界（不含），Unix 毫秒。' },
    },
    async read({ scope, filter, offset, limit, signal }) {
      const tasks = await ctx.schedule.catalog();
      signal.throwIfAborted();
      const workspaces = ctx.workspaceRegistry.list();
      const workspace = workspaces.find(item => item.id === scope.workspaceId);
      if (!workspace) throw Error('SCHEDULE_WORKSPACE_UNAVAILABLE');
      const visible = [];
      for (const task of tasks) {
        if (task.status !== (filter.status ?? 'active') || !belongsToWorkspace(task.target, workspace, workspaces)) continue;
        const at = Date.parse(task.scheduledAt);
        if ((filter.from !== undefined || filter.before !== undefined) && (task.status !== 'active' || !Number.isFinite(at) ||
            at < (filter.from ?? -Infinity) || at >= (filter.before ?? Infinity))) continue;
        visible.push({ workspaceId: workspace.id, ref: { kind: 'schedule.task', id: task.id }, title: task.title.slice(0, 120),
          status: task.status, timing: task.kind, ...(task.status === 'active' && Number.isFinite(at) && { nextRunAt: task.scheduledAt }),
          ...(task.timeZone && { timeZone: task.timeZone }) });
      }
      const revision = createHash('sha256').update(JSON.stringify(visible)).digest('hex');
      return { revision, more: visible.length > offset + limit, items: visible.slice(offset, offset + limit) };
    },
  }));
}
