import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transition, remainingMs, restoreState, createController, DURATIONS } from '../timer.js';
import { apply } from '../index.js';

test('focus keeps its deadline over a long background gap and restored state', () => {
  const start = 100_000;
  const running = transition(initialState(), { action: 'start' }, start);
  const restored = restoreState(JSON.parse(JSON.stringify(running)));
  assert.equal(remainingMs(restored, start + 700_250), 799_750);
  const completed = transition(restored, { action: 'status' }, start + 1_600_000);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.remainingMs, 0);
  assert.equal(completed.endsAt, null);
  assert.strictEqual(transition(completed, { action: 'status' }, start + 2_000_000), completed);
});

test('pause preserves milliseconds and resume does not count paused time', () => {
  const running = transition(initialState(), { action: 'start' }, 100_000);
  const paused = transition(running, { action: 'pause' }, 110_125);
  assert.equal(paused.remainingMs, 1_489_875);
  const resumed = transition(paused, { action: 'resume' }, 1_000_000);
  assert.equal(resumed.endsAt, 2_489_875);
  assert.equal(remainingMs(resumed, 1_000_000), 1_489_875);
  assert.strictEqual(transition(resumed, { action: 'start' }, 1_000_100), resumed);
});

test('mode changes cannot discard a running timer, reset stops it explicitly', () => {
  const running = transition(initialState(), { action: 'start' }, 100_000);
  assert.throws(() => transition(running, { action: 'select', mode: 'break' }, 101_000), /Pause/);
  const reset = transition(running, { action: 'reset', mode: 'break' }, 101_000);
  assert.equal(reset.status, 'idle');
  assert.equal(reset.remainingMs, 300_000);
  assert.equal(reset.endsAt, null);
  const rest = transition(reset, { action: 'start' }, 102_000);
  const finished = transition(rest, { action: 'status' }, 402_000);
  assert.equal(finished.status, 'completed');
  const next = transition(finished, { action: 'start', mode: 'focus' }, 403_000);
  assert.equal(next.endsAt, 403_000 + DURATIONS.focus);
});

test('invalid actions and saved state are rejected without silently erasing data', () => {
  assert.throws(() => transition(initialState(), { action: 'start', mode: '__proto__' }, 1), /Unknown/);
  assert.throws(() => transition(initialState(), { action: 'select' }, 1), /requires/);
  assert.throws(() => restoreState({ ...initialState(), remainingMs: NaN }), /preserved/);
  assert.throws(() => restoreState({ ...initialState(), status: 'running', endsAt: null }), /preserved/);
});

test('simultaneous UI and tool writes serialize and publish after persistence', async () => {
  let now = 100_000;
  const saves = [], published = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const controller = createController(null, async state => {
    if (saves.length === 0) await gate;
    saves.push(state);
  }, { now: () => now });
  controller.subscribe(state => published.push(state.revision));
  const start = controller.operate({ action: 'start' });
  await new Promise(resolve => setImmediate(resolve));
  const pause = controller.operate({ action: 'pause' });
  assert.deepEqual(published, []);
  release();
  const started = await start;
  now += 1250;
  const paused = await pause;
  assert.equal(started.status, 'running');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.remainingMs, DURATIONS.focus - 1250);
  assert.deepEqual(published, [1, 2]);
  await controller.close();
});

test('a failed durable write is not published and requires reload', async () => {
  const controller = createController(null, async () => { throw new Error('disk full'); });
  let publications = 0;
  controller.subscribe(() => publications++);
  await assert.rejects(controller.operate({ action: 'start' }), /disk full/);
  assert.equal(publications, 0);
  await assert.rejects(controller.operate({ action: 'reset' }), /reload/);
  await controller.close();
});

test('installed Host routes and tool share state; SSE closes on plugin disposal', async () => {
  const routes = new Map(), tools = new Map(), effects = [];
  let stored = null, closed = false;
  const unit = {
    async loadAll() { return { tables: {}, global: stored }; },
    async setGlobal(state) { stored = structuredClone(state); },
    async close() { closed = true; },
  };
  const ctx = {
    storage: { backend: { get(name) {
      assert.equal(name, 'json');
      return { kv: { async open(spec) { assert.equal(spec.name, 'local_pomodoro'); assert.match(spec.name, /^[a-z][a-z0-9_]*$/); return unit; } } };
    } } },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    provide() {},
    effect(fn) { const cleanup = fn(); effects.push(cleanup); return cleanup; },
  };
  await apply(ctx);
  const route = routes.get('/api/local-pomodoro');
  const eventRoute = routes.get('/api/local-pomodoro/events');
  const tool = tools.get('pomodoro');
  const eventRequest = new Request('http://localhost/api/local-pomodoro/events');
  const streamResponse = await eventRoute.fetch(eventRequest);
  const reader = streamResponse.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"status":"idle"/);
  const response = await route.fetch(new Request('http://localhost/api/local-pomodoro', {
    method: 'POST', body: JSON.stringify({ action: 'start' }), headers: { 'content-type': 'application/json' },
  }));
  const started = await response.json();
  assert.equal(response.status, 200);
  assert.equal(started.status, 'running');
  const live = new TextDecoder().decode((await reader.read()).value);
  assert.match(live, /"status":"running"/);
  const paused = await tool.execute({ action: 'pause' });
  assert.equal(paused.status, 'paused');
  assert.equal(stored.status, 'paused');
  const current = await (await route.fetch(new Request('http://localhost/api/local-pomodoro'))).json();
  assert.equal(current.revision, paused.revision);
  const reset = await tool.execute({ action: 'reset' });
  assert.equal(reset.remainingMs, DURATIONS.focus);
  const bad = await route.fetch(new Request('http://localhost/api/local-pomodoro', { method: 'POST', body: '{}' }));
  assert.equal(bad.status, 400);
  await reader.cancel();
  for (const cleanup of effects.reverse()) await cleanup?.();
  assert.equal(closed, true);
  assert.equal(routes.size, 0);
  assert.equal(tools.size, 0);
});
