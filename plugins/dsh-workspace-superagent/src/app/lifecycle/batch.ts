import { LIMITS } from '../../storage/types.js';
import { TimerSet, systemClock, type Clock } from './clock.js';
import type { LifecycleLease } from './coordinator.js';
/** 仅合并“已有持久项可读”的唤醒信号，不保存候选或消费队列。 */
export class BatchWindow {
  readonly #timers: TimerSet;
  #cancel?: () => void;
  #disposed = false;
  constructor(readonly lease: () => LifecycleLease, readonly wake: (lease: LifecycleLease) => void,
    readonly clock: Clock = systemClock) { this.#timers = new TimerSet(clock); }
  request(control = false): void {
    if (this.#disposed) throw Error('DISPOSED');
    const lease = this.lease(); lease.assertCurrent();
    if (control) { this.clear(); this.wake(lease); return; }
    if (this.#cancel) return;
    this.#cancel = this.#timers.after(LIMITS.batchWaitMs, () => {
      this.#cancel = undefined; lease.assertCurrent(); this.wake(lease);
    });
  }
  clear(): void { this.#cancel?.(); this.#cancel = undefined; this.#timers.clear(); }
  dispose(): void { this.#disposed = true; this.clear(); }
  handles(): number { return this.#timers.size; }
}
