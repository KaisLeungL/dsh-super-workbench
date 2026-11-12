import { ACTIONS, createController } from './timer.js';

export const inject = ['storage', 'storage.backend.json', 'connection', 'tools'];

export async function apply(ctx) {
  const backend = ctx.storage.backend.get('json');
  if (!backend.kv) throw new Error('Pomodoro requires a KV-capable storage backend.');
  const unit = await backend.kv.open({ name: 'local_pomodoro', version: 1, tables: [], hasGlobal: true });
  let clock;
  let unsubscribe;
  let deadline;
  let stopped = false;
  const streams = new Set();
  ctx.effect(() => async () => {
    stopped = true;
    clearTimeout(deadline);
    unsubscribe?.();
    for (const close of [...streams]) close();
    await clock?.close();
    await unit.close();
  });
  const saved = await unit.loadAll();
  clock = createController(saved.global, next => unit.setGlobal(next));
  const service = { operate: input => clock.operate(input) };
  ctx.provide('localPomodoro', service);

  function schedule(state) {
    clearTimeout(deadline);
    if (state.status !== 'running' || stopped) return;
    deadline = setTimeout(() => {
      service.operate({ action: 'status' }).catch(error => console.error('[pomodoro]', error));
    }, Math.min(2_147_483_647, Math.max(1, state.endsAt - Date.now())));
    deadline.unref?.();
  }
  unsubscribe = clock.subscribe(schedule);
  schedule(await service.operate({ action: 'status' }));

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/local-pomodoro',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const input = request.method === 'POST' ? await request.json() : { action: 'status' };
        const result = await service.operate(input);
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : 'Pomodoro request failed.' },
          { status: 400, headers: { 'cache-control': 'no-store' } });
      }
    },
  }));

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/local-pomodoro/events',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const encoder = new TextEncoder();
      let close = () => {};
      const body = new ReadableStream({
        start(output) {
          let ended = false;
          let heartbeat;
          let off = () => {};
          close = () => {
            if (ended) return;
            ended = true;
            clearInterval(heartbeat);
            off();
            request.signal.removeEventListener('abort', close);
            streams.delete(close);
            try { output.close(); } catch {}
          };
          const send = state => {
            if (ended) return;
            try {
              output.enqueue(encoder.encode('data: ' + JSON.stringify({ ...state, serverNow: Date.now() }) + '\n\n'));
            } catch { close(); }
          };
          off = clock.subscribe(send);
          streams.add(close);
          request.signal.addEventListener('abort', close, { once: true });
          heartbeat = setInterval(() => {
            try { output.enqueue(encoder.encode(': keepalive\n\n')); } catch { close(); }
          }, 25_000);
          heartbeat.unref?.();
          service.operate({ action: 'status' }).then(send, close);
          if (request.signal.aborted) close();
        },
        cancel() { close(); },
      });
      return new Response(body, { headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      } });
    },
  }));

  ctx.effect(() => ctx.tools.register({
    name: 'pomodoro',
    description: 'Read or control the DSH sidebar Pomodoro clock. Returns the shared timer state and remaining time. Use status to inspect it without starting a session.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS], description: 'status reads; start begins the selected mode (or continues a paused timer); pause and resume preserve remaining time; reset stops and restores the full duration; select changes an idle or paused mode.' },
        mode: { type: 'string', enum: ['focus', 'break'], description: 'focus is 25 minutes; break is 5 minutes. Required for select, optional for start and reset.' },
      },
      required: ['action'], additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: {
        mode: { type: 'string' }, status: { type: 'string' }, remainingMs: { type: 'number' },
        endsAt: { oneOf: [{ type: 'number' }, { type: 'null' }] }, serverNow: { type: 'number' },
      } },
      render(_args, value) {
        const ms = value.status === 'running' ? Math.max(0, value.endsAt - value.serverNow) : value.remainingMs;
        return [{ type: 'text', text: JSON.stringify({ ...value, remainingSeconds: Math.ceil(ms / 1000) }) }];
      },
    },
    async execute(input) { return service.operate(input); },
  }));
}
