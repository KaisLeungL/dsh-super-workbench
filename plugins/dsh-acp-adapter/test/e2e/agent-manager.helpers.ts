import type { Page } from 'playwright'

/** 从原生设置侧栏进入 Agent Provider。 */
export async function openAgentProvider(page: Page, locale: 'en' | 'zh' = 'en'): Promise<void> {
  const dialog = page.getByRole('dialog', { name: locale === 'zh' ? '设置' : 'Settings', exact: true })
  if (!(await dialog.isVisible())) {
    await page.getByRole('button', { name: locale === 'zh' ? '账号菜单' : 'Account menu', exact: true }).click()
    await page.getByRole('menuitem', { name: locale === 'zh' ? '设置' : 'Settings', exact: true }).click()
  }
  await dialog.getByRole('button', { name: 'Agent Provider', exact: true }).click()
}

/** 从设置中的会话总览打开指定会话诊断。 */
export async function openAcpDiagnostics(page: Page, sessionId: string, locale: 'en' | 'zh' = 'en'): Promise<void> {
  await openAgentProvider(page, locale)
  const manager = page.locator('[data-agent-manager]')
  await manager.getByRole('button', { name: locale === 'zh' ? '会话总览' : 'Overview', exact: true }).click()
  await manager.locator(`[data-agent-manager-session="${sessionId}"]`).getByRole('button').click()
  await manager.getByRole('button', { name: locale === 'zh' ? 'ACP 诊断' : 'ACP Diagnostics', exact: true }).click()
  await manager.locator('[data-acp-diagnostics]').waitFor()
}
