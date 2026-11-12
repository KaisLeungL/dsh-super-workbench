import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { launchAdapterWorld, root } from './scaffold.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { executeTool } from '../native-tools.ts'
import type { AcpRemoteService } from '../../src/remote/service.ts'
import { required } from './required.ts'
import { openAgentProvider } from './agent-manager.helpers.ts'

for (const live of [false, true]) {
  it.skipIf(live && process.env.DSH_E2E_LIVE_MANAGED !== '1')(
    live ? '真实 Codex 主 Agent 创建 Claude 成员并继续其原生团队会话' : '协议夹具：两个外部 Agent 的原生团队派单、追问与刷新',
    async () => {
      const host = await launchAdapterWorld({ teams: true, adapterDirectory: process.env.DSH_E2E_ADAPTER_DIRECTORY ?? root })
      let browser: TestBrowser | undefined
      const token = `MANAGED_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      const directory = join(root, '.local/managed-agents-e2e', live ? 'live' : 'protocol')
      mkdirSync(directory, { recursive: true })
      const evidence: Record<string, unknown> = { live, token }
      const events = new Map<string, SessionEvent[]>()
      host.ctx.on('session/event', (session, event) => {
        const log = events.get(session.id) ?? []
        log.push(event)
        events.set(session.id, log)
      })
      const turns = (id: string) => (events.get(id) ?? []).filter((event) => event.type === 'turn/end')
      const replies = (id: string) => (events.get(id) ?? []).filter((event) => event.type === 'assistant/message')
        .flatMap((event) => event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text))
      try {
        const model = live ? required(process.env.DSH_E2E_LIVE_CODEX_MODEL) : 'mock-model-a'
        const childModel = live ? 'haiku' : 'mock-model-a'
        await host.ctx.settings.replace('dsh-acp-adapter', {
          toolApprovalDefault: 'auto',
          agents: Object.fromEntries(['codex', 'claude'].map((id) => [id, {
            name: live ? id : `Protocol fixture ${id}`,
            command: live ? `${id === 'codex' ? 'codex' : 'claude-agent'}-acp` : process.execPath,
            args: live ? [] : [join(root, 'test/mock-agent/mock-agent.ts')],
            env: live
              ? id === 'claude' ? {
                ANTHROPIC_DEFAULT_HAIKU_MODEL: required(process.env.DSH_E2E_CLAUDE_HAIKU_ALIAS),
              } : {}
              : { MOCK_STEP_DELAY_MS: '2', MOCK_PROFILE: id, MOCK_MCP_HTTP: '1' },
          }])),
        })
        await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-codex', model, ...(live ? { reasoningEffort: ReasoningEffortId('low') } : {}) })
        browser = await launchBrowser({ headless: true,
          ...(process.env.DSH_E2E_BROWSER_CHANNEL ? { channel: process.env.DSH_E2E_BROWSER_CHANNEL } : {}) })
        const page = await newEnglishPage(browser)
        const pageErrors: string[] = []
        page.on('pageerror', (error) => pageErrors.push(error.message))
        await page.goto(host.authenticatedUrl)
        await connectFreshWorkspace(page, host.workspaceCwd)
        const executionNames: string[] = []
        let spawningLead: Agent | undefined
        host.ctx.on('tools/result', (exec, result) => {
          if (!result.isError) executionNames.push(exec.name)
          if (exec.name === 'acp_spawn_agent' && !result.isError) spawningLead = exec.agent
        })
        const prompt = live
          ? `This is an authorized isolated Agent Teams integration check. Use ONLY the DSH MCP tools named in the current host instructions, not Codex's own delegation tools. Call acp_spawn_agent exactly once with agent_id="claude", model="haiku", name="reviewer", description="Verify the mixed Agent connection", prompt="Reply with ${token}_CHILD only. Do not call tools or read/write files.". Then wait for that member's completion notice; use the DSH wait_agent tool if needed. Finally reply with ${token}_LEAD. Do not create other teammates or shared tasks.`
          : '只回复一句话，初始化这个协议验证会话。'
        const initial = host.whenTurnSettled(120_000)
        void initial.catch(() => {})
        await writeComposerDraft(page, page.locator('[data-composer-input]').first(), prompt)
        await page.getByRole('button', { name: 'Send message', exact: true }).click()
        if (live) await vi.waitFor(() => expect(spawningLead).toBeDefined(), { timeout: 120_000 })
        const lead = live ? required(spawningLead) : required(host.ctx.agents.get(await initial))
        const leadId = lead.id
        let child: Agent
        if (live) {
          await vi.waitFor(() => expect(executionNames).toContain('acp_spawn_agent'), { timeout: 120_000 })
          const row = required(host.ctx.agentTeams.listMembers(lead).find((row) => row.name === 'reviewer'))
          child = required(host.ctx.agents.get(row.id))
          await vi.waitFor(() => {
            expect(child.session.requestHeader()?.config.provider).toBe('acp-claude')
            expect(child.status).toBe('idle')
          }, { timeout: 120_000 })
        } else {
          const signal = new AbortController().signal
          const toolSet = await host.ctx.tools.resolve({ agent: lead, modelSelection: lead.model.current()!, signal })
          let result
          try {
            result = await host.ctx.agents.withInitiator(lead, () => executeTool(host.ctx.tools, {
              agent: lead, signal, toolSet, callId: ToolCallId('mixed-team-fixture'), name: 'acp_spawn_agent',
              arguments: { agent_id: 'claude', model: childModel, name: 'reviewer', description: '验证跨 Agent 路由', prompt: '完成协议检查。' },
            }))
          } finally { toolSet.dispose() }
          expect(result.isError, JSON.stringify(result.content)).toBe(false)
          const row = required(host.ctx.agentTeams.listMembers(lead).find((row) => row.name === 'reviewer'))
          child = required(host.ctx.agents.get(row.id))
          await vi.waitFor(() => expect(child.session.requestHeader()?.config.provider).toBe('acp-claude'), { timeout: 20_000 })
        }
        await vi.waitFor(() => expect(turns(child.id)).toHaveLength(1), { timeout: 120_000 })
        if (live) {
          expect(replies(child.id).join('')).toContain(`${token}_CHILD`)
          await vi.waitFor(() => expect(host.ctx.agentTeams.listMembers(lead).find((row) => row.id === child.id)?.status)
            .toBe('inactive'), { timeout: 20_000 })
          // Claude's own Auto classifier may deny opaque MCP mutations without
          // asking ACP. Manual keeps native DSH approval and sandbox checks intact.
          const snapshot = await (host.ctx.get('dshAcp') as AcpRemoteService).setTeamMemberMode(lead.id, child.id, 'default')
          expect(snapshot.pendingModeId ?? snapshot.currentModeId).toBe('default')
          expect(await (host.ctx.get('dshAcp') as AcpRemoteService).teamMemberModels(lead.id, child.id))
            .toMatchObject({ writable: false })
          evidence.claudeMode = 'default'
        } else {
          await vi.waitFor(() => expect(host.ctx.agentTeams.listMembers(lead).find((row) => row.id === child.id)?.status)
            .toBe('inactive'), { timeout: 20_000 })
          const service = host.ctx.get('dshAcp') as AcpRemoteService
          expect(await service.teamMemberModels(lead.id, child.id)).toMatchObject({ writable: false })
          await expect(service.setTeamMemberModel(lead.id, child.id, 'mock-model-b')).rejects.toThrow()
        }
        const task = await host.ctx.agentTeams.createTask(lead, { subject: '混合 Agent 验证', description: '验证成员任务的原生归属。' })
        await host.ctx.agentTeams.sendMessage(lead, {
          target: 'reviewer', content: [{ type: 'text', text: live
            ? `This new authorized task supersedes the previous no-tools instruction. Use ONLY your current DSH MCP connection. Discover the exact schemas of team_task_get and team_task_update. Get shared task ${task.id}, claim it with its current revision, get its latest revision and complete it yourself. Do not use shell, files or other delegation. After the actual successful tool calls, reply ${token}_FOLLOWUP.`
            : `只回复 ${token}_FOLLOWUP，不调用工具。` }],
          signal: new AbortController().signal,
        })
        await vi.waitFor(() => {
          expect(turns(child.id)).toHaveLength(2)
          expect(turns(child.id).every((event) => event.data.reason.kind === 'completed')).toBe(true)
        }, { timeout: 120_000 })
        if (live) {
          expect(replies(child.id).join('')).toContain(`${token}_FOLLOWUP`)
          await vi.waitFor(() => expect(replies(lead.id).join('')).toContain(`${token}_LEAD`), { timeout: 120_000 })
          expect(executionNames).toContain('team_task_update')
        }
        const headers = (events.get(child.id) ?? []).filter((event) => event.type === 'request/header')
        // 原生 Host 仅在头变化或新 request series 时记录；连续两轮可共用同一头。
        expect(headers.length).toBeGreaterThan(0)
        expect(child.session.requestHeader()?.config.provider).toBe('acp-claude')
        expect(headers.every((event) => event.data.header.config.provider === 'acp-claude')).toBe(true)
        if (!live) expect(headers.at(-1)?.data.header.config.model).toBe('mock-model-a')
        let completed = host.ctx.agentTeams.getTask(lead, task.id)
        if (!live) {
          const claimed = await host.ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
          completed = await host.ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: claimed.revision, action: 'complete' })
        }
        expect(completed.status).toBe('completed')
        expect(completed.ownerName).toBe(live ? 'reviewer' : 'lead')
        await page.reload()
        await page.locator('[data-composer-input]').first().waitFor()
        expect(host.ctx.agentTeams.listMembers(lead).find((row) => row.id === child.id)?.name).toBe('reviewer')
        if (!live) {
          await openAgentProvider(page)
          const manager = page.locator('[data-agent-manager]')
          await manager.getByRole('button', { name: 'Overview', exact: true }).click()
          await manager.locator(`[data-agent-manager-session="${child.id}"]`).getByRole('button').click()
          const memberPane = manager.locator(`[data-agent-monitor-pane="${child.id}"]`)
          await memberPane.waitFor()
          await memberPane.getByRole('button', { name: 'Open session', exact: true }).click()
          await page.locator('[data-sidebar-chat]').waitFor()
          await page.locator(`[data-sidebar-chat] [data-conversation-session="${child.id}"]`).waitFor()
          await page.getByRole('tab', { name: 'Chat', exact: true }).first().click()
        }
        await host.ctx.settings.replace('locale', { preference: 'zh' })
        await page.locator('[data-acp-team-management] button').click()
        await page.locator('[data-acp-managed-member="reviewer"]').waitFor()
        await page.locator('[data-acp-mode-group="claude"]').waitFor()
        expect(pageErrors).toEqual([])
        await page.screenshot({ path: join(directory, 'team.png'), fullPage: true })
        await page.setViewportSize({ width: 390, height: 844 })
        await page.screenshot({ path: join(directory, 'team-390-light.png'), fullPage: true })
        await page.emulateMedia({ colorScheme: 'dark' })
        await page.screenshot({ path: join(directory, 'team-390-dark.png'), fullPage: true })
        Object.assign(evidence, { status: 'passed', leadId, childId: child.id, leadProvider: lead.session.requestHeader()?.config.provider,
          childProvider: headers.at(-1)?.data.header.config.provider, childTurns: 2, executionNames,
          replies: { lead: replies(lead.id), child: replies(child.id) },
          task: { id: completed.id, status: completed.status, ownerName: completed.ownerName } })
      } catch (error) {
        Object.assign(evidence, { status: 'failed', error: error instanceof Error ? error.message : String(error),
          agents: host.ctx.agents.list().map((agent) => ({ id: agent.id, status: agent.status,
            parent: agent.session.header.parentSession, origin: agent.session.header.origin,
            membership: host.ctx.agentTeams.tryMembership(agent)?.role })),
          sessions: Object.fromEntries([...events].map(([id, log]) => [id, log.filter((event) =>
            ['request/header', 'assistant/message', 'turn/end'].includes(event.type))])) })
        throw error
      } finally {
        const database = new DatabaseSync(required(host.ctx.dshHomePath)('dsh-acp', 'sidecar.sqlite'), { readOnly: true })
        try {
          evidence.permissions = database.prepare("SELECT dsh_session_id, payload FROM audit WHERE kind = 'permission' ORDER BY time")
            .all().map((row) => ({ sessionId: row.dsh_session_id, data: JSON.parse(String(row.payload)) }))
        } finally { database.close() }
        writeFileSync(join(directory, 'result.json'), JSON.stringify(evidence, null, 2))
        await browser?.close()
        await host.close()
      }
    }, 240_000,
  )
}
