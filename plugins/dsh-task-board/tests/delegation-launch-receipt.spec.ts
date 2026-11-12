/**
 * Durable Router delegation receipts at the Host ledger boundary: the accepted
 * receipt is committed with the execution it names, a retry answers the same
 * receipt instead of opening a second run, and a refusal is persisted as the
 * durable answer for that operation.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import type { TaskRecord } from '../src/core/tasks.ts'

const roots: string[] = []
const NOW = 1_700_000_000_000

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-delegation-'))
  roots.push(root)
  return root
}

function seedTask(ledger: HostTaskLedger, id: string, workspaceId?: string): void {
  ledger.applyRequest('seed-' + id, {
    kind: 'create',
    id,
    input: { title: id, description: '', prompt: id, ...(workspaceId === undefined ? {} : { workspaceId }) },
  })
}

function task(ledger: HostTaskLedger, id: string): TaskRecord | undefined {
  return ledger.state().tasks.find(entry => entry.id === id)
}

describe('delegation launch receipts', () => {
  it('accepts once and answers the same execution on retry', () => {
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    seedTask(ledger, 'root')

    const first = ledger.applyDelegationLaunch({ operationId: 'op-1', taskId: 'root', initiator: 'router-session' })
    expect(first.receipt.state).toBe('accepted')
    if (first.receipt.state !== 'accepted') throw new Error('unreachable')
    const executionId = first.receipt.executionId
    expect(first.runs?.map(run => run.task.id)).toEqual(['root'])
    expect(task(ledger, 'root')?.executions.map(entry => entry.id)).toEqual([executionId])

    // A retry of the SAME operation answers the stored receipt and opens no run.
    const retry = ledger.applyDelegationLaunch({ operationId: 'op-1', taskId: 'root' })
    expect(retry.receipt).toEqual({ state: 'accepted', operationId: 'op-1', taskId: 'root', executionId })
    expect(retry.runs).toBeUndefined()
    expect(task(ledger, 'root')?.executions).toHaveLength(1)

    // The receipt survives a restart with the same execution id.
    ledger.dispose()
    const reloaded = new HostTaskLedger(root, () => NOW)
    expect(reloaded.readDelegationLaunch({ operationId: 'op-1', taskId: 'root' }))
      .toEqual({ state: 'accepted', operationId: 'op-1', taskId: 'root', executionId })
    reloaded.dispose()
  })

  it('persists a refusal without opening an execution, and retries answer it', () => {
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    seedTask(ledger, 'root')

    const accepted = ledger.applyDelegationLaunch({ operationId: 'op-a', taskId: 'root' })
    expect(accepted.receipt.state).toBe('accepted')

    // The card already has an open execution: a second operation is refused.
    const refused = ledger.applyDelegationLaunch({ operationId: 'op-b', taskId: 'root' })
    expect(refused.receipt.state).toBe('rejected')
    expect(task(ledger, 'root')?.executions).toHaveLength(1)

    ledger.dispose()
    const reloaded = new HostTaskLedger(root, () => NOW)
    const reread = reloaded.readDelegationLaunch({ operationId: 'op-b', taskId: 'root' })
    expect(reread.state).toBe('rejected')
    // The durable rejection is the answer; the retry never opens a second run.
    expect(reloaded.applyDelegationLaunch({ operationId: 'op-b', taskId: 'root' }).receipt.state).toBe('rejected')
    expect(reloaded.state().tasks.find(entry => entry.id === 'root')?.executions).toHaveLength(1)
    reloaded.dispose()
  })

  it('answers unknown for an operation it never saw', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    expect(ledger.readDelegationLaunch({ operationId: 'never', taskId: 'root' }))
      .toEqual({ state: 'unknown', operationId: 'never', taskId: 'root' })
    ledger.dispose()
  })

  it('refuses an operation id reused for a different card', () => {
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    seedTask(ledger, 'root')
    seedTask(ledger, 'other')
    ledger.applyDelegationLaunch({ operationId: 'op-1', taskId: 'root' })
    expect(() => ledger.applyDelegationLaunch({ operationId: 'op-1', taskId: 'other' })).toThrow(/different task/)
    ledger.dispose()
  })

  it('refuses a card from another workspace and records the refusal', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    seedTask(ledger, 'root', 'workspace-a')
    const result = ledger.applyDelegationLaunch({ operationId: 'op-w', taskId: 'root', workspaceId: 'workspace-b' })
    expect(result.receipt.state).toBe('rejected')
    if (result.receipt.state !== 'rejected') throw new Error('unreachable')
    expect(result.receipt.reason).toMatch(/another workspace/)
    expect(task(ledger, 'root')?.executions).toEqual([])
    ledger.dispose()
  })

  it('drops malformed receipts at load instead of trusting them', async () => {
    const { writeFileSync } = await import('node:fs')
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    seedTask(ledger, 'root')
    ledger.applyDelegationLaunch({ operationId: 'op-1', taskId: 'root' })
    ledger.dispose()

    const file = join(root, 'ledger-v2.json')
    const { readFileSync } = await import('node:fs')
    const document = JSON.parse(readFileSync(file, 'utf8')) as { launchReceipts: unknown[] }
    document.launchReceipts.push(
      { operationId: 'bad-1', taskId: 'root', state: 'accepted', at: NOW },
      { operationId: 'bad-2', taskId: 'root', state: 'rejected', at: NOW },
      { operationId: '', taskId: 'root', state: 'rejected', reason: 'x', at: NOW },
    )
    writeFileSync(file, JSON.stringify(document))

    const reloaded = new HostTaskLedger(root, () => NOW)
    expect(reloaded.readDelegationLaunch({ operationId: 'bad-1', taskId: 'root' }).state).toBe('unknown')
    expect(reloaded.readDelegationLaunch({ operationId: 'bad-2', taskId: 'root' }).state).toBe('unknown')
    expect(reloaded.readDelegationLaunch({ operationId: 'op-1', taskId: 'root' }).state).toBe('accepted')
    reloaded.dispose()
  })
})
