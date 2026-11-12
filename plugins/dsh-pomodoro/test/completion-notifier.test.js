import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionNotifier } from '../completion-notifier.js';

function ports() {
  let claim;
  const presented = [], messages = [], errors = [];
  const options = { readClaim: () => claim, writeClaim: value => { claim = value; },
    present: state => presented.push(state.mode), notify: (state, key) => messages.push(key), onError: error => errors.push(error) };
  return { options, presented, messages, errors };
}

test('focus and break completions each notify once despite duplicate stream and status responses', async () => {
  const p = ports(), n = createCompletionNotifier(p.options);
  assert.equal(await n.completed({ mode: 'focus', status: 'running', revision: 1 }), false);
  assert.equal(await n.completed({ mode: 'focus', status: 'paused', revision: 2 }), false);
  await Promise.all([n.completed({ mode: 'focus', status: 'completed', revision: 3 }), n.completed({ mode: 'focus', status: 'completed', revision: 3 })]);
  await n.completed({ mode: 'break', status: 'completed', revision: 5 });
  assert.deepEqual(p.presented, ['focus', 'break']);
  assert.deepEqual(p.messages, ['focus:3', 'break:5']);
});

test('reload and another tab do not replay a claimed completion', async () => {
  const p = ports();
  const state = { mode: 'focus', status: 'completed', revision: 7 };
  await createCompletionNotifier(p.options).completed(state);
  assert.equal(await createCompletionNotifier(p.options).completed(state), false);
  assert.equal(p.messages.length, 1);
});

test('denied or unsupported system notifications still present the completion in the app', async () => {
  const p = ports();
  p.options.notify = () => { throw new Error('Notifications unavailable'); };
  const n = createCompletionNotifier(p.options);
  assert.equal(await n.completed({ mode: 'break', status: 'completed', revision: 2 }), true);
  assert.deepEqual(p.presented, ['break']);
  assert.equal(p.errors.length, 1);
});

test('storage restrictions preserve one-time delivery in page memory', async () => {
  const p = ports();
  p.options.readClaim = () => { throw new Error('Storage blocked'); };
  p.options.writeClaim = p.options.readClaim;
  const n = createCompletionNotifier(p.options), state = { mode: 'focus', status: 'completed', revision: 6 };
  assert.equal(await n.completed(state), true);
  assert.equal(await n.completed(state), false);
  assert.equal(p.messages.length, 1);
});

test('two pages serialize delivery through their shared browser lock', async () => {
  const p = ports();
  let queue = Promise.resolve();
  p.options.withLock = (_name, run) => { const next = queue.then(run); queue = next; return next; };
  const a = createCompletionNotifier(p.options), b = createCompletionNotifier(p.options);
  await Promise.all([a.completed({ mode: 'focus', status: 'completed', revision: 4 }), b.completed({ mode: 'focus', status: 'completed', revision: 4 })]);
  assert.deepEqual(p.messages, ['focus:4']);
});

test('disposal cancels a notification waiting for a browser lock', async () => {
  const p = ports();
  let release;
  p.options.withLock = (_name, run) => new Promise(resolve => { release = () => resolve(run()); });
  const n = createCompletionNotifier(p.options);
  const result = n.completed({ mode: 'break', status: 'completed', revision: 9 });
  n.dispose(); release();
  assert.equal(await result, false);
  assert.deepEqual(p.messages, []);
});
