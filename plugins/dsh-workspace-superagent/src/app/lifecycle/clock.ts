export interface Clock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
export const systemClock: Clock = {
  now: Date.now,
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, Math.max(0, delayMs));
    return () => clearTimeout(timer);
  },
};
/** 只管理本模块的计时器；取消后回调不再取得执行权。 */
export class TimerSet {
  readonly #timers = new Set<() => void>();
  constructor(readonly clock: Clock) {}
  after(delayMs: number, callback: () => void): () => void {
    let active = true;
    const cancelNative = this.clock.schedule(() => {
      if (!active) return;
      active = false; this.#timers.delete(cancel); callback();
    }, delayMs);
    const cancel = () => {
      if (!active) return;
      active = false; cancelNative(); this.#timers.delete(cancel);
    };
    this.#timers.add(cancel); return cancel;
  }
  clear(): void { for (const cancel of this.#timers) cancel(); }
  get size(): number { return this.#timers.size; }
}
