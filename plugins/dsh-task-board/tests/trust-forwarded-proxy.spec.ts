/**
 * Forwarded-proxy trust switch (issue #1918).
 *
 * A board reached through the operator's own reverse proxy or tunnel sees a
 * loopback socket (the proxy dials 127.0.0.1:<port>), a loopback Host (the
 * proxy rewrote the authority to its upstream literal), and a forwarding
 * header — so the repository-wide fence refuses it (issue #1906). The board's
 * own switch admits exactly that case and defaults off, which keeps the #1906
 * refusal for every deployment that never configured it.
 */
import { createServer, request, type IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { makeTaskBoardRoutes, type TaskBoardRouteAccess } from '../src/host-routes.ts'
import type { TaskBoardHostService } from '../src/host-service.ts'
import type { TaskBoardSnapshot } from '../src/protocol.ts'
import { isForwardedLoopbackRequest, isLoopbackRequest } from '../src/loopback.ts'
import { Config, DEFAULT_TRUST_FORWARDED_PROXY, readConfigField, resolveProxyAccess } from '../src/index.ts'

const snapshot: TaskBoardSnapshot = {
  schemaVersion: 8,
  revision: 0,
  tasks: [],
  scheduler: { timeZone: 'UTC' },
  power: {
    platform: 'linux', phase: 'unsupported', enabled: false,
    runningSessions: 0, armedSchedules: 0, sessionStateKnown: true,
  },
}

/** The forwarding headers a proxy or tunnel stamps on the traffic it forwards. */
const FORWARDED = { 'x-forwarded-for': '203.0.113.5' }

/** The browser marker the board's fence requires in addition to any trust. */
const BROWSER = { 'sec-fetch-site': 'same-origin' }

/**
 * A request as the origin sees it, for the predicate-level checks: only the
 * two facts the loopback predicates read are real here.
 * @param headers - request headers.
 * @param remoteAddress - the socket address the origin accepted.
 * @returns the request shape the predicates consume.
 */
function fakeRequest(headers: Record<string, string>, remoteAddress: string): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

/** One board bound to a real loopback listener, closed by the caller. */
interface BoardUnderTest {
  base: string
  close: () => Promise<void>
}

/**
 * Serve the task-board routes on a loopback listener.
 * @param access - the route access the fence resolves.
 * @param remoteAddress - the socket address the handler reports, overriding the real loopback peer to model a non-local client.
 * @returns the board URL and its teardown.
 */
async function startBoard(access: TaskBoardRouteAccess, remoteAddress?: string): Promise<BoardUnderTest> {
  const service = {
    snapshot: () => snapshot,
    apply: () => snapshot,
    subscribe: () => () => undefined,
  } as unknown as TaskBoardHostService
  const routes = makeTaskBoardRoutes(service, access)
  const server = createServer((req, res) => {
    if (remoteAddress !== undefined) Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress, configurable: true })
    const route = routes.find(candidate => candidate.path === new URL(req.url ?? '/', 'http://local').pathname)
    if (route === undefined) { res.writeHead(404); res.end(); return }
    void route.handler(req, res)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind')
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => { await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) }) },
  }
}

/**
 * Read the state route's status.
 * @param url - the state route URL.
 * @param headers - request headers.
 * @returns the HTTP status the fence answered with.
 */
