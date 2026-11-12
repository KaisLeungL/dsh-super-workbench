// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskCard } from '../src/client/board/TaskCard.tsx'
import { ExecutionLog } from '../src/client/board/ExecutionLog.tsx'
import { t } from '../src/client/locales.ts'
import type { ExecutionRecord, TaskRecord } from '../src/core/tasks.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-10T09:00:00Z')) })
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.useRealTimers() })
function mount(element: Parameters<Root['render']>[0]) {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root!.render(element) })
  return container
}
function execution(id: string, sessionId?: string): ExecutionRecord {
  return { id, sessionId, startedAt: 1000, endedAt: 2000, result: 'succeeded', error: undefined }
}
function task(executions: ExecutionRecord[]): TaskRecord {
  return { id: 'completed', title: '完成的任务', description: '', prompt: '', status: 'done', createdAt: 0, updatedAt: 2000, executions }
}
describe('任务会话记录入口', () => {
  it.each([false, true])('operator：给定紧凑模式为 %s 的已执行卡片，当点击会话记录时，打开最近会话而非任务详情', compact => {
    // Given: 两次执行分别拥有自己的会话
    const sessions: string[] = []
    const details = vi.fn()
    const container = mount(<TaskCard task={task([execution('earlier', 'session-earlier'), execution('latest', 'session-latest')])} compact={compact} pending={false} onClick={details} onOpenSession={id => sessions.push(id)}/>)
    const link = container.querySelector<HTMLButtonElement>('[data-dsh-part="card-session"]')!
    expect(link.textContent).toBe(t('card.sessionHistory'))
    // When: 点击明确的会话记录入口
    act(() => { link.click() })
    // Then: 进入最近的关联会话，不误触详情
    expect(sessions).toEqual(['session-latest'])
    expect(details).not.toHaveBeenCalled()
  })
  it('operator：给定最新启动未生成会话，当点击卡片会话记录时，仍可回看最近已有会话', () => {
    // Given: 早先的执行有会话，之后一次在创建会话前失败
    const sessions: string[] = []
    const records = [execution('earlier', 'session-existing'), { ...execution('launch-failed'), result: 'failed' as const }]
    const container = mount(<TaskCard task={task(records)} compact pending={false} onClick={() => {}} onOpenSession={id => sessions.push(id)}/>)
    // When: 点击卡片入口
    act(() => { container.querySelector<HTMLButtonElement>('[data-dsh-part="card-session"]')!.click() })
    // Then: 回看实际存在的会话
    expect(sessions).toEqual(['session-existing'])
  })
  it.each([
    { name: '手动完成', records: [] },
    { name: '外部登记', records: [{ ...execution('external'), external: true }] },
  ])('operator：给定 $name 任务没有关联会话，当查看卡片时，不显示无效跳转', ({ records }) => {
    // Given: 没有任何可打开的会话
    // When: 查看紧凑卡片
    const container = mount(<TaskCard task={task(records)} compact pending={false} onClick={() => {}} onOpenSession={() => {}}/>)
    // Then: 任务内容仍可查看，没有伪造的会话按钮
    expect(container.querySelector('[data-dsh-part="card-title"]')?.textContent).toBe('完成的任务')
    expect(container.querySelector('button[data-dsh-part="card-session"]')).toBeNull()
  })
  it('operator：给定多次执行历史，当分别点击会话记录时，打开各自的会话', () => {
    // Given: 两条历史会话和一条无会话的外部结果
    const sessions: string[] = []
    const records = [execution('earlier', 'session-earlier'), execution('later', 'session-later'), { ...execution('external'), external: true }]
    const container = mount(<ExecutionLog executions={records} timeZone="UTC" onOpenSession={id => sessions.push(id)}/>)
    // When: 依次打开不同的历史记录
    act(() => { container.querySelector<HTMLButtonElement>('[data-execution-id="earlier"] button')!.click() })
    act(() => { container.querySelector<HTMLButtonElement>('[data-execution-id="later"] button')!.click() })
    // Then: 保持会话对应关系，外部结果不提供无效入口
    expect(sessions).toEqual(['session-earlier', 'session-later'])
    expect(container.querySelector('[data-execution-id="external"] button')).toBeNull()
  })
})
