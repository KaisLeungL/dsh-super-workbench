import type { StewardStore } from '../../storage/store.js';
import type { JobClaim, JobRequest } from '../../storage/types.js';
import { LIMITS } from '../../storage/types.js';
import { TimerSet, systemClock, type Clock } from './clock.js';
import type { LifecycleLease } from './coordinator.js';

export interface JobResult { resultRef: string; hash: string; nativeReceiptRef: string }
export interface JobRunContext { signal: AbortSignal; deadline: number }
export type JobOutcome = 'blocked' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'retained_stale';
interface Running {
  claim: JobClaim; abort: AbortController; deadline: number;
  cancelTimer: () => void; removeAbort: () => void;
  finish(outcome: JobOutcome): void; settled: boolean;
}
interface ProducerSlot { jobId: string }
const occupancyKey = Symbol.for('@local/dsh-workspace-superagent/producer-occupancy/v1');
const processState = globalThis as typeof globalThis & { [occupancyKey]?: Map<string, Set<ProducerSlot>> };
const occupancy = processState[occupancyKey] ??= new Map<string, Set<ProducerSlot>>();
const deploymentKey = (store: StewardStore): string => JSON.stringify([store.identity.domainId, store.identity.instanceId]);
function reserveProducer(store: StewardStore, jobId: string): (() => void) | undefined {
  const key = deploymentKey(store), pending = occupancy.get(key) ?? new Set<ProducerSlot>();
  if (pending.size >= LIMITS.jobs || [...pending].some(slot => slot.jobId === jobId)) return;
  const slot = { jobId }; pending.add(slot); occupancy.set(key, pending);
  return () => {
    pending.delete(slot);
    if (!pending.size && occupancy.get(key) === pending) occupancy.delete(key);
  };
}
/** 持久任务真值仍在 SQLite；跨装配仅保留同部署尚未退出producer的进程内占用。 */
export class JobSupervisor {
  readonly #running = new Map<string, Running>();
  readonly #timers: TimerSet;
  #disposed = false;
  constructor(
    readonly store: StewardStore,
    readonly lease: () => LifecycleLease,
    readonly notify: (jobId: string) => void,
    readonly fault: (error: unknown) => void,
    readonly clock: Clock = systemClock,
  ) { this.#timers = new TimerSet(clock); }
  start(
    jobId: string,
    currentAuthority: (request: JobRequest) => boolean,
    produce: (request: JobRequest, context: JobRunContext) => Promise<JobResult>,
  ): Promise<JobOutcome> {
    if (this.#disposed || this.#running.has(jobId)) return Promise.resolve('blocked');
    // 在任何可重入的准入回调前预占；取消/卸载都不能代替producer真正退出。
    const release = reserveProducer(this.store, jobId);
    if (!release) return Promise.resolve('blocked');
    let lease: LifecycleLease, claim: JobClaim | undefined;
    try {
      lease = this.lease(); lease.assertCurrent();
      claim = this.store.claimJob(jobId, this.clock.now(), request => {
        // 健康摘要自身有读取事务；认领内仍核身份，容量在认领前与producer前复核。
        if (lease.assertCurrentInTransaction) lease.assertCurrentInTransaction(); else lease.assertCurrent();
        return currentAuthority(request);
      });
      if (!claim) { release(); return Promise.resolve('blocked'); }
    } catch (error) { release(); throw error; }
    const abort = new AbortController();
    const deadline = this.clock.now() + Math.min(LIMITS.jobTimeoutMs, claim.request.budget.deadlineMs);
    let finish!: (outcome: JobOutcome) => void;
    const outcome = new Promise<JobOutcome>(resolve => { finish = resolve; });
    const run: Running = { claim, abort, deadline, finish, settled: false,
      cancelTimer: () => {}, removeAbort: () => {} };
    this.#running.set(jobId, run);
    const cancelFromLease = () => this.#cancel(run, 'cancelled', '生命周期准入已失效');
    lease.signal.addEventListener('abort', cancelFromLease, { once: true });
    run.removeAbort = () => lease.signal.removeEventListener('abort', cancelFromLease);
    run.cancelTimer = this.#timers.after(Math.max(0, deadline - this.clock.now()), () => this.#cancel(run, 'timeout', '内部计算超过期限'));
    let work: Promise<JobResult>;
    try {
      lease.assertCurrent(); abort.signal.throwIfAborted();
      work = Promise.resolve(produce(claim.request, { signal: abort.signal, deadline }));
    } catch (error) { work = Promise.reject(error); }
    const pending = work.then(result => {
      // 每个 await 后重核依赖/政策；取消后的晚到结果仍以原 claim 留回执。
      if (!run.settled) {
        try {
          lease.assertCurrent();
          if (!currentAuthority(claim.request)) throw Error('CURRENT_AUTHORITY_REQUIRED');
        } catch { this.#cancel(run, 'cancelled', '完成前授权已失效'); }
      }
      const current = this.store.completeJob(claim, result, this.clock.now());
      if (!run.settled && current) {
        try { lease.assertCurrent(); this.notify(jobId); }
        catch (error) { this.fault(error); }
      }
      this.#finish(run, current ? 'completed' : 'retained_stale');
    }, error => {
      const current = this.store.failJob(claim, String(error));
      this.#finish(run, current ? 'failed' : 'retained_stale');
    }).catch(error => {
      this.fault(error);
      try { this.store.cancelJob(jobId, claim.cancelGeneration, '结果持久化失败，保留取消状态'); }
      catch (cancelError) { this.fault(cancelError); }
      this.#finish(run, 'retained_stale');
    }).finally(release);
    void pending; return outcome;
  }
  #finish(run: Running, outcome: JobOutcome): void {
    if (run.settled) return;
    run.settled = true; run.cancelTimer(); run.removeAbort();
    if (this.#running.get(run.claim.jobId) === run) this.#running.delete(run.claim.jobId);
    run.finish(outcome);
  }
  #cancel(run: Running, outcome: 'cancelled' | 'timeout', reason: string): void {
    if (run.settled) return;
    run.abort.abort(new Error(reason));
    try { this.store.cancelJob(run.claim.jobId, run.claim.cancelGeneration, reason); }
    catch (error) { this.fault(error); }
    finally { this.#finish(run, outcome); }
  }
  cancel(jobId: string, reason: string): boolean {
    const run = this.#running.get(jobId); if (!run) return false;
    this.#cancel(run, 'cancelled', reason); return true;
  }
  cancelAll(reason: string): void { for (const run of this.#running.values()) this.#cancel(run, 'cancelled', reason); }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.cancelAll('插件停用'); this.#timers.clear(); }
  handles(): { running: number; timers: number; pendingResults: number } {
    return { running: this.#running.size, timers: this.#timers.size, pendingResults: occupancy.get(deploymentKey(this.store))?.size ?? 0 };
  }
}
