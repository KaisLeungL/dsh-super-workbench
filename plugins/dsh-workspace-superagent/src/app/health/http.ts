import { randomUUID } from 'node:crypto';
import type { HealthView } from './view.js';
import { CONTROL_TOKEN_HEADER } from '../../status.js';
import { readChatContent, readChatModel, type ChatContent, type ChatModelSelection, type DailyMotto } from './chat-input.js';
export interface Peer { readonly id: string; readonly principal: { readonly kind: string }; readonly signal: AbortSignal }
export interface HealthWebServer { getOrigin(): string }
export interface HealthConnection {
  readonly browserPeer: Peer;
  requestRejection(request: { headers: Headers }): number | undefined;
  admit(request: { headers: Headers }): { peer: Peer } | { rejection: number };
  readonly fetch: { register(route: {
    path: string; methods: readonly ('GET' | 'POST')[]; requestBody: 'buffered';
    fetch(request: Request): Promise<Response>;
  }): () => Promise<void> };
}
export interface HealthControl {
  read(): HealthView;
  dailyMotto?(): Promise<DailyMotto | null>;
  revision(): number;
  execute(action: 'pause' | 'resume' | 'stop', revision: number, proofRef: string, caller: ChatCaller): void | Promise<void>;
  connect?(revision: number, proofRef: string, caller: ChatCaller): void | Promise<void>;
  send?(sessionId: string, requestId: string, text: string, caller: ChatCaller): Promise<void>;
  sendContent?(sessionId: string, requestId: string, content: ChatContent[], caller: ChatCaller): Promise<void>;
  actions?(sessionId: string, value: unknown, caller: ChatCaller): Promise<unknown>;
  personalRead?(caller: ChatCaller): Promise<unknown>;
  personalWrite?(sessionId: string, value: unknown, caller: ChatCaller): Promise<unknown>;
  selectModel?(sessionId: string, model: ChatModelSelection, caller: ChatCaller): Promise<void>;
}
interface ChatCaller { signal: AbortSignal; assertCurrent(): void }
const canonical = (value: unknown): unknown => value && (typeof value === 'object' || typeof value === 'function')
  ? Reflect.get(value, Symbol.for('cordis.original')) ?? value : value;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
