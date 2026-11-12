export const DURATIONS = Object.freeze({ focus: 25 * 60_000, break: 5 * 60_000 });
export const ACTIONS = Object.freeze(['status', 'start', 'pause', 'resume', 'reset', 'select']);

export function initialState(mode = 'focus') {
  return { version: 1, mode, status: 'idle', remainingMs: DURATIONS[mode], endsAt: null, revision: 0 };
}

export function restoreState(raw) {
  if (raw == null) return initialState();
  if (raw.version !== 1 || !Object.hasOwn(DURATIONS, raw.mode) ||
      !['idle', 'running', 'paused', 'completed'].includes(raw.status) ||
      !Number.isSafeInteger(raw.revision) || raw.revision < 0 ||
      !Number.isFinite(raw.remainingMs) || raw.remainingMs < 0 || raw.remainingMs > DURATIONS[raw.mode] ||
      (raw.status === 'running' ? !Number.isSafeInteger(raw.endsAt) || raw.endsAt <= 0 : raw.endsAt !== null)) {
    throw new Error('Saved Pomodoro state is invalid; it has been preserved for recovery.');
  }
  return { version: 1, mode: raw.mode, status: raw.status, remainingMs: raw.remainingMs,
    endsAt: raw.endsAt, revision: raw.revision };
}

export function remainingMs(state, now) {
  return state.status === 'running' ? Math.max(0, state.endsAt - now) : state.remainingMs;
}

export function transition(state, input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !ACTIONS.includes(input.action)) {
    throw new Error('Unknown Pomodoro action.');
  }
  if (input.mode !== undefined && !Object.hasOwn(DURATIONS, input.mode)) throw new Error('Unknown Pomodoro mode.');
  let next = state;
  if (state.status === 'running' && remainingMs(state, now) === 0) {
    next = { ...state, status: 'completed', remainingMs: 0, endsAt: null };
  }
  switch (input.action) {
    case 'status': break;
    case 'select':
      if (!input.mode) throw new Error('Select requires a mode.');
      if (next.status === 'running') throw new Error('Pause the timer before switching modes.');
      next = { ...initialState(input.mode), revision: state.revision };
      break;
    case 'start':
      if (next.status === 'running') {
        if (input.mode && input.mode !== next.mode) throw new Error('Pause the timer before switching modes.');
        break;
      }
      {
        const mode = input.mode ?? next.mode;
        const duration = mode === next.mode && next.status === 'paused' ? next.remainingMs : DURATIONS[mode];
        next = { ...next, mode, status: 'running', remainingMs: duration, endsAt: now + duration };
      }
      break;
    case 'pause':
      if (next.status === 'running') next = { ...next, status: 'paused', remainingMs: remainingMs(next, now), endsAt: null };
      break;
    case 'resume':
      if (next.status === 'paused') next = { ...next, status: 'running', endsAt: now + next.remainingMs };
      break;
    case 'reset':
      next = { ...initialState(input.mode ?? next.mode), revision: state.revision };
      break;
  }
  if (next !== state) next = { ...next, revision: state.revision + 1 };
  return next;
}

/** Serialize UI and tool writes; publish only after the state is durable. */
export function createController(initial, save, { now = Date.now } = {}) {
  let state = restoreState(initial);
  let queue = Promise.resolve();
  let closed = false;
  let fault;
  const listeners = new Set();
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    operate(input) {
      const task = queue.then(async () => {
        if (closed) throw new Error('Pomodoro plugin is stopped.');
        if (fault) throw new Error('Pomodoro storage failed; reload the plugin before retrying.');
        const next = transition(state, input, now());
        if (next !== state) {
          try { await save(next); } catch (error) { fault = error; throw error; }
          state = next;
          for (const listener of listeners) listener(state);
        }
        return { ...state, serverNow: now() };
      });
      queue = task.catch(() => {});
      return task;
    },
    async close() { closed = true; await queue; listeners.clear(); },
  };
}
