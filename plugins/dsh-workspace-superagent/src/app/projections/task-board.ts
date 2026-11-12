import { createHash, randomUUID } from 'node:crypto';
import { BoardReadError, type BoardCapture, type BoardLocation, type BoardReadSource, type CapturedExecution, type CapturedTask, type CurrentReadScope, type ExecutionReportPage, type ReadLease, type ReadMetadata, type ReadTaskResult, type TaskDetailPage, type TaskPage, type TaskRecallPage, type TaskRecallQuery, type TaskSection, type TaskSelector, type TaskSummary, type TextSlice } from './types.js';

const PAGE_CHARS = 8000, PAGE_ITEMS = 50;
const RECALL_ITEMS = 8;
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().trim();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cut = (text: string, limit: number): TextSlice => ({ text: text.slice(0, limit), originalLength: text.length, truncated: text.length > limit });
const compareId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
function inBranches(lease: ReadLease, at: BoardLocation): boolean {
  return lease.branches.some(branch => branch.workspaceId === at.workspaceId && branch.projectIds.includes(at.resolvedProjectId) && (branch.taskIds === undefined || branch.taskIds.includes(at.id)));
}
function allowed(lease: ReadLease, at: BoardLocation): boolean {
  return lease.allBoardProjects === true ? at.hidden !== true : inBranches(lease, at);
}
function executionAllowed(lease: ReadLease, task: CapturedTask, execution: CapturedExecution): boolean {
  return execution.projectKnown && inBranches(lease, task) && inBranches(lease, { ...task, resolvedProjectId: execution.resolvedProjectId });
}
function summary(task: CapturedTask, lease: ReadLease): TaskSummary {
  // 不用“最后一个可见历史”冒充真实 latest；不可见的真实 latest 只返回 null。
  const latest = task.executions.at(-1), current = task.executions.findLast(execution => execution.endedAt === null);
  return {
    id: task.id, workspaceId: task.workspaceId, resolvedProjectId: task.resolvedProjectId,
    title: cut(task.title, 160), description: cut(task.description, 160), status: task.status,
    updatedAt: task.updatedAt, archivedAt: task.archivedAt,
    currentExecutionId: current && executionAllowed(lease, task, current) ? current.id : null,
    latestExecution: latest && executionAllowed(lease, task, latest) ? { id: latest.id, sessionId: latest.sessionId, result: latest.result, endedAt: latest.endedAt } : null,
  };
}
function selectorOf(value: TaskSelector): Required<Pick<TaskSelector, 'archived' | 'sort'>> & TaskSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['workspaceId', 'projectId', 'parentId', 'query', 'archived', 'sort', 'status'].includes(key))) throw new BoardReadError('invalid_query', '读取筛选条件无效。');
  for (const key of ['workspaceId', 'projectId', 'parentId', 'query'] as const) {
    const item = value[key];
    if (item !== undefined && !((key === 'workspaceId' || key === 'projectId') && item === null) && (typeof item !== 'string' || item.length > (key === 'query' ? 2000 : 512))) throw new BoardReadError('invalid_query', '读取筛选条件无效。');
  }
  if (value.archived !== undefined && !['include', 'exclude', 'only'].includes(value.archived)) throw new BoardReadError('invalid_query', '归档筛选无效。');
  if (value.sort !== undefined && !['id', 'updated'].includes(value.sort)) throw new BoardReadError('invalid_query', '排序方式无效。');
  if (value.status !== undefined && !['backlog', 'todo', 'running', 'needs_input', 'review', 'done', 'failed'].includes(value.status)) throw new BoardReadError('invalid_query', '任务状态无效。');
  return { workspaceId: value.workspaceId, projectId: value.projectId, parentId: value.parentId, status: value.status, query: value.query ?? '', archived: value.archived ?? 'include', sort: value.sort ?? 'id' };
}
type Cursor = { binding: string; query: string; offset: number };
type Reading = { capture: BoardCapture; lease: ReadLease; binding: string; guard: () => void };
const metadata = (capture: BoardCapture): ReadMetadata => ({ sourceEpoch: capture.sourceEpoch, boardRevision: capture.boardRevision, asOf: capture.asOf, stale: false, sourceRead: 'full-snapshot' });

