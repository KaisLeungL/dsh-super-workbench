/** 设置中的 Agent Provider 页；原生对话仍由宿主管理。 */
import { createElement as h, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { AcpSection } from './AcpSection.ts'
import type { AcpSectionProps } from './AcpSection.ts'
import { createAgentMonitor } from './AgentMonitor.ts'
import type { MonitorDeps } from './AgentMonitor.ts'
import css from './AgentManager.module.css'

export function AgentManagerIcon({ size = 20 }: { size?: number }): ReactNode {
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      'aria-hidden': true,
    },
    h('path', { d: 'M10 8 6 15m8-7 4 7M8 18h8' }),
    h('circle', { cx: 12, cy: 5, r: 3 }),
    h('circle', { cx: 5, cy: 18, r: 3 }),
    h('circle', { cx: 19, cy: 18, r: 3 }),
  )
}

type AgentManagerProps = AcpSectionProps & { close?: () => void }

export function createAgentManager(
  deps: MonitorDeps,
  workspaces: IWorkspaces,
): (props: AgentManagerProps) => ReactNode {
  return function AgentManager(props): ReactNode {
    const Monitor = useMemo(
      () =>
        createAgentMonitor({
          ...deps,
          openSession: async (id) => {
            await deps.openSession(id)
            props.close?.()
          },
        }),
      [props.close],
    )
    const source = useMemo(
      () => ({
        subscribe: (listener: () => void) => workspaces.list.subscribe(listener),
        getSnapshot: () => workspaces.list.getSnapshot(),
      }),
      [],
    )
    const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
    const [workspaceId, setWorkspaceId] = useState('')
    const [tab, setTab] = useState<'overview' | 'connections'>('connections')
    const workspace = snapshot.items.find((item) => item.workspaceId === workspaceId) ?? snapshot.items[0]
    if (!props.t) return null
    const t = props.t
    const tabs = [
      ['connections', t('managerCopy3')],
      ['overview', t('managerCopy1')],
    ] as const
    return h(
      'section',
      { className: css.root, 'data-agent-manager': '', 'aria-label': t('managerCopy4') },
      h(
        'header',
        { className: css.header },
        h('div', null, h('h2', null, t('managerCopy5')), h('p', null, t('managerCopy6'))),
        tab === 'overview'
          ? h(
              'label',
              { className: css.workspace },
              h('span', null, t('managerCopy7')),
              h(
                'select',
                {
                  value: workspace?.workspaceId ?? '',
                  'aria-label': t('managerCopy8'),
                  onChange: (event: { currentTarget: HTMLSelectElement }) => setWorkspaceId(event.currentTarget.value),
                },
                ...snapshot.items.map((item) =>
                  h('option', { key: item.workspaceId, value: item.workspaceId }, item.title),
                ),
              ),
            )
          : null,
        tab === 'overview' && snapshot.error ? h('p', { role: 'status' }, t('managerCopy9')) : null,
      ),
      h(
        'nav',
        { className: css.tabs, 'aria-label': t('managerCopy10') },
        ...tabs.map(([key, label]) =>
          h(
            'button',
            { key, type: 'button', 'aria-current': tab === key ? 'page' : undefined, onClick: () => setTab(key) },
            label,
          ),
        ),
      ),
      h(
        'div',
        { className: `${css.body} ${tab === 'overview' ? css.overview : ''}` },
        tab === 'connections'
          ? h(AcpSection, { ...props, presentation: 'management' })
          : workspace
            ? h(Monitor, {
                key: workspace.workspaceId,
                cwd: workspace.path,
                workspaceTitle: workspace.title,
              })
            : h(
                'div',
                { className: css.empty },
                snapshot.phase === 'pending' ? t('managerCopy11') : t('managerCopy12'),
              ),
      ),
    )
  }
}
