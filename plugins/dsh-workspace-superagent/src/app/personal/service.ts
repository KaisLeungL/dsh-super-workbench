import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { CapturedTask } from '../projections/types.js';

interface TodoRow {
  id: string; title: string; local_date: string; done: number; revision: number; board_task_id: string | null;
}
interface ScheduleEntry {
  id: string; title: string; status: 'active' | 'paused' | 'ended'; kind: string;
  time?: string; timeZone?: string; weekdays?: number[]; scheduledAt?: string; code?: string;
}
export interface PersonalActivityEvent { title: string; at: number; summary?: string }
export interface PersonalActivity {
  id: string; title: string; status: string; updatedAt: number;
  worker?: string; events: readonly PersonalActivityEvent[]; taskId: string; sessionId?: string;
}
export interface PersonalActivities { available: boolean; items: readonly PersonalActivity[]; error?: string }
export interface PersonalBindings {
  workspaceId: string;
  sessionId(): string | null;
  assertCurrent(): void;
  tasks(): readonly CapturedTask[];
  schedule(): { view(request: { id: string }): Promise<ScheduleEntry> } | undefined;
  scheduleIds(sessionId: string): string[];
  /** 可选的委派投影；缺失时活动区明确显示尚未接入。 */
  activities?(sessionId: string): Promise<PersonalActivities>;
}
type PublicTodo = { id: string; title: string; localDate: string; done: boolean; revision: number; boardTaskId?: string; sourceUnavailable?: boolean };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const date = /^\d{4}-\d{2}-\d{2}$/;
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !date.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
function asTodo(row: TodoRow): PublicTodo {
  return { id: row.id, title: row.title, localDate: row.local_date, done: row.done === 1, revision: row.revision,
    ...(row.board_task_id ? { boardTaskId: row.board_task_id } : {}) };
}
function timing(item: ScheduleEntry): string {
  const time = item.time?.slice(0, 5) ?? '';
  if (item.kind === 'daily') return `每天 ${time}${item.timeZone ? ' · ' + item.timeZone : ''}`;
  if (item.kind === 'weekly') return `每周 ${(item.weekdays ?? []).map(n => ['一','二','三','四','五','六','日'][n - 1]).join('、')} ${time}${item.timeZone ? ' · ' + item.timeZone : ''}`;
  return item.kind === 'at' || item.kind === 'after' ? '单次' : '定时任务';
}

