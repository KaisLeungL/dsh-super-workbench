import type { StewardStore } from '../../storage/store.js';
import type { EffectRequest } from '../../storage/types.js';

/** 单次消费适配口，不是 sender 实现。currentAuthority 必须来自真实 Host，不能取模型正文。 */
export async function dispatchOnce(
  store: StewardStore, identity: { effectKey: string; seq: number; generation: number },
  currentAuthority: (request: EffectRequest) => boolean,
  send: (request: EffectRequest) => Promise<{ nativeLogRef: string; accepted: boolean }>,
): Promise<'blocked' | 'accepted' | 'unknown'> {
  const claim = store.claimEffect(identity.effectKey, identity.seq, identity.generation, currentAuthority);
  if (!claim) return 'blocked';
  // claim 已提交 unknown，外呼不在 SQLite 事务中；异常绝不自动重发。
  try {
    const receipt = await send(claim.request);
    return store.recordEffectReceipt(claim, receipt) ? 'accepted' : 'unknown';
  } catch { return 'unknown'; }
}
