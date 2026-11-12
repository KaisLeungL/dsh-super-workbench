import type { ChatContent, ChatModelSelection, DailyMotto } from '../app/health/chat-input.js';
import type { HealthView } from '../app/health/view.js';
import { CONTROL_TOKEN_HEADER } from '../status.js';

const BASE = '/api/workspace-superagent/';

export async function readChatHealth(signal?: AbortSignal) {
  const response = await fetch(BASE + 'health', { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) throw Error('暂时无法读取主理状态。');
  return { health: await response.json() as HealthView, token: response.headers.get(CONTROL_TOKEN_HEADER) };
}

export async function mutateChat(body: object, token: string | null, signal?: AbortSignal) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set(CONTROL_TOKEN_HEADER, token);
  const response = await fetch(BASE + 'chat', { method: 'POST', credentials: 'same-origin', headers, signal, body: JSON.stringify(body) });
  const result = await response.json() as { ok?: boolean; health?: HealthView; dailyMotto?: DailyMotto | null; error?: string };
  if (!response.ok || !result.ok) throw Error(result.error ?? '请求未完成。');
  return result;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: Error & { code: string; details: object } };
type Prompt = (request: { sessionId: string; requestId: string; content: ChatContent[] }, signal?: AbortSignal) => Promise<Result<{ accepted: true }>>;
type SelectModel = (request: ChatModelSelection & { sessionId: string }) => Promise<Result<{ selected: ChatModelSelection }>>;
export type ChatReference = {
  sessionId: string;
  binding: { session: { remote: { session: { prompt: Prompt } } } };
  ready: Promise<unknown>;
  release(): void;
};
export interface ChatModelDirectories {
  directoryFor(sessionId: string): { sessions: { selectModel: SelectModel } };
}

function withMethod<T extends object, K extends keyof T>(source: T, name: K, replacement: T[K]): T {
  return new Proxy(Object.create(null) as T, { get(_target, key) {
    if (key === name) return replacement;
    const value = Reflect.get(source, key, source);
    return typeof value === 'function' ? value.bind(source) : value;
  } });
}

// 仅替换当前会话及其模型目录的传输，保留普通聊天的编辑器、发送回执和模型菜单。
export function attachChatTransport(reference: ChatReference, models: ChatModelDirectories,
  request: (body: object, signal?: AbortSignal) => Promise<unknown>): () => void {
  const { sessionId, binding: { session } } = reference;
  const directory = models.directoryFor(sessionId);
  const remote = session.remote, modelRemote = directory.sessions;
  if (typeof remote?.session?.prompt !== 'function' || typeof modelRemote?.selectModel !== 'function') throw Error('当前 DSH 的输入框接口不兼容。');
  const failure = (error: unknown) => ({ ok: false as const, error: Object.assign(
    new Error(error instanceof Error ? error.message : '主理请求未完成。'), { code: 'session/agent-busy', details: {} },
  ) });
  const prompt: Prompt = async (value, signal) => {
    try {
      if (value.sessionId !== sessionId) throw Error('主理会话已变化。');
      if (!value.content.length) throw Error('请重新发送上一条消息。');
      await request({ sessionId, requestId: value.requestId, content: value.content }, signal);
      return { ok: true, value: { accepted: true } };
    } catch (error) { return failure(error); }
  };
  const selectModel: SelectModel = async ({ sessionId: target, ...model }) => {
    try {
      if (target !== sessionId) throw Error('主理会话已变化。');
      await request({ sessionId, model });
      return { ok: true, value: { selected: model } };
    } catch (error) { return failure(error); }
  };
  const chatRemote = withMethod(remote, 'session', withMethod(remote.session, 'prompt', prompt));
  const chatModels = withMethod(modelRemote, 'selectModel', selectModel);
  session.remote = chatRemote;
  try { directory.sessions = chatModels; }
  catch (error) { session.remote = remote; throw error; }
  return () => {
    if (session.remote === chatRemote) session.remote = remote;
    if (directory.sessions === chatModels) directory.sessions = modelRemote;
  };
}
