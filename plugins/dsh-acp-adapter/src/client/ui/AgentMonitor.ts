/** Agent 会话总览：读取当前选中会话的原生内容。 */
import { createElement as h, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode, SyntheticEvent } from 'react'
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AcpActivityView } from '../../contract/remote.ts'
import type { SettingsScopeLike } from '../data/controller.ts'
import type { AcpActivityJournalHub } from '../data/activity-journal.ts'
import {
  monitorAnchors,
  monitorFeed,
  monitorScope,
  monitorSessions,
  monitorTiming,
  monitorSummary,
  monitorState,
} from '../data/agent-monitor.ts'
import type { MonitorSession } from '../data/agent-monitor.ts'
import { ActivityAnchorSubscriptions } from './activity-anchor-subscriptions.ts'
import { activityToolOutput } from './activity-tool-output.ts'
import { activityDiffsOf } from '../../contract/activity-diffs.ts'
import { redactSecretText } from '../../contract/redaction.ts'
import type { AcpLocaleKey } from './locales.ts'
import css from './AgentMonitor.module.css'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    acpMonitor: unknown
  }
}

export interface MonitorDeps {
  readonly sessions: ISessions
  readonly conversation: Pick<UiConversation, 'binding'>
  readonly scope: SettingsScopeLike
  readonly hub: AcpActivityJournalHub
  readonly owns: (provider: string | undefined) => boolean
  readonly diagnostics: (id: SessionId) => ReactNode
  readonly openSession: (id: SessionId) => void
  readonly t: (key: AcpLocaleKey, params?: Record<string, string | number>) => string
}

const statuses: Record<string, AcpLocaleKey> = {
  running: 'monitorCopy1',
  completed: 'monitorCopy2',
  failed: 'monitorCopy3',
  cancelled: 'monitorCopy4',
  unfinished: 'monitorCopy5',
}
const timeLabel = (value: number): string => new Date(value).toLocaleTimeString('zh-CN', { hour12: false })

function toolSummary(text: string, time: number, status: string | undefined, t: MonitorDeps['t']): ReactNode {
  return h(
    'span',
    { className: css.activitySummary },
    h('span', { className: css.activityTitle }, text),
    h(
      'span',
      { className: css.activityMeta },
      status ? h('span', { 'data-status': status }, statuses[status] ? t(statuses[status]) : status) : null,
      h('time', { dateTime: new Date(time).toISOString() }, timeLabel(time)),
    ),
  )
}

function MonitorActivity({ row, deps }: { row: AcpActivityView; deps: MonitorDeps }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  return h(
    'details',
    { onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => setExpanded(event.currentTarget.open) },
    h('summary', null, toolSummary(row.presentation, row.time, row.status, deps.t)),
    expanded ? h(ActivityDetail, { row, deps }) : null,
  )
}

function ActivityDetail({ row, deps }: { row: AcpActivityView; deps: MonitorDeps }): ReactNode {
  const [detail, setDetail] = useState<AcpActivityView>()
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setDetail(undefined)
    setError(false)
    const request = row.detailDeferred ? deps.hub.detail(row) : Promise.resolve(row)
    void request.then(
      (value) => {
        if (active) setDetail(value)
      },
      () => {
        if (active) setError(true)
      },
    )
    return () => {
      active = false
    }
  }, [row, deps, attempt])
  if (error) return h('button', { type: 'button', onClick: () => setAttempt(attempt + 1) }, deps.t('monitorCopy6'))
  if (detail === undefined) return h('p', { className: css.muted }, deps.t('monitorCopy7'))
  let raw: unknown
  try {
    raw = JSON.parse(detail.rawDetail ?? '{}') as unknown
  } catch {
    raw = {}
  }
  const object = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const output = activityToolOutput(object.rawOutput, object.content, deps.t).text
  const diffs = detail.display?.diffs ?? activityDiffsOf(raw)
  return h(
    'div',
    { className: css.detail },
    detail.display?.plan?.map((item, index) =>
      h(
        'p',
        { key: index },
        `${item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '→' : '·'} ${item.content}`,
      ),
    ),
    output ? h('pre', null, output) : null,
    ...diffs.map((diff, index) =>
      h(
        'details',
        { key: index },
        h('summary', null, diff.path),
        diff.oldText === null
          ? h('p', { className: css.muted }, deps.t('monitorCopy8'))
          : h('pre', null, redactSecretText(diff.oldText)),
        h('p', { className: css.muted }, deps.t('monitorCopy9')),
        h('pre', null, redactSecretText(diff.newText)),
      ),
    ),
    !output && diffs.length === 0 && !detail.display?.plan?.length
      ? h(
          'p',
          { className: css.muted },
          detail.display?.unavailable ? deps.t('monitorCopy10') : deps.t('monitorCopy11'),
        )
      : null,
  )
}

