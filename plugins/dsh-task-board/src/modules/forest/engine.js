import { randomUUID } from 'node:crypto';

export const FOREST_TIME_ZONE = 'Asia/Shanghai';
export const TREES_PER_ISLAND = 16;
const clone = value => structuredClone(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max;
const timestamp = value => typeof value === 'number' ? (Number.isFinite(value) && value >= 0 ? value : NaN) : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
const validZone = value => { try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return typeof value === 'string'; } catch { return false; } };
function nickname(value) {
  if (typeof value !== 'string' || Array.from(value.trim()).length < 1 || Array.from(value.trim()).length > 32 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('Nickname must contain 1–32 characters');
  return value.trim();
}
export function calendar(value, timeZone = FOREST_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const part = name => parts.find(item => item.type === name).value;
  const day = part('year') + '-' + part('month') + '-' + part('day');
  const date = new Date(day + 'T00:00:00Z');
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday);
  return { day, month: day.slice(0, 7), week: date.toISOString().slice(0, 10) };
}
/** Calendar periods, Monday-start week, evaluated in the supplied IANA zone. */
export function countRewards(rewards, at = Date.now(), timeZone = FOREST_TIME_ZONE) {
  if (!validZone(timeZone) || !Number.isFinite(at)) throw new TypeError('Invalid clock or time zone');
  const current = calendar(at, timeZone);
  const counts = { day: 0, week: 0, month: 0 };
  for (const reward of rewards) {
    const time = timestamp(reward.completedAt);
    if (!Number.isFinite(time) || time > at) continue;
    const period = calendar(time, timeZone);
    for (const key of Object.keys(counts)) if (period[key] === current[key]) counts[key]++;
  }
  return counts;
}
export function rewardDays(rewards, at = Date.now(), timeZone = FOREST_TIME_ZONE) {
  const today = calendar(at, timeZone).day;
  const earliest = new Date(today + 'T00:00:00Z');
  earliest.setUTCDate(earliest.getUTCDate() - 62);
  const days = {};
  for (const reward of rewards) {
    const time = timestamp(reward.completedAt);
    if (!Number.isFinite(time) || time > at) continue;
    const day = calendar(time, timeZone).day;
    if (day >= earliest.toISOString().slice(0, 10)) days[day] = (days[day] ?? 0) + 1;
  }
  return days;
}
function restore(saved) {
  if (!saved || saved.version !== 1 || !saved.identity || !uuid(saved.identity.id) || !Array.isArray(saved.rewards)) throw new TypeError('Invalid saved forest; refusing to replace it');
  const state = clone(saved);
  state.identity.nickname = nickname(state.identity.nickname);
  state.timeZone ??= FOREST_TIME_ZONE;
  state.revision ??= 0;
  state.activatedAt ??= 0;
  state.claimedTasks ??= [];
  if (!Number.isFinite(state.activatedAt) || !Array.isArray(state.claimedTasks) || state.claimedTasks.some(id => !text(id))) throw new TypeError('Invalid forest activation state');
  if (!validZone(state.timeZone) || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new TypeError('Invalid saved forest metadata');
  const keys = new Set();
  const ids = new Set();
  for (const [index, reward] of state.rewards.entries()) {
    const expectedKey = reward.type === 'task' ? 'task:' + reward.taskId : reward.type === 'cron' && Number.isFinite(timestamp(reward.occurrence)) ? 'cron:' + reward.taskId + ':' + new Date(timestamp(reward.occurrence)).toISOString() : null;
    if (!uuid(reward.id) || ids.has(reward.id) || !text(reward.key, 600) || reward.key !== expectedKey || keys.has(reward.key) || !text(reward.taskId) || !text(reward.title) || !Number.isFinite(timestamp(reward.completedAt)) || reward.island !== Math.floor(index / TREES_PER_ISLAND) + 1 || reward.position !== index % TREES_PER_ISLAND + 1) throw new TypeError('Invalid saved reward ledger');
    keys.add(reward.key); ids.add(reward.id);
  }
  return state;
}
function inspectTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError('Tasks must be an array');
  const byId = new Map();
  const children = new Map();
  for (const task of tasks) {
    if (!task || !text(task.id) || byId.has(task.id) || !text(task.title, 100000) || !['todo', 'running', 'needs_input', 'review', 'done', 'failed', 'backlog'].includes(task.status) || !Array.isArray(task.executions) || (task.parentId != null && !text(task.parentId))) throw new TypeError('Invalid task snapshot');
    for (const execution of task.executions) if (!execution || !text(execution.id) || !Number.isFinite(timestamp(execution.startedAt)) || (execution.endedAt != null && (!Number.isFinite(timestamp(execution.endedAt)) || timestamp(execution.endedAt) < timestamp(execution.startedAt)))) throw new TypeError('Invalid execution snapshot');
    byId.set(task.id, task);
    if (task.parentId != null) {
      if (!children.has(task.parentId)) children.set(task.parentId, []);
      children.get(task.parentId).push(task);
    }
  }
  return { byId, children };
}
function latest(task) {
  return task.executions.reduce((best, execution) => !best || timestamp(execution.startedAt) >= timestamp(best.startedAt) ? execution : best, null);
}
function completeTree(root, children, clock) {
  const visiting = new Set();
  let completedAt = 0;
  const visit = task => {
    if (visiting.has(task.id) || task.status !== 'done') return false;
    visiting.add(task.id);
    if (task.executions.some(execution => execution.endedAt == null)) return false;
    const execution = latest(task);
    if (execution && (execution.result !== 'succeeded' || (execution.ownResult != null && execution.ownResult !== 'succeeded'))) return false;
    const time = execution ? timestamp(execution.endedAt) : timestamp(task.updatedAt ?? task.createdAt);
    if (!Number.isFinite(time) || time > clock) return false;
    completedAt = Math.max(completedAt, time);
    for (const child of children.get(task.id) ?? []) if (!visit(child)) return false;
    visiting.delete(task.id);
    return true;
  };
  return visit(root) ? completedAt : null;
}