/** 每个可信调用者闭包创建一个投影实例；不持有原卡缓存或共享可变 currentCaller。 */
export class TaskBoardProjection {
  #cursors = new Map<string, Cursor>();
  #scopeKey?: string;
  #generation = 0;
  #disposed = false;
  #listeners = new Set<() => void>();
  #unsubscribe: () => void;
  constructor(private readonly source: BoardReadSource, private readonly currentScope: CurrentReadScope) {
    this.#unsubscribe = source.watchInvalidate(() => { this.#generation++; this.#notify(); });
  }
  watchInvalidate(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  /** Host 撤权时同步调用；即使没有该通知，每跳 provider 仍阻止旧授权。 */
  invalidateScope(): void { this.#scopeKey = undefined; this.#cursors.clear(); this.#generation++; this.#notify(); }
  status(): { stale: boolean; available: boolean } {
    const available = !this.#disposed && this.source.isAvailable();
    return { stale: !available, available };
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.#generation++; this.#cursors.clear(); this.#unsubscribe(); this.#listeners.clear();
  }

  async listTasks(selector: TaskSelector = {}, cursor?: string): Promise<TaskPage> {
    const filter = selectorOf(selector), reading = await this.#read();
    const { capture, lease } = reading;
    const visible = capture.tasks.filter(task => allowed(lease, task));
    // parentId 也是一次引用跳转：父卡不可读时不泄漏其子卡关系。
    const parentVisible = filter.parentId === undefined || visible.some(task => task.id === filter.parentId);
    const rows = parentVisible ? visible.filter(task =>
      (filter.workspaceId === undefined || filter.workspaceId === task.workspaceId) &&
      (filter.projectId === undefined || filter.projectId === task.resolvedProjectId) &&
      (filter.status === undefined || filter.status === task.status) &&
      (filter.parentId === undefined || filter.parentId === task.parentId) &&
      (filter.archived === 'include' || (filter.archived === 'only') === (task.archivedAt !== null)) &&
      (!filter.query || task.id.includes(filter.query) || task.title.includes(filter.query) || task.description.includes(filter.query))
    ) : [];
    rows.sort(filter.sort === 'updated' ? (a, b) => b.updatedAt - a.updatedAt || compareId(a, b) : compareId);
    const query = hash(['list', filter]), offset = this.#offset(cursor, reading.binding, query);
    const page: TaskPage = { ...metadata(capture), items: [], truncated: false };
    let index = offset;
    while (index < rows.length && page.items.length < PAGE_ITEMS) {
      const item = summary(rows[index], lease);
      // 预留 nextCursor 的最大长度，按完整 JSON UTF-16 字符计，不仅是正文。
      if (JSON.stringify({ ...page, items: [...page.items, item], truncated: true, nextCursor: 'x'.repeat(36) }).length > PAGE_CHARS) break;
      page.items.push(item); index++;
    }
    if (index === offset && index < rows.length) throw new BoardReadError('source_invalid', '单条看板摘要超过读取上限。');
    page.truncated = index < rows.length;
    if (page.truncated) page.nextCursor = this.#cursor(reading.binding, query, index);
    return this.#finish(reading, page);
  }

  async recallTasks(query: TaskRecallQuery, includeReports: boolean): Promise<TaskRecallPage> {
    const { terms, updatedSince, updatedBefore } = query;
    if (!Array.isArray(terms) || terms.length === 0 || terms.length > 6 ||
      !terms.every(term => typeof term === 'string' && term.length <= 120 && normalize(term)) ||
      [updatedSince, updatedBefore].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0)) ||
      (updatedSince !== undefined && updatedBefore !== undefined && updatedSince >= updatedBefore)) {
      throw new BoardReadError('invalid_query', '召回关键词或更新时间范围无效。');
    }
    const keywords = [...new Set(terms.map(normalize))];
    const reading = await this.#read(), { capture, lease } = reading;
    const rows = [];
    for (const task of capture.tasks) {
      if (!allowed(lease, task) || task.updatedAt < (updatedSince ?? 0) || task.updatedAt >= (updatedBefore ?? Infinity)) continue;
      const id = normalize(task.id), title = normalize(task.title), description = normalize(task.description);
      const hits = new Set<string>();
      const matchedBy: TaskRecallPage['items'][number]['matchedBy'] = [];
      if (keywords.includes(id)) { matchedBy.push('id'); hits.add(id); }
      for (const [field, value] of [['title', title], ['description', description]] as const) {
        const matching = keywords.filter(term => value.includes(term));
        if (matching.length) matchedBy.push(field);
        for (const term of matching) hits.add(term);
      }
      let reportExecutionId: string | undefined;
      if (includeReports) {
        for (const execution of [...task.executions].reverse()) {
          if (!executionAllowed(lease, task, execution)) continue;
          const report = normalize(execution.summary);
          const matching = keywords.filter(term => report.includes(term));
          if (matching.length) {
            reportExecutionId ??= execution.id;
            for (const term of matching) hits.add(term);
          }
        }
      }
      if (reportExecutionId) matchedBy.push('report');
      if (hits.size) rows.push({ task, matchedBy, reportExecutionId, score: Number(keywords.includes(id)) * 100 + hits.size * 4 + Number(matchedBy.includes('title')) * 2 + Number(matchedBy.includes('description')) });
    }
    rows.sort((a, b) => b.score - a.score || b.task.updatedAt - a.task.updatedAt || compareId(a.task, b.task));
    const page: TaskRecallPage = { ...metadata(capture), items: [], truncated: false };
    for (const { task, matchedBy, reportExecutionId } of rows.slice(0, RECALL_ITEMS)) {
      const item = { task: summary(task, lease), matchedBy, ...(reportExecutionId ? { reportExecutionId } : {}) };
      if (JSON.stringify({ ...page, items: [...page.items, item], truncated: true }).length > PAGE_CHARS) break;
      page.items.push(item);
    }
    page.truncated = page.items.length < rows.length;
    return this.#finish(reading, page);
  }

