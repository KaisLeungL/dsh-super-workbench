/**
 * Proxy resolution and a dependency-free proxy transport for the GitHub client.
 *
 * The Host process reaches api.github.com directly, and on a machine whose
 * egress goes through a local proxy that direct path is the part that breaks:
 * the failure surfaces as undici's "fetch failed" on some percentage of
 * requests while a freshly spawned CLI works, because every CLI call opens a new
 * connection and no CLI request inherits a pooled socket that died with a
 * network change. This module gives the client the other half of that story: it
 * reads the conventional proxy variables and routes the request through the
 * proxy instead.
 *
 * It deliberately does not import undici. The GitHub client sends and receives
 * JSON only — it needs status, headers and a small body, never streaming — so a
 * CONNECT tunnel (https targets) or an absolute-form request (http targets) over
 * node:http/node:https is the whole transport. Bundling an HTTP stack for a
 * plugin whose host half ships as one file would cost more than the feature.
 *
 * @module dsh-task-board-github/host/proxy
 */
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import type { GitHubProxyMode, GitHubProxySource } from '../core/setup.ts'

/** Proxy variables consulted for an https target, most specific first. */
const HTTPS_PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'] as const

/** Proxy variables consulted for an http target, most specific first. */
const HTTP_PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] as const

/** Variables that list destinations which must bypass the proxy. */
const NO_PROXY_VARS = ['NO_PROXY', 'no_proxy'] as const

/** Redirects a proxied request follows before giving up. */
const MAX_REDIRECTS = 3

/**
 * Whether one destination must bypass the proxy.
 *
 * The entries follow the de-facto convention every tool that reads NO_PROXY
 * implements: a bare `*` bypasses everything, an entry matches the host
 * exactly, an entry with a leading dot (or a plain suffix) matches the host and
 * its subdomains, and an entry may carry a `:port` that must agree with the
 * destination's.
 * @param host - destination host.
 * @param port - destination port.
 * @param raw - the NO_PROXY value.
 * @returns whether the destination bypasses the proxy.
 */
export function bypassesProxy(host: string, port: number, raw: string | undefined): boolean {
  if (raw === undefined) return false
  const target = host.trim().toLowerCase()
  for (const entry of raw.split(',')) {
    const item = entry.trim().toLowerCase()
    if (item === '') continue
    if (item === '*') return true
    const colon = item.lastIndexOf(':')
    let name = item
    let wantedPort: number | undefined
    if (colon > 0 && !item.includes(']')) {
      const tail = item.slice(colon + 1)
      if (/^\d+$/.test(tail)) {
        name = item.slice(0, colon)
        wantedPort = Number(tail)
      }
    }
    if (wantedPort !== undefined && wantedPort !== port) continue
    const bare = name.startsWith('.') ? name.slice(1) : name
    if (bare === '') continue
    if (target === bare || target.endsWith('.' + bare)) return true
  }
  return false
}

/**
 * Resolve the proxy one destination should use.
 * @param targetUrl - absolute URL of the destination.
 * @param env - environment to read the proxy variables from.
 * @returns the proxy URL, or undefined when the request goes direct.
 */
export function resolveProxyUrl(
  targetUrl: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return undefined
  }
  const secure = target.protocol === 'https:'
  if (!secure && target.protocol !== 'http:') return undefined
  const port = target.port === '' ? (secure ? 443 : 80) : Number(target.port)
  const noProxy = NO_PROXY_VARS.map(name => env[name]).find(value => value !== undefined && value.trim() !== '')
  if (bypassesProxy(target.hostname, port, noProxy)) return undefined
  for (const name of secure ? HTTPS_PROXY_VARS : HTTP_PROXY_VARS) {
    const value = env[name]
    if (value === undefined) continue
    const candidate = value.trim()
    if (candidate === '') continue
    if (!/^https?:\/\//i.test(candidate)) continue
    return candidate
  }
  return undefined
}

/**
 * How long one system proxy detection is reused, in milliseconds.
 *
 * The probe is a synchronous child process, so it must not run on the request
 * path of every GitHub call: a pass issues a hundred or more sequential
 * requests, and each one would pay a process spawn. Thirty seconds is short
 * enough that a user who turns the system proxy on gets it without a restart,
 * and long enough that a pass costs at most one probe.
 */
export const SYSTEM_PROXY_CACHE_TTL_MS = 30_000

/** Ceiling on one system proxy probe, in milliseconds. */
const SYSTEM_PROXY_PROBE_TIMEOUT_MS = 2_000

