import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpPanelSnapshot } from '../../../src/client/data/stores/panel-store.ts'
import type { AcpProviderHealth } from '../../../src/client/data/logic.ts'
import type { AcpSectionProps, AcpSectionWire } from '../../../src/client/ui/AcpSection.ts'

const hooks = vi.hoisted(() => ({
  frame: '',
  index: 0,
  values: new Map<string, unknown[]>(),
  effects: [] as (() => void)[],
}))
vi.mock('react', () => ({
  Fragment: 'Fragment',
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
    type,
    props: { ...props, children },
  }),
  useState: (initial: unknown) => {
    const frame = hooks.frame
    const index = hooks.index++
    const values = hooks.values.get(frame) ?? []
    if (!(index in values)) values[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    hooks.values.set(frame, values)
    return [
      values[index],
      (next: unknown) => {
        values[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(values[index]) : next
      },
    ]
  },
  useRef: (initial: unknown) => {
    const index = hooks.index++
    const values = hooks.values.get(hooks.frame) ?? []
    if (!(index in values)) values[index] = { current: initial }
    hooks.values.set(hooks.frame, values)
    return values[index]
  },
  useEffect: (effect: () => void, dependencies: unknown[]) => {
    const index = hooks.index++
    const values = hooks.values.get(hooks.frame) ?? []
    const previous = values[index] as unknown[] | undefined
    if (previous === undefined || dependencies.some((value, i) => value !== previous[i])) {
      values[index] = dependencies
      hooks.effects.push(effect)
    }
    hooks.values.set(hooks.frame, values)
  },
  useLayoutEffect: () => {},
  useId: () => ':connections:',
  useCallback: (callback: unknown) => callback,
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'Button',
  Input: 'Input',
  Menu: 'Menu',
  Tag: 'Tag',
  IconChevronDownOutlineMedium: 'Chevron',
  IconPlusOutlineMedium: 'Plus',
  IconRefreshOutlineMedium: 'Refresh',
}))
import { AcpSection } from '../../../src/client/ui/AcpSection.ts'

type Element = { type: string | ((props: never) => unknown); props: Record<string, unknown> }
const isElement = (value: unknown): value is Element =>
  typeof value === 'object' && value !== null && 'type' in value && 'props' in value