  async readTask(taskId: string, section: TaskSection = 'description', cursor?: string): Promise<ReadTaskResult> {
    this.#id(taskId);
    if (!['description', 'executions', 'relations'].includes(section)) throw new BoardReadError('invalid_query', '详情段落无效。');
    const reading = await this.#read(), { capture, lease } = reading;
    const query = hash(['detail', taskId, section]), offset = this.#offset(cursor, reading.binding, query);
    const task = capture.tasks.find(task => task.id === taskId && allowed(lease, task));
    if (!task) {
      // 只有观察到原生明确删除事件才有墓碑；缺页/断连/撤权均不推断删除。
      const deleted = capture.tombstones.find(row => row.id === taskId && allowed(lease, row));
      return this.#finish(reading, deleted ? { ...metadata(capture), state: 'deleted' as const, id: deleted.id, deletedAt: deleted.deletedAt } : { state: 'not_found' as const });
    }
    const page: TaskDetailPage = { ...metadata(capture), task: summary(task, lease), section, historyRetentionLimit: 20, truncated: false };
    if (section === 'description') {
      this.#textPage(page, task.description, offset, reading.binding, query);
    } else {
      const rows = section === 'executions'
        ? task.executions.filter(execution => executionAllowed(lease, task, execution)).map(({ summary: _text, ...execution }) => execution)
        : capture.tasks.filter(row => allowed(lease, row) && (row.id === task.parentId || row.parentId === task.id)).sort(compareId).map(row => ({ kind: row.id === task.parentId ? 'parent' as const : 'child' as const, task: summary(row, lease) }));
      const field = section === 'executions' ? 'executions' : 'relations';
      const items: unknown[] = [];
      let index = offset;
      while (index < rows.length && items.length < PAGE_ITEMS) {
        if (JSON.stringify({ ...page, [field]: [...items, rows[index]], truncated: true, nextCursor: 'x'.repeat(36) }).length > PAGE_CHARS) break;
        items.push(rows[index++]);
      }
      if (index === offset && index < rows.length) throw new BoardReadError('source_invalid', '单条看板详情超过读取上限。');
      Object.assign(page, { [field]: items, truncated: index < rows.length });
      if (page.truncated) page.nextCursor = this.#cursor(reading.binding, query, index);
    }
    return this.#finish(reading, page);
  }

  async readExecutionReport(taskId: string, executionId: string, cursor?: string): Promise<ExecutionReportPage | { state: 'not_found' }> {
    this.#id(taskId); this.#id(executionId);
    const reading = await this.#read(), { capture, lease } = reading;
    const query = hash(['report', taskId, executionId]), offset = this.#offset(cursor, reading.binding, query);
    const task = capture.tasks.find(task => task.id === taskId && allowed(lease, task));
    const execution = task?.executions.find(execution => execution.id === executionId && executionAllowed(lease, task, execution));
    if (!execution) return this.#finish(reading, { state: 'not_found' as const });
    const page = { ...metadata(capture), taskId, executionId, result: execution.result, sessionId: execution.sessionId, summarySeq: execution.summarySeq, text: { text: '', offset, originalLength: execution.summary.length, truncated: false }, truncated: false } satisfies ExecutionReportPage;
    this.#textPage(page, execution.summary, offset, reading.binding, query);
    return this.#finish(reading, page);
  }

