import { TaskBoardProjection } from '../app/projections/task-board.js';
import type { BoardReadSource, TaskRecallQuery, TaskSection, TaskSelector } from '../app/projections/types.js';
import { CallerAuthority, CallerDenied, READ_TOOLS, type CallerAgent, type Invocation } from './authority.js';

export interface ReadInvocation<A extends CallerAgent> extends Invocation<A> { readonly name: string }
interface Entry { readonly fingerprint: string; readonly lifetime: AbortController; readonly projection: TaskBoardProjection }
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CallerDenied('INVALID_ARGUMENTS', '工具参数必须是对象。');
  return value as Record<string, unknown>;
};
const text = (value: unknown, required = false): string | undefined => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.length || value.length > 512) throw new CallerDenied('INVALID_ARGUMENTS', '任务标识或分页游标无效。');
  return value;
};
/** Host 持有生命周期；每个精确 Agent 和授权代次有独立 cursor 表，逐次 signal 不进入共享状态。 */
export class ScopedBoardReads<A extends CallerAgent> {
  readonly #entries = new Map<A, Entry>();
  constructor(readonly authority: CallerAuthority<A>, readonly source: BoardReadSource) {}
  release(agent: A): void {
    const entry = this.#entries.get(agent);
    if (entry) { entry.lifetime.abort(); entry.projection.dispose(); this.#entries.delete(agent); }
  }
  invalidateAll(): void { for (const agent of this.#entries.keys()) this.release(agent); }
  dispose(): void { this.invalidateAll(); }
  async execute(args: unknown, exec: ReadInvocation<A>): Promise<unknown> {
    let lease;
    try { lease = this.authority.capture(exec); }
    catch (error) { if (exec.agent) this.release(exec.agent); throw error; }
    const input = record(args);
    lease.require(exec.name, 'read', { taskId: typeof input.taskId === 'string' ? input.taskId : undefined, executionId: typeof input.executionId === 'string' ? input.executionId : undefined });
    const agent = exec.agent!;
    for (const old of this.#entries.keys()) if (old.id === agent.id && old !== agent) this.release(old);
    let entry = this.#entries.get(agent);
    if (entry && entry.fingerprint !== lease.fingerprint) { this.release(agent); entry = undefined; }
    if (!entry) {
      const lifetime = new AbortController();
      entry = { fingerprint: lease.fingerprint, lifetime, projection: new TaskBoardProjection(this.source, this.authority.provider({ agent, signal: lifetime.signal })) };
      this.#entries.set(agent, entry);
    }
    const allowed = exec.name === READ_TOOLS[0] ? ['selector', 'cursor', 'recall'] : exec.name === READ_TOOLS[1] ? ['taskId', 'section', 'cursor'] : exec.name === READ_TOOLS[2] ? ['taskId', 'executionId', 'cursor'] : [];
    if (!allowed.length || Object.keys(input).some(k => !allowed.includes(k))) throw new CallerDenied('INVALID_ARGUMENTS', '工具参数包含未支持字段。');
    const cursor = text(input.cursor);
    try {
      let result: unknown;
      if (input.recall !== undefined) {
        const query = record(input.recall);
        if (input.selector !== undefined || cursor !== undefined || Object.keys(query).some(key => !['terms', 'updatedSince', 'updatedBefore'].includes(key))) {
          throw new CallerDenied('INVALID_ARGUMENTS', '召回不能与列表筛选或分页混用。');
        }
        result = await entry.projection.recallTasks(query as unknown as TaskRecallQuery, lease.role === 'router' && lease.tools.includes(READ_TOOLS[2]!));
      } else if (exec.name === READ_TOOLS[0]) result = await entry.projection.listTasks(input.selector === undefined ? undefined : record(input.selector) as TaskSelector, cursor);
      else if (exec.name === READ_TOOLS[1]) {
        if (input.section !== undefined && !['description', 'executions', 'relations'].includes(String(input.section))) throw new CallerDenied('INVALID_ARGUMENTS', '读取段落无效。');
        result = await entry.projection.readTask(text(input.taskId, true)!, input.section as TaskSection | undefined, cursor);
      } else result = await entry.projection.readExecutionReport(text(input.taskId, true)!, text(input.executionId, true)!, cursor);
      exec.signal.throwIfAborted(); lease.assertCurrent();
      return exec.name === READ_TOOLS[0] && lease.allBoardProjects ? { ...record(result), readScope: 'all-board-projects' } : result;
    } catch (error) {
      // 任一失败都不继续保留可能来自旧授权的分页状态；不影响别的 Agent。
      this.release(agent); throw error;
    }
  }
}
const id = { type: 'string', minLength: 1, maxLength: 512 };
const selector = { type: 'object', additionalProperties: false, properties: {
  status: { enum: ['backlog', 'todo', 'running', 'needs_input', 'review', 'done', 'failed'] },
  workspaceId: { type: ['string', 'null'] }, projectId: { type: ['string', 'null'] }, parentId: id,
  query: { type: 'string', maxLength: 2000 }, archived: { enum: ['include', 'exclude', 'only'] }, sort: { enum: ['id', 'updated'] },
} };
const recall = { type: 'object', additionalProperties: false, required: ['terms'], properties: {
  terms: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 120 } },
  updatedSince: { type: 'integer', minimum: 0, description: '卡片更新时间下界，Unix 毫秒（含）。' },
  updatedBefore: { type: 'integer', minimum: 0, description: '卡片更新时间上界，Unix 毫秒（不含）。' },
} };
/** 仅创建已有真实只读实现的定义；由 Agent scope 注册，普通会话不受影响。 */
export function readToolDefinitions<A extends CallerAgent>(reads: ScopedBoardReads<A>) {
  return [
    { name: READ_TOOLS[0]!, description: '列出当前授权范围内的任务摘要，或用 recall 查找旧任务。召回用短关键词返回少量候选及命中位置。selector、cursor 仅用于普通列表。', properties: { selector, cursor: id, recall }, required: [] },
    { name: READ_TOOLS[1]!, description: '读取已授权任务的描述、执行列表或关系。任务可读不代表历史执行可读；长内容用返回的游标续页。', properties: { taskId: id, section: { enum: ['description', 'executions', 'relations'] }, cursor: id }, required: ['taskId'] },
    { name: READ_TOOLS[2]!, description: '读取已授权任务的一次执行报告。Worker仅能读取自己的当前执行；游标只对原调用者和授权版本有效。', properties: { taskId: id, executionId: id, cursor: id }, required: ['taskId', 'executionId'] },
  ].map(tool => ({
    name: tool.name, description: tool.description,
    parameters: { type: 'object', additionalProperties: false, properties: tool.properties, required: tool.required },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args: unknown, exec: ReadInvocation<A>) => reads.execute(args, exec),
  }));
}
