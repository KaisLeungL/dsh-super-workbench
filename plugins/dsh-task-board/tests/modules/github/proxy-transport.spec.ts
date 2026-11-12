import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GitHubApiClient,
  GitHubApiError,
  GitHubTransportError,
  proxyClientOptions,
} from '../../../src/modules/github/host/client.ts'
import { bypassesProxy, resolveProxyConfiguration, resolveProxyUrl } from '../../../src/modules/github/host/proxy.ts'

/** Servers started by a case, closed when it ends. */
const open: http.Server[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(server => new Promise<void>(resolve => { server.close(() => { resolve() }) })))
})

/**
 * Start a server on a port the kernel picks.
 * @param handler - request handler.
 * @returns the base URL the server answers on.
 */
async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  open.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = server.address() as AddressInfo
  return 'http://127.0.0.1:' + String(address.port)
}

describe('proxy resolution', () => {
  it('operator who sets both proxy variables gets the https one for an https destination', () => {
    // Given: an https proxy and a catch-all proxy, both set
    const env = { HTTPS_PROXY: 'http://127.0.0.1:7890', ALL_PROXY: 'http://127.0.0.1:1080' }

    // When: an https destination is resolved
    const proxy = resolveProxyUrl('https://api.github.com/user', env)

    // Then: the https-specific variable wins
    expect(proxy).toBe('http://127.0.0.1:7890')
  })

  it('operator who writes the lowercase spelling gets the same proxy', () => {
    // Given: only the lowercase variable set, as most CLIs document it
    const env = { https_proxy: 'http://127.0.0.1:7890' }

    // When: an https destination is resolved
    const proxy = resolveProxyUrl('https://api.github.com/user', env)

    // Then: the spelling does not change the decision
    expect(proxy).toBe('http://127.0.0.1:7890')
  })

  it('operator who proxies only https keeps an http destination direct', () => {
    // Given: only the https variable set
    const env = { HTTPS_PROXY: 'http://127.0.0.1:7890' }

    // When: an http destination is resolved
    const proxy = resolveProxyUrl('http://127.0.0.1:3000/user', env)

    // Then: it stays direct rather than borrowing a variable it was not given
    expect(proxy).toBeUndefined()
  })

  it('operator whose proxy value is not a URL gets a direct request instead of a guess', () => {
    // Given: a value missing its scheme
    const env = { HTTPS_PROXY: '127.0.0.1:7890' }

    // When: a destination is resolved
    const proxy = resolveProxyUrl('https://api.github.com/user', env)

    // Then: no proxy is invented from it
    expect(proxy).toBeUndefined()
  })

  it('operator naming a host in NO_PROXY reaches it and its subdomains directly', () => {
    // Given: a bypass list naming a host and a dotted domain
    const env = { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'example.com,.internal' }

    // When: those destinations and an unrelated one are resolved
    // Then: the named host, its subdomains and the dotted domain bypass, while
    // the unrelated host keeps the proxy
    expect(resolveProxyUrl('https://example.com/x', env)).toBeUndefined()
    expect(resolveProxyUrl('https://api.example.com/x', env)).toBeUndefined()
    expect(resolveProxyUrl('https://ghe.internal/x', env)).toBeUndefined()
    expect(resolveProxyUrl('https://api.github.com/user', env)).toBe('http://127.0.0.1:7890')
  })

  it('operator pinning a port in NO_PROXY bypasses that port only', () => {
    // Given: a bypass entry carrying a port
    const env = { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'api.github.com:8443' }

    // When: the same host is resolved on two ports
    // Then: only the pinned port bypasses
    expect(resolveProxyUrl('https://api.github.com/user', env)).toBe('http://127.0.0.1:7890')
    expect(resolveProxyUrl('https://api.github.com:8443/user', env)).toBeUndefined()
  })

  it('operator whose NO_PROXY is a bare star bypasses every destination', () => {
    // Given: a star bypass list
    const raw = '*'

    // When: a destination is tested and resolved
    // Then: both agree it goes direct
    expect(bypassesProxy('api.github.com', 443, raw)).toBe(true)
    expect(resolveProxyUrl('https://api.github.com/user', { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: raw })).toBeUndefined()
  })
})

