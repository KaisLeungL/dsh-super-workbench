import { createForestEngine, countRewards, rewardDays } from './engine.js';
import { ForestLan } from './lan.js';

export const FOREST_ID = 'task-forest';
export const ACTIONS = ['status', 'island', 'profile', 'room-create', 'room-join', 'room-leave', 'room-refresh'];

/** One application operation shared by the browser, board extension and agent tool. */
export async function createForestService({ unit, board, onChange = () => {}, now = Date.now }) {
  const saved = await unit.loadAll();
  const records = saved.tables?.state ?? {};
  let active = true;
  let fault;
  let queue = Promise.resolve();
  let lan;
  let engine;
  const listeners = new Set();
  const notify = () => {
    if (!active || !engine || !lan) return;
    const view = snapshot();
    // The board's mirror is useful to other extensions; SSE also delivers LAN-only changes.
    board.publish({ total: view.total, currentIsland: view.currentIsland, currentCount: view.currentCount, counts: view.counts });
    onChange(view);
    for (const fn of [...listeners]) fn(view);
  };
  engine = createForestEngine({
    saved: records.engine,
    save: value => unit.putRecord('state', 'engine', value),
    now,
    onChange: notify,
  });
  lan = new ForestLan({
    saved: records.lan,
    save: value => unit.putRecord('state', 'lan', value),
    now,
    getLocal: (timeZone) => {
      const view = engine.snapshot();
      return { ...view.identity, total: view.total,
        days: rewardDays(engine.exportState().rewards, now(), timeZone ?? view.timeZone),
        counts: countRewards(engine.exportState().rewards, now(), timeZone ?? view.timeZone) };
    },
    onChange: notify,
  });

  function snapshot(options = {}) {
    const view = engine.snapshot(options);
    return { ...view, room: lan.snapshot(), serverNow: now(), ...(fault ? { error: fault } : {}) };
  }
  function serialized(fn) {
    const next = queue.then(async () => {
      if (!active) throw new Error('The task forest is disabled.');
      return fn();
    });
    queue = next.catch(() => {});
    return next;
  }
  async function reconcile() {
    // Capture at notification time: a queued deletion must not erase a completion.
    const tasks = structuredClone(board.tasks.list());
    return serialized(async () => {
      try {
        await engine.reconcile(tasks);
        // Reward provenance belongs to each card; the independent engine ledger survives deletion.
        for (const reward of engine.exportState().rewards) {
          if (!board.tasks.get(reward.taskId)) continue;
          const previous = board.integration.read(reward.taskId);
          if (previous?.rewardId === reward.id) continue;
          board.integration.write(reward.taskId, {
            rewarded: true, rewardId: reward.id, completedAt: reward.completedAt,
            island: reward.island, position: reward.position,
          });
        }
        fault = undefined;
        await lan.sync().catch(() => {});
      } catch (error) {
        fault = error instanceof Error ? error.message : String(error);
        notify();
        throw error;
      }
      notify();
      return snapshot();
    });
  }
  async function operate(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !ACTIONS.includes(input.action)) throw new Error('Unknown forest action.');
    if (Object.keys(input).some(key => !['action', 'island', 'nickname', 'roomName', 'invite', 'address'].includes(key))) throw new Error('Unknown forest parameter.');
    return serialized(async () => {
      if (input.action === 'status' || input.action === 'island') return snapshot(input.island === undefined ? {} : { island: input.island });
      if (input.action === 'profile') {
        await engine.operate(input);
        await lan.sync().catch(() => {});
      } else {
        await lan.operate(input);
      }
      notify();
      return snapshot();
    });
  }
  await engine.operate({ action: 'status' });
  // An unavailable room must never prevent the local forest from starting.
  await lan.restore().catch(() => {});
  return {
    operate, reconcile, snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async close() {
      active = false;
      listeners.clear();
      await queue;
      await lan.close();
      await engine.close();
    },
  };
}

export function forestTool(service) {
  return {
    name: 'task_forest',
    description: 'Read the task forest and LAN tree rankings, edit your nickname, or create, join and leave a LAN room. Completed root tasks grow trees automatically; this tool never awards trees or changes task status.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS },
        island: { type: 'integer', minimum: 1, description: 'Island number to inspect with status or island.' },
        nickname: { type: 'string', minLength: 1, maxLength: 32, description: 'Display name for profile.' },
        roomName: { type: 'string', minLength: 1, maxLength: 32, description: 'Name for room-create.' },
        invite: { type: 'string', maxLength: 1024, description: 'Private-network dshforest invitation for room-join.' },
      },
      required: ['action'], additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { total: { type: 'integer' }, currentIsland: { type: 'integer' }, currentCount: { type: 'integer' }, room: { type: 'object' } } },
      render(_input, value) { return [{ type: 'text', text: JSON.stringify(value) }]; },
    },
    execute(input) { return service.operate(input); },
  };
}