/** 认证由宿主Connection负责；只接受其当前已认证浏览器owner Peer。 */
export function healthRoutes(current: () => HealthConnection | undefined, controls: () => HealthControl, currentWebServer: () => HealthWebServer | undefined) {
  const controlToken = randomUUID();
  const authenticate = (request: Request) => {
    request.signal.throwIfAborted();
    const connection = current();
    if (!connection || typeof connection.admit !== 'function') throw Error('BROWSER_AUTH_UNAVAILABLE');
    const admission = connection.admit({ headers: request.headers });
    if ('rejection' in admission) throw Error('BROWSER_AUTH_REQUIRED');
    const peer = admission.peer;
    const check = () => {
      request.signal.throwIfAborted(); peer.signal.throwIfAborted();
      const live = current();
      if (!live || canonical(live) !== canonical(connection)) throw Error('CONNECTION_CHANGED');
      if (live.requestRejection({ headers: request.headers }) !== undefined) throw Error('BROWSER_REQUEST_REJECTED');
      const next = live.admit({ headers: request.headers });
      if ('rejection' in next || next.peer.id !== peer.id || peer.id !== live.browserPeer.id ||
          next.peer.principal.kind !== 'owner' || live.browserPeer.principal.kind !== 'owner') throw Error('BROWSER_OWNER_REQUIRED');
      next.peer.signal.throwIfAborted(); live.browserPeer.signal.throwIfAborted();
    };
    check(); return { check, peer };
  };
  async function mutate(request: Request, kind: 'chat' | 'control' | 'actions' | 'personal'): Promise<Response> {
    const chat = kind === 'chat';
    let auth: ReturnType<typeof authenticate> | undefined;
    try {
      auth = authenticate(request);
      const server = currentWebServer();
      let origin: string;
      try {
        if (!server) throw Error('missing');
        origin = server.getOrigin();
        const parsed = new URL(origin);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw Error('invalid');
      } catch { throw Error('BROWSER_ORIGIN_UNAVAILABLE'); }
      const assertCurrent = () => {
        auth!.check();
        const live = currentWebServer();
        if (!live || canonical(live) !== canonical(server) || live.getOrigin() !== origin) throw Error('BROWSER_ORIGIN_CHANGED');
      };
      assertCurrent();
      const requestOrigin = request.headers.get('origin');
      const fetchSite = request.headers.get('sec-fetch-site');
      const sameOrigin = requestOrigin === origin && fetchSite === 'same-origin';
      // 桌面代理会移除这两个头。此时必须提交当前宿主发给浏览器所有者的凭证。
      const ownerProof = requestOrigin === null && fetchSite === null &&
        request.headers.get(CONTROL_TOKEN_HEADER) === controlToken;
      if ((!sameOrigin && !ownerProof) || (['actions','personal'].includes(kind) && request.headers.get(CONTROL_TOKEN_HEADER) !== controlToken)) return json({ error: '拒绝未经确认的请求。' }, 403);
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return json({ error: '只接受JSON控制请求。' }, 415);
      const limit = chat ? 16 * 1024 * 1024 : kind === 'actions' ? 24 * 1024 : 1024;
      if (Number(request.headers.get('content-length') ?? 0) > limit) return json({ error: '请求过大。' }, 413);
      const bodyText = await request.text(); assertCurrent();
      if (new TextEncoder().encode(bodyText).byteLength > limit) return json({ error: '请求过大。' }, 413);
      const body = JSON.parse(bodyText) as Record<string, unknown> | null;
      const caller = { signal: AbortSignal.any([request.signal, auth.peer.signal]), assertCurrent };
      const proof = 'browser-owner:' + auth.peer.id + ':' + randomUUID();
      const control = controls();
      if (kind === 'personal') {
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).sort().join() !== 'request,sessionId' || typeof body.sessionId !== 'string') return json({ error:'个人面板请求无效' }, 400);
        if (!control.personalWrite) return json({ error:'个人面板暂不可用' }, 503);
        const result = await control.personalWrite(body.sessionId,body.request,caller);
        assertCurrent();
        return json(result);
      }
      if (kind === 'actions') {
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).sort().join() !== 'request,sessionId' || typeof body.sessionId !== 'string') return json({ error:'快捷操作请求无效' }, 400);
        if (!control.actions) return json({ error:'当前主理不支持快捷操作' }, 503);
        const proposal = await control.actions(body.sessionId,body.request,caller);
        assertCurrent();
        return json({ ok:true, proposal });
      }
      if (chat) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: '对话请求无效。' }, 400);
        const keys = Object.keys(body).sort().join(',');
        if (keys === 'dailyMotto' && body.dailyMotto === true) {
          const dailyMotto = await control.dailyMotto?.() ?? null;
          assertCurrent();
          return json({ ok: true, dailyMotto });
        }
        if (keys === 'revision' && Number.isSafeInteger(body.revision) && Number(body.revision) >= 0) {
          if (!control.connect) return json({ error: '主理对话暂不可用。' }, 503);
          if (control.revision() !== body.revision) return json({ error: '状态已变化，请刷新后重试。' }, 409);
          await control.connect(Number(body.revision), proof, caller);
          assertCurrent();
          return json({ ok: true, health: controls().read() });
        }
        if (keys === 'requestId,sessionId,text' && typeof body.sessionId === 'string' &&
            typeof body.requestId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.requestId) &&
            typeof body.text === 'string' && body.text.trim() && body.text.length <= 6000) {
          if (!control.send) return json({ error: '主理对话暂不可用。' }, 503);
          await control.send(body.sessionId, body.requestId, body.text, caller);
          return json({ ok: true });
        }
        if (keys === 'content,requestId,sessionId' && typeof body.sessionId === 'string' &&
            typeof body.requestId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.requestId)) {
          const content = readChatContent(body.content);
          if (content && control.sendContent) {
            await control.sendContent(body.sessionId, body.requestId, content, caller);
            return json({ ok: true });
          }
        }
        if (keys === 'model,sessionId' && typeof body.sessionId === 'string') {
          const model = readChatModel(body.model);
          if (model && control.selectModel) {
            await control.selectModel(body.sessionId, model, caller);
            return json({ ok: true });
          }
        }
        return json({ error: '对话请求无效。' }, 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).sort().join(',') !== 'action,revision') return json({ error: '控制字段无效。' }, 400);
      const value = body as { action: string; revision: number };
      if (!['pause', 'resume', 'stop'].includes(value.action) || !Number.isSafeInteger(value.revision) || value.revision < 0) return json({ error: '控制参数无效。' }, 400);
      assertCurrent();
      if (control.revision() !== value.revision) return json({ error: '状态已变化，请刷新后重试。' }, 409);
      await control.execute(value.action as 'pause' | 'resume' | 'stop', value.revision, proof, caller);
      assertCurrent();
      return json({ ok: true, health: controls().read() });
    } catch (error) {
      const code = error instanceof Error ? ('code' in error ? String(error.code) : error.message) : '';
      if (code === 'PENDING_INPUT') return json({ error: '主理正在回复，请稍后再发送。' }, 409);
      if (code === 'NATIVE_CHAT_MODEL_REQUIRED') return json({ error: '主理目前支持 DSH 原生模型，请选择 DeepSeek 或其他原生模型。' }, 400);
      if (code === 'CHAT_MODEL_UNAVAILABLE') return json({ error: '这个模型或推理强度当前不可用。' }, 400);
      if (code === 'CHAT_SESSION_CHANGED' || code === 'REQUEST_ID_REUSED') return json({ error: '发送请求已变化，请重新打开主理对话。' }, 409);
      if (['REVISION_CONFLICT', 'CONTROL_BUSY'].includes(code)) return json({ error: '状态已变化或控制处理中。' }, 409);
      if (code === 'PERSONAL_INVALID') return json({ error: '请检查待办内容和日期。' }, 400);
      if (code === 'PERSONAL_BOARD_UNAVAILABLE') return json({ error: '关联的看板任务不可用。' }, 409);
      if (['INVALID_DRAFT','DRAFT_NOT_READY'].includes(code)) return json({ error: '请检查卡片中的信息，再预览' }, 400);
      if (['DRAFT_SCOPE_CHANGED','DRAFT_NOT_FOUND'].includes(code)) return json({ error: '草稿已失效，请重新发起' }, 409);
      if (code === 'RESULT_NOT_AVAILABLE') return json({ error: '原对象已不可用，请在对应管理页核对' }, 404);
      if (error instanceof SyntaxError) return json({ error: '控制JSON无效。' }, 400);
      if (code.includes('BROWSER') || code.includes('CONNECTION') || request.signal.aborted || auth?.peer.signal.aborted) return json({ error: '浏览器授权已失效。' }, 403);
      return json({ error: chat ? '主理暂时无法处理请求，请检查连接与授权后重试。' : '控制未完成，当前状态请以重新读取结果为准。' }, 503);
    }
  }
  return {
    async read(request: Request): Promise<Response> {
      try {
        const auth = authenticate(request);
        auth.check();
        const response = json(controls().read());
        response.headers.set(CONTROL_TOKEN_HEADER, controlToken);
        return response;
      }
      catch { return json({ error: '需要当前已认证浏览器所有者连接。' }, 403); }
    },
    control: (request: Request) => mutate(request, 'control'),
    chat: (request: Request) => mutate(request, 'chat'),
    actions: (request: Request) => mutate(request, 'actions'),
    personalWrite: (request: Request) => mutate(request, 'personal'),
    async personalRead(request: Request): Promise<Response> {
      let auth: ReturnType<typeof authenticate>;
      try { auth = authenticate(request); }
      catch { return json({ error: '需要当前已认证浏览器所有者连接。' }, 403); }
      try {
        const service = controls().personalRead;
        if (!service) return json({ error: '个人面板暂不可用。' }, 503);
        const value = await service({ signal: AbortSignal.any([request.signal, auth.peer.signal]), assertCurrent: auth.check });
        auth.check();
        return json(value);
      } catch (error) {
        try { auth.check(); } catch { return json({ error: '浏览器授权已失效。' }, 403); }
        if (error instanceof Error && error.message === 'PERSONAL_AUTH_EXPIRED') return json({ error: '主理只读授权已到期，请更新授权后重试。' }, 403);
        return json({ error: '个人面板暂时无法读取。' }, 503);
      }
    },
  };
}
