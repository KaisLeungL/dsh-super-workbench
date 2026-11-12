import { randomUUID } from 'node:crypto';

const capabilityId = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = id => ({ status: 'unavailable', capability: id });
const hasBoardScope = (scope, info) => scope.allBoardProjects === true &&
  info.id === 'task-board.list' && info.provider === '@local/dsh-workspace-context/task-board' && info.scope === 'project';

function moduleName(ctx) {
  for (let fiber = ctx?.fiber; fiber; fiber = fiber.parent?.fiber) {
    if (typeof fiber.entry?.options.name === 'string') return fiber.entry.options.name;
    if (fiber.parent?.fiber === fiber) break;
  }
  throw Error('CONTEXT_PLUGIN_IDENTITY_REQUIRED');
}

function parseFilter(value, fields) {
  if (!record(value)) return;
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const rule = Object.hasOwn(fields, key) && fields[key];
    const item = value[key];
    if (!rule || (rule.type === 'integer' ? !Number.isSafeInteger(item) : typeof item !== rule.type) ||
        (typeof item === 'string' && item.length > 256) || (rule.enum && !rule.enum.includes(item))) return;
    result[key] = item;
  }
  return Object.freeze(result);
}

async function readWithin(provider, request, signal) {
  let abort;
  const stop = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => {
    signal.throwIfAborted();
    return provider.read(request);
  }), stop]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Cordis Host 服务。注册的读取函数在宿主进程内执行。 */