function BoundMonitor({ binding, deps }: { binding: SessionBinding; deps: MonitorDeps }): ReactNode {
  const sessionSource = useMemo(
    () => ({
      subscribe: (listener: () => void) => binding.session.subscribe(listener),
      getSnapshot: () => binding.session.getSnapshot(),
    }),
    [binding],
  )
  const session = useSyncExternalStore(sessionSource.subscribe, sessionSource.getSnapshot)
  const chatSource = useMemo(() => deps.conversation.binding(binding).target('chat'), [binding, deps])
  const chat = useSyncExternalStore(chatSource.subscribe, chatSource.getSnapshot)
  const leases = useMemo(() => new ActivityAnchorSubscriptions(), [binding])
  const anchors = useMemo(() => monitorAnchors(chat, binding.sessionId), [chat, binding.sessionId])
  const [windows, setWindows] = useState<
    Map<string, { rows: readonly AcpActivityView[]; error: boolean; retry: () => void }>
  >(new Map())
  const [follow, setFollow] = useState(true)
  const [now, setNow] = useState(Date.now)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => () => leases.dispose(), [leases])
  useEffect(() => {
    const desired = anchors.map((anchor) => ({
      ...anchor,
      key: JSON.stringify([anchor.ownerDshSessionId, anchor.promptAnchorMessageId]),
    }))
    const keys = new Set(desired.map((item) => item.key))
    setWindows((old) => new Map([...old].filter(([key]) => keys.has(key))))
    leases.reconcile(deps.hub, binding.sessionId, binding, desired, (key, handle) => {
      setWindows((old) =>
        new Map(old).set(key, { rows: handle.snapshot(), error: handle.error() !== undefined, retry: handle.retry }),
      )
    })
  }, [anchors, binding, deps, leases])
  useEffect(() => {
    if (!session.running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [session.running])
  const feed = monitorFeed(
    chat,
    [...windows.values()].flatMap((window) => window.rows),
  )
  useEffect(() => {
    if (follow && body.current) body.current.scrollTop = body.current.scrollHeight
  }, [chat, windows, follow])
  const timing = monitorTiming(chat)
  const failed = !session.running && (session.lastAgentError !== null || session.openState === 'error')
  return h(
    'div',
    { className: css.bound },
    h(
      'div',
      { className: css.sessionState },
      failed ? h('span', { className: css.error }, deps.t('monitorCopy12')) : null,
      timing
        ? h(
            'span',
            { className: css.duration },
            deps.t('monitorDuration', {
              seconds: Math.max(0, Math.floor(((timing.end ?? now) - timing.start) / 1000)),
            }),
          )
        : null,
      h(
        'button',
        { type: 'button', className: css.textButton, 'aria-pressed': follow, onClick: () => setFollow(!follow) },
        follow ? deps.t('monitorCopy13') : deps.t('monitorCopy14'),
      ),
    ),
    h(
      'div',
      { ref: body, className: css.feed, tabIndex: 0, 'aria-label': deps.t('monitorCopy15') },
      session.openState === 'loading' ? h('p', { className: css.muted }, deps.t('monitorCopy16')) : null,
      session.openState === 'error' ? h('p', { className: css.error }, deps.t('monitorCopy17')) : null,
      ...[...windows.entries()]
        .filter(([, window]) => window.error)
        .map(([key, window]) => h('button', { key, type: 'button', onClick: window.retry }, deps.t('monitorCopy18'))),
      ...feed.map((item) =>
        h(
          'article',
          { key: item.key, className: css.item, 'data-kind': item.kind },
          item.kind === 'tool'
            ? null
            : h(
                'div',
                { className: css.itemMeta },
                h(
                  'span',
                  null,
                  item.kind === 'user'
                    ? deps.t('monitorCopy19')
                    : item.kind === 'assistant'
                      ? deps.t('connectionsAgent')
                      : item.kind === 'error'
                        ? deps.t('monitorCopy20')
                        : deps.t('monitorCopy21'),
                ),
                h('time', { dateTime: new Date(item.time).toISOString() }, timeLabel(item.time)),
                item.status
                  ? h(
                      'span',
                      { 'data-status': item.status },
                      statuses[item.status] ? deps.t(statuses[item.status]!) : item.status,
                    )
                  : null,
              ),
          item.activity
            ? h(MonitorActivity, { row: item.activity, deps })
            : item.kind === 'tool'
              ? toolSummary(item.text, item.time, item.status, deps.t)
              : h(
                  'p',
                  { className: css.message },
                  item.text.length > 8000 ? `${item.text.slice(0, 8000)}\n${deps.t('monitorFullContent')}` : item.text,
                ),
        ),
      ),
      feed.length === 0 && session.openState === 'open'
        ? h('p', { className: css.muted }, deps.t('monitorCopy22'))
        : null,
    ),
    h('div', { className: css.paneFooter }, deps.t('monitorCopy23')),
  )
}

function MonitorPane({ item, deps }: { item: MonitorSession; deps: MonitorDeps }): ReactNode {
  const [binding, setBinding] = useState<SessionBinding>()
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const settings = useSyncExternalStore(deps.scope.subscribe.bind(deps.scope), deps.scope.getSnapshot.bind(deps.scope))
  const agentName = settings.value?.agents[item.provider.slice(4)]?.name ?? item.provider.slice(4)
  useEffect(() => {
    setBinding(undefined)
    setError(false)
    let active = true
    const reference = deps.sessions.retain(item.summary.id, { source: 'acpMonitor' })
    setBinding(reference.binding)
    void reference.ready.catch(() => {
      if (active) setError(true)
    })
    return () => {
      active = false
      reference.release()
    }
  }, [item.summary.id, deps, attempt])
  return h(
    'section',
    {
      className: css.pane,
      'data-agent-monitor-pane': item.summary.id,
      'aria-label': `${agentName} · ${item.summary.displayTitle}`,
    },
    h(
      'header',
      { className: css.paneHeader },
      h(
        'div',
        { className: css.heading },
        h('strong', { title: item.summary.displayTitle }, item.summary.displayTitle),
        h('span', { title: item.model }, `${agentName} · ${item.model}`),
      ),
      h(
        'span',
        { className: css.status, 'data-running': item.summary.running, 'aria-live': 'polite' },
        item.summary.running ? deps.t('monitorCopy1') : deps.t('monitorCopy24'),
      ),
      h(
        'button',
        { type: 'button', className: css.textButton, onClick: () => deps.openSession(item.summary.id) },
        deps.t('monitorCopy25'),
      ),
    ),

    error
      ? h('button', { type: 'button', onClick: () => setAttempt(attempt + 1) }, deps.t('monitorCopy30'))
      : binding
        ? h(BoundMonitor, { key: `${item.summary.id}:${attempt}`, binding, deps })
        : h('p', { className: css.muted }, deps.t('monitorCopy31')),
  )
}

export interface AgentMonitorProps {
  cwd: string | undefined
  workspaceTitle: string
}

const stateLabels: Record<'running' | 'idle' | 'failed' | 'unknown', AcpLocaleKey> = {
  running: 'monitorCopy1',
  idle: 'monitorCopy24',
  failed: 'monitorCopy32',
  unknown: 'monitorCopy33',
}

export function createAgentMonitor(deps: MonitorDeps): (props: AgentMonitorProps) => ReactNode {
  return function AgentMonitor(props): ReactNode {
    const list = useSyncExternalStore(deps.sessions.list.subscribe, deps.sessions.list.getSnapshot)
    const settings = useSyncExternalStore(
      deps.scope.subscribe.bind(deps.scope),
      deps.scope.getSnapshot.bind(deps.scope),
    )
    const cwd = props.cwd
    const rows = monitorSessions(list, cwd, deps.owns)
    const [detail, setDetail] = useState<SessionId>()
    const [diagnosticSession, setDiagnosticSession] = useState<SessionId>()
    const [search, setSearch] = useState('')
    const [provider, setProvider] = useState('')
    const [status, setStatus] = useState('')
    const [refresh, setRefresh] = useState(0)
    const [refreshError, setRefreshError] = useState(false)
    const attempted = useRef(new Map<SessionId, number>())
    const scope = monitorScope(list, cwd)
    const readKey = scope.map((row) => `${row.id}:${row.updatedAt}`).join('|')
    useEffect(() => {
      let active = true
      const queue = monitorScope(deps.sessions.list.getSnapshot(), cwd).filter(
        (row) => attempted.current.get(row.id) !== row.updatedAt,
      )
      const read = async (): Promise<void> => {
        while (active && queue.length) {
          const row = queue.shift()!
          attempted.current.set(row.id, row.updatedAt)
          await deps.sessions.refreshProjections(row.id).catch(() => {
            if (active) setRefreshError(true)
          })
        }
      }
      void Promise.all([read(), read(), read()])
      return () => {
        active = false
      }
    }, [cwd, readKey, refresh])
    useEffect(() => {
      setDetail(undefined)
      setDiagnosticSession(undefined)
      setSearch('')
      setProvider('')
      setStatus('')
    }, [cwd])
    const rowKey = rows.map((row) => row.summary.id).join('|')
    useEffect(() => {
      setDetail((old) => (rows.some((row) => row.summary.id === old) ? old : rows[0]?.summary.id))
    }, [rowKey])
    const fact = (row: MonitorSession) => monitorSummary(list.projectionsBySession[row.summary.id]?.values.acpMonitor)
    const state = (row: MonitorSession) => monitorState(row.summary.running, fact(row))
    const name = (row: MonitorSession) => settings.value?.agents[row.provider.slice(4)]?.name ?? row.provider.slice(4)
    const filtered = rows.filter(
      (row) =>
        (!provider || row.provider === provider) &&
        (!status || state(row) === status) &&
        `${name(row)} ${row.summary.displayTitle} ${row.model}`.toLowerCase().includes(search.toLowerCase()),
    )
    const current = rows.find((row) => row.summary.id === detail)
    const groups = [...new Set(rows.map((row) => row.provider))]
    const retry = (): void => {
      attempted.current.clear()
      setRefreshError(false)
      setRefresh((value) => value + 1)
      void deps.sessions.refresh().catch(() => setRefreshError(true))
    }
    const filters = h(
      'div',
      { className: css.filters },
      h('input', {
        className: css.search,
        value: search,
        onChange: (event) => setSearch(event.currentTarget.value),
        placeholder: deps.t('monitorCopy34'),
        'aria-label': deps.t('monitorCopy35'),
      }),
      h(
        'select',
        {
          value: provider,
          'aria-label': deps.t('monitorCopy36'),
          onChange: (event: { currentTarget: HTMLSelectElement }) => setProvider(event.currentTarget.value),
        },
        h('option', { value: '' }, deps.t('monitorCopy37')),
        ...groups.map((id) =>
          h('option', { key: id, value: id }, settings.value?.agents[id.slice(4)]?.name ?? id.slice(4)),
        ),
      ),
      h(
        'select',
        {
          value: status,
          'aria-label': deps.t('monitorCopy38'),
          onChange: (event: { currentTarget: HTMLSelectElement }) => setStatus(event.currentTarget.value),
        },
        h('option', { value: '' }, deps.t('monitorCopy39')),
        ...Object.entries(stateLabels).map(([id, label]) => h('option', { key: id, value: id }, deps.t(label))),
      ),
    )
    const pending =
      list.phase === 'pending' ||
      scope.some((row) => {
        const value = list.projectionsBySession[row.id]
        return !value || value.state === 'idle' || value.state === 'loading'
      })
    const metadataFailed = scope.some((row) => list.projectionsBySession[row.id]?.state === 'error')
    const table = h(
      'div',
      { className: css.tableScroll },
      h(
        'table',
        { className: css.table },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ...[deps.t('monitorCopy40'), deps.t('monitorCopy41'), deps.t('monitorCopy42'), deps.t('monitorCopy43')].map(
              (label) => h('th', { key: label }, label),
            ),
          ),
        ),
        h(
          'tbody',
          null,
          ...filtered.map((row) => {
            const summary = fact(row)
            return h(
              'tr',
              {
                key: row.summary.id,
                'data-selected': detail === row.summary.id,
                'data-agent-manager-session': row.summary.id,
              },
              h(
                'td',
                null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: css.rowButton,
                    onClick: () => {
                      setDetail(row.summary.id)
                      setDiagnosticSession(undefined)
                    },
                    title: row.summary.displayTitle,
                  },
                  row.summary.displayTitle,
                ),
              ),
              h('td', null, h('strong', null, name(row)), h('small', null, row.model)),
              h(
                'td',
                null,
                h('span', { className: css.status, 'data-state': state(row) }, deps.t(stateLabels[state(row)])),
              ),
              h(
                'td',
                { title: summary?.error ?? summary?.latestActivity ?? summary?.latestMessage ?? '' },
                summary?.error ??
                  summary?.latestActivity ??
                  (summary?.outcome === 'completed'
                    ? deps.t('monitorCopy44')
                    : summary?.outcome === 'aborted'
                      ? deps.t('monitorCopy45')
                      : (summary?.latestMessage ?? deps.t('monitorCopy46'))),
                h(
                  'small',
                  null,
                  new Date(summary?.latestAt ?? row.summary.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }),
                ),
              ),
            )
          }),
        ),
      ),
      !filtered.length
        ? h(
            'p',
            { className: css.empty },
            metadataFailed
              ? deps.t('monitorCopy50')
              : pending
                ? deps.t('monitorCopy16')
                : rows.length
                  ? deps.t('monitorCopy47')
                  : deps.t('monitorCopy48'),
          )
        : null,
    )
    return h(
      'section',
      { className: css.root, 'data-agent-monitor': '', 'data-view': 'overview', 'aria-label': deps.t('monitorCopy49') },
      refreshError || metadataFailed
        ? h('button', { className: css.notice, onClick: retry }, deps.t('monitorCopy50'))
        : null,
      h(
        'div',
        { className: css.overview },
        h(
          'div',
          { className: css.overviewList },
          h(
            'div',
            { className: css.counts },
            ...(['running', 'idle', 'failed'] as const).map((key) =>
              h(
                'span',
                { key, 'data-state': key },
                `${key === 'failed' ? deps.t('monitorCopy51') : deps.t(stateLabels[key])} ${rows.filter((row) => state(row) === key).length}`,
              ),
            ),
            pending ? h('span', null, deps.t('monitorCopy52')) : null,
            h('button', { type: 'button', className: css.textButton, onClick: retry }, deps.t('monitorCopy53')),
          ),
          filters,
          table,
          h(
            'div',
            { className: css.listFooter },
            h('span', null, deps.t('monitorCopy54')),
            h('span', null, deps.t('monitorResultCount', { count: filtered.length })),
          ),
        ),
        current
          ? h(
              'aside',
              {
                className: css.detailPane,
                'aria-label': deps.t('monitorCopy55'),
                'data-diagnostics': diagnosticSession === current.summary.id,
              },
              h(
                'div',
                { className: css.detailActions },
                h('span', { title: cwd }, props.workspaceTitle),
                h(
                  'button',
                  {
                    type: 'button',
                    className: css.actionButton,
                    'aria-expanded': diagnosticSession === current.summary.id,
                    onClick: () =>
                      setDiagnosticSession((id) => (id === current.summary.id ? undefined : current.summary.id)),
                  },
                  deps.t(diagnosticSession === current.summary.id ? 'monitorBackToActivity' : 'auditOpen'),
                ),
              ),
              diagnosticSession === current.summary.id
                ? h(
                    'div',
                    { className: css.diagnosticPane },
                    h('h2', { className: css.diagnosticTitle }, current.summary.displayTitle),
                    deps.diagnostics(current.summary.id),
                  )
                : h(MonitorPane, {
                    key: current.summary.id,
                    item: current,
                    deps,
                  }),
            )
          : h('aside', { className: css.detailPane }, h('p', { className: css.empty }, deps.t('monitorCopy60'))),
      ),
    )
  }
}