/** Registry key the Windows system proxy is configured under. */
export const WINDOWS_PROXY_REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/**
 * Add the scheme a user left out.
 *
 * `127.0.0.1:7890` is how every proxy tool on Windows and macOS displays its
 * listen address, so accepting only the URL form would refuse the value the
 * user just copied out of it. A value that already carries a scheme is returned
 * untouched — including one this client cannot speak (see
 * {@link resolveProxyConfiguration}), which is rejected with a reason instead
 * of being silently rewritten into something that would be dialled.
 * @param rawUrl - the value as typed, stored or reported by the OS.
 * @returns the URL form, or an empty string for an empty value.
 */
export function normalizeProxyUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (trimmed === '') return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  return 'http://' + trimmed
}

/** One accepted proxy, or why nothing can be dialled. */
export interface ProxyConfiguration {
  /** Proxy URL to route through; absent means the request goes direct. */
  url?: string
  /** Where {@link url} came from. */
  source?: GitHubProxySource
  /** Why a configured proxy cannot be used, phrased for a person. Never a credential. */
  reason?: string
}

/**
 * Accept one candidate proxy URL, or explain why it cannot be used.
 *
 * The scheme allowlist is the transport's, not a preference: this client speaks
 * CONNECT (https targets) and absolute-form requests (http targets) over
 * node:http, and a SOCKS proxy needs a different handshake. Rejecting here —
 * rather than throwing, or dialling and failing — is what lets a socks-only
 * system proxy fall back to a direct connection and still be explainable.
 * @param candidate - normalized proxy URL.
 * @param source - where the candidate came from.
 * @returns the configuration to use.
 */
function acceptedProxy(candidate: string, source: GitHubProxySource): ProxyConfiguration {
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return { reason: 'the configured proxy is not a URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { reason: 'proxy scheme "' + parsed.protocol.replace(':', '') + '" is not supported; only http and https proxies are' }
  }
  if (parsed.hostname === '') return { reason: 'the configured proxy names no host' }
  return { url: candidate, source }
}

/**
 * Parse the Windows registry output into a proxy URL.
 *
 * Kept separate from the command so a fixed stdout is testable: this is the
 * only place that has to know the shape `reg query` prints, and the shape
 * differs between a single server (`127.0.0.1:7890`) and a per-protocol list
 * (`https=...;http=...`). The https entry is preferred because the GitHub API
 * this client talks to is https, then http, then a socks spelling reported as
 * such so the resolver can refuse it with a reason.
 * @param stdout - the command's output.
 * @returns the proxy URL, or undefined when the registry names no usable one.
 */
export function parseWindowsSystemProxy(stdout: string): string | undefined {
  const enabled = /^\s*ProxyEnable\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)\s*$/m.exec(stdout)
  if (enabled === null) return undefined
  const written = enabled[1] ?? ''
  const value = written.toLowerCase().startsWith('0x') ? Number.parseInt(written.slice(2), 16) : Number.parseInt(written, 10)
  if (value !== 1) return undefined
  const server = /^\s*ProxyServer\s+REG_SZ\s+([^\r\n]+)$/m.exec(stdout)
  if (server === null) return undefined
  const list = (server[1] ?? '').trim()
  if (list === '') return undefined
  if (!list.includes('=')) return list
  const perProtocol = new Map<string, string>()
  for (const entry of list.split(';')) {
    const [protocol, address] = entry.split('=').map(part => part.trim())
    if (protocol === undefined || protocol === '' || address === undefined || address === '') continue
    const key = protocol.toLowerCase()
    if (!perProtocol.has(key)) perProtocol.set(key, address)
  }
  const https = perProtocol.get('https')
  if (https !== undefined) return https
  const plain = perProtocol.get('http')
  if (plain !== undefined) return plain
  const socks = perProtocol.get('socks')
  if (socks !== undefined) return 'socks5://' + socks
  return undefined
}

/**
 * Parse `scutil --proxy` output into a proxy URL.
 *
 * Same split as the Windows parser: the dictionary `scutil` prints is the only
 * thing this function needs to know. The https proxy wins over the http one for
 * the same reason as above, and a SOCKS-only configuration is reported as
 * `socks5://` so the resolver can name what it cannot speak.
 * @param stdout - the command's output.
 * @returns the proxy URL, or undefined when nothing is enabled.
 */
