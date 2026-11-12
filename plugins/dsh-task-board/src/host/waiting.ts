/** Read-only observation of official Host waterfalls; never answers either request. */
export interface WaitingEventBus {
  on(name: 'approval/request', listener: (request: { agent: { id: string }; reason?: string; toolName: string }, next: () => Promise<unknown>) => Promise<unknown>, options: { prepend: true; global: true }): (() => unknown) | undefined
  on(name: 'user-questions/request', listener: (request: { agent?: { id: string }; questions: readonly { question: string }[] }, next: () => Promise<unknown>) => Promise<unknown>, options: { prepend: true; global: true }): (() => unknown) | undefined
}
export interface WaitingObserver {
  observeWaiting(sessionId: string, kind: 'user' | 'permission', reason?: string): () => void
}
export function installWaitingObservers(bus: WaitingEventBus, host: WaitingObserver): () => void {
  const observe = async (sessionId: string | undefined, kind: 'user' | 'permission', reason: string | undefined, next: () => Promise<unknown>): Promise<unknown> => {
    // Reporting a wait must never change an approval or question's result.
    let finish: (() => void) | undefined
    try { if (sessionId !== undefined) finish = host.observeWaiting(sessionId, kind, reason?.slice(0, 1000)) } catch { /* The original waterfall remains authoritative. */ }
    try { return await next() } finally {
      try { finish?.() } catch { /* A closing Host cannot veto the answer. */ }
    }
  }
  const permission = bus.on('approval/request', (request, next) => observe(request.agent.id, 'permission', request.reason ?? request.toolName, next), { prepend: true, global: true })
  const question = bus.on('user-questions/request', (request, next) => observe(request.agent?.id, 'user', request.questions.map(item => item.question).join('; '), next), { prepend: true, global: true })
  return () => { permission?.(); question?.() }
}