describe('proxied transport', () => {
  it('operator who configured a proxy sees the request arrive through it', async () => {
    // Given: an origin and a proxy that records what passes through it
    const seen: string[] = []
    const origin = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ login: 'octocat', authorization: req.headers.authorization }))
    })
    const proxyTarget = await listen((req, res) => {
      seen.push(String(req.url))
      const upstream = http.request(req.url ?? '', { method: req.method, headers: req.headers }, answer => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      })
      upstream.on('error', () => { res.writeHead(502); res.end() })
      req.pipe(upstream)
    })

    // When: the client is pointed at the proxy explicitly
    const client = new GitHubApiClient({ token: 't', baseUrl: origin, proxyUrl: proxyTarget })
    const user = await client.getAuthenticatedUser()

    // Then: the answer travelled through the proxy, carrying the credential
    expect(user.login).toBe('octocat')
    expect(seen).toEqual([origin + '/user'])
    expect(client.proxyUrl).toBe(proxyTarget)
  })

  it('operator whose NO_PROXY covers loopback reaches an http origin directly', async () => {
    // Given: a dead proxy in the environment, bypassed for loopback
    const origin = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ login: 'direct' }))
    })

    // When: the client resolves its transport from that environment
    const client = new GitHubApiClient({
      token: 't',
      baseUrl: origin,
      env: { HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1' },
    })
    const user = await client.getAuthenticatedUser()

    // Then: the bypass applies and no proxy is wrapped around the request
    expect(user.login).toBe('direct')
    expect(client.proxyUrl).toBeUndefined()
  })

  it('operator whose proxy refuses the tunnel is told which authority was refused', async () => {
    // Given: a proxy that refuses CONNECT and records the authority asked for
    const authorities: string[] = []
    const proxy = http.createServer()
    open.push(proxy)
    proxy.on('connect', (req, socket) => {
      authorities.push(String(req.url))
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    })
    await new Promise<void>(resolve => { proxy.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = proxy.address() as AddressInfo

    // When: the client reaches the default https endpoint through it
    const client = new GitHubApiClient({
      token: 't',
      proxyUrl: 'http://127.0.0.1:' + String(address.port),
      useEnvironmentProxy: false,
    })
    const outcome = await client.getAuthenticatedUser().then(() => 'answered', (error: unknown) => error)

    // Then: it asked for a tunnel to the API authority and reported the refusal
    expect(authorities[0]).toBe('api.github.com:443')
    expect(outcome).toBeInstanceOf(GitHubTransportError)
    expect((outcome as GitHubTransportError).message).toContain('502')
    expect((outcome as GitHubTransportError).endpoint).toBe('/user')
  })
})

describe('configuration-driven transport', () => {
  it('operator who chose a custom proxy has the request reach the origin through it', async () => {
    // Given: an origin, a recording proxy, and the custom mode pinned to it
    // while the environment names a dead one
    const seen: string[] = []
    const origin = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ login: 'octocat' }))
    })
    const proxyTarget = await listen((req, res) => {
      seen.push(String(req.url))
      const upstream = http.request(req.url ?? '', { method: req.method, headers: req.headers }, answer => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      })
      upstream.on('error', () => { res.writeHead(502); res.end() })
      req.pipe(upstream)
    })

    // When: the configuration is resolved and handed to the client
    const resolved = resolveProxyConfiguration(origin, {
      mode: 'custom',
      customUrl: proxyTarget,
      env: { HTTP_PROXY: 'http://127.0.0.1:9' },
      detect: () => undefined,
    })
    const client = new GitHubApiClient({ token: 't', baseUrl: origin, ...proxyClientOptions(resolved) })
    const user = await client.getAuthenticatedUser()

    // Then: the request travelled through the configured proxy, not the dead
    // one the environment still names
    expect(user.login).toBe('octocat')
    expect(seen).toEqual([origin + '/user'])
    expect(client.proxyUrl).toBe(proxyTarget)
  })

  it('operator who selected direct is not routed through the proxy its environment names', async () => {
    // Given: an http origin and a dead proxy in the environment
    const origin = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ login: 'direct' }))
    })

    // When: the direct mode is resolved and handed to the client
    const env = { HTTP_PROXY: 'http://127.0.0.1:9' }
    const resolved = resolveProxyConfiguration(origin, { mode: 'direct', env, detect: () => undefined })
    const client = new GitHubApiClient({ token: 't', baseUrl: origin, env, ...proxyClientOptions(resolved) })
    const user = await client.getAuthenticatedUser()

    // Then: the request went straight to the origin
    expect(user.login).toBe('direct')
    expect(client.proxyUrl).toBeUndefined()
  })
})