export function parseMacSystemProxy(stdout: string): string | undefined {
  const read = (enabledKey: string, hostKey: string, portKey: string): string | undefined => {
    if (!new RegExp('\\b' + enabledKey + '\\s*:\\s*1\\b').test(stdout)) return undefined
    const host = new RegExp('\\b' + hostKey + '\\s*:\\s*(\\S+)').exec(stdout)?.[1]
    const port = new RegExp('\\b' + portKey + '\\s*:\\s*(\\d+)').exec(stdout)?.[1]
    if (host === undefined || host === '' || port === undefined) return undefined
    return host + ':' + port
  }
  const https = read('HTTPSEnable', 'HTTPSProxy', 'HTTPSPort')
  if (https !== undefined) return https
  const plain = read('HTTPEnable', 'HTTPProxy', 'HTTPPort')
  if (plain !== undefined) return plain
  const socks = read('SOCKSEnable', 'SOCKSProxy', 'SOCKSPort')
  if (socks !== undefined) return 'socks5://' + socks
  return undefined
}

/** One system proxy probe command, when this platform has one. */
export interface SystemProxyCommand {
  /** Executable to run. */
  file: string
  /** Its arguments. */
  args: readonly string[]
}

/**
 * The probe command for one platform.
 *
 * Windows and macOS only: those are the two platforms whose system proxy the
 * desktop actually configures in one place this process can read. Any other
 * platform returns undefined and the environment decides, which is what a Linux
 * desktop with only `gsettings` configured gets.
 * @param platform - the platform to probe on.
 * @returns the command, or undefined when there is nothing to run.
 */
export function systemProxyCommand(platform: NodeJS.Platform): SystemProxyCommand | undefined {
  if (platform === 'win32') return { file: 'reg', args: ['query', WINDOWS_PROXY_REGISTRY_KEY] }
  if (platform === 'darwin') return { file: 'scutil', args: ['--proxy'] }
  return undefined
}

/**
 * Parse one platform's probe output.
 * @param platform - the platform the output came from.
 * @param stdout - the command's output.
 * @returns the proxy URL, or undefined.
 */
export function parseSystemProxyOutput(platform: NodeJS.Platform, stdout: string): string | undefined {
  if (platform === 'win32') return parseWindowsSystemProxy(stdout)
  if (platform === 'darwin') return parseMacSystemProxy(stdout)
  return undefined
}

/** Cached detection result per platform. */
const systemProxyCache = new Map<string, { at: number; value: string | undefined }>()

/** Drop the cache; used by a test that drives the clock, and after a config change. */
export function resetSystemProxyCache(): void {
  systemProxyCache.clear()
}

/** Options of {@link detectSystemProxy}. */
export interface DetectSystemProxyOptions {
  /** Platform to probe (default: this process's). */
  platform?: NodeJS.Platform
  /** Clock, for the cache lifetime. */
  now?: () => number
  /** Command runner, so a test never spawns a process. */
  run?: (file: string, args: readonly string[]) => string
}

