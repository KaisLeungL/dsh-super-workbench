/**
 * The board's own agent tool and the new-card defaults: `task_board_create` is
 * the caller that opts in, so a card a model creates from a conversation starts
 * from the same configured targets the GUI dialog offers — while a tool call
 * that passes its own values still keeps them.
 *
 * The cases drive the real ledger through the real tool definition, so what
 * they observe is the shipped tool surface rather than a re-implementation.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { buildTaskBoardTools } from '../src/host/agent-tools.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'
import type { CardDefaults } from '../src/core/card-defaults.ts'
import type { TaskRecord } from '../src/core/tasks.ts'

const roots: string[] = []
const NOW = new Date(2026, 7, 16, 10, 0, 30).getTime()
const services: TaskBoardHostService[] = []

afterEach(() => {
  for (const service of services.splice(0)) service.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A gateway double the service builds but never uses here: no card is run. */
function idleGateway(): TypertGateway {
  return {
    invoke: async () => ({ items: [] }),
    stream: async () => ({ async *[Symbol.asyncIterator]() {} }),
  } as unknown as TypertGateway
}

/**
 * Bind every board tool to a real ledger that reads the given defaults live.
 * @param defaults - the deployment's configured new-card defaults.
 * @returns the tool definitions and the ledger behind them.
 */
function harness(defaults: CardDefaults): { tools: ToolDefinition[]; ledger: HostTaskLedger } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-card-defaults-tool-'))
  roots.push(root)
  const ledger = new HostTaskLedger(root, () => NOW, { cardDefaults: () => defaults })
  const host = new TaskBoardHostService(idleGateway(), { ledger, power: new PowerInhibitor({ platform: 'linux' }), now: () => NOW })
  services.push(host)
  return { tools: buildTaskBoardTools(host), ledger }
}

/** Run one board tool by name (defineTool validates the arguments first). */
async function call(tools: ToolDefinition[], name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tool = tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error('unknown tool ' + name)
  return await tool.execute(args, {} as never) as Record<string, unknown>
}

/** The card one create call answered with, or a failure when it did not report one. */
function createdCard(result: Record<string, unknown>): TaskRecord {
  const task = result.task as TaskRecord | undefined
  if (task === undefined) throw new Error('the tool reported no task: ' + JSON.stringify(result))
  return task
}

describe('the agent create tool and the new-card defaults', () => {
  it('user asking a model to create a card sees the configured defaults filled in', async () => {
    // Given a board whose settings configure one preset, permission, model and level
    const live = harness({ mode: 'preset-team', permission: 'workspace-write', model: 'acme/reasoner', reasoningEffort: 'high' })

    // When the model creates a card without naming any execution target
    const result = await call(live.tools, 'task_board_create', { title: 'From a conversation' })

    // Then the card starts from all four configured defaults
    expect(createdCard(result)).toMatchObject({
      mode: 'preset-team',
      permission: 'workspace-write',
      model: 'acme/reasoner',
      reasoningEffort: 'high',
    })
  })

  it('user asking a model to create a card with its own targets keeps every one of them', async () => {
    // Given the same configured board
    const live = harness({ mode: 'preset-team', permission: 'workspace-write', model: 'acme/reasoner', reasoningEffort: 'high' })

    // When the model names its own preset, binding and model
    const result = await call(live.tools, 'task_board_create', {
      title: 'Pinned by the model',
      mode: 'preset-mine',
      permission: 'read-only',
      model: 'acme/mine',
    })

    // Then none of them is overwritten, and the caller's own model borrows no level
    const task = createdCard(result)
    expect(task).toMatchObject({ mode: 'preset-mine', permission: 'read-only', model: 'acme/mine' })
    expect('reasoningEffort' in task).toBe(false)
  })

  it('user asking a model to create a subtask sees the parent binding left out of it', async () => {
    // Given a parent pinned above the session baseline and a board with a default binding
    const live = harness({ permission: 'workspace-write' })
    const parent = await call(live.tools, 'task_board_create', { title: 'Parent', permission: 'danger-full-access' })

    // When the model creates a subtask of it without naming a binding
    const result = await call(live.tools, 'task_board_create', { title: 'Child', parentId: createdCard(parent).id })

    // Then the subtask takes the configured default, never the parent's binding
    expect(createdCard(result).permission).toBe('workspace-write')
  })

  it('user asking a model to create a card on a board that configures nothing sees an unpinned card', async () => {
    // Given a board that configures no new-card default at all
    const live = harness({})

    // When the model creates a card without naming any execution target
    const task = createdCard(await call(live.tools, 'task_board_create', { title: 'Plain' }))

    // Then the card pins nothing, exactly as it did before the settings existed
    expect(['mode', 'permission', 'model', 'reasoningEffort'].filter(key => key in task)).toEqual([])
  })
})