  #textPage(page: object, text: string, offset: number, binding: string, query: string): void {
    let size = Math.min(text.length - offset, PAGE_CHARS);
    if (size < 0) throw new BoardReadError('cursor_stale', '读取位置已经失效，请刷新首页。');
    const make = (length: number) => ({ ...page, text: { text: text.slice(offset, offset + length), offset, originalLength: text.length, truncated: offset + length < text.length }, truncated: offset + length < text.length, ...(offset + length < text.length ? { nextCursor: 'x'.repeat(36) } : {}) });
    // JSON 转义后的真实长度也计入上限。
    while (size > 0 && JSON.stringify(make(size)).length > PAGE_CHARS) size--;
    if (size === 0 && offset < text.length) throw new BoardReadError('source_invalid', '看板详情元数据超过读取上限。');
    Object.assign(page, make(size));
    if (offset + size < text.length) Object.assign(page, { nextCursor: this.#cursor(binding, query, offset + size) });
  }
  #scope(): { lease: ReadLease; key: string } {
    try {
      const lease = this.currentScope(); lease.assertCurrent();
      if (!lease.fingerprint || !lease.policyRevision || !lease.scopeRevision || !Array.isArray(lease.branches) || lease.branches.some(branch =>
        !(branch.workspaceId === null || typeof branch.workspaceId === 'string') || !Array.isArray(branch.projectIds) || branch.projectIds.some((id: unknown) => id !== null && typeof id !== 'string') || (branch.taskIds !== undefined && (!Array.isArray(branch.taskIds) || branch.taskIds.some((id: unknown) => typeof id !== 'string'))))) throw Error('scope');
      return { lease, key: hash([lease.fingerprint, lease.policyRevision, lease.scopeRevision, lease.branches, lease.allBoardProjects]) };
    } catch {
      this.invalidateScope(); throw new BoardReadError('scope_changed', '当前读取授权已失效，请重新确认范围。');
    }
  }
  async #read(): Promise<Reading> {
    if (this.#disposed || !this.source.isAvailable()) throw new BoardReadError('unavailable', '看板连接不可用，旧快照已标记过期。');
    const { lease, key } = this.#scope();
    if (this.#scopeKey !== key) { this.#cursors.clear(); this.#scopeKey = key; this.#generation++; }
    const generation = this.#generation;
    const capture = await this.source.capture();
    const guard = () => {
      lease.assertCurrent();
      const current = this.#scope();
      if (current.key !== key) { this.invalidateScope(); throw new BoardReadError('scope_changed', '读取期间授权已变化，请刷新首页。'); }
      if (this.#disposed || !this.source.isAvailable() || generation !== this.#generation) throw new BoardReadError('unavailable', '读取期间看板绑定或内容已变化，请重新读取。');
    };
    try { guard(); } catch (error) {
      if (error instanceof BoardReadError) throw error;
      this.invalidateScope(); throw new BoardReadError('scope_changed', '当前读取授权已失效，请重新确认范围。');
    }
    return { capture, lease, guard, binding: hash([capture.sourceEpoch, capture.boardRevision, key]) };
  }
  #finish<T>(reading: Reading, page: T): T {
    try { reading.guard(); } catch (error) {
      if (error instanceof BoardReadError) throw error;
      this.invalidateScope(); throw new BoardReadError('scope_changed', '当前读取授权已失效，请重新确认范围。');
    }
    if (JSON.stringify(page).length > PAGE_CHARS) throw new BoardReadError('source_invalid', '看板读取结果超过上限。');
    return page;
  }
  #offset(cursor: string | undefined, binding: string, query: string): number {
    if (cursor === undefined) return 0;
    const stored = this.#cursors.get(cursor);
    if (!stored || stored.binding !== binding || stored.query !== query) throw new BoardReadError('cursor_stale', '续页已失效，请刷新首页。');
    return stored.offset;
  }
  #cursor(binding: string, query: string, offset: number): string {
    const cursor = randomUUID(); this.#cursors.set(cursor, { binding, query, offset });
    if (this.#cursors.size > 256) this.#cursors.delete(this.#cursors.keys().next().value!);
    return cursor;
  }
  #id(value: string): void { if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new BoardReadError('invalid_query', '任务或执行标识无效。'); }
  #notify(): void { for (const listener of this.#listeners) { try { listener(); } catch { /* 失效监听不能改变读取授权。 */ } } }
}
