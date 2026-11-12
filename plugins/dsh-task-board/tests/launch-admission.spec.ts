/**
 * The admission queue on its own: the order it admits launches in, the width it
 * reads live, and what it does with the launches still waiting when it is torn
 * down. Ordering is the part the run-level tests cannot pin down on their own —
 * there a whole subtree is one group, so every member simply goes in order.
 */
import { describe, expect, it } from 'vitest'
import { LaunchAdmissionQueue, type QueuedLaunch } from '../src/host/launch-admission.ts'

/** Let the queue's admission microtasks run. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

/**
 * A queue plus the launches handed to it: every started launch is recorded and
 * held open until the test releases it, and every abandoned one is recorded.
 */
function harness(width: number | (() => number)) {
  const started: string[] = []
  const abandoned: string[] = []
  const released = new Map<string, () => void>()
  const queue = new LaunchAdmissionQueue(typeof width === 'function' ? width : () => width)
  const entry = (groupId: string, label: string, options: { reject?: boolean } = {}): QueuedLaunch => ({
    groupId,
    start: () => {
      started.push(label)
      if (options.reject === true) return Promise.reject(new Error('boom'))
      return new Promise<void>(resolve => { released.set(label, resolve) })
    },
    abandon: () => { abandoned.push(label) },
  })
  return {
    queue,
    started,
    abandoned,
    enqueue: (groupId: string, label: string, options?: { reject?: boolean }) => { queue.enqueue(entry(groupId, label, options)) },
    release(label: string): void {
      released.get(label)?.()
      released.delete(label)
    },
  }
}

describe('launch admission queue', () => {
  it('operator sees the queue admit at most the width and fill free slots in arrival order', async () => {
    // Given a width of two and one group with three launches
    const bench = harness(2)

    // When they arrive
    bench.enqueue('a', 'a0')
    bench.enqueue('a', 'a1')
    bench.enqueue('a', 'a2')
    await flush()

    // Then the first two hold the slots and the third waits its turn
    expect(bench.started).toEqual(['a0', 'a1'])
    expect(bench.queue.inFlightCount).toBe(2)
    expect(bench.queue.pendingCount).toBe(1)
    expect(bench.queue.peakInFlight).toBe(2)

    // When one slot frees
    bench.release('a0')
    await flush()

    // Then exactly the waiting launch takes it
    expect(bench.started).toEqual(['a0', 'a1', 'a2'])
    expect(bench.queue.peakInFlight).toBe(2)
  })

  it('operator sees every run group get a turn instead of one group draining first', async () => {
    // Given a width of two, a large group and a small one that arrives after it
    const bench = harness(2)
    for (let index = 0; index < 41; index += 1) bench.enqueue('big', `big-${index}`)
    bench.enqueue('small', 'small-0')
    await flush()
    expect(bench.started).toEqual(['big-0', 'big-1'])

    // When each admitted launch settles
    for (let round = 0; round < 4; round += 1) {
      bench.release(bench.started.at(-1) ?? '')
      bench.release(bench.started.at(-2) ?? '')
      await flush()
    }

    // Then the small group is admitted within a bounded number of admissions,
    // and never starves behind the large group's remaining members
    expect(bench.started.indexOf('small-0')).toBeLessThanOrEqual(4)
    expect(bench.started).toContain('big-2')
  })

  it('operator sees a launch that rejects free its slot so the queue keeps moving', async () => {
    // Given a width of one whose first launch rejects outright
    const bench = harness(1)
    bench.enqueue('a', 'a0', { reject: true })
    bench.enqueue('a', 'a1')

    // When the queue runs that rejection through
    await flush()

    // Then the rejection released its slot and the next launch was admitted
    expect(bench.started).toEqual(['a0', 'a1'])
    expect(bench.queue.inFlightCount).toBe(1)
  })

  it('operator sees a raised width admit the waiting launches sooner', async () => {
    // Given a width of one with two launches waiting
    let width = 1
    const bench = harness(() => width)
    bench.enqueue('a', 'a0')
    bench.enqueue('a', 'a1')
    bench.enqueue('a', 'a2')
    bench.enqueue('a', 'a3')
    await flush()
    expect(bench.started).toEqual(['a0'])

    // When the width is raised while launches are still waiting
    width = 3
    bench.release('a0')
    await flush()

    // Then the new width bounds what had not been admitted yet
    expect(bench.started).toEqual(['a0', 'a1', 'a2', 'a3'])
    expect(bench.queue.peakInFlight).toBe(3)
  })

  it('operator sees only the launches that never started abandoned when the queue is torn down', async () => {
    // Given a width of two with one launch in flight and three waiting
    const bench = harness(2)
    bench.enqueue('a', 'a0')
    bench.enqueue('b', 'b0')
    bench.enqueue('a', 'a1')
    bench.enqueue('b', 'b1')
    await flush()
    expect(bench.started).toEqual(['a0', 'b0'])

    // When the queue is torn down
    const abandoned = bench.queue.drain()

    // Then every waiting launch is abandoned in arrival order, the in-flight
    // ones are left alone, and the queue holds nothing afterwards
    expect(abandoned.map(launch => launch.groupId)).toEqual(['a', 'b'])
    expect(bench.abandoned).toEqual(['a1', 'b1'])
    expect(bench.queue.pendingCount).toBe(0)
    expect(bench.queue.inFlightCount).toBe(2)
    expect(bench.started).toEqual(['a0', 'b0'])
  })
})
