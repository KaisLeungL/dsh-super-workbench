import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { BOARD, SCHEDULE, SCHEDULE_PRESET, missingFields, parseCandidate, type Candidate, type Proposal } from './protocol.js';

type Row = { id: string; session: string; turn: number; revision: number; state: 'draft' | 'pending' | 'succeeded' | 'dismissed'; body: string; expires: number; result: string | null };
type Timing = { kind: 'daily'; daily: { time: string; time_zone: string } } |
  { kind: 'weekly'; weekly: { time: string; time_zone: string; weekdays: number[] } };
type ScheduleRequest = { title: string; prompt: string; timing: Timing; target: { kind: 'new_once'; create: { cwd: string; agentPreset: string } } };
type ScheduleResult = { id: string; scheduledAt?: string; code?: string };
interface ScheduleFace {
  previewConfirmedCreate(request: ScheduleRequest): { scheduledAt?: string };
  createConfirmed(request: ScheduleRequest, operationId: string): Promise<ScheduleResult>;
  viewConfirmedCreate(request: ScheduleRequest, operationId: string): Promise<ScheduleResult>;
}
interface BoardRow { id: string; workspaceId?: string; projectId?: string | null }
interface BoardFace {
  snapshot(): { tasks: readonly BoardRow[] };
  isExtensionEnabled(id: string): boolean;
  apply(operationId: string, action: { kind: 'create'; id: string; input: {
    title: string; description: string; prompt: string; projectId: string; workspaceId: string; status: 'todo' | 'backlog'; permission: 'read-only'; mode: string;
    model?: string; reasoningEffort?: string;
  } }): unknown | Promise<unknown>;
}
interface Bindings {
  workspaceId: string; workspacePath: string;
  schedule(): unknown; board(): unknown;
  /** The Router model a card created here will run with; keeps the Worker on a usable route. */
  model?(): { provider: string; model: string; reasoningEffort?: string } | null;
  check(): void;
  now?(): number;
}
export type ActionRequest = { op: 'read'; turn: number } |
  { op: 'save'; id: string; revision: number; proposal: Candidate } |
  { op: 'confirm'; id: string; revision: number; expectedNextRunAt?: string } |
  { op: 'dismiss' | 'reconcile' | 'open'; id: string; revision: number };

