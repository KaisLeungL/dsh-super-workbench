import { describe, expect, it } from 'vitest'
import { applyMonitorSummary, initialMonitorSummary } from '../../../src/host/composition/monitor-summary.ts'

describe('管理页真实会话摘要', () => {
  it('没有记录时保持未知，不制造完成结果', () => {
    const state = initialMonitorSummary()
    expect(state).toMatchObject({ start: null, end: null, error: null, latestMessage: null })
    expect(applyMonitorSummary(state, { type: 'unrelated', time: 5, data: {} })).toBe(state)
  })
  it('使用轮次真实时间并在新一轮清除旧错误', () => {
    let state = applyMonitorSummary(initialMonitorSummary(), { type: 'turn/start', time: 10, data: { turn: 1 } })
    state = applyMonitorSummary(state, {
      type: 'turn/end',
      time: 20,
      data: { turn: 1, reason: { kind: 'error', error: { message: 'ACP connection closed' } } },
    })
    expect(state).toMatchObject({ start: 10, end: 20, error: 'ACP connection closed' })
    state = applyMonitorSummary(state, { type: 'turn/start', time: 30, data: { turn: 2 } })
    expect(state).toMatchObject({ start: 30, end: null, error: null })
  })
  it('只保留回答正文和工具标题，不泄露内部推理与工具参数', () => {
    let state = applyMonitorSummary(initialMonitorSummary(), {
      type: 'assistant/message',
      time: 20,
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'private' },
            { type: 'text', text: '已检查组件' },
          ],
        },
      },
    })
    expect(state.latestMessage).toBe('已检查组件')
    state = applyMonitorSummary(state, { type: 'tool/call', time: 30, data: { name: 'read', arguments: 'secret' } })
    expect(state).toMatchObject({ latestMessage: '已检查组件', latestActivity: 'read', latestAt: 30 })
    expect(JSON.stringify(state)).not.toContain('secret')
  })
  it('已取消不冒充成功，缺失信息保持明确标记', () => {
    const state = applyMonitorSummary(initialMonitorSummary(), {
      type: 'turn/end',
      time: 9,
      data: { reason: { kind: 'aborted' } },
    })
    expect(state).toMatchObject({ outcome: 'aborted', start: null, end: 9 })
  })
  it('终态清除旧工具摘要，时间取当前轮次边界', () => {
    let state = applyMonitorSummary(initialMonitorSummary(), { type: 'turn/start', time: 10, data: { turn: 1 } })
    state = applyMonitorSummary(state, { type: 'tool/call', time: 11, data: { name: 'read' } })
    state = applyMonitorSummary(state, { type: 'turn/end', time: 20, data: { turn: 1, reason: { kind: 'aborted' } } })
    expect(state).toMatchObject({ latestActivity: null, latestAt: 20, outcome: 'aborted' })
    state = applyMonitorSummary(state, { type: 'turn/start', time: 30, data: { turn: 2 } })
    expect(state.latestAt).toBe(30)
    state = applyMonitorSummary(state, {
      type: 'turn/end',
      time: 40,
      data: { turn: 2, reason: { kind: 'error', error: { message: 'closed' } } },
    })
    expect(state).toMatchObject({ error: 'closed', latestAt: 40 })
  })
  it('截断摘要长度，旧轮次结束不覆盖新轮次状态', () => {
    let state = applyMonitorSummary(initialMonitorSummary(), { type: 'turn/start', time: 10, data: { turn: 2 } })
    const old = applyMonitorSummary(state, {
      type: 'turn/end',
      time: 15,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    expect(old).toBe(state)
    state = applyMonitorSummary(state, {
      type: 'assistant/message',
      time: 20,
      data: { message: { content: [{ type: 'text', text: 'a'.repeat(2000) }] } },
    })
    expect(state.latestMessage!.length).toBeLessThanOrEqual(600)
  })
})
