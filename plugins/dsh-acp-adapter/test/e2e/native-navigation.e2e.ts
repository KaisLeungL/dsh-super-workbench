import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { expect, it } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { launchAdapterWorld, root } from './scaffold.ts'
import { ACP_PACKAGE, returnToConversation } from './plugin-panel.helpers.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'
import { required } from './required.ts'
import { openAcpDiagnostics } from './agent-manager.helpers.ts'

/** Assert the native discovery action opens the existing bundle entry, not a second ACP settings surface. */
async function openAcpFromNativeMore(page: Page): Promise<void> {
  const menu = page.getByRole('menu')
  await menu.getByRole('menuitem', { name: 'Browse other plugins', exact: true }).click()
  await menu.waitFor({ state: 'detached' })
  const card = page.locator(`[data-plugin-package="${ACP_PACKAGE}"]`)
  await card.waitFor({ state: 'visible' })
  expect(await card.count()).toBe(1)
  await card.getByRole('button').first().click()
  const detail = page.locator(`[data-plugin-detail="${ACP_PACKAGE}"]`)
  await detail.waitFor({ state: 'visible' })
  await detail.getByRole('heading', { name: 'Agent configuration', exact: true }).waitFor()
  expect(await detail.count()).toBe(1)
  expect(await detail.locator('[data-dsh-acp-panel]').count()).toBe(1)
}

it('keeps ACP drafts and diagnostics reachable through RC.4 native navigation without dispatching extra work', async () => {
  const host = await launchAdapterWorld()
  let browser: TestBrowser | undefined
  const createdSessions: string[] = []
  host.ctx.on('session/created', (session) => {
    createdSessions.push(session.id)
  })
  const agentLog = join(host.workspaceCwd, 'navigation-agent.log')
  const promptCount = (): number =>
    existsSync(agentLog) ? readFileSync(agentLog, 'utf8').split('--> session/prompt ').length - 1 : 0
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'ask',
      agents: {
        codex: {
          name: 'Navigation fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'codex',
            MOCK_LOG: agentLog,
          },
        },
      },
    })
    await expect.poll(() => host.ctx.llm.listProviders().some((route) => route.id === 'acp-codex')).toBe(true)
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model: 'mock-model-a' })
    browser = await launchBrowser({
      headless: true,
      ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}),
    })
    const page = await newEnglishPage(browser)
    await page.setViewportSize({ width: 1680, height: 1000 })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const capture = async (name: string): Promise<void> => {
      const directory = process.env.DSH_E2E_EVIDENCE_DIR
      if (directory === undefined) return
      mkdirSync(directory, { recursive: true })
      await page.screenshot({ path: join(directory, name), animations: 'disabled' })
    }
    await page.goto(host.authenticatedUrl)
    await connectFreshWorkspace(page, host.workspaceCwd)
    const conversation = page.locator('[data-conversation-session]:visible').first()
    const sessionId = required(await conversation.getAttribute('data-conversation-session'))
    const createdBeforeNavigation = [...createdSessions]
    const draft = 'E2E_MESSAGE\nKeep this unsent ACP draft.'
    const input = page.locator('[data-composer-input][contenteditable="true"]:visible').first()
    // The upstream typing helper treats a newline as Enter (send). Enter the
    // multiline draft through the native line-break shortcut instead.
    await writeComposerDraft(page, input, 'E2E_MESSAGE')
    await input.press('Shift+Enter')
    await page.keyboard.type('Keep this unsent ACP draft.')
    await expect.poll(() => input.innerText()).toBe(draft)
    expect(promptCount()).toBe(0)
    // The sidecar is created lazily at binding. Check UI now and the complete
    // durable approval history after the first turn below.
    expect(await page.locator('[data-question-key]:visible').count()).toBe(0)

    // Native New Session returns to the existing blank. ACP must not replace
    // that native draft owner, create a duplicate session, or send the draft.
    await page
      .getByRole('navigation', { name: 'Global panels', exact: true })
      .getByRole('button', { name: 'More', exact: true })
      .click()
    await openAcpFromNativeMore(page)
    await capture('native-more-acp-detail-wide.png')
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    await input.waitFor({ state: 'visible' })
    await expect.poll(() => conversation.getAttribute('data-conversation-session')).toBe(sessionId)
    await expect.poll(() => input.innerText()).toBe(draft)
    await page.getByRole('button', { name: /^Select model, current Mock Model A/ }).waitFor()
    await expect.poll(() => [...createdSessions]).toEqual(createdBeforeNavigation)
    expect(promptCount()).toBe(0)
    // The sidecar is created lazily at binding. Check UI now and the complete
    // durable approval history after the first turn below.
    expect(await page.locator('[data-question-key]:visible').count()).toBe(0)
    await capture('native-new-session-preserved-draft-wide.png')

    // 建立 ACP 会话后，诊断仍可从管理页读取，聊天顶部不再注册诊断 Tab。
    const settled = host.whenTurnSettled(30_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    expect(await settled).toBe(sessionId)
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Trajectory', exact: true }).waitFor()
    expect(await page.getByRole('tab', { name: 'ACP Diagnostics', exact: true }).count()).toBe(0)
    expect(promptCount()).toBe(1)

    await page.getByRole('button', { name: 'More conversation views', exact: true }).click()
    await openAcpFromNativeMore(page)
    await returnToConversation(page, sessionId)
    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
    const guide = page.locator('[data-rightbar-col] [data-sidebar-right-guide]')
    await guide.waitFor({ state: 'visible' })
    await guide.getByRole('button', { name: 'More tools', exact: true }).click()
    await openAcpFromNativeMore(page)
    await returnToConversation(page, sessionId)
    await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()

    await openAcpDiagnostics(page, sessionId)
    const diagnostics = page.getByRole('region', { name: 'ACP Diagnostics', exact: true })
    await diagnostics.waitFor({ state: 'visible' })
    await capture('management-acp-diagnostics-wide.png')
    await page.setViewportSize({ width: 390, height: 844 })
    await expect
      .poll(() => diagnostics.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
      .toBe(true)
    await capture('management-acp-diagnostics-mobile.png')
    await page.setViewportSize({ width: 1680, height: 1000 })
    await returnToConversation(page, sessionId)
    expect(await page.getByRole('tab', { name: 'ACP Diagnostics', exact: true }).count()).toBe(0)
    await page.getByText('E2E_DONE mock-model-a', { exact: true }).waitFor()
    await expect.poll(() => [...createdSessions]).toEqual(createdBeforeNavigation)
    expect(promptCount()).toBe(1)
    expect(acpPermissionAudit(host, 'asked')).toHaveLength(0)
    expect(await page.locator('[data-question-key]:visible').count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    try {
      await browser?.close()
    } finally {
      await host.close()
    }
  }
}, 120_000)