function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(text).join(' ')
  return isElement(value) ? text(value.props.children) : ''
}
function elements(value: unknown, path = 'root'): Element[] {
  if (Array.isArray(value)) return value.flatMap((child, index) => elements(child, `${path}/${index}`))
  if (!isElement(value)) return []
  if (typeof value.type === 'function') {
    hooks.frame = `${path}/${value.type.name}/${String(value.props.key ?? '')}`
    hooks.index = 0
    return elements(value.type(value.props as never), hooks.frame)
  }
  return [value, ...elements(value.props.children, `${path}/children`)]
}
const t = (key: string, params?: Record<string, string | number>) =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`
const probeAt = Date.UTC(2026, 10, 8, 10)
const fetchedAt = Date.UTC(2026, 10, 9, 10)
function snapshot(): AcpPanelSnapshot {
  return {
    settings: {
      status: 'ready',
      writable: true,
      revision: undefined,
      toolApprovalDefault: 'ask',
      agents: {
        codex: {
          name: 'Codex',
          command: 'codex-acp',
          args: ['--stdio'],
          env: { API_TOKEN: 'SECRET_NOT_FOR_DISPLAY', NO_COLOR: '1' },
        },
        custom: { name: '自定义 Agent', command: '/bin/custom-acp', args: [], env: {} },
      },
    },
    health: {
      status: 'ready',
      fetchedAt,
      message: undefined,
      checkingAgentIds: [],
      agentErrors: {},
      rows: [
        {
          id: 'codex',
          name: 'Codex',
          command: 'codex-acp',
          args: [],
          loginHint: null,
          executable: true,
          version: null,
          state: 'auth-required',
          probe: { status: 'error', at: probeAt, failureKind: 'auth_required', message: 'login needed', phase: null },
        },
        {
          id: 'custom',
          name: '自定义 Agent',
          command: '/bin/custom-acp',
          args: [],
          loginHint: null,
          executable: true,
          version: null,
          state: 'saved-unverified',
          probe: { status: 'never', at: null },
        },
      ] as AcpProviderHealth[],
    },
  }
}
function setup(presentation: 'management' | false = 'management') {
  const state = snapshot()
  const panel: AcpSectionWire = {
    refreshHealth: vi.fn(),
    refreshAgentHealth: vi.fn(),
    saveAgent: vi.fn(async () => undefined),
    deleteAgent: vi.fn(async () => undefined),
    countBoundSessions: vi.fn(async () => 2),
    setToolApprovalDefault: vi.fn(async () => undefined),
    notifyOutcome: vi.fn(),
  }
  const render = () => {
    hooks.frame = 'entry'
    hooks.index = 0
    const nodes = elements(
      AcpSection({
        t,
        panel,
        useStore: (select) => select(state),
        presentation: presentation || undefined,
      } as AcpSectionProps),
    )
    for (const effect of hooks.effects.splice(0)) effect()
    return nodes
  }
  const find = (nodes: Element[], label: string) => {
    const node = nodes.find(
      (candidate) =>
        ['Button', 'button'].includes(String(candidate.type)) && text(candidate).trim().replace(/\s+/g, ' ') === label,
    )
    expect(node, label).toBeDefined()
    return node!
  }
  const click = (nodes: Element[], label: string) => (find(nodes, label).props.onClick as () => void)()
  return { state, panel, render, find, click }
}
beforeEach(() => {
  hooks.values.clear()
  hooks.effects.length = 0
})
describe('Provider 管理', () => {
  it('沿用插件页，并通过稳定 ID 显示实例、认证未知及只读 ID', () => {
    expect(
      setup(false)
        .render()
        .some((node) => node.props['data-provider-detail']),
    ).toBe(false)
    hooks.values.clear()
    const { render } = setup()
    const nodes = render()
    expect(
      nodes.filter((node) => node.props['data-provider-instance']).map((node) => node.props['data-provider-instance']),
    ).toEqual(['codex', 'custom'])
    expect(text(nodes)).toContain('providerAuthRequired')
    expect(text(nodes)).not.toContain('SECRET_NOT_FOR_DISPLAY')
    expect(nodes.some((node) => node.props.value === 'codex' && node.props.disabled === true)).toBe(true)
  })

  it('进入仅读缓存，显式检查使用原控制器，停用不删除实例', async () => {
    const { panel, render, click } = setup()
    const nodes = render()
    expect(panel.refreshHealth).toHaveBeenCalledExactlyOnceWith()
    click(nodes, 'providerCheckAll')
    expect(panel.refreshHealth).toHaveBeenLastCalledWith(true)
    click(nodes, 'providerCheck')
    expect(panel.refreshAgentHealth).toHaveBeenCalledExactlyOnceWith('codex')
    const toggle = nodes.find((node) => node.props.role === 'switch')!
    await (toggle.props.onClick as () => Promise<void>)()
    await Promise.resolve()
    expect(panel.saveAgent).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ enabled: false, maskedEnv: { API_TOKEN: 'SECRET_NOT_FOR_DISPLAY' } }),
    )
    expect(panel.deleteAgent).not.toHaveBeenCalled()
  })

  it('只读模式禁止配置写入，允许检查', () => {
    const { render, state, find } = setup()
    state.settings.writable = false
    const nodes = render()
    expect(find(nodes, '+ providerAdd').props.disabled).toBe(true)
    expect(find(nodes, 'providerCheck').props.disabled).toBe(false)
    expect(nodes.filter((node) => node.props.role === 'switch').every((node) => node.props.disabled)).toBe(true)
  })

  it('三步向导保留同类型多实例，Escape 取消不保存', () => {
    const { render, click, panel } = setup()
    click(render(), '+ providerAdd')
    let nodes = render()
    const type = elements(nodes.find((node) => node.props['data-provider-wizard'] === 0)).find(
      (node) => node.type === 'button' && text(node).startsWith('Codex'),
    )!
    ;(type.props.onClick as () => void)()
    nodes = render()
    expect(nodes.find((node) => node.props.value === 'codex-2')).toBeDefined()
    click(nodes, 'providerNext')
    nodes = render()
    expect(nodes.some((node) => node.props['data-provider-wizard'] === 2)).toBe(true)
    const wizard = nodes.find((node) => node.props['data-provider-wizard'] === 2)!
    ;(wizard.props.onKeyDown as (event: unknown) => void)({ key: 'Escape', stopPropagation: vi.fn() })
    expect(render().some((node) => node.props['data-provider-wizard'] !== undefined)).toBe(false)
    expect(panel.saveAgent).not.toHaveBeenCalled()
  })
})
