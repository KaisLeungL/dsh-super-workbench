/**
 * Outbound HTTPS client for the GitHub REST API (v2022-11-28).
 *
 * Security:
 * - Runs exclusively in the Host process.
 * - Outbound-only HTTPS to api.github.com.
 * - Credentials resolved from Host environment / profile patch; never sent to browser or agent.
 *
 * @module dsh-task-board-github/host/client
 */

import type { GitHubCommentPayload, GitHubIssuePayload, GitHubPullRequestPayload } from '../core/types.ts'
import { createProxyFetch, resolveProxyUrl, type ProxyConfiguration } from './proxy.ts'

/**
 * Base URL of the GitHub REST API this client addresses by default.
 *
 * Exported because the proxy decision is made for a destination, and every
 * caller that resolves one has to resolve it for the same destination the
 * client dials: a status line computed for a different host would report a
 * proxy the next request does not use (or hide the one it does).
 */
export const GITHUB_API_BASE_URL = 'https://api.github.com'

/**
 * Default ceiling on one GitHub request, in milliseconds.
 *
 * Generous enough for a slow connection and small enough that a wedged one
 * is bounded: a pass makes many sequential requests, so an unbounded request
 * does not cost one call, it costs the entire pass and every poll after it.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly endpoint?: string,
  ) {
    super(message)
    this.name = 'GitHubApiError'
  }
}

/**
 * A request that exceeded its ceiling.
 *
 * Distinct from a transport error so a caller can tell "GitHub said no" from
 * "GitHub never answered", which are different problems with different fixes.
 */
export class GitHubTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly endpoint: string,
  ) {
    super(`GitHub request timed out after ${String(timeoutMs)}ms: ${endpoint}`)
    this.name = 'GitHubTimeoutError'
  }
}

/**
 * A request that never reached GitHub: DNS, TCP, TLS or a proxy refused it.
 *
 * Distinct from both neighbours so a caller can act on the difference — an
 * `GitHubApiError` means GitHub answered, and a `GitHubTimeoutError` means the
 * endpoint stayed silent, while this one means the request did not get there.
 * It exists because the raw transport failure ("fetch failed") names neither the
 * endpoint nor the cause, and it is what a card stores as its sync error.
 */
export class GitHubTransportError extends Error {
  /**
   * @param endpoint - request that failed.
   * @param reason - transport cause, already phrased for a person.
   */
  constructor(
    readonly endpoint: string,
    readonly reason: string,
  ) {
    super('GitHub request failed (network): ' + reason + ': ' + endpoint)
    this.name = 'GitHubTransportError'
  }
}

/** Methods a transport failure may be repeated for. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'])

/**
 * Whether repeating one request is safe when the first attempt's fate is unknown.
 *
 * A transport failure does not prove the request never arrived: the connection
 * can die after GitHub accepted it and before the answer was read. Repeating a
 * GET costs one request, while repeating a POST creates a second comment, so
 * the split is the HTTP idempotency rule rather than a preference. A POST that
 * fails this way reports its transport cause and leaves the decision to the
 * caller, which can look before it writes again.
 * @param method - request method.
 * @returns whether a retry is allowed.
 */
function isIdempotentMethod(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase())
}

/** Attempts one request gets before the transport failure is final. */
export const TRANSPORT_ATTEMPTS = 2

/**
 * Pause between the two attempts, in milliseconds.
 *
 * Long enough that a socket which died with a network change is replaced
 * rather than reused, short enough that a pass of many requests stays bounded.
 */
export const TRANSPORT_RETRY_DELAY_MS = 250

/**
 * Whether one failure is a transport failure worth repeating.
 *
 * A timeout is not repeated: it already spent the whole ceiling, and a pass
 * makes many sequential requests. An API refusal is not repeated either — GitHub
 * answered, and asking again asks the same question.
 * @param error - the failure.
 * @returns whether the caller may try once more.
 */
function isRetryableTransportError(error: unknown): boolean {
  if (error instanceof GitHubTimeoutError) return false
  if (error instanceof GitHubApiError) return false
  if (error instanceof Error && error.name === 'AbortError') return false
  return error instanceof Error
}

/**
 * Phrase a transport cause for a card's stored sync error.
 * @param error - the failure.
 * @returns the cause, most specific available first.
 */
function transportReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return error.message + ' (' + code + ')'
    if (cause.message !== '') return error.message + ': ' + cause.message
  }
  return error.message
}

export interface GitHubClientOptions {
  /** Explicit API token (testing or direct programmatic injection). */
  token?: string
  /** Environment variable name holding the token (default: 'GITHUB_TOKEN'). */
  tokenEnv?: string
  /** Custom base URL (default: 'https://api.github.com'). */
  baseUrl?: string
  /** Injected fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof fetch
  /** Custom env dictionary (defaults to process.env). */
  env?: Record<string, string | undefined>
  /**
   * Proxy to reach GitHub through, when the deployment names one explicitly.
   *
   * Absent means the conventional variables decide (see ./proxy.ts), which is
   * the case a machine whose egress runs through a local proxy actually hits.
   */
  proxyUrl?: string
  /** Whether the conventional proxy variables are consulted (default true). */
  useEnvironmentProxy?: boolean
  /**
   * Ceiling on one request, in milliseconds.
   *
   * Every request is bounded by this. A sync pass issues a hundred or more
   * single-issue reads for the cards a listing did not return, and an
   * unbounded fetch on any of them can leave the await pending forever —
   * which wedges the whole background poll, silently, on every start. Zero or
   * less disables the bound and restores the old (unsafe) behavior.
   */
  requestTimeoutMs?: number
}