export function apply(ctx) {
  const entries = new Map();
  const cursors = new Map();
  const lifetime = new AbortController();
  ctx.effect(() => () => { lifetime.abort(); entries.clear(); cursors.clear(); });
  const find = (provider, id) => entries.get(JSON.stringify([provider, id]));
  const catalog = grants => Object.entries(grants).sort(([a], [b]) => a.localeCompare(b)).map(([id, provider]) => {
    const entry = find(provider, id);
    return entry ? { ...structuredClone(entry.info), status: 'available' } : { id, status: 'unavailable' };
  });

  ctx.provide('workspaceContext', {
    register(owner, capability) {
      lifetime.signal.throwIfAborted();
      const module = moduleName(owner);
      const { protocol, id, source, description, scope, filters } = capability;
      if (protocol !== 1 || !capabilityId.test(id) || !['workspace', 'project'].includes(scope) ||
          typeof source !== 'string' || !source || source.length > 160 || typeof description !== 'string' || !description ||
          description.length > 320 || !record(filters) || Object.keys(filters).length > 12 || typeof capability.read !== 'function') {
        throw Error('CONTEXT_CAPABILITY_INVALID');
      }
      const cleanFilters = Object.fromEntries(Object.entries(filters).map(([key, field]) => {
        if (!/^[a-z][a-zA-Z0-9]*$/.test(key) || !field || !['string', 'boolean', 'integer'].includes(field.type) ||
            typeof field.description !== 'string' || field.description.length > 240 ||
            (field.enum !== undefined && (field.type !== 'string' || !Array.isArray(field.enum) || field.enum.length > 20 ||
              field.enum.some(item => typeof item !== 'string' || item.length > 80)))) throw Error('CONTEXT_FILTER_INVALID');
        return [key, { type: field.type, description: field.description, ...(field.enum && { enum: [...field.enum] }) }];
      }));
      const key = JSON.stringify([module, id]);
      if (entries.has(key)) throw Error('CONTEXT_CAPABILITY_ALREADY_REGISTERED');
      const controller = new AbortController();
      const entry = { info: { protocol, id, source, provider: module, description, scope, filters: cleanFilters }, read: capability.read, controller };
      entries.set(key, entry);
      return () => {
        if (entries.get(key) !== entry) return;
        entries.delete(key);
        controller.abort();
        for (const [token, page] of cursors) if (page.entry === entry) cursors.delete(token);
      };
    },
    catalog(access) {
      access.assertCurrent();
      lifetime.signal.throwIfAborted();
      const capabilities = catalog(access.grants).map(info => hasBoardScope(access.scope, info) ? { ...info, readScope: 'all-board-projects' } : info);
      return { status: 'ok', protocol: 1, workspaceId: access.scope.workspaceId, capabilities };
    },
    status(grants) {
      return Object.entries(grants).map(([id, provider]) => ({ id, available: !!find(provider, id) }));
    },
    async query(access, input) {
      access.assertCurrent();
      lifetime.signal.throwIfAborted();
      if (!record(input) || Object.keys(input).some(key => !['capability', 'filter', 'limit', 'cursor'].includes(key)) ||
          typeof input.capability !== 'string' || !capabilityId.test(input.capability)) return { status: 'invalid_query' };
      const id = input.capability;
      if (!Object.hasOwn(access.grants, id)) return { status: 'denied' };
      const entry = find(access.grants[id], id);
      if (!entry) return unavailable(id);
      const limit = input.limit ?? 10;
      const filter = parseFilter(input.filter === undefined ? {} : input.filter, entry.info.filters);
      if (!filter || !Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
          (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 36))) return { status: 'invalid_query', capability: id };
      const { workspaceId, projectIds } = access.scope;
      const allBoardProjects = hasBoardScope(access.scope, entry.info);
      const scope = Object.freeze({ workspaceId, projectIds, ...(allBoardProjects && { allBoardProjects: true }) });
      const queryKey = JSON.stringify([access.binding, scope, filter, limit]);
      const page = input.cursor === undefined ? undefined : cursors.get(input.cursor);
      if (input.cursor !== undefined && (!page || page.entry !== entry || page.queryKey !== queryKey || page.expiresAt <= Date.now())) {
        return { status: 'cursor_stale', capability: id };
      }
      const timeout = AbortSignal.timeout(3000);
      const signal = AbortSignal.any([access.signal, entry.controller.signal, lifetime.signal, timeout]);
      const offset = page?.offset ?? 0;
      let result;
      try { result = await readWithin(entry, { scope, filter, offset, limit, signal }, signal); }
      catch {
        access.assertCurrent();
        return timeout.aborted && !entry.controller.signal.aborted && !lifetime.signal.aborted
          ? { status: 'timeout', capability: id } : unavailable(id);
      }
      access.assertCurrent();
      if (entry.controller.signal.aborted || lifetime.signal.aborted) return unavailable(id);
      if (timeout.aborted) return { status: 'timeout', capability: id };
      if (!Array.isArray(result?.items) || result.items.length > limit || typeof result.revision !== 'string' ||
          !result.revision || result.revision.length > 160 || typeof result.more !== 'boolean' || (result.more && !result.items.length) ||
          result.items.some(item => !record(item) ||
            (allBoardProjects ? !(item.workspaceId === null || typeof item.workspaceId === 'string') ||
              !(item.projectId === null || typeof item.projectId === 'string') :
              item.workspaceId !== workspaceId || (entry.info.scope === 'project' && !projectIds.includes(item.projectId))) ||
            !record(item.ref) || typeof item.ref.kind !== 'string' || typeof item.ref.id !== 'string' || !item.ref.id)) return unavailable(id);
      let items;
      try {
        const json = JSON.stringify(result.items);
        if (Buffer.byteLength(json) > 16_000) return unavailable(id);
        items = JSON.parse(json);
      } catch { return unavailable(id); }
      if (page && page.revision !== result.revision) return { status: 'cursor_stale', capability: id };
      let nextCursor;
      if (result.more) {
        nextCursor = randomUUID();
        if (cursors.size >= 128) cursors.delete(cursors.keys().next().value);
        cursors.set(nextCursor, { entry, queryKey, revision: result.revision, offset: offset + items.length, expiresAt: Date.now() + 300_000 });
      }
      return { status: 'ok', capability: id, source: entry.info.source,
        ...(allBoardProjects ? { readScope: 'all-board-projects' } : { workspaceId }),
        readAt: new Date().toISOString(), revision: result.revision, items, complete: !result.more, ...(nextCursor && { nextCursor }) };
    },
  });
}
