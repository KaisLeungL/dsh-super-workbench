/** 构建产物 + 真实 Host/浏览器；ACP 协议夹具，不消耗模型额度。 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { required } from './required.ts'
import { openAgentProvider } from './agent-manager.helpers.ts'
import type { AcpRemoteService } from '../../src/remote/service.ts'

it('会话总览保留实时详情、诊断与原生导航，并移除多屏监控', async () => {
  const host = await launchAdapterWorld({ adapterDirectory: process.env.DSH_E2E_ADAPTER_DIRECTORY ?? root })
  let browser: TestBrowser | undefined
  const directory = join(root, '.local/agent-manager-ui/e2e')
  const gate = join(host.workspaceCwd, 'monitor-stream')
  mkdirSync(directory, { recursive: true })
  mkdirSync(gate, { recursive: true })
  const errors: string[] = []
  const service = host.ctx.get('dshAcp') as AcpRemoteService
  const activeJournals = new Map<string, number>()
  const follow = service.activityFollow.bind(service)
  const observedFollow = vi.spyOn(service, 'activityFollow').mockImplementation(async function* (id, ...args) {
    activeJournals.set(id, (activeJournals.get(id) ?? 0) + 1)
    try {
      yield* follow(id, ...args)
    } finally {
      activeJournals.set(id, (activeJournals.get(id) ?? 1) - 1)
    }
  })
  const journalCount = () => [...activeJournals.values()].filter((count) => count > 0).length
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: Object.fromEntries(
        ['codex', 'claude', 'gemini'].map((id) => [
          id,
          {
            name: { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' }[id]!,
            command: process.execPath,
            args: [join(root, 'test/mock-agent/mock-agent.ts')],
            env: { HOME: host.workspaceCwd, MOCK_PROFILE: id, MOCK_SCENARIO: 'regression', MOCK_RENDER_GATE_DIR: gate },
          },
        ]),
      ),
    })
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'mock-model-a' })
    browser = await launchBrowser({
      headless: true,
      ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
    })
    const page = await newEnglishPage(browser)
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const turn = host.whenTurnSettled()
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'E2E_RICH')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const lead = required(host.ctx.agents.get(await turn))
    await expect.poll(() => page.getByRole('tab', { name: 'ACP Diagnostics', exact: true }).count()).toBe(0)
    const cwd = join(host.workspaceCwd, 'workspace')
    await host.ctx.sessionController.rename({ sessionId: lead.id, title: '检查文件改动' })
    const children = []
    for (const [provider, title, prompt] of [
      ['acp-claude', '审阅实现与边界', 'E2E_RICH'],
      ['acp-gemini', '核对执行结果', 'E2E_MESSAGE'],
      ['acp-codex', '持续执行中的任务', 'E2E_RENDER_STREAM'],
    ]) {
      await host.ctx.agentDefaultModel.saveSelection({ provider: provider!, model: 'mock-model-a' })
      const { sessionId } = await host.ctx.sessionController.create({ cwd })
      const resolved = await host.ctx.sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw resolved.error
      await host.ctx.sessionController.rename({ sessionId, title: title! })
      resolved.agent.followup(
        createUserMessage({ content: [{ type: 'text', text: prompt! }], source: { kind: 'user' } }),
      )
      children.push(resolved.agent)
      if (prompt !== 'E2E_RENDER_STREAM') {
        await vi.waitFor(
          () => expect(resolved.agent.session.snapshotEvents().some((event) => event.type === 'turn/end')).toBe(true),
          { timeout: 20_000 },
        )
      } else {
        await vi.waitFor(() => expect(resolved.agent.status).toBe('running'))
      }
    }
    const stream = children[2]!
    expect(await page.getByRole('button', { name: 'Agent Provider', exact: true }).count()).toBe(0)
    await openAgentProvider(page)
    const manager = page.locator('[data-agent-manager]')
    await manager.getByRole('button', { name: 'Connections', exact: true }).waitFor()
    await manager.getByRole('button', { name: 'Overview', exact: true }).click()
    await manager.getByRole('button', { name: '检查文件改动', exact: true }).waitFor()
    await expect.poll(() => page.getByRole('dialog', { name: 'Settings', exact: true }).isVisible()).toBe(true)
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: join(directory, 'overview-dark.png') })
    await manager.getByRole('button', { name: '检查文件改动', exact: true }).click()
    await manager.getByRole('button', { name: 'ACP Diagnostics', exact: true }).click()
    const diagnostics = manager.getByRole('region', { name: 'ACP Diagnostics', exact: true })
    await diagnostics.getByText('No recorded ACP issues.', { exact: true }).waitFor()
    await diagnostics.getByRole('button', { name: 'Technical records', exact: true }).click()
    await expect.poll(() => diagnostics.locator('tbody tr').count()).toBeGreaterThan(0)
    await page.screenshot({ path: join(directory, 'diagnostics-dark.png') })
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      diagnostics.getByRole('button', { name: 'Export safe summary', exact: true }).click(),
    ])
    const exported = JSON.parse(readFileSync(required(await download.path()), 'utf8')) as { schema: string }
    expect(exported.schema).toBe('dsh-acp-support')
    await manager.getByRole('button', { name: '核对执行结果', exact: true }).click()
    await expect.poll(() => diagnostics.count()).toBe(0)
    await manager.getByRole('button', { name: 'ACP Diagnostics', exact: true }).click()
    await diagnostics.getByText('No recorded ACP issues.', { exact: true }).waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => manager.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await expect
      .poll(() => diagnostics.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
      .toBe(true)
    await page.screenshot({ path: join(directory, 'diagnostics-mobile.png') })
    await manager.getByRole('button', { name: 'Back to activity', exact: true }).click()
    await expect.poll(() => diagnostics.count()).toBe(0)
    await page.setViewportSize({ width: 1680, height: 1000 })
    await manager.getByRole('button', { name: 'Connections', exact: true }).click()
    await manager.locator('[data-provider-detail]').waitFor()
    await page.screenshot({ path: join(directory, 'connections-dark.png') })
    await manager.getByRole('button', { name: 'Overview', exact: true }).click()
    const monitor = page.locator('[data-agent-monitor]')
    await expect.poll(() => manager.locator('nav button').allTextContents()).toEqual(['Connections', 'Overview'])
    await expect.poll(() => manager.getByRole('button', { name: /monitor|pane/i }).count()).toBe(0)
    await manager.getByRole('button', { name: '持续执行中的任务', exact: true }).click()
    const running = monitor.locator(`[data-agent-monitor-pane="${stream.id}"]`)
    await running.getByText('E2E_RENDER_READY', { exact: true }).waitFor()
    await expect.poll(() => monitor.locator('[data-agent-monitor-pane]').count()).toBe(1)
    writeFileSync(join(gate, 'continue--1'), 'continue')
    await running.getByText('E2E_RENDER_READYE2E_RENDER_CHUNK_0', { exact: true }).waitFor()
    for (let index = 0; index < 5; index++) writeFileSync(join(gate, `continue-${index}`), 'continue')
    await vi.waitFor(() => expect(stream.status).toBe('idle'), { timeout: 20_000 })
    await running.getByText('Idle', { exact: true }).waitFor()
    await manager.getByRole('button', { name: '检查文件改动', exact: true }).click()
    const source = monitor.locator(`[data-agent-monitor-pane="${lead.id}"]`)
    await source.getByText('Read fixture file', { exact: true }).click()
    await source.getByText('1\tE2E_READ_LINE', { exact: true }).waitFor()
    await source.getByText('Edit fixture file', { exact: true }).click()
    await source.getByText('fixture.txt', { exact: true }).click()
    await source.getByText('E2E_NEW_LINE', { exact: true }).waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => manager.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(directory, 'overview-mobile-dark.png') })
    await page.setViewportSize({ width: 1680, height: 1000 })
    await source.getByRole('button', { name: 'Open session', exact: true }).click()
    await page.getByRole('tab', { name: 'Chat', exact: true }).waitFor()
    await expect.poll(() => monitor.count()).toBe(0)
    await expect.poll(journalCount).toBe(1)
    expect(errors).toEqual([])
    writeFileSync(
      join(directory, 'evidence.json'),
      JSON.stringify(
        {
          host: '0.2.2-rc.1',
          inference: 'protocol-fixtures-only',
          sessions: [lead.id, ...children.map((agent) => agent.id)],
          errors,
        },
        null,
        2,
      ),
    )
  } catch (error) {
    const page = browser
      ?.contexts()
      .flatMap((context) => context.pages())
      .at(-1)
    await page?.screenshot({ path: join(directory, 'failure.png') }).catch(() => {})
    writeFileSync(
      join(directory, 'failure.json'),
      JSON.stringify(
        {
          errors,
          text: await page
            ?.locator('body')
            .innerText()
            .catch(() => ''),
          failure: String(error),
        },
        null,
        2,
      ),
    )
    throw error
  } finally {
    for (let index = -1; index < 5; index++) writeFileSync(join(gate, `continue-${index}`), 'cleanup')
    await browser?.close()
    await host.close()
    observedFollow.mockRestore()
  }
})
