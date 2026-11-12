import { describe, expect, it } from 'vitest'
import type { ChatSnapshot, ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  monitorAnchors,
  monitorFeed,
  monitorRoute,
  monitorScope,
  monitorSessions,
  monitorTiming,
} from '../../../src/client/data/agent-monitor.ts'
import type { AcpActivityView } from '../../../src/contract/remote.ts'

function row(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: SessionId(id),
    displayTitle: id,
    running: false,
    blank: false,
    retainedBy: {},
    updatedAt: 1,
    cwd: '/project',
    ...overrides,
  }
}
function list(rows: SessionSummary[]): SessionListState {
  return {
    ids: rows.map((item) => item.id),
    byId: Object.fromEntries(rows.map((item) => [item.id, item])),
    phase: 'ready',
    projectionsBySession: {},
  }
}
function chat(nodes: unknown[], times = new Map<number, { startTime: number; endTime?: number }>()): ChatSnapshot {
  return {
    nodes: { values: () => nodes as ChatConversationViewNode[] },
    timeline: { turnOrder: [...times.keys()], turns: new Map() },
    legacy: { turnTimings: times },
  } as unknown as ChatSnapshot
}
const activity: AcpActivityView = {
  dshSessionId: 'one',
  ownerDshSessionId: 'one',
  promptAnchorMessageId: 'prompt',
  activityId: 'call',
  activitySeq: 1,
  revisionSeq: 1,
  time: 20,
  kind: 'tool',
  status: 'running',
  presentation: '读取文件',
}

describe('Agent 工作台的数据边界', () => {
  it('优先使用已执行路由，拒绝未知形状，不把下一轮切换当作已运行 Agent', () => {
    expect(
      monitorRoute({ lastUsed: { provider: 'native', model: 'x' }, next: { provider: 'acp-codex', model: 'y' } }),
    ).toEqual({ provider: 'native', model: 'x' })
    expect(monitorRoute({ lastUsed: null, next: { provider: 'acp-codex', model: 'y' } })?.provider).toBe('acp-codex')
    expect(monitorRoute({ lastUsed: 'acp-codex' })).toBeUndefined()
    expect(monitorRoute(null)).toBeUndefined()
  })
  it('工作区隔离、跳过待迁移历史，保留超出 100 条的运行会话', () => {
    const state = list([
      ...Array.from({ length: 110 }, (_, index) => row(`old-${index}`, { updatedAt: index })),
      row('running', { running: true, updatedAt: 0 }),
      row('other', { cwd: '/other' }),
      row('legacy', { formatStatus: 'migration-required' }),
    ])
    const scoped = monitorScope(state, '/project')
    expect(scoped).toHaveLength(101)
    expect(scoped[0]?.id).toBe('running')
    expect(scoped.some((item) => ['other', 'legacy', 'old-0'].includes(item.id))).toBe(false)
    const running = list(Array.from({ length: 105 }, (_, index) => row(`${index}`, { running: true })))
    expect(monitorScope(running, '/project')).toHaveLength(105)
  })
  it('仅列出权威目录拥有的 Agent，不仅依赖 acp 前缀', () => {
    const state = list([row('one'), row('two'), row('three')])
    state.projectionsBySession = {
      [SessionId('one')]: {
        values: { modelSelection: { lastUsed: { provider: 'acp-codex', model: 'm' }, next: null } },
        state: 'ready',
        error: null,
      },
      [SessionId('two')]: {
        values: { modelSelection: { lastUsed: { provider: 'acp-unowned', model: 'm' }, next: null } },
        state: 'ready',
        error: null,
      },
    }
    expect(
      monitorSessions(state, '/project', (provider) => provider === 'acp-codex').map((item) => item.summary.id),
    ).toEqual(['one'])
  })
  it('消息与活动按实际时间排序，流式文本替换同一条记录，忽略内部推理', () => {
    const snapshot = chat([
      {
        key: 'answer',
        kind: 'assistant-step',
        data: {
          time: 30,
          blocks: [
            { kind: 'text', text: '正在' },
            { kind: 'reasoning', text: '内部内容' },
          ],
        },
      },
      { key: 'prompt', kind: 'user', data: { time: 10, content: [{ type: 'text', text: '检查代码' }] } },
    ])
    expect(monitorFeed(snapshot, [activity]).map((item) => item.text)).toEqual(['检查代码', '读取文件', '正在'])
    const updated = chat([
      { key: 'answer', kind: 'assistant-step', data: { time: 30, blocks: [{ kind: 'text', text: '正在检查' }] } },
    ])
    expect(monitorFeed(updated, [{ ...activity, status: 'completed', revisionSeq: 2 }])).toMatchObject([
      { key: 'activity:one:call', status: 'completed' },
      { key: 'answer', text: '正在检查' },
    ])
    expect(
      monitorFeed(
        chat(
          Array.from({ length: 80 }, (_, index) => ({
            key: `${index}`,
            kind: 'turn-error',
            data: { time: index, message: `${index}` },
          })),
        ),
        [],
      ),
    ).toHaveLength(60)
  })
  it('使用真实轮次边界计时，不将挂载时间当作开始时间', () => {
    expect(monitorTiming(undefined)).toBeUndefined()
    expect(
      monitorTiming(
        chat(
          [],
          new Map([
            [1, { startTime: 10, endTime: 30 }],
            [2, { startTime: 50 }],
          ]),
        ),
      ),
    ).toEqual({ start: 50 })
  })
  it('从原生活动标记读取归属并只订阅最近三个轮次', () => {
    const snapshot = chat(
      Array.from({ length: 4 }, (_, index) => ({
        kind: 'acp-activity',
        data: { ownerDshSessionId: index === 3 ? '' : 'owner', promptAnchorMessageId: `prompt-${index}` },
      })),
    )
    expect(
      monitorAnchors(snapshot, 'fallback').map((item) => [item.ownerDshSessionId, item.promptAnchorMessageId]),
    ).toEqual([
      ['owner', 'prompt-1'],
      ['owner', 'prompt-2'],
      ['fallback', 'prompt-3'],
    ])
  })
})