/**
 * Append-only reward ledger. Save resolves before state becomes visible.
 * Cron credit only considers the current trigger and current complete tree.
 * A trigger can earn at most once, including after a manual rerun/history trim.
 */
export function createForestEngine({ saved, save, now = Date.now, onChange } = {}) {
  if (typeof save !== 'function' || typeof now !== 'function') throw new TypeError('save and now must be functions');
  let state = saved === undefined ? { version: 1, identity: { id: randomUUID(), nickname: '森林旅人' }, rewards: [], timeZone: FOREST_TIME_ZONE, revision: 0, activatedAt: now(), claimedTasks: [] } : restore(saved);
  let persisted = saved !== undefined;
  let queue = Promise.resolve();
  let closed = false;
  function snapshot({ island } = {}) {
    const total = state.rewards.length;
    const currentIsland = Math.floor(total / TREES_PER_ISLAND) + 1;
    const summary = {
      total, currentIsland, currentCount: total % TREES_PER_ISLAND, completedIslands: Math.floor(total / TREES_PER_ISLAND),
      counts: countRewards(state.rewards, now(), state.timeZone),
      recent: clone(state.rewards.slice(-12).reverse()),
      // Bounded overview keeps the Host wire below 64 KiB even for long-lived forests.
      islands: Array.from({ length: Math.min(currentIsland, 48) }, (_, index) => {
        const number = Math.max(1, currentIsland - 47) + index;
        return { island: number, count: Math.min(TREES_PER_ISLAND, Math.max(0, total - (number - 1) * TREES_PER_ISLAND)), completed: number < currentIsland };
      }),
      identity: clone(state.identity), timeZone: state.timeZone, revision: state.revision,
      ...(state.rewards.length ? { lastReward: clone(state.rewards.at(-1)) } : {})
    };
    if (island !== undefined) {
      if (!Number.isSafeInteger(island) || island < 1 || island > currentIsland) throw new RangeError('Unknown island');
      const rewards = state.rewards.slice((island - 1) * TREES_PER_ISLAND, island * TREES_PER_ISLAND);
      summary.island = { island, count: rewards.length, rewards: clone(rewards) };
    }
    return summary;
  }
  async function commit(next, changed) {
    if (changed) next.revision = state.revision + 1;
    if (changed || !persisted) {
      await save(clone(next));
      state = next;
      persisted = true;
      if (changed && onChange) { try { onChange(snapshot()); } catch { /* A view callback cannot roll back a durable commit. */ } }
    }
    return snapshot();
  }
  function enqueue(operation) {
    if (closed) return Promise.reject(new Error('Forest engine is closed'));
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  return {
    snapshot,
    exportState: () => clone(state),
    reconcile(tasks) {
      // Copy at call time so caller mutations cannot alter an enqueued reconciliation.
      const input = clone(tasks);
      return enqueue(async () => {
        const { byId, children } = inspectTasks(input);
        const next = clone(state);
        const seen = new Set(next.rewards.map(reward => reward.key));
        const clock = now();
        for (const task of byId.values()) {
          if (task.parentId != null) continue;
          const completedAt = completeTree(task, children, clock);
          if (completedAt === null || completedAt < state.activatedAt) continue;
          let type = 'task', key = 'task:' + task.id, occurrence;
          if (task.schedule?.mode === 'cron') {
            const trigger = timestamp(task.schedule.lastTriggeredAt);
            const execution = latest(task);
            if (!Number.isFinite(trigger) || trigger > clock || !execution || timestamp(execution.startedAt) < trigger || completedAt < trigger) continue;
            type = 'cron';
            occurrence = new Date(trigger).toISOString();
            key = 'cron:' + task.id + ':' + occurrence;
          }
          if (seen.has(key)) continue;
          const descendants = [];
          const collect = item => { descendants.push(item.id); for (const child of children.get(item.id) ?? []) collect(child); };
          collect(task);
          // A credited child cannot earn a second tree by becoming a root.
          if (type === 'task' && descendants.some(id => next.claimedTasks.includes(id))) continue;
          if (type === 'task') next.claimedTasks.push(...descendants);
          const index = next.rewards.length;
          next.rewards.push({ id: randomUUID(), key, taskId: task.id, title: Array.from(task.title).slice(0, 128).join(''), completedAt: new Date(completedAt).toISOString(), island: Math.floor(index / TREES_PER_ISLAND) + 1, position: index % TREES_PER_ISLAND + 1, type, ...(occurrence ? { occurrence } : {}) });
          seen.add(key);
        }
        return commit(next, next.rewards.length !== state.rewards.length);
      });
    },
    operate(input = { action: 'status' }) {
      return enqueue(async () => {
        if (!input || !['status', 'profile', 'island'].includes(input.action)) throw new TypeError('Unknown forest action');
        if (input.action === 'island') {
          if (!Number.isSafeInteger(input.island)) throw new RangeError('Unknown island');
          snapshot({ island: input.island });
          await commit(clone(state), false);
          return snapshot({ island: input.island });
        }
        const next = clone(state);
        if (input.action === 'profile') next.identity.nickname = nickname(input.nickname);
        return commit(next, next.identity.nickname !== state.identity.nickname);
      });
    },
    close() {
      if (closed) return queue;
      closed = true;
      const result = queue.then(() => commit(clone(state), false)).then(() => {});
      queue = result.catch(() => {});
      return result;
    }
  };
}
