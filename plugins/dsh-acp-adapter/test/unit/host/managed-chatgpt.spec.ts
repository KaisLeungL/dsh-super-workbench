import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Agent, get } from 'node:http'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { ManagedChatGpt } from '../../../src/host/composition/managed-chatgpt.ts'
import { ManagedCodexRuntime } from '../../../src/host/composition/managed-codex-runtime.ts'
import { acpLaunchFingerprint } from '../../../src/domain/session/launch-fingerprint.ts'
import type { AcpAgentConfig } from '../../../src/contract/agent-config.ts'

const keys = await generateKeyPair('RS256')
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'fixture-key' }
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const issuer = 'https://issuer.test'
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

async function harness() {
  const root = await fs.mkdtemp(path.resolve('.local/managed-chatgpt-unit-'))
  let nonce = ''
  let lifetime = 3600
  let scopes = 'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct'
  let mutateClaims: (claims: Record<string, unknown>) => Record<string, unknown> = (value) => value
  let refreshCount = 0
  let revokeStatus = 200
  let refreshError: string | undefined
  const exchanges: URLSearchParams[] = []
  const auth = new ManagedChatGpt({
    root,
    issuer,
    fetcher: async (url, init) => {
      if (url.endsWith('openid-configuration'))
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          revocation_endpoint: `${issuer}/revoke`,
        })
      if (url.endsWith('/jwks')) return json({ keys: [jwk] })
      if (url.endsWith('/revoke')) return new Response('', { status: revokeStatus })
      if (!url.endsWith('/token')) throw new Error('Unexpected test network request')
      const fields = new URLSearchParams(init?.body)
      exchanges.push(fields)
      if (fields.get('grant_type') === 'refresh_token') {
        refreshCount += 1
        if (refreshError) return json({ error: refreshError }, 400)
        return json({
          access_token: `refreshed-access-${refreshCount}`,
          refresh_token: `rotated-refresh-${refreshCount}`,
          expires_in: 3600,
        })
      }
      const claims = mutateClaims({
        iss: issuer,
        aud: fields.get('client_id'),
        sub: 'fixture-user',
        email: 'fixture@example.test',
        nonce,
      })
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(keys.privateKey)
      return json({
        access_token: 'fixture-access-token',
        refresh_token: 'fixture-refresh-token',
        id_token: token,
        expires_in: lifetime,
        scope: scopes,
      })
    },
  })
  cleanups.push(
    async () => fs.rm(root, { recursive: true, force: true }),
    () => auth.close(),
  )
  const start = async (id = 'codex-chatgpt') => {
    const login = await auth.begin(id)
    const url = new URL(login.authorizationUrl)
    nonce = url.searchParams.get('nonce')!
    return {
      login,
      url,
      callback: async (patch: Record<string, string> = {}) => {
        const callback = new URL(url.searchParams.get('redirect_uri')!)
        callback.search = new URLSearchParams({
          state: url.searchParams.get('state')!,
          code: 'fixture-code',
          client_id: 'fixture-client',
          ...patch,
        }).toString()
        const result = await fetch(callback)
        await result.text()
        return result.status
      },
    }
  }
  return {
    root,
    auth,
    start,
    exchanges,
    refreshCount: () => refreshCount,
    setLifetime: (value: number) => {
      lifetime = value
    },
    setScopes: (value: string) => {
      scopes = value
    },
    mutateClaims: (mutate: typeof mutateClaims) => {
      mutateClaims = mutate
    },
    failRefresh: () => {
      refreshError = 'invalid_grant'
    },
    failRevocation: () => {
      revokeStatus = 503
    },
  }
}

