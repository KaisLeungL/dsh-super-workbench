/** T01 类型仅属于 Host 内的只读投影；模型参数不能生成授权。 */
export interface ReadBranch {
  readonly workspaceId: string | null;
  readonly projectIds: readonly (string | null)[];
  readonly taskIds?: readonly string[];
}
export interface ReadLease {
  readonly fingerprint: string;
  readonly policyRevision: string;
  readonly scopeRevision: string;
  readonly branches: readonly ReadBranch[];
  /** 当前前台主理可读取桌面看板的全部卡片。 */
  readonly allBoardProjects?: true;
  /** B03 核验真实 caller、对象身份、当前策略/执行代次；失败必须抛错。 */
  assertCurrent(): void;
}
/** 每跳同步取得当前授权，不能缓存旧 lease 为新请求续权。 */
export type CurrentReadScope = () => ReadLease;
export type BoardStatus = 'backlog' | 'todo' | 'running' | 'needs_input' | 'review' | 'done' | 'failed';
export interface BoardLocation {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly resolvedProjectId: string | null;
  readonly hidden?: true;
}
export interface CapturedExecution {
  readonly id: string;
  readonly sessionId: string | null;
  readonly resolvedProjectId: string | null;
  /** 缺原生历史项目字段时不从当前卡猜测历史归属。 */
  readonly projectKnown: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly result: 'succeeded' | 'failed' | 'cancelled' | null;
  readonly external: boolean;
  readonly summary: string;
  readonly summarySeq: number | null;
}
export interface CapturedTask extends BoardLocation {
  readonly title: string;
  readonly description: string;
  readonly status: BoardStatus;
  readonly updatedAt: number;
  readonly archivedAt: number | null;
  readonly parentId: string | null;
  readonly executions: readonly CapturedExecution[];
}
export interface BoardTombstone extends BoardLocation { readonly deletedAt: number }
export interface BoardCapture {
  readonly sourceEpoch: string;
  readonly boardRevision: string;
  readonly asOf: number;
  readonly tasks: readonly CapturedTask[];
  readonly tombstones: readonly BoardTombstone[];
}
export interface BoardReadSource {
  capture(): BoardCapture | Promise<BoardCapture>;
  watchInvalidate(listener: () => void): () => void;
  isAvailable(): boolean;
}
export interface TaskSelector {
  status?: BoardStatus;
  workspaceId?: string | null;
  projectId?: string | null;
  parentId?: string;
  query?: string;
  archived?: 'include' | 'exclude' | 'only';
  sort?: 'id' | 'updated';
}
export interface TextSlice { text: string; originalLength: number; truncated: boolean }
export interface TaskSummary extends BoardLocation {
  title: TextSlice;
  description: TextSlice;
  status: BoardStatus;
  updatedAt: number;
  archivedAt: number | null;
  currentExecutionId: string | null;
  latestExecution: { id: string; sessionId: string | null; result: CapturedExecution['result']; endedAt: number | null } | null;
}
export interface ReadMetadata {
  sourceEpoch: string;
  boardRevision: string;
  asOf: number;
  stale: false;
  /** 原生 snapshot 是全量读取；这里的分页仅约束产品输出。 */
  sourceRead: 'full-snapshot';
}
export interface TaskPage extends ReadMetadata {
  items: TaskSummary[];
  truncated: boolean;
  nextCursor?: string;
}
export interface TaskRecallQuery {
  terms: string[];
  updatedSince?: number;
  updatedBefore?: number;
}
export interface TaskRecallPage extends ReadMetadata {
  items: {
    task: TaskSummary;
    matchedBy: ('id' | 'title' | 'description' | 'report')[];
    reportExecutionId?: string;
  }[];
  truncated: boolean;
}
export type TaskSection = 'description' | 'executions' | 'relations';
export interface TaskDetailPage extends ReadMetadata {
  task: TaskSummary;
  section: TaskSection;
  text?: TextSlice & { offset: number };
  executions?: Omit<CapturedExecution, 'summary'>[];
  relations?: { kind: 'parent' | 'child'; task: TaskSummary }[];
  /** 原生仅保留最近至多 20 次执行；不是完整历史。 */
  historyRetentionLimit: 20;
  truncated: boolean;
  nextCursor?: string;
}
export interface ExecutionReportPage extends ReadMetadata {
  taskId: string;
  executionId: string;
  result: CapturedExecution['result'];
  sessionId: string | null;
  summarySeq: number | null;
  text: TextSlice & { offset: number };
  truncated: boolean;
  nextCursor?: string;
}
export type ReadTaskResult = TaskDetailPage | { state: 'not_found' } | (ReadMetadata & { state: 'deleted'; id: string; deletedAt: number });
export class BoardReadError extends Error {
  constructor(readonly code: 'unavailable' | 'scope_changed' | 'cursor_stale' | 'invalid_query' | 'source_invalid', message: string) {
    super(message); this.name = 'BoardReadError';
  }
}
