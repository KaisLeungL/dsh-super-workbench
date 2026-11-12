import { describe, expect, it } from 'vitest'
import { createAgentManager } from '../../../src/client/ui/AgentManager.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'

type Element = { type: unknown; props: { children?: unknown } }

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (value === null || typeof value !== 'object' || !('props' in value)) return []
  const node = value as Element
  return [node, ...elements(node.props.children)]
}

describe('Agent Provider 导航', () => {
  it.each([
    ['中文', zh],
    ['英文', en],
  ] as const)('%s 只保留会话总览与接入管理', (_language, messages) => {
    const Manager = createAgentManager(
      {} as never,
      {
        list: { subscribe: () => () => {}, getSnapshot: () => ({ items: [], phase: 'ready' }) },
      } as never,
    )
    const page = Manager({ t: (key: keyof typeof zh) => messages[key] } as never)
    const nodes = elements(page)
    const nav = nodes.find((node) => node.type === 'nav')!
    const buttons = elements(nav.props.children).filter((node) => node.type === 'button')
    expect(buttons.map((button) => button.props.children)).toEqual([messages.managerCopy3, messages.managerCopy1])
    expect(buttons[0]?.props).toMatchObject({ 'aria-current': 'page' })
    expect(nodes.find((node) => node.type === 'h2')?.props.children).toBe('Agent Provider')
    expect(nodes.some((node) => node.type === 'select')).toBe(false)
  })
})
