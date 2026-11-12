/**
 * The new-card defaults as the deployment sees them: the four volatile config
 * keys, the read-only snapshot the create dialog prefills from, and the live
 * path a settings edit takes to the next card created through the Host.
 *
 * The last three cases mount the real host half into a capture-only context and
 * drive its HTTP surface over loopback, so what they observe is the shipped
 * activation — schema, reader, snapshot and create path together — rather than a
 * re-implementation of it.
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Config, apply, readConfigField } from '../src/index.ts'
import type { TaskRecord } from '../src/core/tasks.ts'

/** The write protocol a volatile reference shares across cosmokit copies. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** The four new-card default keys the settings card edits. */
type CardDefaultField = 'cardDefaultMode' | 'cardDefaultPermission' | 'cardDefaultModel' | 'cardDefaultReasoningEffort'

/** The snapshot subset the cases below read. */
interface BoardState {
  tasks?: TaskRecord[]
  cardDefaults?: { mode?: string; permission?: string; model?: string; reasoningEffort?: string }
}

/** One mounted activation under test. */
interface MountedBoard {
  /** Replace one volatile config value in the running activation, as the Loader does. */
  commit(field: CardDefaultField, value: string): void
  /** GET the snapshot the browser mirrors. */
  state(): Promise<BoardState>
  /** POST one action envelope to the mounted surface. */
  action(envelope: { requestId: string; action: Record<string, unknown> }): Promise<{ status: number; body: BoardState & { error?: string } }>
  /** Tear the activation and its HTTP surface down. */
  dispose(): Promise<void>
}

/** A session-list gateway double: the board's poll reads an empty roster through it. */
function emptyRosterGateway(): TypertGateway {
  return {
    invoke: async () => ({ items: [] }),
    stream: async () => ({ async *[Symbol.asyncIterator]() {} }),
  } as unknown as TypertGateway
}

/**
 * Mount the board's host half into a capture-only context and serve its routes.
 * @param config - the parsed row config the Host hands the activation.
 * @returns the mounted activation's observation surface.
 */
