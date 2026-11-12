/** 管理页只发布有界摘要；由宿主增量投影维护，不为列表保留聊天订阅。 */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session/types'
import { redactSecretText } from '../../contract/redaction.ts'

export const monitorSummarySchema = z.object({
  turn: z.number().nullable(),
  start: z.number().nullable(),
  end: z.number().nullable(),
  outcome: z.string().nullable(),
  error: z.string().nullable(),
  latestMessage: z.string().nullable(),
  latestActivity: z.string().nullable(),
  latestAt: z.number().nullable(),
})
export type MonitorSummary = z.infer<typeof monitorSummarySchema>

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    acpMonitor: MonitorSummary
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    acpMonitor: MonitorSummary
  }
}

export function initialMonitorSummary(): MonitorSummary {
  return {
    turn: null,
    start: null,
    end: null,
    outcome: null,
    error: null,
    latestMessage: null,
    latestActivity: null,
    latestAt: null,
  }
}
const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
const short = (value: string): string => redactSecretText(value).slice(0, 600)

export function applyMonitorSummary(
  state: MonitorSummary,
  event: { type: string; time: number; data: unknown },
): MonitorSummary {
  const data = object(event.data)
  if (event.type === 'turn/start')
    return {
      ...state,
      turn: typeof data.turn === 'number' ? data.turn : null,
      start: event.time,
      end: null,
      outcome: null,
      error: null,
      latestActivity: null,
      latestAt: event.time,
    }
  if (event.type === 'turn/end') {
    if (typeof data.turn === 'number' && state.turn !== null && data.turn !== state.turn) return state
    const reason = object(data.reason)
    const failure = object(reason.error)
    return {
      ...state,
      end: event.time,
      latestAt: event.time,
      latestActivity: null,
      outcome: typeof reason.kind === 'string' ? reason.kind : null,
      error:
        reason.kind === 'error'
          ? short(typeof failure.message === 'string' ? failure.message : '本轮执行失败')
          : reason.kind === 'interrupted'
            ? '会话执行已中断'
            : null,
    }
  }
  if (event.type === 'assistant/message') {
    const content = object(data.message).content
    const text = Array.isArray(content)
      ? content
          .map(object)
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
      : ''
    return text.trim() ? { ...state, latestMessage: short(text), latestAt: event.time } : state
  }
  if (event.type === 'tool/call' && typeof data.name === 'string')
    return { ...state, latestActivity: short(data.name), latestAt: event.time }
  return state
}

export const acpMonitorProjection = {
  key: 'acpMonitor',
  stateVersion: 2,
  stateSchema: monitorSummarySchema,
  init: initialMonitorSummary,
  apply: applyMonitorSummary,
  wire: { viewSchema: monitorSummarySchema, view: (state: MonitorSummary) => state },
} satisfies ProjectionDefinition<'acpMonitor', MonitorSummary>
