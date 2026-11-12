import type { StewardStore } from '../../storage/store.js';
import type { JobRequest } from '../../storage/types.js';

/** B02 只提供一次内部计算桥；不接真实 Job 调度，不重启 unknown/interrupted producer。 */
export async function computeOnce(
  store: StewardStore, jobId: string, currentAuthority: (request: JobRequest) => boolean,
  produce: (request: JobRequest) => Promise<{ resultRef: string; hash: string; nativeReceiptRef: string }>,
  notify: (jobId: string) => void, now: () => number = Date.now,
): Promise<'blocked' | 'completed' | 'retained_stale' | 'failed'> {
  const claim = store.claimJob(jobId, now(), currentAuthority);
  if (!claim) return 'blocked';
  let result: { resultRef: string; hash: string; nativeReceiptRef: string };
  try { result = await produce(claim.request); }
  catch (error) { return store.failJob(claim, String(error)) ? 'failed' : 'retained_stale'; }
  const current = store.completeJob(claim, result, now());
  // receipt 提交之后才通知；通知失败不回滚数据库，也不重复 producer。
  if (current) { try { notify(jobId); } catch {} }
  return current ? 'completed' : 'retained_stale';
}
