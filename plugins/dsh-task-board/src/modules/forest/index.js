import { FOREST_ID, createForestService, forestTool } from './host-service.js';

export const inject = ['taskBoard', 'storage', 'storage.backend.json', 'connection'];

export async function apply(ctx) {
  const backend = ctx.storage.backend.get('json');
  if (!backend.kv) throw new Error('Task forest requires a KV storage backend.');
  const unit = await backend.kv.open({ name: 'task_forest', version: 1, tables: ['state'], hasGlobal: false });
  let current;
  let generation = 0;
  let initialization = Promise.resolve();
  let released = false;
  const streams = new Set();
  const cleanup = [];
  const report = error => console.error('[task-forest]', error);
  const service = async () => {
    await initialization;
    if (!current) throw new Error('Enable the task board to use the forest.');
    return current;
  };
  const extension = {
    id: FOREST_ID, apiVersion: 1,
    start(board) {
      const stamp = ++generation;
      initialization = createForestService({ unit, board }).then(async next => {
        if (released || generation !== stamp) { await next.close(); return; }
        current = next;
        const reconcile = () => { next.reconcile().catch(report); };
        cleanup.push(board.events.onStatusChanged(reconcile));
        cleanup.push(board.events.onExecutionSettled(reconcile));
        cleanup.push(board.events.onTaskDeleted(reconcile));
        cleanup.push(board.registerTool(forestTool(next)));
        await next.reconcile();
      }).catch(error => { report(error); throw error; });
      // Initialization errors are also returned by the HTTP/tool operation.
      initialization.catch(() => {});
    },
    stop() {
      generation++;
      for (const off of cleanup.splice(0)) off();
      for (const close of [...streams]) close();
      const previous = current;
      current = undefined;
      if (previous) initialization = initialization.catch(() => {}).then(() => previous.close());
    },
    async handleAction(request) {
      const input = { ...(request.payload ?? {}), action: request.action };
      return (await service()).operate(input);
    },
  };
  ctx.effect(() => ctx.taskBoard.registerExtension(extension));
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/task-forest', methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      const headers = { 'cache-control': 'no-store' };
      try {
        let input = { action: 'status' };
        if (request.method === 'POST') {
          const text = await request.text();
          if (text.length > 4096) throw new Error('Forest request is too large.');
          input = JSON.parse(text);
        }
        return Response.json(await (await service()).operate(input), { headers });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers });
      }
    },
  }));
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/task-forest/events', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      let forest;
      try { forest = await service(); } catch (error) { return Response.json({ error: error.message }, { status: 503 }); }
      const encoder = new TextEncoder();
      let close = () => {};
      const body = new ReadableStream({
        start(output) {
          let ended = false;
          let off = () => {};
          let heartbeat;
          close = () => {
            if (ended) return;
            ended = true;
            off(); clearInterval(heartbeat); streams.delete(close);
            request.signal.removeEventListener('abort', close);
            try { output.close(); } catch {}
          };
          const send = view => {
            if (ended) return;
            try { output.enqueue(encoder.encode('data: ' + JSON.stringify(view) + '\n\n')); } catch { close(); }
          };
          off = forest.subscribe(send);
          streams.add(close);
          request.signal.addEventListener('abort', close, { once: true });
          heartbeat = setInterval(() => {
            send(forest.snapshot());
          }, 25000);
          heartbeat.unref?.();
          send(forest.snapshot());
          if (request.signal.aborted) close();
        },
        cancel() { close(); },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
    },
  }));
  ctx.effect(() => async () => {
    released = true;
    extension.stop();
    await initialization.catch(() => {});
    await unit.close();
  });
}
