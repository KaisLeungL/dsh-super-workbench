export type ChatModelSelection = { provider: string; model: string; reasoningEffort?: string };
export type DailyMotto = { day: string; text: string };
export function localMottoDay(date = new Date()): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(part => String(part).padStart(2, '0')).join('-');
}
export const DEFAULT_CHAT_MODEL = Object.freeze({
  provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high',
});
export type ChatContent =
  | { type: 'text'; text: string }
  | { type: 'file'; receiptId: string }
  | { type: 'image'; mediaType: string; data: string; name?: string };

export function nativeChatModel(provider: string): boolean {
  return !!provider && !/^acp(?:[-:]|$)/i.test(provider);
}

export function readChatModel(value: unknown): ChatModelSelection | undefined {
  if (!value || typeof value !== 'object') return;
  const { provider, model, reasoningEffort } = value as Record<string, unknown>;
  if (typeof provider !== 'string' || !provider.trim() || provider.length > 256 ||
      typeof model !== 'string' || !model.trim() || model.length > 256 ||
      (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || !reasoningEffort.trim() || reasoningEffort.length > 64))) return;
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
}

export function readChatContent(value: unknown): ChatContent[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return;
  const content: ChatContent[] = [];
  for (const part of value) {
    if (!part || typeof part !== 'object') return;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.length <= 6000) {
      content.push({ type: 'text', text: part.text });
    } else if (part.type === 'file' && typeof part.receiptId === 'string' && part.receiptId.length > 0 && part.receiptId.length <= 256) {
      content.push({ type: 'file', receiptId: part.receiptId });
    } else if (part.type === 'image' && typeof part.mediaType === 'string' && /^image\/(?:png|jpeg|gif|webp)$/.test(part.mediaType) &&
        typeof part.data === 'string' && part.data.length > 0 &&
        (part.name === undefined || (typeof part.name === 'string' && part.name.length <= 512))) {
      content.push({ type: 'image', mediaType: part.mediaType, data: part.data, ...(part.name === undefined ? {} : { name: part.name }) });
    } else return;
  }
  if (content.some(part => part.type !== 'text' || part.text.trim())) return content;
}
