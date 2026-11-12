/** 工作台只读取原生投影；不会创建、激活或取消 Agent。 */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { AcpActivityView } from '../../contract/remote.ts'
import type { AcpActivityNodeData } from '../ui/activity-definitions.ts'

import type { MonitorSummary } from '../../host/composition/monitor-summary.ts'

export function monitorSummary(value: unknown): MonitorSummary | undefined {
  if (!record(value) || !('error' in value) || !('start' in value)) return undefined
  return value as unknown as MonitorSummary
}

export function monitorState(
  running: boolean,
  summary: MonitorSummary | undefined,
): 'running' | 'idle' | 'failed' | 'unknown' {
  return running ? 'running' : summary === undefined ? 'unknown' : summary.error !== null ? 'failed' : 'idle'
}

export interface MonitorSession {
  readonly summary: SessionSummary
  readonly provider: string
  readonly model: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function monitorRoute(value: unknown): { provider: string; model: string } | undefined {
  if (!record(value)) return undefined
  // 已执行的路由优先；next 可能只是尚未执行的模型切换。
  const route = value.lastUsed ?? value.next
  return record(route) && typeof route.provider === 'string' && typeof route.model === 'string'
    ? { provider: route.provider, model: route.model }
    : undefined
}

/** 限制历史元数据读取量，运行中的会话始终包含在范围内。 */
export function monitorScope(list: SessionListState, cwd: string | undefined): SessionSummary[] {
  const rows = Object.values(list.byId)
    .filter((row) => row.cwd === cwd && row.formatStatus !== 'migration-required')
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  return rows
    .filter((row, index) => row.running || index < 100)
    .sort((a, b) => Number(b.running) - Number(a.running) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
}

export function monitorSessions(
  list: SessionListState,
  cwd: string | undefined,
  owns: (provider: string | undefined) => boolean,
): MonitorSession[] {
  return monitorScope(list, cwd).flatMap((summary) => {
    const route = monitorRoute(list.projectionsBySession[summary.id]?.values.modelSelection)
    return route !== undefined && owns(route.provider) ? [{ summary, ...route }] : []
  })
}

export interface MonitorFeedItem {
  readonly key: string
  readonly time: number
  readonly kind: 'user' | 'assistant' | 'tool' | 'error'
  readonly text: string
  readonly status?: string
  readonly activity?: AcpActivityView
}

export function monitorAnchors(chat: ChatSnapshot | undefined, sessionId: string): AcpActivityNodeData[] {
  const anchors = new Map<string, AcpActivityNodeData>()
  const add = (data: AcpActivityNodeData | undefined): void => {
    if (data !== undefined) {
      const ownerDshSessionId = data.ownerDshSessionId || sessionId
      anchors.set(JSON.stringify([ownerDshSessionId, data.promptAnchorMessageId]), { ...data, ownerDshSessionId })
    }
  }
  for (const node of chat?.nodes.values() ?? []) {
    if (node.kind === 'acp-activity') add((node as ChatNode<'acp-activity'>).data)
  }
  for (const turn of chat?.timeline.turns.values() ?? []) {
    for (const step of turn.steps) add(step.data.get('acp-activity') ?? step.data.get('acp-activity-live'))
  }
  return [...anchors.values()].slice(-3)
}

export function monitorFeed(chat: ChatSnapshot | undefined, activities: readonly AcpActivityView[]): MonitorFeedItem[] {
  const items: MonitorFeedItem[] = []
  for (const node of chat?.nodes.values() ?? []) {
    if (node.kind === 'user' || node.kind === 'steering') {
      const data = (node as ChatNode<'user' | 'steering'>).data
      const text = data.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
      if (text.trim()) items.push({ key: node.key, time: data.time, kind: 'user', text })
    } else if (node.kind === 'assistant-step') {
      const data = (node as ChatNode<'assistant-step'>).data
      const text = data.blocks.flatMap((block) => (block.kind === 'text' ? [block.text] : [])).join('')
      if (text.trim()) items.push({ key: node.key, time: data.time, kind: 'assistant', text })
    } else if (node.kind === 'tool-call') {
      const { root } = (node as ChatNode<'tool-call'>).data
      const settled = 'kind' in root && root.kind === 'tool-result'
      items.push({
        key: node.key,
        time: root.time,
        kind: 'tool',
        text: root.name || root.callId,
        status: settled ? (root.isError ? 'failed' : 'completed') : 'running',
      })
    } else if (node.kind === 'turn-error') {
      const data = (node as ChatNode<'turn-error'>).data
      items.push({ key: node.key, time: data.time, kind: 'error', text: data.message })
    }
  }
  for (const activity of activities) {
    items.push({
      key: `activity:${activity.ownerDshSessionId}:${activity.activityId}`,
      time: activity.time,
      kind: 'tool',
      text: activity.presentation,
      status: activity.status,
      activity,
    })
  }
  return items.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key)).slice(-60)
}

export function monitorTiming(chat: ChatSnapshot | undefined): { start: number; end?: number } | undefined {
  const turn = chat?.timeline.turnOrder.at(-1)
  if (turn === undefined) return undefined
  const timing = chat?.legacy.turnTimings.get(turn)
  return timing === undefined
    ? undefined
    : { start: timing.startTime, ...(timing.endTime === undefined ? {} : { end: timing.endTime }) }
}
