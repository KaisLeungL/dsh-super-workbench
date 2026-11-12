/** 显式选择已授权的托管连接；仅在独立临时 DSH 中调用 Codex。 */
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { required } from './required.ts'
import { openAgentProvider } from './agent-manager.helpers.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

it.skipIf(process.env.DSH_E2E_MANAGED_CHATGPT !== '1')(
  '托管 ChatGPT 的真实 DSH 对话、工具审批与取消',
  async () => {
    const source = process.env.DSH_E2E_CHATGPT_AUTH_DIR
    const model = process.env.DSH_E2E_CHATGPT_MODEL
    if (!source || !isAbsolute(source) || !model) throw new Error('必须显式指定已授权目录和模型。')
    const host = await launchAdapterWorld()
    let browser: TestBrowser | undefined
    const evidence = join(root, '.local/managed-chatgpt-host-live')
    mkdirSync(evidence, { recursive: true })
    const errors: string[] = []
    let stage = '启动'
    let failureView: (() => Promise<void>) | undefined
    let sessionId: SessionId | undefined
    try {
      const destination = join(host.harnessHome, 'dsh-agent-manager', 'chatgpt')
      if (resolve(source) === resolve(destination)) throw new Error('真实授权目录不能充当测试目录。')
      mkdirSync(destination, { recursive: true, mode: 0o700 })
      const file = `${createHash('sha256').update('codex-chatgpt').digest('hex')}.json`
      const expiry = (JSON.parse(readFileSync(join(source, file), 'utf8')) as { expiresAt?: number }).expiresAt
      if (typeof expiry !== 'number' || expiry < Date.now() + 10 * 60_000)
        throw new Error('请先在原托管连接中检查连接以刷新令牌；测试不会在克隆目录刷新真实授权。')
      copyFileSync(join(source, file), join(destination, file))
      chmodSync(join(destination, file), 0o600)
      // 不读取、打印令牌。克隆仅供本次有界调用，随临时 Host 目录清理。
      await host.ctx.settings.replace('dsh-acp-adapter', {
        toolApprovalDefault: 'ask',
        agents: {
          'codex-chatgpt': {
            name: 'Codex · ChatGPT',
            runtime: 'codex',
            authentication: 'chatgpt-managed',
            command: process.execPath,
            args: [join(root, '.local/agent-runtimes/node_modules/@agentclientprotocol/codex-acp/dist/index.js')],
            env: { HOME: host.workspaceCwd },
          },
        },
      })
      const remote = required(host.ctx.get('dshAcp'))
      const status = await remote.managedChatGptStatus('codex-chatgpt')
      expect(status.status).toBe('connected')
      browser = await launchBrowser({
        headless: true,
        ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
      })
      const page = await newEnglishPage(browser)
      failureView = async () => {
        await page.screenshot({ path: join(evidence, 'failure.png') })
        writeFileSync(join(evidence, 'failure-page.txt'), await page.locator('body').innerText())
      }
      page.setDefaultTimeout(20_000)
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(host.authenticatedUrl)
      await connectFreshWorkspace(page, host.workspaceCwd)
      await openAgentProvider(page)
      await page.getByRole('button', { name: 'Connections', exact: true }).click()
      const card = page.locator('[data-managed-chatgpt="codex-chatgpt"]')
      await card.getByRole('button', { name: 'Disconnect this connection', exact: true }).waitFor()
      await expect
        .poll(
          () =>
            (
              host.ctx.settings.describe().find((v) => v.ns === 'dsh-acp-adapter')?.value as {
                agents: Record<string, { authBinding?: string }>
              }
            ).agents['codex-chatgpt']?.authBinding,
        )
        .toBe(status.bindingId)
      await page.screenshot({
        path: join(evidence, 'connected.png'),
        mask: status.email ? [page.getByText(status.email, { exact: true })] : [],
      })
      const models = await host.ctx.llm.listModels('acp-codex-chatgpt')
      expect(models.some((v) => v.id === model)).toBe(true)
      await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex-chatgpt', model })
      await page
        .getByRole('button', { name: /^New session$/i })
        .last()
        .click()
      const send = async (text: string) => {
        const finished = host.whenTurnSettled(90_000)
        void finished.catch(() => undefined)
        await writeComposerDraft(page, page.locator('[data-composer-input]').first(), text)
        await page.getByRole('button', { name: 'Send message', exact: true }).click()
        return { finished }
      }
      const marker = 'DSH_HOST_CHATGPT_9372'
      stage = '真实对话'
      const first = await send(`请记住标记 ${marker}，只回复该标记，不使用工具。`)
      const session = await first.finished
      sessionId = session
      await page.getByText(marker, { exact: true }).last().waitFor()
      // 模式选择属于原生会话设置；通过真实 UI 更新宿主和 Agent 两侧。
      await page.getByRole('button', { name: /^Session ·/ }).click()
      await page.getByRole('menuitem', { name: /^Mode(?:\s|$)/ }).click()
      await page.getByRole('menuitem', { name: /^Read-only(?:\s|$)/ }).click()
      await page.getByRole('button', { name: /^Session · Read-only/ }).waitFor()
      stage = '人工工具审批'
      const second = await send(
        '必须调用 DSH 提供的 bash 工具执行 printf DSH_MANAGED_TOOL_OK，不能只文字描述。不要读取文件，不使用 Codex 自带 shell。完成后回复刚才约定的标记。',
      )
      const approval = page.locator('[data-question-key], [data-approval-key]').last()
      const next = await Promise.race([
        approval.waitFor({ timeout: 60_000 }).then(() => 'approval'),
        second.finished.then(() => 'settled'),
      ])
      if (next !== 'approval') throw new Error('人工审批模式没有产生审批请求。')
      await page.screenshot({ path: join(evidence, 'approval.png') })
      if (await approval.getAttribute('data-question-key')) {
        await approval.getByRole('radio', { name: 'Allow', exact: true }).click()
        await approval.getByRole('button', { name: /Submit|Send/ }).click()
      } else await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
      expect(await second.finished).toBe(session)
      const activity = await remote.activitySnapshot(session, { limit: 100 })
      expect(JSON.stringify(activity.activities)).toContain('DSH_MANAGED_TOOL_OK')
      await expect.poll(() => page.getByText(marker, { exact: true }).count()).toBeGreaterThanOrEqual(2)
      stage = '审批期间取消'
      const third = await send(
        '请调用 DSH 的 bash 工具执行 sleep 30，然后回复完成。不要读取文件，也不要使用 Codex 自带 shell。',
      )
      const pending = page.locator('[data-question-key], [data-approval-key]').filter({ hasText: 'sleep 30' }).last()
      await pending.waitFor({ timeout: 60_000 })
      await pending.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(await third.finished).toBe(session)
      await page.getByRole('button', { name: 'Send message', exact: true }).waitFor()
      await page.screenshot({ path: join(evidence, 'cancelled.png') })
      expect(errors).toEqual([])
      writeFileSync(
        join(evidence, 'result.json'),
        JSON.stringify(
          {
            host: '0.2.2-rc.1',
            model,
            managedIdentityBound: true,
            realReply: true,
            continuation: true,
            toolApproved: true,
            cancelledBeforeToolExecution: true,
            pageErrors: errors,
          },
          null,
          2,
        ),
      )
    } catch (error) {
      await failureView?.().catch(() => undefined)
      if (sessionId) {
        const activity = await host.ctx
          .get('dshAcp')
          ?.activitySnapshot(sessionId, { limit: 100 })
          .catch(() => undefined)
        writeFileSync(join(evidence, 'failure-activity.json'), JSON.stringify(activity, null, 2))
        writeFileSync(
          join(evidence, 'failure-events.json'),
          JSON.stringify(
            host.ctx.agents.get(sessionId)?.session.snapshotEvents(),
            (key, value) => (/token|secret|password|authorization/i.test(key) ? '[REDACTED]' : value),
            2,
          ),
        )
      }
      writeFileSync(
        join(evidence, 'failure.json'),
        JSON.stringify(
          { stage, message: error instanceof Error ? error.message : '未知失败', pageErrors: errors },
          null,
          2,
        ),
      )
      throw error
    } finally {
      await browser?.close()
      await host.close()
    }
  },
  300_000,
)
