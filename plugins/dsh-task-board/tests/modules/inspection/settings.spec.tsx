// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { InspectionSettings, type Settings, type ClientBoard } from '../../../src/modules/inspection/client/InspectionSettings.tsx'
import { zh } from '../../../src/modules/inspection/client/locales.ts'
import type { InspectionRule } from '../../../src/modules/inspection/core/types.ts'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const rule: InspectionRule = { id: 'r', workspaceId: 'w', root: '/fixture', goal: '核对交付', revision: 1, enabled: true, paths: ['README.md'], model: 'p/m', daily: false, cron: '0 9 * * *', timeZone: 'Asia/Shanghai', maxRecommendations: 3 }
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
let root: Root | undefined
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open') } })
})
afterAll(() => {
  for (const [name, descriptor] of [['showModal', originalShow], ['close', originalClose]] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  }
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.replaceChildren() })
function setup({ writable = true, scheduleAvailable = false } = {}) {
  const formSnapshot = { value: { rules: [rule] }, writable, status: 'ready' } as unknown as ConfigFormSnapshot<Settings>
  const set = vi.fn(async () => true)
  const form = { getSnapshot: () => formSnapshot, subscribe: () => () => {}, set } as unknown as ConfigForm<Settings>
  const dispatch = vi.fn(async () => true)
  const mirror = { enabled: true, extensions: { inspection: { scheduleAvailable, workspaces: [{ id: 'w', title: '项目' }], runs: [] } } }
  const board: ClientBoard = { snapshot: () => mirror, subscribe: () => () => {}, dispatch }
  const container = document.createElement('div')
  document.body.append(container)
  act(() => { root = createRoot(container); root.render(<InspectionSettings board={board} form={form} t={key => zh[key]}/>) })
  const button = (text: string) => [...container.querySelectorAll('button')].find(element => element.textContent === text)!
  const open = () => { act(() => { button(zh.configure).click() }) }
  return { container, set, dispatch, button, open }
}
describe('巡检设置弹窗', () => {
  it('operator：给定设置入口，当打开后修改并取消时，保留已保存设置且可重新打开', () => {
    // Given: 默认只展示入口，不铺开表单
    const { container, set, button, open } = setup()
    expect(container.querySelector('dialog')).toBeNull()
    // When: 在弹窗内修改目标后取消
    open()
    const goal = container.querySelector('textarea')!
    act(() => { Simulate.change(goal, { target: { value: '未保存目标' } } as never) })
    act(() => { button(zh.cancel).click() })
    // Then: 不写入配置，重新打开仍是保存的目标
    expect(container.querySelector('dialog')).toBeNull()
    expect(set).not.toHaveBeenCalled()
    open()
    expect(container.querySelector('textarea')?.value).toBe('核对交付')
  })
  it('operator：给定已保存授权规则，当点击立即巡检时，仅派发受限 run 动作', async () => {
    // Given: 已保存授权规则在弹窗中
    const { container, dispatch, button, open } = setup()
    open()
    // When: 点击立即巡检
    await act(async () => { button(zh.run).click() })
    // Then: 仅派发受限 run 动作并保留表单
    expect(dispatch).toHaveBeenCalledWith({ extensionId: 'inspection', action: 'run', payload: { ruleId: 'r' } })
    expect(container.querySelector('dialog')?.open).toBe(true)
    expect(container.textContent).toContain(zh.requested)
  })
  it('operator：给定目标已修改，当保存时，递增目标版本并关闭弹窗而不开始扫描', async () => {
    // Given: 弹窗内的目标已修改
    const { container, set, dispatch, button, open } = setup()
    open()
    act(() => { Simulate.change(container.querySelector('textarea')!, { target: { value: '更新后的项目目标' } } as never) })
    expect(button(zh.run).disabled).toBe(true)
    // When: 保存设置
    await act(async () => { button(zh.save).click() })
    // Then: 递增版本，不扫描，回到原界面
    expect(set).toHaveBeenCalledWith('rules', [expect.objectContaining({ goal: '更新后的项目目标', revision: 2 })])
    expect(dispatch).not.toHaveBeenCalled()
    expect(container.querySelector('dialog')).toBeNull()
  })
  it('operator：给定宿主有定时能力，当启用每日巡检时，才展示时间配置', () => {
    // Given: 默认关闭每日巡检，额外证据来源折叠
    const { container, open } = setup({ scheduleAvailable: true })
    open()
    expect(container.querySelector('input[value="0 9 * * *"]')).toBeNull()
    expect(container.querySelector('details')?.open).toBe(false)
    // When: 启用每日巡检
    const daily = [...container.querySelectorAll('label')].find(label => label.textContent === zh.daily)!.querySelector('input')!
    act(() => { Simulate.change(daily, { target: { checked: true } } as never) })
    // Then: 出现已保存的表达式和时区
    const cron = [...container.querySelectorAll('label')].find(label => label.textContent === zh.cron)!.querySelector('input')!
    const timezone = [...container.querySelectorAll('label')].find(label => label.textContent === zh.timezone)!.querySelector('input')!
    expect(cron.value).toBe('0 9 * * *')
    expect(timezone.value).toBe('Asia/Shanghai')
  })
  it('operator：给定宿主无 Cron 适配且配置只读，当打开设置时，规则不可修改', () => {
    // Given: 配置只读且无 Cron 适配
    const { container, button, open } = setup({ writable: false })
    // When: 打开设置
    open()
    // Then: 不可修改和保存，解释定时能力缺失
    const daily = [...container.querySelectorAll('label')].find(label => label.textContent === zh.daily)!.querySelector('input')!
    expect(daily.disabled).toBe(true)
    expect(container.textContent).toContain(zh.unavailable)
    expect(container.querySelector('fieldset')?.disabled).toBe(true)
    expect(button(zh.save).disabled).toBe(true)
  })
  it('operator：给定保存被拒绝，当提交设置时，保留弹窗和草稿供重试', async () => {
    // Given: 设置存储拒绝写入
    const { container, set, button, open } = setup()
    set.mockResolvedValue(false)
    open()
    // When: 提交设置
    await act(async () => { button(zh.save).click() })
    // Then: 表单仍可恢复，不丢失输入
    expect(container.querySelector('dialog')?.open).toBe(true)
    expect(container.querySelector('textarea')?.value).toBe('核对交付')
    expect(container.textContent).toContain(zh.failed)
    expect(button(zh.save).disabled).toBe(false)
  })
})