/** Run one probe command and return its stdout. */
function probeSystemProxy(file: string, args: readonly string[]): string {
  return execFileSync(file, [...args], {
    encoding: 'utf-8',
    windowsHide: true,
    timeout: SYSTEM_PROXY_PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/**
 * Detect the operating system's own proxy, cached.
 *
 * Every failure reads as "no system proxy": the probe runs a child process, and
 * a deployment where `reg` is unavailable, the registry key is missing or the
 * command exceeds its ceiling must lose the detection, never the request. The
 * result is cached for {@link SYSTEM_PROXY_CACHE_TTL_MS} because the probe is
 * synchronous and sits on the request path.
 * @param options - platform, clock and runner seams.
 * @returns the proxy URL, or undefined when nothing was detected.
 */
export function detectSystemProxy(options: DetectSystemProxyOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform
  const now = options.now ?? Date.now
  const at = now()
  const cached = systemProxyCache.get(platform)
  if (cached !== undefined && at - cached.at < SYSTEM_PROXY_CACHE_TTL_MS) return cached.value
  let value: string | undefined
  try {
    const command = systemProxyCommand(platform)
    if (command !== undefined) {
      const stdout = (options.run ?? probeSystemProxy)(command.file, command.args)
      value = parseSystemProxyOutput(platform, stdout)
    }
  } catch {
    value = undefined
  }
  systemProxyCache.set(platform, { at, value })
  return value
}

/** Options of {@link resolveProxyConfiguration}. */
export interface ProxyResolutionOptions {
  /** Configured mode. */
  mode: GitHubProxyMode
  /** Configured custom URL; read only by the `custom` mode. */
  customUrl?: string
  /** Environment to read the conventional variables from. */
  env?: Record<string, string | undefined>
  /** Platform the system proxy is detected on. */
  platform?: NodeJS.Platform
  /** Detection seam, so a caller (or a test) never inherits the machine's own proxy. */
  detect?: () => string | undefined
}

/**
 * Decide the proxy one destination should actually use.
 *
 * The precedence is the one the settings card documents: `direct` never
 * proxies; `custom` pins the configured URL (an empty one is not a decision and
 * falls back to `auto`); `auto` reads the conventional variables, then the
 * operating system's own proxy, then goes direct. `NO_PROXY` is checked first
 * and applies to all three sources — a bypass list that only defeated the
 * environment variables would be a trap for the very user who set a custom
 * proxy.
 * @param targetUrl - absolute URL of the destination.
 * @param options - mode, custom URL and the detection seams.
 * @returns what to dial, and why not when nothing can be.
 */
export function resolveProxyConfiguration(targetUrl: string, options: ProxyResolutionOptions): ProxyConfiguration {
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return {}
  }
  const secure = target.protocol === 'https:'
  if (!secure && target.protocol !== 'http:') return {}
  if (options.mode === 'direct') return {}
  const env = options.env ?? process.env
  const port = target.port === '' ? (secure ? 443 : 80) : Number(target.port)
  const noProxy = NO_PROXY_VARS.map(name => env[name]).find(value => value !== undefined && value.trim() !== '')
  if (bypassesProxy(target.hostname, port, noProxy)) return {}

  if (options.mode === 'custom') {
    const custom = normalizeProxyUrl(options.customUrl ?? '')
    if (custom !== '') return acceptedProxy(custom, 'custom')
  }

  const fromEnvironment = resolveProxyUrl(targetUrl, env)
  if (fromEnvironment !== undefined) return { url: fromEnvironment, source: 'env' }

  const detected = (options.detect ?? ((): string | undefined => detectSystemProxy({ platform: options.platform ?? process.platform })))()
  if (detected === undefined || detected.trim() === '') return {}
  return acceptedProxy(normalizeProxyUrl(detected), 'system')
}

/** Headers of one proxied request, as the client hands them over. */
type HeaderInput = HeadersInit | undefined

/** What both Node request paths share: the tunnel may carry a body. */
interface TunnelRequest {
  /** HTTP method. */
  method: string
  /** Request target as the destination sees it. */
  path: string
  /** Request headers. */
  headers: Record<string, string>
  /** Request body, when the method carries one. */
  body: string | Buffer | undefined
}

/**
 * One header record from whatever the caller passed.
 * @param input - Headers, a record, or nothing.
 * @returns a plain record.
 */
function headerRecord(input: HeaderInput): Record<string, string> {
  if (input === undefined) return {}
  const out: Record<string, string> = {}
  if (Array.isArray(input)) {
    for (const [key, value] of input) out[key] = String(value)
    return out
  }
  if (typeof input === 'object' && input !== null && typeof (input as Headers).forEach === 'function') {
    ;(input as Headers).forEach((value, key) => { out[key] = value })
    return out
  }
  for (const [key, value] of Object.entries(input as Record<string, string>)) out[key] = String(value)
  return out
}

/**
 * Proxy credentials as an authorization header, when the proxy URL carries them.
 * @param proxy - parsed proxy URL.
 * @returns the header value, or undefined.
 */
function proxyAuthorization(proxy: URL): string | undefined {
  if (proxy.username === '' && proxy.password === '') return undefined
  const user = decodeURIComponent(proxy.username)
  const pass = decodeURIComponent(proxy.password)
  return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64')
}

/**
 * Collect a Node response into a real Response.
 * @param response - the Node response.
 * @returns the equivalent Response.
 */
function collect(response: http.IncomingMessage): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const chunks: Buffer[] = []
    response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    response.on('end', () => {
      const status = response.statusCode ?? 0
      const headers = new Headers()
      for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) for (const item of value) headers.append(key, item)
        else headers.set(key, String(value))
      }
      // 204 and 304 forbid a body, and Response refuses to construct one with it.
      const body = status === 204 || status === 304 ? null : Buffer.concat(chunks)
      resolve(new Response(body, { status, headers }))
    })
    response.on('error', reject)
  })
}

