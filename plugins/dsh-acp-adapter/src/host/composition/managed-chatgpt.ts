/// <reference types="node" />
/** 插件独立持有的 SIWC 授权。与 Codex 原生 auth.json、旧 ACP 配置无共享写入。 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici'
import { z } from 'zod'
import { ACP_AGENT_ID_PATTERN } from '../../contract/agent-config.ts'
import type { ManagedChatGptLogin, ManagedChatGptStatus } from '../../contract/managed-chatgpt.ts'

const Credential = z.object({
  clientId: z.string(),
  subject: z.string(),
  email: z.string().nullable(),
  bindingId: z.string(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  idToken: z.string().optional(),
  expiresAt: z.number(),
  scopes: z.array(z.string()),
})
type Credential = z.infer<typeof Credential>
type Fetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>
type Discovery = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  revocation_endpoint: string
}
type Attempt = {
  state: string
  nonce: string
  verifier: string
  redirectUri: string
  server: Server
  abort: AbortController
  timer: ReturnType<typeof setTimeout>
  clientId: string | undefined
  previous: Credential | undefined
  finishing: boolean
}
const RESOURCE = 'https://api.openai.com/v1'
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const SHARING = 'chatgpt.tokens.use.direct'
export const CHATGPT_APP_NAME = 'dsh-agent-manager'
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const equal = (a: string, b: string): boolean =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
class ReauthorizationRequired extends Error {}

export interface ManagedChatGptOptions {
  root: string
  /** 仅供隔离协议测试替换网络；生产使用固定 OpenAI issuer。 */
  fetcher?: Fetcher
  issuer?: string
}

export class ManagedChatGpt {
  private readonly issuer: string
  private readonly fetcher: Fetcher
  private readonly dispatcher: EnvHttpProxyAgent | undefined
  private readonly attempts = new Map<string, Attempt>()
  private readonly messages = new Map<string, string>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private discoveryPromise: Promise<Discovery> | undefined
  private closed = false
  constructor(private readonly options: ManagedChatGptOptions) {
    this.issuer = options.issuer ?? 'https://auth.openai.com'
    this.dispatcher = options.fetcher ? undefined : new EnvHttpProxyAgent()
    this.fetcher =
      options.fetcher ??
      (async (url, init) =>
        (await proxyFetch(url, {
          ...init,
          ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
        })) as unknown as Response)
  }

