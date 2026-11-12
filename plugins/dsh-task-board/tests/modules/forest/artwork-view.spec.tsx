// @vitest-environment jsdom
import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../../../src/modules/forest/client/main.js'

const NOW = '2026-11-11T08:00:00+08:00'
const cleanups: Array<() => void> = []
let root: Root | undefined

class ForestEvents {
  onmessage = null
  onerror = null
  close() {}
}

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  for (const off of cleanups.splice(0).reverse()) off()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

async function mountForest(total: number) {
  const rewards = Array.from({ length: total }, (_, i) => ({
    id: `reward-${i}`, taskId: `task-${i}`, title: `奖励 ${i + 1}`, completedAt: NOW,
    island: Math.floor(i / 16) + 1, position: i % 16 + 1, type: 'task',
  }))
  const view = {
    total, revision: 1, currentIsland: Math.floor(total / 16) + 1, currentCount: total % 16,
    completedIslands: Math.floor(total / 16), counts: { day: total, week: total, month: total },
    recent: rewards.slice(-5).reverse(), timeZone: 'Asia/Shanghai',
    identity: { id: 'local', nickname: '旅人' }, room: { mode: 'none' },
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('EventSource', ForestEvents)
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const input = JSON.parse(String(init.body))
    return Response.json(input.action === 'island'
      ? { ...view, island: { island: input.island, rewards: rewards.filter(r => r.island === input.island) } }
      : view)
  })
  const originalShow = HTMLDialogElement.prototype.showModal
  const originalClose = HTMLDialogElement.prototype.close
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
  cleanups.push(() => {
    HTMLDialogElement.prototype.showModal = originalShow
    HTMLDialogElement.prototype.close = originalClose
  })
  const views = new Map<string, ComponentType<{ openTask: () => void; navigate: () => void }>>()
  const board = {
    registerView(view: { id: string; render: ComponentType<{ openTask: () => void; navigate: () => void }> }) { views.set(view.id, view.render); return () => {} },
    registerBanner() { return () => {} },
    dispatch: async () => true,
    snapshot: () => ({ tasks: rewards.map(r => ({ id: r.taskId })) }),
  }
  const dicts = new Map<string, Record<string, string>>()
  const localeSnapshot = { active: 'zh' }
  const locale = {
    register(_namespace: string, lang: string, dict: Record<string, string>) { dicts.set(lang, dict); return () => {} },
    bind: () => (key: string) => dicts.get('zh')?.[key] ?? key,
    subscribe: () => () => {}, getSnapshot: () => localeSnapshot,
  }
  apply({
    get: (key: string) => key === 'taskBoard' ? board : locale,
    effect: (effect: () => unknown) => { const off = effect(); if (typeof off === 'function') cleanups.push(off as () => void) },
    slots: { inject() {} },
  })
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(views.get('task-forest.forest')!, { openTask() {}, navigate() {} }))
  })
  return container
}

describe('PNG 森林展示', () => {
  it('member 在空岛只看到 PNG 岛屿与网格，没有未获得的树和点击区域', async () => {
    // Given: 用户没有奖励。
    const container = await mountForest(0)
    // When: 森林完成首次读取。
    const artwork = container.querySelector('.tfArtImage')!
    // Then: 保留真实素材底座，未制造树木或错误的记录入口。
    expect(artwork.querySelectorAll('image')).toHaveLength(2)
    expect(container.querySelectorAll('.tfTreeHit')).toHaveLength(0)
    expect(artwork.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 1536 1024')
  })

  it('member 查看第二岛与种植记录时树种一致，切回满岛仍有 16 个准确入口', async () => {
    // Given: 用户种下 20 棵树，当前在第二岛。
    const container = await mountForest(20)
    const tree = container.querySelector('.tfArtImage [data-tree-kind="dragonblood"] image')!
    expect(container.querySelectorAll('.tfArtImage [data-tree-kind]')).toHaveLength(4)
    const recent = container.querySelector('.tfRecentMark img')!
    expect(recent.getAttribute('src')).toBe(tree.getAttribute('href'))
    // When: 用户用键盘打开第二岛第 4 个奖励。
    await act(async () => {
      container.querySelectorAll('.tfTreeHit')[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    // Then: 记录显示该树种，关闭并切回第一岛后满岛仍有 16 棵及 16 个入口。
    const recordTree = container.querySelector('.tfRecord [data-tree-kind="dragonblood"] image')!
    expect(recordTree.getAttribute('href')).toBe(tree.getAttribute('href'))
    expect(container.querySelector('dialog')!.textContent).toContain('奖励 20')
    await act(async () => container.querySelector('dialog')!.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true })))
    await act(async () => (container.querySelector('.tfIslandTile') as HTMLButtonElement).click())
    expect(container.querySelectorAll('.tfArtImage [data-tree-kind]')).toHaveLength(16)
    expect(container.querySelectorAll('.tfTreeHit')).toHaveLength(16)
    expect(container.querySelectorAll('.tfTreeHit')[0].getAttribute('cx')).toBe('768')
  })
})