/**
 * The client's proxy options for one already-resolved configuration.
 *
 * The proxy is resolved BEFORE the client is built (it depends on the target
 * URL, the configured mode and the machine's system proxy), so the client must
 * not resolve it a second time from the environment: an explicit `undefined`
 * with the environment read switched off is the difference between "the host
 * decided direct" and "let the client guess".
 * @param configuration - the resolution, when one was made.
 * @returns proxy options for {@link GitHubClientOptions}.
 */
export function proxyClientOptions(configuration: ProxyConfiguration | undefined): { proxyUrl?: string; useEnvironmentProxy?: boolean } {
  if (configuration === undefined) return {}
  return { proxyUrl: configuration.url, useEnvironmentProxy: false }
}

export class GitHubApiClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly tokenEnv: string
  private readonly explicitToken?: string
  private readonly env: Record<string, string | undefined>
  private readonly requestTimeoutMs: number
  /** Proxy this client routes through, when one resolved. */
  readonly proxyUrl: string | undefined
  /** Token supplied by the owner per pass; wins over the configured value. */
  private liveToken: string | undefined

  constructor(options: GitHubClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, '')
    this.env = options.env ?? process.env
    this.proxyUrl = options.proxyUrl
      ?? (options.useEnvironmentProxy === false ? undefined : resolveProxyUrl(this.baseUrl, this.env))
    // An injected fetch is the test seam and owns the transport: the proxy is
    // never wrapped around it, so a test that stubs the network stays offline.
    this.fetchImpl = options.fetch
      ?? (this.proxyUrl === undefined ? globalThis.fetch : createProxyFetch(this.proxyUrl))
    this.tokenEnv = options.tokenEnv ?? 'GITHUB_TOKEN'
    this.explicitToken = options.token
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  /**
   * Replace the token this client authenticates with.
   *
   * The credential store is ASYNC, so a client cannot read it inside the
   * synchronous request path. It is resolved by the owner once per pass and
   * handed in here, which is what lets a client that was built before the
   * store came up authenticate on the next pass instead of never.
   * @param token - the live token, or undefined to fall back to the configured
   * value and the environment.
   */
  setToken(token: string | undefined): void {
    this.liveToken = token !== undefined && token.trim() !== '' ? token.trim() : undefined
  }

  /** Resolve effective GitHub token. Returns undefined when none is configured. */
  getToken(): string | undefined {
    if (this.liveToken !== undefined) return this.liveToken
    if (this.explicitToken !== undefined && this.explicitToken.trim() !== '') {
      return this.explicitToken.trim()
    }
    const token = this.env[this.tokenEnv] ?? this.env.GH_TOKEN
    return token !== undefined && token.trim() !== '' ? token.trim() : undefined
  }

  /** Whether a valid authentication credential is present on the Host. */
  hasCredential(): boolean {
    return this.getToken() !== undefined
  }

  /**
   * One request, guaranteed to settle.
   *
   * The ceiling is enforced with a real AbortSignal rather than a raced
   * promise: a race would let the caller continue while the socket stayed
   * open, and this client is shared by every poll. A fetch that ignores the
   * signal is still bounded by the race, so both guards are present — the
   * signal releases the socket, the race guarantees the await returns.
   */
  private async boundedFetch(input: string, init: RequestInit): Promise<Response> {
    const bound = this.requestTimeoutMs
    if (!(bound > 0)) return await this.fetchImpl(input, init)
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, bound)
    try {
      return await Promise.race([
        this.fetchImpl(input, { ...init, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => { reject(new GitHubTimeoutError(bound, input)) }, bound)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

/**
   * One request with a single transport retry.
   *
   * The failure this exists for is a socket that died while the Host was idle:
   * the next request inherits it and reports "fetch failed" for a destination
   * that is perfectly reachable, which is why a freshly spawned CLI works at the
   * same moment. A retry opens a new connection, and if that fails too the
   * caller gets a `GitHubTransportError` naming the endpoint and the cause
   * instead of a bare transport message.
   * @param input - absolute URL.
   * @param init - request to send.
   * @param endpoint - endpoint the request addresses, for the error.
   * @param allowRetry - whether this method may be repeated (see {@link isIdempotentMethod}).
   * @returns the response.
   */
  private async fetchWithRetry(input: string, init: RequestInit, endpoint: string, allowRetry: boolean): Promise<Response> {
    let attempt = 1
    for (;;) {
      try {
        return await this.boundedFetch(input, init)
      } catch (error) {
        const retryable = isRetryableTransportError(error)
        if (!retryable) throw error
        if (!allowRetry || attempt >= TRANSPORT_ATTEMPTS) throw new GitHubTransportError(endpoint, transportReason(error))
        attempt += 1
        await new Promise<void>(resolve => setTimeout(resolve, TRANSPORT_RETRY_DELAY_MS))
      }
    }
  }

  private async request<T>(
    endpoint: string,
    options: {
      method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
      body?: unknown
      headers?: Record<string, string>
    } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`
    const token = this.getToken()
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-task-board',
      'x-github-api-version': '2022-11-28',
      ...options.headers,
    }
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`
    }
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
    }

    const method = options.method ?? 'GET'
    const response = await this.fetchWithRetry(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    }, endpoint, isIdempotentMethod(method))

    if (!response.ok) {
      let errorDetail = response.statusText
      try {
        const data = await response.json() as { message?: string }
        if (typeof data?.message === 'string' && data.message !== '') {
          errorDetail = data.message
        }
      } catch {
        // use statusText
      }
      throw new GitHubApiError(response.status, `GitHub API error (${response.status}): ${errorDetail}`, endpoint)
    }

    if (response.status === 204) {
      return undefined as T
    }
    return (await response.json()) as T
  }

  /**
   * List issues in a repository.
   * Excludes pull requests (GitHub REST /issues returns both by default).
   */
  async listIssues(owner: string, repo: string, labels?: string[]): Promise<GitHubIssuePayload[]> {
    const params = new URLSearchParams({ state: 'all', per_page: '100' })
    if (labels !== undefined && labels.length > 0) {
      params.set('labels', labels.join(','))
    }
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params.toString()}`
    const raw = await this.request<GitHubIssuePayload[]>(endpoint)
    // Filter out pull requests
    return raw.filter(item => item.pull_request === undefined)
  }

  /** Get one specific issue by number. */
  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssuePayload> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`
    return await this.request<GitHubIssuePayload>(endpoint)
  }

  /** Update issue properties (state or title/body). */
  async updateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    patch: { state?: 'open' | 'closed'; title?: string; body?: string },
  ): Promise<GitHubIssuePayload> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`
    return await this.request<GitHubIssuePayload>(endpoint, { method: 'PATCH', body: patch })
  }

  /**
   * Post one comment on an issue (or a PR: the REST endpoint is shared).
   *
   * The body is sent verbatim. The caller is responsible for what it puts
   * there; the extension only bounds the length it will transmit.
   */
  async createComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<GitHubCommentPayload> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`
    return await this.request<GitHubCommentPayload>(endpoint, { method: 'POST', body: { body } })
  }

  /** Replace all labels on an issue. */
  async setIssueLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`
    await this.request(endpoint, { method: 'PUT', body: { labels } })
  }

  /** Add labels to an issue without removing existing ones. */
  async addIssueLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`
    await this.request(endpoint, { method: 'POST', body: { labels } })
  }

  /** Remove one specific label from an issue. Tolerates 404 (already absent). */
  async removeIssueLabel(owner: string, repo: string, issueNumber: number, labelName: string): Promise<void> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels/${encodeURIComponent(labelName)}`
    try {
      await this.request(endpoint, { method: 'DELETE' })
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return
      throw error
    }
  }

  /** Check if a branch exists remotely on the repository. */
  async getBranch(owner: string, repo: string, branch: string): Promise<{ name: string; commit: { sha: string } } | null> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`
    try {
      return await this.request<{ name: string; commit: { sha: string } }>(endpoint)
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null
      throw error
    }
  }

  /** Create a new pull request. */
  async createPullRequest(
    owner: string,
    repo: string,
    input: { title: string; head: string; base: string; body?: string; draft?: boolean },
  ): Promise<GitHubPullRequestPayload> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`
    return await this.request<GitHubPullRequestPayload>(endpoint, { method: 'POST', body: input })
  }

  /** Get pull request details by number. */
  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<GitHubPullRequestPayload> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`
    return await this.request<GitHubPullRequestPayload>(endpoint)
  }

  /**
   * Identify the account this credential authenticates as. The setup surface
   * uses it as the one call that proves a token works before it checks any
   * repository.
   */
  async getAuthenticatedUser(): Promise<{ login: string; name?: string | null }> {
    return await this.request<{ login: string; name?: string | null }>('/user')
  }

  /** Read one repository's identity facts, or throw the status that refused it. */
  async getRepository(owner: string, repo: string): Promise<{ full_name?: string; default_branch?: string; private?: boolean }> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    return await this.request<{ full_name?: string; default_branch?: string; private?: boolean }>(endpoint)
  }

  /**
   * List one repository's open issues, pull requests filtered out.
   *
   * The connection test counts through this listing with the same inclusion
   * rule the sync uses, so the number it reports is what the board would take,
   * not what a label query alone would return.
   */
  async listOpenIssues(owner: string, repo: string, cap = 100): Promise<GitHubIssuePayload[]> {
    const params = new URLSearchParams({ state: 'open', per_page: String(cap) })
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params.toString()}`
    const raw = await this.request<GitHubIssuePayload[]>(endpoint)
    return raw.filter(item => item.pull_request === undefined)
  }
}