describe('独立 ChatGPT 托管授权', () => {
  it('使用动态注册、PKCE、OIDC 身份校验和受保护的凭据文件；公开快照不含令牌', async () => {
    const h = await harness()
    const { url, callback } = await h.start()
    expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(url.searchParams.get('agent_name_hint')).toBe('dsh-agent-manager')
    expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127.0.0.1:\d+\/auth\/callback$/)
    expect(await callback()).toBe(200)
    const status = await h.auth.status('codex-chatgpt')
    expect(status).toMatchObject({ status: 'connected', email: 'fixture@example.test' })
    expect(JSON.stringify(status)).not.toMatch(/fixture-access-token|fixture-refresh-token|idToken/)
    const exchange = h.exchanges[0]!
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    )
    expect(exchange.get('client_id')).toBe('fixture-client')
    expect(exchange.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'))
    const file = (await fs.readdir(h.root)).find((name) => name.endsWith('.json'))!
    expect((await fs.stat(path.join(h.root, file))).mode & 0o777).toBe(0o600)
    expect(await h.auth.access('codex-chatgpt', status.bindingId!)).toBe('fixture-access-token')
  })

  it('成功回调关闭浏览器长连接，不残留阻止 Host 退出的套接字', async () => {
    const h = await harness()
    const { url } = await h.start()
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    callback.search = new URLSearchParams({
      state: url.searchParams.get('state')!,
      code: 'fixture-code',
      client_id: 'fixture-client',
    }).toString()
    const agent = new Agent({ keepAlive: true })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('浏览器回调套接字未关闭')), 1500)
        const req = get(callback, { agent }, (res) => {
          expect(res.statusCode).toBe(200)
          res.resume()
        })
        req.on('socket', (socket) =>
          socket.once('close', () => {
            clearTimeout(timer)
            resolve()
          }),
        )
        req.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
      expect((await h.auth.status('codex-chatgpt')).status).toBe('connected')
    } finally {
      agent.destroy()
    }
  })

  it('拒绝错误 state 和 Unicode state，不终止真正的授权；同实例不创建并行监听器', async () => {
    const h = await harness()
    const { callback } = await h.start()
    expect(await callback({ state: '坏'.repeat(43) })).toBe(400)
    expect(await callback({ state: 'wrong-state' })).toBe(400)
    expect((await h.auth.status('codex-chatgpt')).status).toBe('pending')
    await expect(h.auth.begin('codex-chatgpt')).rejects.toThrow(/已有授权/)
    expect(await callback()).toBe(200)
  })

  it.each(['nonce', 'aud', 'iss', 'sub'])('身份 %s 不匹配时不保存凭据', async (claim) => {
    const h = await harness()
    h.mutateClaims((value) => ({ ...value, [claim]: claim === 'sub' ? '' : 'incorrect' }))
    const { callback } = await h.start()
    expect(await callback()).toBe(400)
    expect((await h.auth.status('codex-chatgpt')).status).toBe('error')
    expect((await fs.readdir(h.root)).filter((name) => name.endsWith('.json'))).toEqual([])
  })

  it('没有套餐使用授权时可识别身份，但不提供推理令牌；重新授权请求 consent', async () => {
    const h = await harness()
    h.setScopes('openid profile email')
    const first = await h.start()
    expect(await first.callback()).toBe(200)
    const status = await h.auth.status('codex-chatgpt')
    expect(status.status).toBe('consent-required')
    await expect(h.auth.access('codex-chatgpt', status.bindingId!)).rejects.toThrow(/授权不可用/)
    const { url } = await h.start()
    expect(url.searchParams.get('client_id')).toBe('fixture-client')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.has('agent_name_hint')).toBe(false)
  })

  it('并发请求只刷新一次、保存轮换令牌；注销后不再提供令牌，并保留注册身份', async () => {
    const h = await harness()
    h.setLifetime(1)
    const first = await h.start()
    await first.callback()
    const binding = (await h.auth.status('codex-chatgpt')).bindingId!
    const tokens = await Promise.all(Array.from({ length: 8 }, () => h.auth.access('codex-chatgpt', binding)))
    expect(new Set(tokens)).toEqual(new Set(['refreshed-access-1']))
    expect(h.refreshCount()).toBe(1)
    expect((await h.auth.logout('codex-chatgpt')).status).toBe('disconnected')
    await expect(h.auth.access('codex-chatgpt', binding)).rejects.toThrow(/授权不可用/)
    expect((await h.start()).url.searchParams.get('client_id')).toBe('fixture-client')
  })

  it('刷新授权永久失效后清除令牌、保留注册身份，并要求重新授权', async () => {
    const h = await harness()
    h.setLifetime(1)
    await (await h.start()).callback()
    const binding = (await h.auth.status('codex-chatgpt')).bindingId!
    h.failRefresh()
    await expect(h.auth.access('codex-chatgpt', binding)).rejects.toThrow(/授权已失效/)
    await expect(h.auth.access('codex-chatgpt', binding)).rejects.toThrow(/授权不可用/)
    expect(h.refreshCount()).toBe(1)
    expect((await h.auth.status('codex-chatgpt')).message).toContain('重新授权')
    expect((await h.start()).url.searchParams.get('client_id')).toBe('fixture-client')
  })

  it('远端撤销失败时清除本地令牌并明确显示未确认；取消授权不保存凭据', async () => {
    const h = await harness()
    const pending = await h.start()
    h.auth.cancel('codex-chatgpt')
    expect((await h.auth.status('codex-chatgpt')).status).toBe('disconnected')
    await expect(pending.callback()).rejects.toThrow()
    const next = await h.start()
    await next.callback()
    h.failRevocation()
    expect((await h.auth.logout('codex-chatgpt')).message).toContain('远端撤销未确认')
  })

  it('托管状态使用独立 Codex 目录和私有令牌命令，配置、指纹不含令牌', async () => {
    const h = await harness()
    await (await h.start()).callback()
    const binding = (await h.auth.status('codex-chatgpt')).bindingId!
    const config: AcpAgentConfig = {
      name: 'Managed',
      command: 'codex-acp',
      args: [],
      env: {},
      runtime: 'codex',
      authentication: 'chatgpt-managed',
      authBinding: binding,
    }
    let current: AcpAgentConfig | undefined = config
    const runtime = new ManagedCodexRuntime(path.join(h.root, 'runtimes'), h.auth, () => current)
    cleanups.push(() => runtime.close())
    const env = await runtime.prepare('codex-chatgpt', config, {
      OPENAI_API_KEY: 'old-key',
      CODEX_HOME: '/old-cli-home',
    })
    expect(env.CODEX_HOME).not.toBe('/old-cli-home')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    const toml = await fs.readFile(path.join(env.CODEX_HOME!, 'config.toml'), 'utf8')
    expect(toml).toContain('dsh_chatgpt_managed')
    const args = JSON.parse(
      toml
        .split('\n')
        .find((line) => line.startsWith('args='))!
        .slice(5),
    ) as string[]
    const run = promisify(execFile)
    const result = await run(
      process.execPath,
      [path.resolve('src/runtime/process/chatgpt-token-command.ts'), ...args.slice(1)],
      { env: { ...process.env, ...env } },
    )
    expect(result.stdout).toBe('fixture-access-token')
    expect(result.stderr).toBe('')
    current = { ...config, enabled: false }
    expect(
      (
        await run(process.execPath, [path.resolve('src/runtime/process/chatgpt-token-command.ts'), ...args.slice(1)], {
          env: { ...process.env, ...env },
        })
      ).stdout,
    ).toBe('fixture-access-token')
    current = undefined
    await expect(
      run(process.execPath, [path.resolve('src/runtime/process/chatgpt-token-command.ts'), ...args.slice(1)], {
        env: { ...process.env, ...env },
      }),
    ).rejects.toMatchObject({ code: 1 })
    current = config
    await expect(
      run(process.execPath, [path.resolve('src/runtime/process/chatgpt-token-command.ts'), ...args.slice(1)], {
        env: { ...process.env, ...env, DSH_CHATGPT_BROKER_SECRET: 'wrong' },
      }),
    ).rejects.toMatchObject({ code: 1 })

    expect(toml).not.toContain('fixture-access-token')
    expect(toml).not.toContain(env.DSH_CHATGPT_BROKER_SECRET!)
    const fingerprint = acpLaunchFingerprint({ profileId: 'codex-chatgpt', config })
    expect(fingerprint.managedAuth).toBe(binding)
    expect(JSON.stringify(fingerprint)).not.toContain('fixture-access-token')
    const legacy: AcpAgentConfig = { name: 'old', command: 'codex-acp', args: [], env: {} }
    expect(acpLaunchFingerprint({ profileId: 'codex', config: legacy }).managedAuth).toBeUndefined()
    await expect(h.auth.access('codex-chatgpt', 'wrong-binding')).rejects.toThrow(/授权不可用/)
  })
})