  private validateId(id: string): void {
    if (!ACP_AGENT_ID_PATTERN.test(id)) throw new Error('Provider ID 无效。')
    if (this.closed) throw new Error('授权服务已关闭。')
  }
  private async directory(): Promise<void> {
    await fs.mkdir(this.options.root, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(this.options.root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('授权存储目录不可信。')
    await fs.chmod(this.options.root, 0o700)
  }
  private filename(id: string): string {
    return path.join(this.options.root, `${hash(id)}.json`)
  }
  private async read(id: string): Promise<Credential | undefined> {
    this.validateId(id)
    try {
      const name = this.filename(id)
      const stat = await fs.lstat(name)
      if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0))
        throw new Error('授权文件权限无效。')
      return Credential.parse(JSON.parse(await fs.readFile(name, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  private async save(id: string, value: Credential): Promise<void> {
    await this.directory()
    const temp = `${this.filename(id)}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
      await fs.rename(temp, this.filename(id))
    } finally {
      await fs.rm(temp, { force: true })
    }
  }
  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.queues.set(id, next)
    try {
      return await next
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id)
    }
  }
  private async discover(): Promise<Discovery> {
    return await (this.discoveryPromise ??= (async () => {
      const response = await this.fetcher(`${this.issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error('无法读取 OpenAI 授权服务。')
      const value = z
        .object({
          issuer: z.string(),
          authorization_endpoint: z.string(),
          token_endpoint: z.string(),
          jwks_uri: z.string(),
          revocation_endpoint: z.string(),
        })
        .parse(await response.json())
      if (value.issuer !== this.issuer || Object.values(value).some((url) => new URL(url).origin !== this.issuer))
        throw new Error('授权服务来源校验失败。')
      return value
    })().catch((error) => {
      this.discoveryPromise = undefined
      throw error
    }))
  }
  async status(id: string): Promise<ManagedChatGptStatus> {
    const saved = await this.read(id)
    return {
      profileId: id,
      status: this.attempts.has(id)
        ? 'pending'
        : this.messages.has(id)
          ? 'error'
          : !saved?.accessToken
            ? 'disconnected'
            : saved.scopes.includes(SHARING)
              ? 'connected'
              : 'consent-required',
      email: saved?.email ?? null,
      bindingId: saved?.bindingId ?? null,
      message: this.messages.get(id) ?? null,
    }
  }
  private async hostId(): Promise<string> {
    await this.directory()
    const name = path.join(this.options.root, 'host-id')
    try {
      await fs.writeFile(name, `urn:uuid:${randomUUID()}`, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = await fs.lstat(name)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('主机身份文件无效。')
    return await fs.readFile(name, 'utf8')
  }
  async begin(id: string): Promise<ManagedChatGptLogin> {
    return await this.serial(id, () => this.beginUnlocked(id))
  }
  private async beginUnlocked(id: string): Promise<ManagedChatGptLogin> {
    this.validateId(id)
    if (this.attempts.has(id)) throw new Error('已有授权正在进行，请先完成或取消。')
    const discovery = await this.discover()
    const previous = await this.read(id)
    const state = randomBytes(32).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      // 浏览器可能保留回调连接；授权结束后不能让它阻止 Host 卸载。
      response.setHeader('Connection', 'close')
      response.setHeader('Content-Type', 'text/plain; charset=utf-8')
      response.setHeader('Content-Security-Policy', "default-src 'none'")
      const attempt = this.attempts.get(id)
      let url: URL
      try {
        url = new URL(request.url ?? '/', attempt?.redirectUri ?? 'http://127.0.0.1')
      } catch {
        response.writeHead(400)
        response.end('授权回调无效。')
        return
      }
      if (
        !attempt ||
        request.method !== 'GET' ||
        url.pathname !== '/auth/callback' ||
        !equal(url.searchParams.get('state') ?? '', state) ||
        request.headers.host !== new URL(attempt.redirectUri).host
      ) {
        response.writeHead(400)
        response.end('授权回调无效。')
        return
      }
      if (attempt.finishing) {
        response.writeHead(409)
        response.end('正在完成授权。')
        return
      }
      attempt.finishing = true
      void this.complete(id, attempt, url)
        .then(
          () => {
            response.end('ChatGPT 授权已完成，可以关闭此页并返回 DSH。')
          },
          () => {
            response.writeHead(400)
            response.end('授权未完成，请返回 DSH 查看状态并重试。')
          },
        )
        .finally(() => this.endAttempt(id, attempt))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('无法创建本地授权回调。')
    }
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
    const attempt: Attempt = {
      state,
      nonce,
      verifier,
      redirectUri,
      server,
      previous,
      clientId: previous?.clientId,
      abort: new AbortController(),
      timer: setTimeout(() => {
        this.messages.set(id, '授权等待超时，请重试。')
        this.cancel(id)
      }, 10 * 60_000),
      finishing: false,
    }
    this.attempts.set(id, attempt)
    this.messages.delete(id)
    try {
      const url = new URL(discovery.authorization_endpoint)
      url.search = new URLSearchParams({
        client_id: previous?.clientId ?? 'dynamic_agent_client',
        ...(previous ? {} : { agent_name_hint: CHATGPT_APP_NAME }),
        ext_agent_host_id: await this.hostId(),
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SCOPE,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        ...(previous && !previous.scopes.includes(SHARING) ? { prompt: 'consent' } : {}),
      }).toString()
      return { authorizationUrl: url.toString(), status: await this.status(id) }
    } catch (error) {
      this.endAttempt(id, attempt)
      throw error
    }
  }
  private async tokenRequest(fields: URLSearchParams, signal?: AbortSignal): Promise<unknown> {
    const discovery = await this.discover()
    const response = await this.fetcher(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: fields.toString(),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
    })
    if (!response.ok) {
      const failure = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined
      if (failure?.error === 'invalid_grant' || failure?.error === 'invalid_client')
        throw new ReauthorizationRequired('OpenAI 授权已失效，请重新授权。')
      throw new Error(`OpenAI 授权请求失败（HTTP ${response.status}），请重新授权或稍后重试。`)
    }
    return await response.json()
  }
  private async complete(id: string, attempt: Attempt, callback: URL): Promise<void> {
    try {
      if (callback.searchParams.has('error')) throw new Error('你已取消或拒绝本次授权。')
      const clientId = callback.searchParams.get('client_id') ?? attempt.clientId
      if (!clientId || clientId === 'dynamic_agent_client' || (attempt.clientId && clientId !== attempt.clientId))
        throw new Error('授权注册身份不匹配。')
      const code = callback.searchParams.get('code')
      if (!code) throw new Error('授权回调缺少授权码。')
      const tokens = z
        .object({
          access_token: z.string().min(1),
          refresh_token: z.string().min(1),
          id_token: z.string().min(1),
          expires_in: z.number().positive(),
          scope: z.string(),
        })
        .parse(
          await this.tokenRequest(
            new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: clientId,
              code,
              code_verifier: attempt.verifier,
              redirect_uri: attempt.redirectUri,
              resource: RESOURCE,
            }),
            attempt.abort.signal,
          ),
        )
      const discovery = await this.discover()
      const jwksResponse = await this.fetcher(discovery.jwks_uri, {
        signal: AbortSignal.any([attempt.abort.signal, AbortSignal.timeout(25_000)]),
      })
      if (!jwksResponse.ok) throw new Error('无法验证 OpenAI 授权身份。')
      const jwks = createLocalJWKSet((await jwksResponse.json()) as Parameters<typeof createLocalJWKSet>[0])
      const { payload } = await jwtVerify(tokens.id_token, jwks, {
        issuer: this.issuer,
        audience: clientId,
        algorithms: ['RS256', 'ES256'],
        clockTolerance: 5,
        requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
      })
      if (
        typeof payload.nonce !== 'string' ||
        !equal(payload.nonce, attempt.nonce) ||
        !payload.sub ||
        (attempt.previous && attempt.previous.subject !== payload.sub)
      )
        throw new Error('返回账号与本实例不一致，请为其他账号新建 Provider。')
      const saved: Credential = {
        clientId,
        subject: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        bindingId: hash(`${clientId}\n${payload.sub}`),
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        scopes: tokens.scope.split(/\s+/),
      }
      await this.serial(id, async () => {
        if (this.attempts.get(id) !== attempt || attempt.abort.signal.aborted || this.closed)
          throw new Error('授权已取消。')
        await this.save(id, saved)
      })
      this.messages.delete(id)
    } catch (error) {
      if (this.attempts.get(id) === attempt)
        this.messages.set(
          id,
          error instanceof Error && /^(授权|你已|返回账号|无法|OpenAI 授权)/.test(error.message)
            ? error.message.slice(0, 180)
            : '授权身份验证失败，请重试。',
        )
      throw error
    }
  }
  private endAttempt(id: string, attempt: Attempt): void {
    if (this.attempts.get(id) === attempt) this.attempts.delete(id)
    clearTimeout(attempt.timer)
    attempt.abort.abort()
    attempt.server.close()
    attempt.server.closeIdleConnections()
  }
  cancel(id: string): void {
    this.validateId(id)
    const attempt = this.attempts.get(id)
    if (attempt) this.endAttempt(id, attempt)
  }

  async access(id: string, bindingId: string): Promise<string> {
    return await this.serial(id, async () => {
      let saved = await this.read(id)
      if (
        !saved?.accessToken ||
        !saved.refreshToken ||
        saved.bindingId !== bindingId ||
        !saved.scopes.includes(SHARING)
      )
        throw new Error('ChatGPT 授权不可用，请在 Provider 管理中授权。')
      if (saved.expiresAt < Date.now() + 60_000) {
        try {
          const tokens = z
            .object({
              access_token: z.string().min(1),
              refresh_token: z.string().min(1),
              expires_in: z.number().positive(),
              scope: z.string().optional(),
              id_token: z.string().optional(),
            })
            .parse(
              await this.tokenRequest(
                new URLSearchParams({
                  grant_type: 'refresh_token',
                  client_id: saved.clientId,
                  refresh_token: saved.refreshToken,
                  resource: RESOURCE,
                }),
              ),
            )
          saved = {
            ...saved,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: Date.now() + tokens.expires_in * 1000,
            ...(tokens.scope ? { scopes: tokens.scope.split(/\s+/) } : {}),
            ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
          }
          if (!saved.scopes.includes(SHARING))
            throw new ReauthorizationRequired('ChatGPT 套餐使用权限已失效，请重新授权。')
          await this.save(id, saved)
        } catch (error) {
          if (error instanceof ReauthorizationRequired) {
            const { accessToken: _access, refreshToken: _refresh, idToken: _id, ...registration } = saved
            await this.save(id, { ...registration, expiresAt: 0 })
            this.messages.set(id, error.message)
          }
          throw error
        }
      }
      return saved.accessToken!
    })
  }
  async logout(id: string): Promise<ManagedChatGptStatus> {
    this.cancel(id)
    await this.serial(id, async () => {
      const saved = await this.read(id)
      if (!saved) return
      let revoked = true
      if (saved.refreshToken) {
        try {
          const discovery = await this.discover()
          const response = await this.fetcher(discovery.revocation_endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token: saved.refreshToken,
              token_type_hint: 'refresh_token',
              client_id: saved.clientId,
            }).toString(),
            signal: AbortSignal.timeout(15_000),
          })
          revoked = response.ok
        } catch {
          revoked = false
        }
      }
      const { accessToken: _access, refreshToken: _refresh, idToken: _id, ...registration } = saved
      await this.save(id, { ...registration, expiresAt: 0 })
      if (!revoked) this.messages.set(id, '已本地退出，远端撤销未确认；可在 ChatGPT 设置中撤销应用授权。')
      else this.messages.delete(id)
    })
    return await this.status(id)
  }
  async close(): Promise<void> {
    this.closed = true
    for (const [id, attempt] of this.attempts) this.endAttempt(id, attempt)
    await Promise.allSettled([...this.queues.values()])
    await this.dispatcher?.close()
  }
}