async function mountBoard(config: ReturnType<typeof Config>): Promise<MountedBoard> {
  const routes: WebRoute[] = []
  const disposers: Array<() => void> = []
  let volatileListener: (() => void) | undefined
  const ctx = {
    get: () => undefined,
    typertGateway: emptyRosterGateway(),
    workspaceRegistry: {},
    agents: { get: () => undefined },
    commands: { execute: async () => undefined },
    systemPrompt: { section: () => () => {} },
    webServer: {
      register: (route: WebRoute) => {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    effect: (body: () => unknown) => {
      const dispose = body()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    },
    on: (name: string, listener: () => void) => {
      if (name === 'loader/volatile-update') volatileListener = listener
    },
  }
  apply(ctx as never, config)

  const server: Server = createServer((incoming, response) => {
    const route = routes.find(candidate => candidate.path === new URL(incoming.url ?? '/', 'http://local').pathname)
    if (route === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    void route.handler(incoming, response)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind')
  const base = `http://127.0.0.1:${address.port}`

  return {
    commit: (field, value) => {
      const ref = config[field] as unknown as Record<symbol, (next: unknown) => void>
      ref[VOLATILE_WRITE](value)
      volatileListener?.()
    },
    state: async () => {
      const response = await fetch(`${base}/api/task-board/state`, { headers: { 'sec-fetch-site': 'same-origin' } })
      return await response.json() as BoardState
    },
    action: async (envelope) => {
      const response = await fetch(`${base}/api/task-board/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ ...envelope, schemaVersion: 8, capabilities: ['planning.v1', 'human-review.v1', 'inspection-control.v1'] }),
      })
      return { status: response.status, body: await response.json() as BoardState & { error?: string } }
    },
    dispose: async () => {
      for (const dispose of disposers.reverse()) dispose()
      disposers.length = 0
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    },
  }
}

/** One create action, opting into the new-card defaults when asked. */
function createAction(requestId: string, applyCardDefaults?: boolean): { requestId: string; action: Record<string, unknown> } {
  return {
    requestId,
    action: {
      kind: 'create',
      id: requestId,
      input: {
        title: 'Board task',
        description: '',
        prompt: 'work',
        ...(applyCardDefaults === undefined ? {} : { applyCardDefaults }),
      },
    },
  }
}

/** The one card named `id` in a snapshot, or a failure when it is absent. */
function cardOf(state: BoardState, id: string): TaskRecord {
  const task = state.tasks?.find(candidate => candidate.id === id)
  if (task === undefined) throw new Error('no card ' + id)
  return task
}

/** The schema node one Config field declares, as the Host reads it for its settings page. */
function configField(field: string): { meta?: { volatile?: boolean } } | undefined {
  const dict: Record<string, { meta?: { volatile?: boolean } }> = Config.dict ?? {}
  return dict[field]
}

const mounted: MountedBoard[] = []
let previousHome: string | undefined
let scratchHome: string | undefined

beforeEach(() => {
  // The activation builds a disk-backed ledger: keep every case off the user's real DSH home.
  previousHome = process.env.DSH_HOME
  scratchHome = mkdtempSync(join(tmpdir(), 'dsh-task-board-card-defaults-config-'))
  process.env.DSH_HOME = scratchHome
})

afterEach(async () => {
  for (const board of mounted.splice(0)) await board.dispose()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (scratchHome !== undefined) rmSync(scratchHome, { recursive: true, force: true })
  scratchHome = undefined
})

describe('the new-card default settings keys', () => {
  it('operator opening the settings card sees all four keys unset by default', () => {
    // Given a row the Host hands without any new-card default configured
    const value = Config({})

    // When the four keys are read the way the plugin reads them
    // Then every one of them resolves to blank, which pins nothing
    expect(readConfigField(value.cardDefaultMode, 'x')).toBe('')
    expect(readConfigField(value.cardDefaultPermission, 'x')).toBe('')
    expect(readConfigField(value.cardDefaultModel, 'x')).toBe('')
    expect(readConfigField(value.cardDefaultReasoningEffort, 'x')).toBe('')
  })

  it('operator saving a value sees it stored as configured', () => {
    // Given a row that configures one preset, the highest permission, a model and a level
    const value = Config({
      cardDefaultMode: 'preset-team',
      cardDefaultPermission: 'danger-full-access',
      cardDefaultModel: 'acme/reasoner',
      cardDefaultReasoningEffort: 'high',
    })

    // When the four keys are read back
    // Then each one carries what was configured
    expect(readConfigField(value.cardDefaultMode, '')).toBe('preset-team')
    expect(readConfigField(value.cardDefaultPermission, '')).toBe('danger-full-access')
    expect(readConfigField(value.cardDefaultModel, '')).toBe('acme/reasoner')
    expect(readConfigField(value.cardDefaultReasoningEffort, '')).toBe('high')
  })

  it('admin sees all four keys served as live-editable settings', () => {
    // Given the Config schema the Host serves as this entry's settings page
    // When each new-card key's schema node is read
    // Then every one of them is volatile, which is what a settings write is fenced on
    for (const field of ['cardDefaultMode', 'cardDefaultPermission', 'cardDefaultModel', 'cardDefaultReasoningEffort']) {
      expect(configField(field)?.meta?.volatile, field).toBe(true)
    }
  })

  it('operator typing a permission outside the three presets is refused by the schema', () => {
    // Given a row whose default permission is not one of the board's permissions
    // When the schema resolves it
    // Then the value is refused instead of being stored as a binding no run can use
    expect(() => Config({ cardDefaultPermission: 'yolo' as never })).toThrow()
  })
})

describe('the new-card defaults a mounted board publishes', () => {
  it('user reading the snapshot of an unconfigured board sees no default section at all', async () => {
    // Given a mounted board that configures none of the four keys
    const board = await mountBoard(Config({ enabled: true }))
    mounted.push(board)

    // When the browser reads the snapshot
    const state = await board.state()

    // Then the section is omitted rather than published as four blank values
    expect('cardDefaults' in state).toBe(false)
  })

  it('user reading the snapshot of a configured board sees exactly the configured keys', async () => {
    // Given a mounted board configuring a preset and a model only
    const board = await mountBoard(Config({ enabled: true, cardDefaultMode: 'preset-team', cardDefaultModel: 'acme/reasoner' }))
    mounted.push(board)

    // When the browser reads the snapshot
    const state = await board.state()

    // Then the configured targets are published and the unset ones stay omitted
    expect(state.cardDefaults).toEqual({ mode: 'preset-team', model: 'acme/reasoner' })
  })
})

describe('the new-card defaults a mounted board applies', () => {
  it('user creating a card through the opted-in action sees the configured defaults filled in', async () => {
    // Given a mounted board configuring all four keys
    const board = await mountBoard(Config({
      enabled: true,
      cardDefaultMode: 'preset-team',
      cardDefaultPermission: 'workspace-write',
      cardDefaultModel: 'acme/reasoner',
      cardDefaultReasoningEffort: 'high',
    }))
    mounted.push(board)

    // When the caller creates a card that opts in and omits every target
    const created = await board.action(createAction('task-opts-in', true))

    // Then the resulting snapshot carries a card pinned to all four
    expect(created.status).toBe(200)
    expect(cardOf(created.body, 'task-opts-in')).toMatchObject({
      mode: 'preset-team',
      permission: 'workspace-write',
      model: 'acme/reasoner',
      reasoningEffort: 'high',
    })
  })

  it('user creating a card without the flag sees the configured defaults leave it untouched', async () => {
    // Given the same configured board
    const board = await mountBoard(Config({
      enabled: true,
      cardDefaultMode: 'preset-team',
      cardDefaultPermission: 'workspace-write',
      cardDefaultModel: 'acme/reasoner',
      cardDefaultReasoningEffort: 'high',
    }))
    mounted.push(board)

    // When the caller creates a card without opting in
    const created = await board.action(createAction('task-plain'))
    const card = cardOf(created.body, 'task-plain')

    // Then the card pins nothing at all, exactly as before the keys existed
    expect(['mode', 'permission', 'model', 'reasoningEffort'].filter(key => key in card)).toEqual([])
  })

  it('operator editing a default while the board runs sees the next created card adopt it with no restart', async () => {
    // Given a mounted board whose new-card model the operator has not configured yet
    const board = await mountBoard(Config({ enabled: true, cardDefaultModel: 'acme/one' }))
    mounted.push(board)
    const first = await board.action(createAction('task-one', true))

    // When the operator commits a different model into the running activation
    board.commit('cardDefaultModel', 'acme/two')
    const second = await board.action(createAction('task-two', true))

    // Then the first card kept what was configured when it was created, the
    // second adopted the edit, and the published snapshot follows it
    expect(cardOf(first.body, 'task-one').model).toBe('acme/one')
    expect(cardOf(second.body, 'task-two').model).toBe('acme/two')
    expect((await board.state()).cardDefaults).toEqual({ model: 'acme/two' })
  })
})
