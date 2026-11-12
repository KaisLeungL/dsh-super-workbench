/// <reference types="node" />
/** 托管令牌通过私有本地管道按需提供给 Codex，不写进 Provider 设置或启动参数。 */
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AcpAgentConfig } from '../../contract/agent-config.ts'
import { AcpClientError } from '../../protocol/v1/errors.ts'
import type { ManagedChatGpt } from './managed-chatgpt.ts'

export class ManagedCodexRuntime {
  private readonly secret = randomBytes(32).toString('hex')
  private directory: string | undefined
  private endpoint: string | undefined
  private starting: Promise<string> | undefined
  private readonly server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const credential = request.headers.authorization ?? ''
    const expected = `Bearer ${this.secret}`
    const match = /^\/token\/([a-z][a-z0-9-]*)\/([a-f0-9]{64})$/.exec(request.url ?? '')
    if (
      request.method !== 'GET' ||
      Buffer.byteLength(credential) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(credential), Buffer.from(expected)) ||
      !match
    ) {
      response.writeHead(403)
      response.end()
      return
    }
    const id = match[1]!,
      binding = match[2]!,
      config = this.configOf(id)
    // 停用只禁止新派单；活着的子进程仍需完成已接受的调用。删除或换账号继续拒绝。
    if (config?.authentication !== 'chatgpt-managed' || config.authBinding !== binding) {
      response.writeHead(403)
      response.end()
      return
    }
    void this.auth.access(id, binding).then(
      (token) => {
        const current = this.configOf(id)
        if (current?.authentication !== 'chatgpt-managed' || current.authBinding !== binding) {
          response.writeHead(403)
          response.end()
          return
        }
        response.end(token)
      },
      () => {
        response.writeHead(401)
        response.end('ChatGPT 授权不可用。')
      },
    )
  })
  constructor(
    private readonly root: string,
    private readonly auth: ManagedChatGpt,
    private readonly configOf: (id: string) => AcpAgentConfig | undefined,
  ) {
    this.server.maxConnections = 32
    this.server.requestTimeout = 30_000
    this.server.headersTimeout = 10_000
    this.server.setTimeout(30_000, (socket) => socket.destroy())
  }
  private async listen(): Promise<string> {
    return await (this.starting ??= (async () => {
      if (process.platform === 'win32') this.endpoint = `\\\\.\\pipe\\dsh-chatgpt-${this.secret.slice(0, 16)}`
      else {
        this.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-auth-'))
        if (Buffer.byteLength(path.join(this.directory, 's')) > 100) {
          await fs.rmdir(this.directory)
          this.directory = await fs.mkdtemp('/tmp/dsh-auth-')
        }
        await fs.chmod(this.directory, 0o700)
        this.endpoint = path.join(this.directory, 's')
      }
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(this.endpoint!, () => {
          this.server.off('error', reject)
          resolve()
        })
      })
      if (process.platform !== 'win32') await fs.chmod(this.endpoint!, 0o600)
      return this.endpoint!
    })())
  }
  async prepare(id: string, config: AcpAgentConfig, baseEnv: Record<string, string>): Promise<Record<string, string>> {
    if (config.authentication !== 'chatgpt-managed') return baseEnv
    if (!config.authBinding) throw new AcpClientError('auth_required', '请先完成此 Provider 的 ChatGPT 授权。')
    try {
      await this.auth.access(id, config.authBinding)
    } catch {
      throw new AcpClientError('auth_required', '此 Provider 的 ChatGPT 授权不可用，请重新授权。')
    }
    const endpoint = await this.listen()
    const home = path.join(this.root, id)
    await fs.mkdir(home, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(home)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('托管 Codex 运行目录无效。')
    const helper = fileURLToPath(new URL('../../runtime/process/chatgpt-token-command.js', import.meta.url))
    const configText =
      [
        'model_provider="dsh_chatgpt_managed"',
        '[model_providers.dsh_chatgpt_managed]',
        'name="DSH ChatGPT"',
        'base_url="https://api.openai.com/v1"',
        'model_catalog_url="https://api.openai.com/v1/models"',
        'wire_api="responses"',
        'requires_openai_auth=false',
        'supports_websockets=false',
        '[model_providers.dsh_chatgpt_managed.auth]',
        `command=${JSON.stringify(process.execPath)}`,
        `args=${JSON.stringify([helper, endpoint, id, config.authBinding])}`,
        'timeout_ms=30000',
        'refresh_interval_ms=0',
        '[features]',
        'api_key_model_discovery=true',
      ].join('\n') + '\n'
    const temp = path.join(home, `config.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await fs.writeFile(temp, configText, { mode: 0o600, flag: 'wx' })
      await fs.rename(temp, path.join(home, 'config.toml'))
    } finally {
      await fs.rm(temp, { force: true })
    }
    const env = { ...baseEnv }
    for (const key of [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'ACCESS_TOKEN',
      'CODEX_ACCESS_TOKEN',
      'OPENAI_BASE_URL',
      'DEFAULT_AUTH_REQUEST',
    ])
      delete env[key]
    return {
      ...env,
      CODEX_HOME: home,
      CODEX_CONFIG: '{}',
      MODEL_PROVIDER: 'dsh_chatgpt_managed',
      DSH_CHATGPT_BROKER_SECRET: this.secret,
    }
  }
  async close(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined)
    this.server.closeAllConnections()
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()))
    if (this.directory) await fs.rm(this.directory, { recursive: true, force: true })
  }
}
