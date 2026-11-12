/** 真实 Host 与浏览器；两个 Codex 类型使用离线 ACP 夹具，不调用真实账号。 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import type { AcpAgentConfig } from '../../src/contract/agent-config.ts'
import { profileLaunchIdentityHash } from '../../src/domain/session/launch-fingerprint.ts'
import { required } from './required.ts'
import { openAgentProvider } from './agent-manager.helpers.ts'

it('Provider 向导、多实例隔离、启停保留执行与历史、配置回读和响应式布局', async () => {
  const host = await launchAdapterWorld({ adapterDirectory: process.env.DSH_E2E_ADAPTER_DIRECTORY ?? root })
  let browser: TestBrowser | undefined
  const evidence = join(root, '.local/provider-management-e2e')
  const gate = join(host.workspaceCwd, 'provider-stream')
  mkdirSync(evidence, { recursive: true })
  mkdirSync(gate, { recursive: true })
  const original: AcpAgentConfig = {
    name: 'Codex Personal',
    command: process.execPath,
    args: [join(root, 'test/mock-agent/mock-agent.ts')],
    env: {
      HOME: host.workspaceCwd,
      CODEX_HOME: join(host.workspaceCwd, 'personal'),
      MOCK_SCENARIO: 'regression',
      MOCK_PROFILE: 'codex',
      MOCK_ADVERTISE_RESUME: '1',
      MOCK_LOG: join(host.workspaceCwd, 'personal.log'),
      MOCK_RENDER_GATE_DIR: gate,
      API_TOKEN: 'PRIVATE_FIXTURE_VALUE',
    },
  }
  const configurations = () =>
    (
      host.ctx.settings.describe().find((row) => row.ns === 'dsh-acp-adapter')?.value as {
        agents: Record<string, AcpAgentConfig>
      }
    ).agents
  const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const turns = (agent: { session: { snapshotEvents(): readonly { type: string }[] } }) =>
    agent.session.snapshotEvents().filter((event) => event.type === 'turn/end').length
  const errors: string[] = []
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', { agents: { codex: original } })
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'mock-model-a' })
    browser = await launchBrowser({
      headless: true,
      ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
    })
    const page = await newEnglishPage(browser)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const initialTurn = host.whenTurnSettled()
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_MESSAGE')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const lead = required(host.ctx.agents.get(await initialTurn))
    const originalFingerprint = profileLaunchIdentityHash('codex', original)
    await openAgentProvider(page)
    const manager = page.locator('[data-agent-manager]')
    await manager.getByRole('button', { name: 'Connections', exact: true }).click()
    const providers = manager.locator('[data-dsh-acp-management]')
    const detail = () => providers.locator('[data-provider-detail]')
    await detail().getByText('Unknown · Managed by CLI', { exact: true }).waitFor()
    expect(await providers.innerText()).not.toContain('PRIVATE_FIXTURE_VALUE')
    expect(await detail().getByLabel('ID', { exact: true }).isDisabled()).toBe(true)
    await page.screenshot({ path: join(evidence, 'providers-before.png') })

    await providers.getByRole('button', { name: 'Add provider', exact: false }).click()
    const wizard = providers.locator('[data-provider-wizard]')
    await wizard.getByLabel('Search ACP types').fill('Codex')
    await wizard
      .getByRole('button')
      .filter({ hasText: /^CodexAdapter tested$/ })
      .click()
    expect(await wizard.getByLabel('ID', { exact: true }).inputValue()).toBe('codex-2')
    await wizard.getByLabel('ID', { exact: true }).fill('codex')
    expect(await wizard.getByRole('button', { name: 'Next', exact: true }).isDisabled()).toBe(true)
    await wizard.getByLabel('ID', { exact: true }).fill('codex-work')
    await wizard.getByLabel('Display name', { exact: true }).fill('Codex Work')
    await page.screenshot({ path: join(evidence, 'wizard-identity.png') })
    await wizard.getByRole('button', { name: 'Next', exact: true }).click()
    await wizard.locator('summary').filter({ hasText: 'Runtime' }).click()
    await wizard.getByLabel('Executable', { exact: true }).fill(process.execPath)
    await wizard.getByLabel('Arguments', { exact: true }).fill(join(root, 'test/mock-agent/mock-agent.ts'))
    const workEnv = {
      HOME: host.workspaceCwd,
      CODEX_HOME: join(host.workspaceCwd, 'work'),
      MOCK_SCENARIO: 'regression',
      MOCK_PROFILE: 'codex',
      MOCK_ADVERTISE_RESUME: '1',
      MOCK_LOG: join(host.workspaceCwd, 'work.log'),
    }
    await wizard.getByLabel('Environment', { exact: true }).fill(
      Object.entries(workEnv)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    )
    await wizard.getByRole('button', { name: 'Save and check', exact: true }).click()
    await providers.locator('[data-provider-detail="codex-work"]').waitFor()
    await expect.poll(() => configurations()['codex-work']?.runtime).toBe('codex')
    await detail()
      .getByText(/Last check discovered \d+ models/)
      .waitFor()
    expect(configurations().codex).toEqual(original)
    expect(configurations()['codex-work']?.env).toEqual(workEnv)
    expect(profileLaunchIdentityHash('codex', configurations().codex!)).toBe(originalFingerprint)
    expect(profileLaunchIdentityHash('codex-work', configurations()['codex-work']!)).not.toBe(originalFingerprint)

    // 在第二个同类型实例上真实派发 ACP 消息，再编辑显示名，确认不改 ID。
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex-work', model: 'mock-model-a' })
    const { sessionId } = await host.ctx.sessionController.create({ cwd: lead.session.header.cwd! })
    const workResolution = await host.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in workResolution) throw workResolution.error
    workResolution.agent.followup(message('E2E_MESSAGE WORK_INSTANCE'))
    await vi.waitFor(() => expect(turns(workResolution.agent)).toBe(1), { timeout: 20_000 })
    expect(readFileSync(workEnv.MOCK_LOG, 'utf8')).toContain('WORK_INSTANCE')
    expect(readFileSync(original.env.MOCK_LOG!, 'utf8')).not.toContain('WORK_INSTANCE')
    await detail().getByLabel('Display name', { exact: true }).fill('Codex Work Updated')
    await detail().getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => configurations()['codex-work']?.name).toBe('Codex Work Updated')
    expect(configurations().codex?.name).toBe('Codex Personal')

    // 已接受的执行不因停用被取消；新调用和模型目录必须被门控。
    lead.followup(message('E2E_RENDER_STREAM'))
    await vi.waitFor(() => expect(readFileSync(original.env.MOCK_LOG!, 'utf8')).toContain('E2E_RENDER_STREAM'), {
      timeout: 20_000,
    })
    const personalRow = providers.locator('[data-provider-instance="codex"]')
    await personalRow.getByRole('switch').click()
    await expect.poll(() => configurations().codex?.enabled).toBe(false)
    await expect.poll(async () => (await host.ctx.llm.listModels('acp-codex')).length).toBe(0)
    await expect(host.ctx.llm.prepareCall({ provider: 'acp-codex', model: 'mock-model-a' })).rejects.toMatchObject({
      code: 'ACP_PROFILE_DISABLED',
    })
    for (let index = -1; index < 5; index++) writeFileSync(join(gate, `continue-${index}`), 'continue')
    await vi.waitFor(() => expect(turns(lead)).toBe(2), { timeout: 20_000 })
    const events = JSON.stringify(lead.session.snapshotEvents())
    expect(events).toContain('E2E_RENDER_CHUNK_4')
    expect(events).not.toContain('ACP_PROFILE_DISABLED')
    await personalRow.getByRole('switch').click()
    await expect.poll(() => configurations().codex?.enabled).toBe(true)
    await expect.poll(async () => (await host.ctx.llm.listModels('acp-codex')).length).toBeGreaterThan(0)
    lead.followup(message('E2E_MESSAGE ORIGINAL_HISTORY_CONTINUES'))
    await vi.waitFor(() => expect(turns(lead)).toBe(3), { timeout: 20_000 })
    expect(lead.session.requestHeader()?.config.provider).toBe('acp-codex')
    expect(workResolution.agent.session.requestHeader()?.config.provider).toBe('acp-codex-work')

    await personalRow.getByRole('button', { name: /Codex Personal/ }).click()
    await detail().getByRole('button', { name: 'Check connection', exact: true }).click()
    await detail()
      .getByText(/Last check discovered \d+ models/)
      .waitFor()
    expect(await providers.innerText()).not.toContain('PRIVATE_FIXTURE_VALUE')
    expect(await detail().getByLabel('Environment', { exact: true }).inputValue()).not.toContain(
      'PRIVATE_FIXTURE_VALUE',
    )
    await detail().getByRole('heading', { name: 'Models', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(evidence, 'providers-models.png') })
    await providers.evaluate((element) => {
      element.scrollTop = 0
    })
    await page.screenshot({ path: join(evidence, 'providers-light.png') })
    await host.ctx.settings.replace('ui-theme', { preference: 'dark' })
    await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark')
    await page.screenshot({ path: join(evidence, 'providers-dark.png') })
    await page.setViewportSize({ width: 390, height: 1000 })
    await page.locator('[data-sidebar-drawer][data-sidebar-collapsed]').waitFor({ state: 'attached' })
    await page.locator('[data-shell-leading]').getByRole('button', { name: 'Open sidebar', exact: true }).waitFor()
    await page.getByRole('dialog', { name: 'Navigation', exact: true }).waitFor({ state: 'hidden' })
    await providers.evaluate((element) => {
      element.scrollTop = 0
    })
    await expect.poll(() => providers.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true)
    const geometry = await providers.evaluate((element) => ({
      viewport: window.innerWidth,
      nodes: [element, ...element.querySelectorAll('*')]
        .map((node) => {
          const rect = node.getBoundingClientRect()
          return {
            tag: node.tagName,
            className: node.getAttribute('class'),
            left: rect.left,
            right: rect.right,
            width: rect.width,
            scrollWidth: node.scrollWidth,
            clientWidth: node.clientWidth,
          }
        })
        .filter((node) => node.width > 0 && (node.right > window.innerWidth + 1 || node.left < -1)),
    }))
    writeFileSync(join(evidence, 'narrow-geometry.json'), JSON.stringify(geometry, null, 2))
    await expect
      .poll(() => providers.evaluate((element) => element.getBoundingClientRect().right))
      .toBeLessThanOrEqual(391)
    await expect
      .poll(() =>
        detail()
          .locator('header')
          .evaluate((element) => element.getBoundingClientRect().right),
      )
      .toBeLessThanOrEqual(391)
    await page.screenshot({ path: join(evidence, 'providers-narrow.png') })
    await detail().getByRole('heading', { name: 'Environment', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(evidence, 'providers-narrow-detail.png') })
    const zhPage = await browser.newPage({
      viewport: { width: 1680, height: 1000 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    })
    await zhPage.goto(host.authenticatedUrl)
    await openAgentProvider(zhPage, 'zh')
    await zhPage.getByRole('button', { name: '接入管理', exact: true }).click()
    await zhPage.locator('[data-provider-instance="codex-work"]').waitFor()
    await zhPage.screenshot({ path: join(evidence, 'providers-zh.png') })
    await zhPage.close()
    await page.setViewportSize({ width: 1680, height: 1000 })
    await providers
      .locator('[data-provider-instance="codex-work"]')
      .getByRole('button', { name: /Codex Work Updated/ })
      .click()
    await detail().getByRole('button', { name: 'Delete instance', exact: true }).click()
    const confirmation = detail().getByRole('region', { name: 'Delete this provider?', exact: true })
    await confirmation.waitFor()
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(configurations()['codex-work']).toBeDefined()
    await page.reload()
    await openAgentProvider(page)
    await manager.getByRole('button', { name: 'Connections', exact: true }).click()
    await providers.locator('[data-provider-instance="codex-work"]').waitFor()
    await providers.getByRole('button', { name: 'Add provider', exact: false }).click()
    await providers.locator('[data-provider-wizard]').waitFor()
    await page.keyboard.press('Escape')
    await providers.locator('[data-provider-wizard]').waitFor({ state: 'hidden' })
    await providers
      .locator('[data-provider-instance="codex-work"]')
      .getByRole('button', { name: /Codex Work Updated/ })
      .click()
    await detail().getByRole('button', { name: 'Delete instance', exact: true }).click()
    await detail()
      .getByRole('region', { name: 'Delete this provider?', exact: true })
      .getByRole('button', { name: 'Delete instance', exact: true })
      .click()
    await expect.poll(() => configurations()['codex-work']).toBeUndefined()
    expect(turns(workResolution.agent)).toBe(1)
    expect(JSON.stringify(workResolution.agent.session.snapshotEvents())).toContain('WORK_INSTANCE')
    expect(configurations().codex?.enabled).toBe(true)
    // 新托管实例与旧 ACP 共存；无授权时不启动真实 Agent，也不复用旧环境凭据。
    await providers.getByRole('button', { name: 'Add provider', exact: false }).click()
    const managedWizard = providers.locator('[data-provider-wizard]')
    await managedWizard.getByRole('button', { name: /Codex · Managed ChatGPT/ }).click()
    await managedWizard.getByRole('button', { name: 'Next', exact: true }).click()
    await managedWizard.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => configurations()['codex-chatgpt']?.authentication).toBe('chatgpt-managed')
    const managed = detail().locator('[data-managed-chatgpt="codex-chatgpt"]')
    await managed.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).waitFor()
    expect(configurations()['codex-chatgpt']?.env).toEqual({})
    expect(configurations().codex?.env.API_TOKEN).toBe('PRIVATE_FIXTURE_VALUE')
    expect(configurations().codex?.authentication).toBeUndefined()
    expect(configurations()['codex-chatgpt']?.authBinding).toBeUndefined()
    await page.screenshot({ path: join(evidence, 'managed-chatgpt-disconnected.png') })
    expect(errors).toEqual([])
    writeFileSync(
      join(evidence, 'result.json'),
      JSON.stringify(
        {
          host: '0.2.2-rc.1',
          protocolFixture: true,
          multiCodex: true,
          disabledAcceptedTurnCompleted: true,
          originalHistoryContinued: true,
          secretValueNotRendered: true,
          pageErrors: errors,
        },
        null,
        2,
      ),
    )
  } finally {
    await browser?.close()
    await host.close()
  }
}, 120_000)