async function stateStatus(url: string, headers: Record<string, string>): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const outgoing = request(url, { headers }, response => {
      response.resume()
      response.once('end', () => { resolve(response.statusCode ?? 0) })
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

describe('forwarded request predicates', () => {
  it('operator who never configured the switch keeps the #1906 refusal of a forwarded request', () => {
    // Given a request that carries a forwarding header over a loopback socket with a loopback Host
    const forwarded = fakeRequest({ host: '127.0.0.1:51729', ...FORWARDED }, '127.0.0.1')
    // When the repository-wide loopback fence judges it
    // Then it is not a local request, so a route that trusts only loopback refuses it
    expect(isLoopbackRequest(forwarded)).toBe(false)
    // And the same request without the forwarding header still is local
    expect(isLoopbackRequest(fakeRequest({ host: '127.0.0.1:51729' }, '::1'))).toBe(true)
  })

  it('operator whose own proxy dials the loopback upstream is visible as a forwarded local request', () => {
    // Given forwarded requests over the loopback upstream, stamped by either header a proxy uses
    const byForwardedFor = fakeRequest({ host: '127.0.0.1:51729', ...FORWARDED }, '127.0.0.1')
    const byCloudflare = fakeRequest({ host: '[::1]:51729', 'cf-connecting-ip': '203.0.113.5' }, '::ffff:127.0.0.1')
    // When the forwarded-loopback predicate judges them
    // Then both are the case the switch exists for
    expect(isForwardedLoopbackRequest(byForwardedFor)).toBe(true)
    expect(isForwardedLoopbackRequest(byCloudflare)).toBe(true)
  })

  it('operator whose request lacks one half of the loopback upstream is never a forwarded local request', () => {
    // Given requests missing the forwarding header, the loopback socket, or the loopback Host
    const direct = fakeRequest({ host: '127.0.0.1:51729' }, '127.0.0.1')
    const remotePeer = fakeRequest({ host: '127.0.0.1:51729', ...FORWARDED }, '203.0.113.7')
    const publicHost = fakeRequest({ host: 'tasks.example.test', ...FORWARDED }, '127.0.0.1')
    const hostless = fakeRequest({ ...FORWARDED }, '127.0.0.1')
    // When the forwarded-loopback predicate judges them
    // Then each is refused: the predicate describes a forwarded request that landed on this machine
    expect(isForwardedLoopbackRequest(direct)).toBe(false)
    expect(isForwardedLoopbackRequest(remotePeer)).toBe(false)
    expect(isForwardedLoopbackRequest(publicHost)).toBe(false)
    expect(isForwardedLoopbackRequest(hostless)).toBe(false)
  })
})

describe('task-board forwarded-proxy switch', () => {
  it('operator whose board keeps the switch off sees a forwarded browser request refused', async () => {
    // Given a board whose forwarded-proxy switch is off (the default)
    const board = await startBoard({ trustForwardedProxy: () => false })
    try {
      // When the operator's proxy forwards a browser request onto the loopback upstream
      const status = await stateStatus(`${board.base}/api/task-board/state`, { ...FORWARDED, ...BROWSER })
      // Then the #1906 fence still refuses it
      expect(status).toBe(403)
    } finally {
      await board.close()
    }
  })

  it('operator who turned the switch on sees the same forwarded request admitted', async () => {
    // Given a board whose forwarded-proxy switch is on
    const board = await startBoard({ trustForwardedProxy: () => true })
    try {
      // When the operator's proxy forwards a browser request onto the loopback upstream
      const forwarded = await stateStatus(`${board.base}/api/task-board/state`, { ...FORWARDED, ...BROWSER })
      // Then the fence admits it, while a direct local request stays admitted too
      expect(forwarded).toBe(200)
      expect(await stateStatus(`${board.base}/api/task-board/state`, { ...BROWSER })).toBe(200)
    } finally {
      await board.close()
    }
  })

  it('operator whose forwarded request arrives from a non-loopback socket is refused even with the switch on', async () => {
    // Given the switch on and a request that carries a forwarding header but whose socket is not this machine
    const board = await startBoard({ trustForwardedProxy: () => true }, '203.0.113.7')
    try {
      // When that request asks for the board state
      const status = await stateStatus(`${board.base}/api/task-board/state`, { ...FORWARDED, ...BROWSER })
      // Then the switch grants nothing: a request relayed from elsewhere never becomes local
      expect(status).toBe(403)
    } finally {
      await board.close()
    }
  })

  it('operator whose forwarded request carries no browser marker is refused even with the switch on', async () => {
    // Given the switch on and a forwarded request over the loopback upstream that presents no marker
    const board = await startBoard({ trustForwardedProxy: () => true })
    try {
      // When it asks for the board state
      const bare = await stateStatus(`${board.base}/api/task-board/state`, { ...FORWARDED })
      const cookieOnly = await stateStatus(`${board.base}/api/task-board/state`, { ...FORWARDED, cookie: 'theme=dark' })
      // Then both are refused: the browser same-origin marker is required on top of any trust
      expect(bare).toBe(403)
      expect(cookieOnly).toBe(403)
    } finally {
      await board.close()
    }
  })

  it('operator whose tunnel is reached by a third-party page sees that cross-site post refused with the switch on', async () => {
    // Given the switch on and a forwarded request that a page on another origin posts through the tunnel
    const board = await startBoard({ trustForwardedProxy: () => true })
    try {
      // When the browser labels it cross-site (it carries an Origin, so the
      // marker alone would pass) and it asks the board to mutate
      const status = await stateStatus(`${board.base}/api/task-board/state`, {
        ...FORWARDED,
        origin: 'https://evil.example.test',
        'sec-fetch-site': 'cross-site',
      })
      // Then the tunnel's trust does not extend to it: the operator's own page
      // never sends that marker, so it stays refused
      expect(status).toBe(403)
    } finally {
      await board.close()
    }
  })

  it('operator who flips the switch in settings sees the next request follow it without a restart', async () => {
    // Given a switch the fence reads per request, currently off
    let trusted = false
    const board = await startBoard({ trustForwardedProxy: () => trusted })
    const url = `${board.base}/api/task-board/state`
    try {
      // When the operator saves the setting and the next request arrives
      expect(await stateStatus(url, { ...FORWARDED, ...BROWSER })).toBe(403)
      trusted = true
      // Then the next request follows the new value with the routes left registered
      expect(await stateStatus(url, { ...FORWARDED, ...BROWSER })).toBe(200)
      trusted = false
      expect(await stateStatus(url, { ...FORWARDED, ...BROWSER })).toBe(403)
    } finally {
      await board.close()
    }
  })
})

describe('forwarded-proxy switch configuration', () => {
  it('operator who configured nothing gets the switch off, and the settings page can write it live', () => {
    // Given the Config schema the Host serves as this profile entry's settings page
    const value = Config({})
    // When the switch's value and schema node are read
    // Then it is off by default and marked volatile, which is what a live settings write is fenced on
    expect(readConfigField(value.trustForwardedProxy, true)).toBe(DEFAULT_TRUST_FORWARDED_PROXY)
    expect(DEFAULT_TRUST_FORWARDED_PROXY).toBe(false)
    const node = (Config.dict as Record<string, { meta?: { volatile?: boolean } }>).trustForwardedProxy
    expect(node?.meta?.volatile).toBe(true)
  })

  it('operator whose switch is a live reference sees the fence read the value it holds at request time', () => {
    // Given the access a board resolves at mount, with the switch as the volatile reference the Loader commits in place
    let committed = true
    const config = {
      trustedProxyHosts: [],
      trustForwardedProxy: { get: () => committed },
    } as unknown as Config
    const access = resolveProxyAccess(config, {})
    // When the switch is read, flipped, and read again
    // Then the reader follows the committed value instead of freezing it at mount
    expect(access.trustForwardedProxy()).toBe(true)
    committed = false
    expect(access.trustForwardedProxy()).toBe(false)
    expect(resolveProxyAccess(undefined, {}).trustForwardedProxy()).toBe(false)
  })
})