export class ActionService {
  readonly #db: DatabaseSync;
  readonly #active = new Set<string>();
  constructor(path: string, private readonly binding: Bindings) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS proposal (
      id TEXT PRIMARY KEY, session TEXT NOT NULL, turn INTEGER NOT NULL, revision INTEGER NOT NULL,
      state TEXT NOT NULL, body TEXT NOT NULL, expires INTEGER NOT NULL, result TEXT, UNIQUE(session, turn)
    ) STRICT`);
  }
  close() { this.#db.close(); }
  /** 只返回该主理会话中确认成功的定时任务 ID。 */
  ownedScheduleIds(session: string): string[] {
    const rows = this.#db.prepare("SELECT body,result FROM proposal WHERE session=? AND state='succeeded' AND result IS NOT NULL").all(session);
    return rows.flatMap(row => {
      const candidate = parseCandidate(JSON.parse(String(row.body)));
      const result = JSON.parse(String(row.result)) as { resultId?: unknown };
      return candidate.actionId === SCHEDULE && typeof result.resultId === 'string' ? [result.resultId] : [];
    });
  }
  #now() { return this.binding.now?.() ?? Date.now(); }
  #modelPin(): { model?: string; reasoningEffort?: string } {
    let route: { provider: string; model: string; reasoningEffort?: string } | null = null;
    try { route = this.binding.model?.() ?? null; } catch { route = null; }
    if (!route || !route.provider || !route.model) return {};
    return { model: route.provider + '/' + route.model, ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) };
  }
  #at(session: string, turn: number) {
    return this.#db.prepare('SELECT * FROM proposal WHERE session=? AND turn=?').get(session, turn) as Row | undefined;
  }
  #owned(session: string, id: string) {
    const row = this.#db.prepare('SELECT * FROM proposal WHERE session=? AND id=?').get(session,id) as Row | undefined;
    if (!row) throw Error('DRAFT_NOT_FOUND');
    return row;
  }
  #normalize(candidate: Candidate): Candidate {
    if (candidate.actionId === BOARD) {
      if (candidate.params.projectId && candidate.params.projectId !== this.binding.workspaceId) throw Error('DRAFT_SCOPE_CHANGED');
      return { ...candidate, params: { ...candidate.params, projectId: this.binding.workspaceId, column: candidate.params.column ?? 'todo' } };
    }
    const { title, instruction, schedule } = candidate.params;
    return { ...candidate, params: { ...candidate.params, title: title ?? instruction?.slice(0, 60), target: 'dedicated_session',
      schedule: { ...schedule, timeZone: schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone } } };
  }
  #schedule(): ScheduleFace {
    const s = this.binding.schedule() as Partial<ScheduleFace> | undefined;
    if (typeof s?.previewConfirmedCreate !== 'function' || typeof s.createConfirmed !== 'function' || typeof s.viewConfirmedCreate !== 'function') throw Error('ACTION_UNAVAILABLE');
    return s as ScheduleFace;
  }
  #board(): BoardFace {
    const b = this.binding.board() as Partial<BoardFace> | undefined;
    if (typeof b?.snapshot !== 'function' || typeof b.apply !== 'function' || b.isExtensionEnabled?.('workspace-superagent-read') !== true) throw Error('ACTION_UNAVAILABLE');
    return b as BoardFace;
  }
  #request(candidate: Extract<Candidate, { actionId: typeof SCHEDULE }>): ScheduleRequest {
    const { title, instruction, schedule } = candidate.params;
    const timing = { time: schedule!.time! + ':00', time_zone: schedule!.timeZone! };
    return { title: title!, prompt: instruction!, timing: schedule!.kind === 'weekly'
      ? { kind: 'weekly', weekly: { ...timing, weekdays: schedule!.weekdays! } } : { kind: 'daily', daily: timing },
      target: { kind: 'new_once', create: { cwd: this.binding.workspacePath, agentPreset: SCHEDULE_PRESET } } };
  }
  #boardResult(row: Row): BoardRow | undefined {
    const task = this.#board().snapshot().tasks.find(task => task.id === row.id);
    return task?.workspaceId === this.binding.workspaceId && (task.projectId === undefined ? task.workspaceId : task.projectId) === this.binding.workspaceId ? task : undefined;
  }
  #result(row: Row, id: string, nextRunAt?: string) {
    this.#db.prepare("UPDATE proposal SET state='succeeded',result=? WHERE id=? AND revision=? AND state='pending'").run(JSON.stringify({resultId:id,nextRunAt}),row.id,row.revision);
    return this.#owned(row.session,row.id);
  }
  #view(row: Row): Proposal {
    const candidate = parseCandidate(JSON.parse(row.body));
    const base = { id: row.id, turn: row.turn, revision: row.revision, candidate };
    if (row.state === 'succeeded') return { ...base, status: 'succeeded', ...JSON.parse(row.result!) as {resultId:string; nextRunAt?:string} };
    if (row.state === 'dismissed') return { ...base, status: 'dismissed' };
    if (row.state === 'pending') return { ...base, status: this.#active.has(row.id) ? 'submitting' : 'unknown' };
    if (row.expires <= this.#now()) return { ...base, status: 'expired' };
    const incomplete = missingFields(candidate).length > 0;
    let schedule: ScheduleFace | undefined;
    try {
      if (candidate.actionId === BOARD) this.#board();
      else schedule = this.#schedule();
    } catch {
      return { ...base, status: incomplete ? 'needs_input' : 'unavailable', submissionIssue: 'entry_unavailable' };
    }
    if (incomplete) return { ...base, status: 'needs_input' };
    if (candidate.actionId === BOARD) return { ...base, status: 'ready' };
    try {
      const nextRunAt = schedule?.previewConfirmedCreate(this.#request(candidate)).scheduledAt;
      if (nextRunAt) return { ...base, status: 'ready', nextRunAt };
    } catch { /* 当前配置未通过调度预览，保留草稿供用户修改。 */ }
    return { ...base, status: 'unavailable', submissionIssue: 'schedule_preview_failed' };
  }
  propose(session: string, turn: number, candidate: Candidate, continueDraft: boolean): Proposal {
    this.binding.check();
    const existing = this.#at(session,turn);
    if (existing) return this.#view(existing);
    if (continueDraft) {
      const previous = this.#db.prepare("SELECT * FROM proposal WHERE session=? AND state='draft' AND expires>? ORDER BY turn DESC LIMIT 1").get(session,this.#now()) as Row | undefined;
      if (previous && previous.turn < turn) {
        const prior = parseCandidate(JSON.parse(previous.body));
        if (prior.actionId === candidate.actionId) {
          const supplied = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined));
          const timing = prior.actionId === SCHEDULE && candidate.actionId === SCHEDULE
            ? { schedule: { ...prior.params.schedule, ...supplied(candidate.params.schedule ?? {}) } } : {};
          if ('schedule' in timing && timing.schedule?.kind === 'daily') delete timing.schedule.weekdays;
          const merged = this.#normalize(parseCandidate({ ...candidate, params: { ...prior.params, ...supplied(candidate.params), ...timing } }));
          this.#db.prepare("UPDATE proposal SET turn=?,revision=revision+1,body=?,expires=? WHERE id=? AND revision=? AND state='draft'")
            .run(turn,JSON.stringify(merged),this.#now()+86400000,previous.id,previous.revision);
          return this.#view(this.#owned(session,previous.id));
        }
      }
    }
    const id = randomUUID(), body = JSON.stringify(this.#normalize(candidate));
    this.#db.prepare("INSERT INTO proposal VALUES(?,?,?,1,'draft',?,?,NULL)").run(id,session,turn,body,this.#now()+86400000);
    return this.#view(this.#owned(session,id));
  }
  async handle(session: string, input: unknown, assertCurrent: () => void): Promise<Proposal | null> {
    assertCurrent(); this.binding.check();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('INVALID_DRAFT');
    const r = input as Record<string, unknown>;
    if (r.op === 'read' && Object.keys(r).sort().join() === 'op,turn' && typeof r.turn === 'number' && Number.isSafeInteger(r.turn) && r.turn >= 0) {
      const row = this.#at(session,r.turn);
      return row ? this.#view(row) : null;
    }
    if (typeof r.id !== 'string' || !/^[0-9a-f-]{36}$/.test(r.id) || typeof r.revision !== 'number' || !Number.isSafeInteger(r.revision) ||
        typeof r.op !== 'string' || !['save','confirm','dismiss','reconcile','open'].includes(r.op) ||
        Object.keys(r).some(k => !['op','id','revision',...(r.op === 'save' ? ['proposal'] : r.op === 'confirm' ? ['expectedNextRunAt'] : [])].includes(k))) throw Error('INVALID_DRAFT');
    let row = this.#owned(session,r.id);
    if (r.revision !== row.revision) return this.#view(row);
    const current = parseCandidate(JSON.parse(row.body));
    if (r.op === 'open') {
      if (row.state !== 'succeeded') throw Error('RESULT_NOT_AVAILABLE');
      const found = current.actionId === BOARD ? this.#boardResult(row)?.id
        : (await this.#schedule().viewConfirmedCreate(this.#request(current),row.id)).code === undefined ? row.result : undefined;
      assertCurrent(); this.binding.check();
      if (!found) throw Error('RESULT_NOT_AVAILABLE');
      return this.#view(row);
    }
    if (r.op === 'reconcile') {
      if (row.state !== 'pending' || this.#active.has(row.id)) return this.#view(row);
      const found = current.actionId === BOARD ? this.#boardResult(row)
        : await this.#schedule().viewConfirmedCreate(this.#request(current),row.id);
      assertCurrent(); this.binding.check();
      return this.#view(found && !('code' in found) ? this.#result(row,found.id,'scheduledAt' in found ? found.scheduledAt : undefined) : row);
    }
    if (row.state !== 'draft' || row.expires <= this.#now()) return this.#view(row);
    if (r.op === 'dismiss') {
      this.#db.prepare("UPDATE proposal SET state='dismissed',revision=revision+1 WHERE id=? AND revision=? AND state='draft'").run(row.id,row.revision);
      return this.#view(this.#owned(session,row.id));
    }
    const candidate = r.op === 'save' ? this.#normalize(parseCandidate(r.proposal)) : current;
    if (candidate.actionId !== current.actionId) throw Error('INVALID_DRAFT');
    if (r.op === 'save') {
      this.#db.prepare("UPDATE proposal SET body=?,revision=revision+1 WHERE id=? AND revision=? AND state='draft'").run(JSON.stringify(candidate),row.id,row.revision);
      return this.#view(this.#owned(session,row.id));
    }
    // Submit only the exact revision previously returned to the user for review.
    const preview = this.#view(row);
    if (preview.status === 'unavailable') return preview;
    if (preview.status !== 'ready') throw Error('DRAFT_NOT_READY');
    if (candidate.actionId === SCHEDULE && r.expectedNextRunAt !== preview.nextRunAt) return preview;
    assertCurrent(); this.binding.check();
    const adapter = candidate.actionId === BOARD ? this.#board() : this.#schedule();
    const reserved = this.#db.prepare("UPDATE proposal SET state='pending' WHERE id=? AND revision=? AND state='draft'").run(row.id,row.revision);
    if (!reserved.changes) return this.#view(this.#owned(session,row.id));
    this.#active.add(row.id);
    try {
      const id = row.id;
      if (candidate.actionId === BOARD) {
        const workspaceId = this.binding.workspaceId;
        await (adapter as BoardFace).apply(id,{ kind:'create',id,input: { title: candidate.params.title!,
          description: candidate.params.description ?? '', prompt: candidate.params.description || candidate.params.title!,
          projectId: workspaceId, workspaceId, status: candidate.params.column!, permission: 'read-only',
          mode: 'workspace-superagent-worker', ...this.#modelPin() } });
        if (this.#boardResult(row)?.id === id) row = this.#result(row,id);
      } else {
        const schedule = adapter as ScheduleFace, request = this.#request(candidate);
        await schedule.createConfirmed(request,id);
        const result = await schedule.viewConfirmedCreate(request,id);
        if (!result.code) row = this.#result(row,result.id,result.scheduledAt);
      }
    } catch (error) {
      // The downstream may have committed. Do not send another create on an ambiguous result.
      console.error('大肥鱼快捷操作结果需要核实', row.id, error instanceof Error ? error.name : '未知错误');
    } finally { this.#active.delete(row.id); }
    assertCurrent(); this.binding.check();
    return this.#view(this.#owned(session,row.id));
  }
}
