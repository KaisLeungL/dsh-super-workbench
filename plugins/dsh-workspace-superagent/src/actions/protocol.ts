export const ACTION_TOOL = 'steward_propose_action';
export const SCHEDULE_PRESET = 'workspace-superagent-scheduled';
export const SCHEDULE = 'dsh.schedule.create';
export const BOARD = 'dsh.taskBoard.create';
export type ActionId = typeof SCHEDULE | typeof BOARD;
export interface ScheduleFields {
  title?: string; instruction?: string;
  schedule?: { kind?: 'daily' | 'weekly'; time?: string; timeZone?: string; weekdays?: number[] };
  target?: 'dedicated_session';
}
export interface BoardFields { title?: string; description?: string; projectId?: string; column?: 'todo' | 'backlog' }
export type Candidate =
  | { actionId: typeof SCHEDULE; version: 1; params: ScheduleFields }
  | { actionId: typeof BOARD; version: 1; params: BoardFields };
export interface Proposal {
  id: string; turn: number; revision: number; candidate: Candidate;
  status: 'needs_input' | 'ready' | 'unavailable' | 'submitting' | 'unknown' | 'succeeded' | 'dismissed' | 'expired';
  nextRunAt?: string; resultId?: string;
  submissionIssue?: 'entry_unavailable' | 'schedule_preview_failed';
}

const str = (maxLength: number) => ({ type: 'string', maxLength });
const shape = (properties: object, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const scheduleFields = shape({
  title: str(120), instruction: str(4000), target: { enum: ['dedicated_session'] },
  schedule: shape({ kind: { enum: ['daily','weekly'] }, time: { type: 'string', pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' },
    timeZone: str(96), weekdays: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 7 } } }),
});
const boardFields = shape({ title: str(120), description: str(4000), projectId: str(256), column: { enum: ['todo','backlog'] } });
export const candidateSchema = { oneOf: [[SCHEDULE, scheduleFields], [BOARD, boardFields]].map(([actionId, params]) =>
  shape({ actionId: { const: actionId }, version: { const: 1 }, params }, ['actionId','version','params'])) };
export const actionToolSchema = shape({ proposal: candidateSchema, continueDraft: { type: 'boolean' } }, ['proposal']);

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error('INVALID_DRAFT');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw Error('INVALID_DRAFT');
  return value.trim() || undefined;
}
function choice<T>(value: unknown, choices: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!choices.includes(value as T)) throw Error('INVALID_DRAFT');
  return value as T;
}
export function parseCandidate(value: unknown): Candidate {
  const { actionId, version, params } = record(value, ['actionId','version','params']);
  if (version !== 1) throw Error('INVALID_DRAFT');
  if (actionId === SCHEDULE) {
    const p = record(params, ['title','instruction','schedule','target']);
    const s = record(p.schedule === undefined ? {} : p.schedule, ['kind','time','timeZone','weekdays']);
    const kind = choice(s.kind, ['daily','weekly'] as const);
    const time = text(s.time, 5);
    if (time && !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) throw Error('INVALID_DRAFT');
    const zone = text(s.timeZone, 96);
    if (zone && !['UTC', ...Intl.supportedValuesOf('timeZone')].includes(zone)) {
      // Intl.supportedValuesOf may omit valid aliases; reject offsets and non-IANA forms.
      try { if (!zone.includes('/')) throw Error('INVALID_DRAFT'); new Intl.DateTimeFormat('en', { timeZone: zone }); }
      catch { throw Error('INVALID_DRAFT'); }
    }
    const days = s.weekdays;
    if (days !== undefined && (kind === 'daily' || !Array.isArray(days) || days.length < 1 || days.length > 7 ||
        new Set(days).size !== days.length || days.some(day => !Number.isInteger(day) || day < 1 || day > 7))) throw Error('INVALID_DRAFT');
    return { actionId, version, params: { title: text(p.title,120), instruction: text(p.instruction,4000), target: choice(p.target,['dedicated_session'] as const),
      schedule: { kind, time, timeZone: zone, weekdays: days === undefined ? undefined : [...days].sort((a,b) => a-b) } } };
  }
  if (actionId === BOARD) {
    const p = record(params, ['title','description','projectId','column']);
    return { actionId, version, params: { title: text(p.title,120), description: text(p.description,4000),
      projectId: text(p.projectId,256), column: choice(p.column,['todo','backlog'] as const) } };
  }
  throw Error('INVALID_DRAFT');
}
export function readToolCandidate(value: unknown) {
  const { proposal, continueDraft } = record(value, ['proposal','continueDraft']);
  if (continueDraft !== undefined && typeof continueDraft !== 'boolean') throw Error('INVALID_DRAFT');
  return { candidate: parseCandidate(proposal), continueDraft: continueDraft === true };
}

export function missingFields(candidate: Candidate): string[] {
  if (candidate.actionId === BOARD) return candidate.params.title?.trim() ? [] : ['title'];
  const { instruction, schedule } = candidate.params;
  return [...(!instruction?.trim() ? ['instruction'] : []), ...(!schedule?.kind ? ['kind'] : []),
    ...(!schedule?.time ? ['time'] : []), ...(!schedule?.timeZone?.trim() ? ['timeZone'] : []),
    ...(schedule?.kind === 'weekly' && !schedule.weekdays?.length ? ['weekdays'] : [])];
}