export class PersonalService {
  readonly #db: DatabaseSync;
  constructor(path: string, private readonly binding: PersonalBindings) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS todo (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
        local_date TEXT NOT NULL, done INTEGER NOT NULL CHECK(done IN (0,1)), revision INTEGER NOT NULL,
        board_task_id TEXT, created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS request_receipt (request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS todo_board_date ON todo(workspace_id,local_date,board_task_id)
        WHERE board_task_id IS NOT NULL;`);
    const owner = this.#db.prepare("SELECT value FROM metadata WHERE key='workspace'").get();
    if (owner && owner.value !== binding.workspaceId) { this.#db.close(); throw Error('PERSONAL_SCOPE_CHANGED'); }
    this.#db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('workspace',?)").run(binding.workspaceId);
  }
  close(): void { this.#db.close(); }
  private current(session: string): void {
    this.binding.assertCurrent();
    if (!session || this.binding.sessionId() !== session) throw Error('CHAT_SESSION_CHANGED');
  }
  private candidates() {
    return this.binding.tasks().filter(task => task.workspaceId === this.binding.workspaceId &&
      task.resolvedProjectId === this.binding.workspaceId && task.archivedAt === null);
  }
  async read(session: string) {
    this.current(session);
    let tasks: readonly CapturedTask[] | undefined;
    try { tasks = this.candidates(); } catch { /* 个人待办仍可读取。 */ }
    const visible = new Map(tasks?.map(task => [task.id, task]) ?? []);
    const rows = this.#db.prepare('SELECT * FROM todo WHERE workspace_id=? ORDER BY local_date,created_at,id').all(this.binding.workspaceId) as unknown as TodoRow[];
    const todos = rows.map(row => {
      const item = asTodo(row);
      if (row.board_task_id && !visible.has(row.board_task_id)) {
        const { boardTaskId: _hidden, ...safe } = item;
        return { ...safe, title: tasks ? '关联任务已归档或不可用' : '关联任务暂时无法读取', sourceUnavailable:true };
      }
      return item;
    });
    let schedules: ScheduleEntry[] = [], scheduleError: string | undefined;
    try {
      const source = this.binding.schedule();
      if (!source || typeof source.view !== 'function') throw Error('SCHEDULE_UNAVAILABLE');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('SCHEDULE_TIMEOUT')), 3000); });
      let entries: ScheduleEntry[];
      try { entries = await Promise.race([Promise.all(this.binding.scheduleIds(session).map(id => source.view({ id }))), timeout]); }
      finally { if (timer) clearTimeout(timer); }
      this.current(session);
      schedules = entries.filter(item => !item.code);
    } catch { scheduleError = '定时任务暂时无法读取'; }
    let activities: PersonalActivities;
    if (!this.binding.activities) {
      activities = { available: false, items: [], error: '委派记录尚未接入' };
    } else {
      try { activities = await this.binding.activities(session); }
      catch { activities = { available: false, items: [], error: '委派记录暂时无法读取' }; }
      this.current(session);
    }
    this.current(session);
    return { ok: true,
      todos: { available: true, items: todos },
      schedules: { available: !scheduleError, items: schedules.map(item => ({ id:item.id,title:item.title,status:item.status,
        ...(item.scheduledAt ? { scheduledAt:item.scheduledAt } : {}), timingLabel:timing(item) })),
        ...(scheduleError ? { error:scheduleError } : {}) },
      activities,
      boardCandidates: { available: !!tasks, items: (tasks ?? []).map(task => ({id:task.id,title:task.title,status:task.status})),
        ...(!tasks ? { error:'看板暂时无法读取' } : {}) } };
  }
  async mutate(session: string, input: unknown) {
    this.current(session);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('PERSONAL_INVALID');
    const request = input as Record<string, unknown>;
    const keys = Object.keys(request);
    if (keys.some(k => !['op','id','revision','title','done','localDate','requestId','boardTaskId'].includes(k)) ||
        typeof request.requestId !== 'string' || !uuid.test(request.requestId) ||
        !['create','update','move'].includes(String(request.op))) throw Error('PERSONAL_INVALID');
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const title = typeof request.title === 'string' ? request.title.trim() : undefined;
    if (title !== undefined && (!title || title.length > 160)) throw Error('PERSONAL_INVALID');
    if (request.localDate !== undefined && !validDate(request.localDate)) throw Error('PERSONAL_INVALID');
    if (request.done !== undefined && typeof request.done !== 'boolean') throw Error('PERSONAL_INVALID');
    if (request.op === 'create') {
      if (!title || !validDate(request.localDate)) throw Error('PERSONAL_INVALID');
      if (request.boardTaskId !== undefined && (typeof request.boardTaskId !== 'string' ||
          !this.candidates().some(task => task.id === request.boardTaskId))) throw Error('PERSONAL_BOARD_UNAVAILABLE');
    } else if (typeof request.id !== 'string' || !uuid.test(request.id) ||
      !Number.isSafeInteger(request.revision) || Number(request.revision) < 1 || request.boardTaskId !== undefined) throw Error('PERSONAL_INVALID');
    this.current(session);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.#db.prepare('SELECT request_hash FROM request_receipt WHERE request_id=?').get(request.requestId);
      if (prior) {
        if (prior.request_hash !== hash) throw Error('REQUEST_ID_REUSED');
        this.#db.exec('COMMIT');
        return this.read(session);
      }
      if (request.op === 'create') {
        this.#db.prepare('INSERT INTO todo VALUES(?,?,?,?,0,1,?,?)').run(randomUUID(),this.binding.workspaceId,title!,
          String(request.localDate),typeof request.boardTaskId === 'string' ? request.boardTaskId : null,Date.now());
      } else {
        const old = this.#db.prepare('SELECT * FROM todo WHERE id=? AND workspace_id=?').get(String(request.id),this.binding.workspaceId) as unknown as TodoRow | undefined;
        if (!old || old.revision !== request.revision) throw Error('REVISION_CONFLICT');
        if (title !== undefined && old.board_task_id && !this.candidates().some(task => task.id === old.board_task_id)) throw Error('PERSONAL_BOARD_UNAVAILABLE');
        this.#db.prepare('UPDATE todo SET title=?,local_date=?,done=?,revision=revision+1 WHERE id=? AND revision=?')
          .run(title ?? old.title, typeof request.localDate === 'string' ? request.localDate : old.local_date,
            typeof request.done === 'boolean' ? Number(request.done) : old.done,old.id,old.revision);
      }
      this.#db.prepare('INSERT INTO request_receipt VALUES(?,?)').run(request.requestId,hash);
      this.current(session);
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    return this.read(session);
  }
}