/**
 * Build a fetch that reaches the destination through one proxy.
 *
 * The result is a drop-in `typeof fetch` for the GitHub client: every request
 * is one JSON exchange, so the body is buffered rather than streamed, and the
 * caller's AbortSignal is honoured by destroying the socket it owns.
 * @param proxyUrl - proxy to route through.
 * @returns a fetch implementation.
 */
export function createProxyFetch(proxyUrl: string): typeof fetch {
  const proxy = new URL(proxyUrl)
  const proxyPort = proxy.port === '' ? (proxy.protocol === 'https:' ? 443 : 80) : Number(proxy.port)
  const authorization = proxyAuthorization(proxy)

  const send = async (targetUrl: string, request: TunnelRequest, signal: AbortSignal | null | undefined, redirects: number): Promise<Response> => {
    const target = new URL(targetUrl)
    const secure = target.protocol === 'https:'
    const port = target.port === '' ? (secure ? 443 : 80) : Number(target.port)
    const response = secure
      ? await throughTunnel(target.hostname, port, request, signal)
      : await absoluteForm(targetUrl, request, signal)
    const location = response.headers.get('location')
    if (location !== null && [301, 302, 303, 307, 308].includes(response.status) && redirects < MAX_REDIRECTS) {
      const next = new URL(location, targetUrl).toString()
      const method = response.status === 303 ? 'GET' : request.method
      return await send(next, { ...request, method, path: new URL(next).pathname + new URL(next).search, body: method === request.method ? request.body : undefined }, signal, redirects + 1)
    }
    return response
  }

  /** Absolute-form request: the proxy reads the destination from the request line. */
  const absoluteForm = (targetUrl: string, request: TunnelRequest, signal?: AbortSignal | null): Promise<Response> => {
    return new Promise<Response>((resolve, reject) => {
      const headers = { ...request.headers }
      if (authorization !== undefined) headers['proxy-authorization'] = authorization
      const req = http.request({
        host: proxy.hostname,
        port: proxyPort,
        method: request.method,
        path: targetUrl,
        headers,
      }, response => { collect(response).then(resolve, reject) })
      req.on('error', reject)
      const abort = (): void => { req.destroy(new Error('the request was aborted')) }
      if (signal !== null && signal !== undefined) {
        if (signal.aborted) { abort(); return }
        signal.addEventListener('abort', abort, { once: true })
        req.on('close', () => { signal.removeEventListener('abort', abort) })
      }
      if (request.body !== undefined) req.write(request.body)
      req.end()
    })
  }

  /** CONNECT tunnel: an opaque byte pipe the TLS handshake then runs inside. */
  const throughTunnel = (host: string, port: number, request: TunnelRequest, signal?: AbortSignal | null): Promise<Response> => {
    return new Promise<Response>((resolve, reject) => {
      const authority = host + ':' + String(port)
      const headers: Record<string, string> = { host: authority }
      if (authorization !== undefined) headers['proxy-authorization'] = authorization
      const connect = http.request({
        host: proxy.hostname,
        port: proxyPort,
        method: 'CONNECT',
        path: authority,
        headers,
      })
      const fail = (error: unknown): void => { connect.destroy(); reject(error) }
      const abort = (): void => { fail(new Error('the request was aborted')) }
      if (signal !== null && signal !== undefined) {
        if (signal.aborted) { abort(); return }
        signal.addEventListener('abort', abort, { once: true })
      }
      connect.on('error', fail)
      connect.on('connect', (response, socket) => {
        if (response.statusCode !== 200) {
          socket.destroy()
          reject(new Error('the proxy refused the tunnel (' + String(response.statusCode ?? 0) + ')'))
          return
        }
        const secured = tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'] })
        secured.on('error', reject)
        const req = https.request({
          host,
          port,
          path: request.path,
          method: request.method,
          headers: request.headers,
          createConnection: () => secured,
        }, outgoing => { collect(outgoing).then(resolve, reject) })
        req.on('error', reject)
        if (request.body !== undefined) req.write(request.body)
        req.end()
      })
      connect.end()
    })
  }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const targetUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    const headers = headerRecord(init?.headers)
    const body = init?.body
    return await send(targetUrl, {
      method: init?.method ?? 'GET',
      path: (() => { const parsed = new URL(targetUrl); return parsed.pathname + parsed.search })(),
      headers,
      body: typeof body === 'string' ? body : body instanceof Uint8Array ? Buffer.from(body) : undefined,
    }, init?.signal, 0)
  }
}
