import { describe, expect, it, vi } from 'vitest'
import { installWaitingObservers, type WaitingEventBus } from '../src/host/waiting.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'

describe('Host interaction observations', () => {
  it('operator sees official waiting lifetimes without changing the original answers or errors', async () => {
    // Given a Host listener bus and a passive waiting observer.
    const handlers = new Map<string, (request: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
    const off = vi.fn()
    const on = vi.fn((name, handler, _options: { prepend: true; global: true }) => { handlers.set(name, handler); return off })
    const finish = vi.fn()
    const host = { observeWaiting: vi.fn(() => finish) }
    const dispose = installWaitingObservers({ on } as WaitingEventBus, host)
    // When the approval chain answers and the question chain rejects.
    const answer = await handlers.get('approval/request')!({ agent: { id: 'session' }, toolName: 'edit', reason: 'needs approval' }, async () => 'allowed-once')
    expect(answer).toBe('allowed-once')
    expect(host.observeWaiting).toHaveBeenCalledWith('session', 'permission', 'needs approval')
    expect(finish).toHaveBeenCalledOnce()
    await expect(handlers.get('user-questions/request')!({ agent: { id: 'session' }, questions: [{ question: 'which?' }] }, async () => { throw new Error('original') })).rejects.toThrow('original')
    // Then the observer clears both waits and never owns an answer.
    expect(finish).toHaveBeenCalledTimes(2)
    expect(on.mock.calls.every(call => call[2].prepend === true && call[2].global === true)).toBe(true)
    dispose()
    expect(off).toHaveBeenCalledTimes(2)
  })

  it('operator retains an open execution during nested waits and ignores late completion callbacks', () => {
    // Given one real isolated ledger with an attached execution.
    const root = mkdtempSync(join(tmpdir(), 'dsh-waiting-test-'))
    const ledger = new HostTaskLedger(root, () => 1000)
    const service = new TaskBoardHostService({ invoke: vi.fn(), stream: vi.fn() } as unknown as TypertGateway, { ledger, now: () => 1000 })
    try {
      ledger.applyRequest('create', { kind: 'create', id: 'task', input: { title: 't', description: '', prompt: '' } })
      const execution = ledger.applyRequest('run', { kind: 'run', taskId: 'task' }).runs![0]!.execution
      ledger.attachSession('task', execution.id, 'session')
      // When nested official waits begin and one of them finishes.
      const questionDone = service.observeWaiting('session', 'user', 'question')
      const approvalDone = service.observeWaiting('session', 'permission', 'permission')
      questionDone()
      expect(ledger.getTask('task')).toMatchObject({ status: 'needs_input', waiting: { kind: 'permission', executionId: execution.id } })
      expect(ledger.getTask('task')?.executions[0]?.endedAt).toBeUndefined()
      expect(() => ledger.applyRequest('move', { kind: 'move', taskId: 'task', status: 'todo' })).toThrow(/running task/)
      // When the execution closes before a late waterfall finally callback.
      ledger.settle('task', execution.id, 'cancelled')
      approvalDone()
      // Then the late callback cannot put the settled task back into running.
      expect(ledger.getTask('task')?.status).toBe('todo')
      expect(ledger.getTask('task')?.waiting).toBeUndefined()
      expect(ledger.getTask('task')?.timeline?.some(event => event.kind === 'waiting-started')).toBe(true)
    } finally {
      service.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
