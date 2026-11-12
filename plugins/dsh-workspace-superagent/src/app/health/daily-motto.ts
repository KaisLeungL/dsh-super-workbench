import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { localMottoDay, type ChatModelSelection, type DailyMotto } from './chat-input.js';

export interface MottoLlm {
  stream(options: {
    provider: string;
    model: string;
    messages: { role: 'user'; content: { type: 'text'; text: string }[] }[];
    maxTokens: number;
    signal: AbortSignal;
  }): AsyncIterable<{ type: string; text?: string; reason?: { kind: string } }>;
}

function cleanMotto(text: string): string {
  const line = text.trim().replace(/^[「“"]|[」”"]$/gu, '').trim();
  return line.length <= 36 && /\p{Script=Han}/u.test(line) && !/[\r\n<>\p{Cc}\p{Cf}]/u.test(line) ? line : '';
}

export function createDailyMotto(path: string, lifetime: AbortSignal) {
  let current: DailyMotto | undefined;
  let pending: Promise<DailyMotto | null> | undefined;
  let retryAfter = 0;
  const saved = readFile(path, 'utf8').then((raw) => {
    const value = JSON.parse(raw) as Partial<DailyMotto>;
    if (typeof value.day === 'string' && typeof value.text === 'string' && cleanMotto(value.text) === value.text) {
      current = { day: value.day, text: value.text };
    }
  }).catch(() => {});

  async function generate(day: string, llm: MottoLlm, model: ChatModelSelection): Promise<DailyMotto | null> {
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(20_000)]);
    const prompt = `今天是 ${day}。给正在做项目的人写一句自然、温和、有行动感的中文鼓励语，12 至 26 字。避免鸡汤、空泛口号、责备和夸张承诺。只返回一句纯文本。`;
    let output = '', finished = false;
    for await (const chunk of llm.stream({
      provider: model.provider, model: model.model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 512, signal,
    })) {
      signal.throwIfAborted();
      if (chunk.type === 'text-delta') output += chunk.text ?? '';
      if (output.length > 128) return null;
      if (chunk.type === 'finish') finished = chunk.reason?.kind === 'stop';
    }
    signal.throwIfAborted();
    const text = cleanMotto(output);
    if (!finished || !text || localMottoDay() !== day) return null;
    const value = { day, text };
    const temporary = path + '.' + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      signal.throwIfAborted();
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    current = value;
    return value;
  }

  return async (llm: MottoLlm | undefined, model: ChatModelSelection): Promise<DailyMotto | null> => {
    await saved;
    if (lifetime.aborted) return null;
    const day = localMottoDay();
    if (current?.day === day) return current;
    if (!llm || Date.now() < retryAfter) return null;
    pending ??= generate(day, llm, model).catch(() => null).then(value => {
      if (!value) retryAfter = Date.now() + 60_000;
      return value;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