describe('transport retry', () => {
  it('operator whose socket died on an idle host has the request carried by the retry', async () => {
    // Given: a transport failure followed by a healthy answer
    let calls = 0
    const flaky: typeof fetch = async () => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ login: 'octocat' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    // When: the client requests through it
    const client = new GitHubApiClient({ token: 't', fetch: flaky, useEnvironmentProxy: false })
    const user = await client.getAuthenticatedUser()

    // Then: the retry carried the request, once
    expect(user.login).toBe('octocat')
    expect(calls).toBe(2)
  })

  it('operator whose transport never recovers gets an error naming the endpoint and the cause', async () => {
    // Given: a transport that fails with a resolvable cause every time
    let calls = 0
    const dead: typeof fetch = async () => {
      calls += 1
      const cause = Object.assign(new Error('getaddrinfo EAI_AGAIN api.github.com'), { code: 'EAI_AGAIN' })
      throw new TypeError('fetch failed', { cause })
    }

    // When: the request is made
    const client = new GitHubApiClient({ token: 't', fetch: dead, useEnvironmentProxy: false })
    const outcome = await client.getAuthenticatedUser().then(() => 'answered', (error: unknown) => error)

    // Then: the stored error names what failed instead of saying "fetch failed"
    expect(calls).toBe(2)
    expect(outcome).toBeInstanceOf(GitHubTransportError)
    expect((outcome as GitHubTransportError).endpoint).toBe('/user')
    expect((outcome as GitHubTransportError).message).toContain('EAI_AGAIN')
  })

  it('operator whose comment write fails at the transport is not asked twice', async () => {
    // Given: a transport that fails every time
    let calls = 0
    const dead: typeof fetch = async () => {
      calls += 1
      throw new TypeError('fetch failed')
    }

    // When: a POST that creates a comment is attempted
    const client = new GitHubApiClient({ token: 't', fetch: dead, useEnvironmentProxy: false })
    const outcome = await client.createComment('owner', 'repo', 1, 'body').then(() => 'posted', (error: unknown) => error)

    // Then: it is attempted once, because the first attempt may have landed —
    // repeating it would post the same comment twice
    expect(calls).toBe(1)
    expect(outcome).toBeInstanceOf(GitHubTransportError)
    expect((outcome as GitHubTransportError).message).toContain('fetch failed')
  })

  it('operator whose request GitHub refused is not asked again', async () => {
    // Given: a 404 from GitHub
    let calls = 0
    const notFound: typeof fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    }

    // When: the request is made
    const client = new GitHubApiClient({ token: 't', fetch: notFound, useEnvironmentProxy: false })
    const outcome = await client.getAuthenticatedUser().then(() => 'answered', (error: unknown) => error)

    // Then: it refuses once, without asking the same question twice
    expect(calls).toBe(1)
    expect(outcome).toBeInstanceOf(GitHubApiError)
    expect((outcome as GitHubApiError).status).toBe(404)
  })
})
