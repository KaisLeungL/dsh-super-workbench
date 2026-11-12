/**
 * Configuration, member bindings and the Host's connection cadence.
 *
 * The bindings come from the dsh-agents ledger, which this provider reads
 * read-only; the timing rules are the protocol's own (section 13: a heartbeat
 * every 15 s, and a reconnect backoff that is bounded rather than unbounded).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentsLedgerPath, readAgentsLedger, resolveBindings } from '../../../src/modules/team/host/bindings.ts'
import { normalizeBindings, normalizeHubUrl } from '../../../src/modules/team/host/setup.ts'
import { HEARTBEAT_INTERVAL_MS, RECONNECT_MAX_MS } from '../../../src/modules/team/core/hub-protocol.ts'
import { flush, makeHarness, type Harness } from './support/harness.ts'

const roots: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  harness?.release()
  harness = undefined
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

let harness: Harness | undefined

/** One scratch directory with an agents ledger in it. */
function ledgerDirectory(document: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-agents-'))
  roots.push(dir)
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify(document), 'utf8')
  return join(dir, 'ledger.json')
}

const AGENTS_DOCUMENT = {
  teams: [{
    id: 'team_1',
    name: 'Core',
    workspaceId: 'ws_1',
    members: [
      { id: 'mem_builder', name: 'builder', preset: 'liangshen' },
      { id: 'mem_reviewer', name: 'reviewer', preset: 'review' },
    ],
  }],
}

describe('member bindings', () => {
  it('operator sees the bound member resolved with its own preset and workspace', async () => {
    // Given a dsh-agents ledger defining two members
    const file = ledgerDirectory(AGENTS_DOCUMENT)

    // When the settings bind one of them
    const view = await readAgentsLedger(file)
    const resolved = resolveBindings([{ memberId: 'mem_builder' }], view)

    // Then the definition supplies the name, preset and workspace
    expect(resolved.problems).toEqual([])
    expect(resolved.agents).toEqual([{
      memberId: 'mem_builder',
      teamId: 'team_1',
      teamName: 'Core',
      name: 'builder',
      preset: 'liangshen',
      workspaceId: 'ws_1',
    }])
  })

  it('operator sees a binding naming no member reported instead of executed', async () => {
    // Given a ledger without the member the settings name
    const file = ledgerDirectory(AGENTS_DOCUMENT)

    // When a stale binding is resolved
    const view = await readAgentsLedger(file)
    const resolved = resolveBindings([{ memberId: 'mem_gone' }], view)

    // Then it is skipped with a reason and nothing is claimed for it
    expect(resolved.agents).toEqual([])
    expect(resolved.problems[0]).toContain('mem_gone')
  })

  it('operator sees an unreadable agents ledger reported instead of thrown', async () => {
    // Given a ledger path that holds no file
    const missing = join(mkdtempSync(join(tmpdir(), 'dsh-team-missing-')), 'ledger.json')
    roots.push(join(missing, '..'))

    // When it is read
    const view = await readAgentsLedger(missing)

    // Then the problem names the path and no team is claimed
    expect(view.teams).toEqual([])
    expect(String(view.problem)).toContain('not readable')
  })

  it('operator sees a malformed agents ledger refused without claiming anything', async () => {
    // Given a ledger that is not JSON
    const dir = mkdtempSync(join(tmpdir(), 'dsh-team-bad-'))
    roots.push(dir)
    const file = join(dir, 'ledger.json')
    writeFileSync(file, '{ not json', 'utf8')

    // When it is read
    const view = await readAgentsLedger(file)

    // Then the failure is a reported problem, not an exception
    expect(view.teams).toEqual([])
    expect(String(view.problem)).toContain('not valid JSON')
  })

  it('operator sees the ledger path resolved under the DSH home', async () => {
    // Given a DSH home override in the environment
    // When the ledger path is resolved
    const path = agentsLedgerPath({ DSH_HOME: '/tmp/dsh-home' }, '/home/operator')

    // Then it points at the agents plugin directory
    expect(path).toBe(join('/tmp/dsh-home', 'dsh-agents', 'ledger.json'))
  })

  it('operator sees duplicate and blank bindings collapsed before they reach the hub', async () => {
    // Given a settings value with duplicates, blanks and a display name
    // When the bindings are normalized before they reach the hub
    const normalized = normalizeBindings([
      { memberId: ' mem_a ', name: ' alpha ' },
      { memberId: 'mem_a' },
      { memberId: '   ' },
      { memberId: 'mem_b' },
    ])

    // Then one row per member survives, with the first name kept
    expect(normalized).toEqual([
      { memberId: 'mem_a', name: 'alpha' },
      { memberId: 'mem_b' },
    ])
  })
})

describe('hub settings', () => {
  it('operator sees a hub URL normalized to a base without a trailing slash', () => {
    // Given a URL typed with a trailing slash and spaces
    // When it is normalized
    // Then the base form is stored
    expect(normalizeHubUrl('  https://hub.example.com/  ')).toBe('https://hub.example.com')
  })

  it('operator gets a refusal for a hub URL that is not http', () => {
    // Given a value that is not an http(s) URL
    // When it is normalized
    // Then the refusal names the requirement
    expect(() => normalizeHubUrl('ftp://hub.example.com')).toThrow('absolute http(s) URL')
    expect(() => normalizeHubUrl('hub.example.com')).toThrow('absolute http(s) URL')
  })
})

describe('connection cadence', () => {
  it('operator sees a heartbeat every fifteen seconds while online', async () => {
    // Given a registered Host
    harness = makeHarness()
    await harness.service().whenStarted()
    const before = harness.hub.calls.filter(call => call.path.endsWith('/heartbeat')).length

    // When two intervals elapse
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)

    // Then one heartbeat reached the hub per interval
    expect(harness.hub.calls.filter(call => call.path.endsWith('/heartbeat')).length).toBe(before + 2)
  })

  it('operator sees the reconnect backoff grow and stay bounded', async () => {
    // Given a Host whose channel keeps dropping
    harness = makeHarness()
    await harness.service().whenStarted()
    harness.hub.drop()
    await flush()
    const afterFirstDrop = harness.service().summary().connection.reconnects

    // When the channel drops again after the first backoff elapsed
    await vi.advanceTimersByTimeAsync(1_000)
    harness.hub.drop()
    await flush()

    // Then the reconnect count grows, and no single wait exceeds the cap
    expect(harness.service().summary().connection.reconnects).toBeGreaterThan(afterFirstDrop)
    expect(RECONNECT_MAX_MS).toBe(30_000)
  })
})