import type { StewardStore } from '../../storage/store.js';
import { LIMITS } from '../../storage/types.js';
import { TimerSet, systemClock, type Clock } from './clock.js';
import type { LifecycleLease } from './coordinator.js';

export interface EvalState {
  id: string; revision: number; state: string; attempt: number;
  control: boolean; queuedAt: number; deadline: number | null; remainingMs: number;
  deadlineBasis: string | null; threadKeys: readonly string[];
}
export interface EvalScan {
  readHealthSummary(now: number): { evals: { active: readonly EvalState[]; truncated: boolean } };
}
/** 只控制已持久化的指定 Eval；不解析意图，不投递模型，不自动重试 unknown。 */
export class EvalDeadlines {
  readonly #timers: TimerSet;
  #paused = true;
  #disposed = false;
  constructor(
    readonly store: Pick<StewardStore, 'evalState' | 'pauseEval' | 'resumeEval' | 'expireEval' | 'beginEval' | 'recordEvalDelivery'> & EvalScan,
    readonly lease: () => LifecycleLease,
    readonly fault: (error: unknown) => void,
    readonly clock: Clock = systemClock,
  ) { this.#timers = new TimerSet(clock); }
  begin(id: string, revision: number): boolean {
    if (this.#paused || this.#disposed) return false;
    const lease = this.lease(); lease.assertCurrent();
    return this.store.beginEval(id, revision, this.clock.now());
  }
  /** 只有已验证的原生投递回执能启动60秒时限；接纳未知不得调此入口。 */
  delivered(id: string, revision: number, receipt: { nativeLogRef: string; deliveredAt: number; basis: 'native-log' }): void {
    if (this.#disposed) throw Error('DISPOSED');
    const lease = this.lease(); lease.assertCurrent();
    this.store.recordEvalDelivery(id, revision, receipt);
    this.refresh();
  }
  #active(): readonly EvalState[] {
    const summary = this.store.readHealthSummary(this.clock.now());
    if (summary.evals.truncated) throw Error('EVAL_SCAN_TRUNCATED');
    return summary.evals.active;
  }
  pause(): void {
    this.#paused = true; this.#timers.clear();
    for (const evaluation of this.#active()) {
      if (['queued', 'dispatching', 'delivered'].includes(evaluation.state)) {
        this.store.pauseEval(evaluation.id, evaluation.revision, this.clock.now());
      }
    }
  }
  resume(): void {
    if (this.#disposed) throw Error('DISPOSED');
    this.lease().assertCurrent();
    for (const evaluation of this.#active()) {
      if (evaluation.state === 'paused') this.store.resumeEval(evaluation.id, evaluation.revision, this.clock.now());
    }
    this.#paused = false; this.refresh();
  }
  refresh(): void {
    this.#timers.clear();
    if (this.#paused || this.#disposed) return;
    const lease = this.lease(); lease.assertCurrent();
    const active = this.#active().filter(e => e.state === 'delivered' && e.deadline !== null);
    for (const evaluation of active) {
      this.#timers.after(Math.max(0, evaluation.deadline! - this.clock.now()), () => {
        try {
          lease.assertCurrent();
          const current = this.store.evalState(evaluation.id);
          if (current?.state === 'delivered' && current.revision === evaluation.revision) {
            this.store.expireEval(evaluation.id, evaluation.revision, this.clock.now());
          }
        } catch (error) { this.fault(error); }
      });
    }
  }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#paused = true; this.#timers.clear(); }
  handles(): number { return this.#timers.size; }
}

/** 元数据选择器，不消费队列。控制优先；普通项按Thread轮转，临近最大年龄的项先选。 */
export function selectEvalBatch(
  evaluations: readonly EvalState[], now: number, afterThread?: string,
): readonly EvalState[] {
  const queued = evaluations.filter(e => ['queued', 'retry_wait'].includes(e.state));
  const order = (a: EvalState, b: EvalState) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id);
  const control = queued.filter(e => e.control).sort(order);
  const ordinary = queued.filter(e => !e.control);
  const aged = ordinary.filter(e => now - e.queuedAt >= LIMITS.queueAgeMs - LIMITS.evalTimeoutMs).sort(order);
  const selected = [...control, ...aged].slice(0, LIMITS.batchItems);
  const chosen = new Set(selected.map(e => e.id));
  const threads = [...new Set(ordinary.filter(e => !chosen.has(e.id)).map(e => e.threadKeys[0] ?? e.id))].sort();
  const pivot = afterThread === undefined ? -1 : threads.indexOf(afterThread);
  const rotated = pivot < 0 ? threads : [...threads.slice(pivot + 1), ...threads.slice(0, pivot + 1)];
  const groups = rotated.map(thread => ordinary.filter(e => !chosen.has(e.id) && (e.threadKeys[0] ?? e.id) === thread).sort(order));
  while (selected.length < LIMITS.batchItems && groups.some(group => group.length)) {
    for (const group of groups) {
      const item = group.shift(); if (item) selected.push(item);
      if (selected.length === LIMITS.batchItems) break;
    }
  }
  return selected;
}
