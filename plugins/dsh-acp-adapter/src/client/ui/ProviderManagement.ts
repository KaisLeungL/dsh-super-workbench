/** 稳定 ACP 实例的 Provider 管理页；所有写入仍走原生设置控制器。 */
import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { catalogIdOf } from '../../contract/agent-config.ts'
import { ACP_CATALOG_ENTRIES, catalogEntryOf } from '../data/catalog.ts'
import {
  agentLoginHint,
  draftFromAgent,
  dropMaskedEnvKey,
  emptyDraft,
  healthRowOf,
  newProviderDraft,
  sortedAgentIds,
  validateAgentDraft,
} from '../data/logic.ts'
import type { AcpAgentConfig, AcpProviderHealth, AgentDraft, DraftError } from '../data/logic.ts'
import type { AcpSectionWire, AcpTranslate, UsePanelStore } from './AcpSection.ts'
import { localizedDiagnostic } from '../data/diagnostics.ts'
import css from './ProviderManagement.module.css'
import { ManagedChatGptCard } from './ManagedChatGptCard.ts'

type Props = { t: AcpTranslate; useStore: UsePanelStore; panel: AcpSectionWire }
type EditorProps = { t: AcpTranslate; draft: AgentDraft; edit(patch: Partial<AgentDraft>): void; disabled: boolean }

function status(t: AcpTranslate, config: AcpAgentConfig, health: AcpProviderHealth | undefined): string {
  if (config.enabled === false) return t('providerDisabled')
  if (health?.probe.status === 'ok') return t('stateReady')
  if (health?.probe.status === 'error') return t('providerProtocolError')
  return t('providerNotChecked')
}

export function ProviderManagement({ t, useStore, panel }: Props): ReactNode {
  const snapshot = useStore((value) => value)
  const [selected, setSelected] = useState('')
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState(false)
  const addRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    panel.refreshHealth()
  }, [panel])
  const settings = snapshot.settings
  if (settings.status !== 'ready')
    return h(
      'p',
      { className: css.empty },
      t(
        settings.status === 'loading'
          ? 'settingsLoading'
          : settings.status === 'invalid'
            ? 'settingsInvalid'
            : 'settingsUnavailable',
      ),
    )
  const agents = settings.agents
  const ids = sortedAgentIds(agents)
  const id = agents[selected] === undefined ? ids[0] : selected
  const config = id === undefined ? undefined : agents[id]
  const readOnly = !settings.writable
  const closeAdd = (): void => {
    setAdding(false)
    addRef.current?.focus()
  }
  const toggle = async (agentId: string): Promise<void> => {
    const current = agents[agentId]
    if (current === undefined) return
    setPending(agentId)
    setFailure(false)
    try {
      const draft = { ...draftFromAgent(agentId, current), enabled: current.enabled === false }
      setFailure((await panel.saveAgent(agentId, draft)) !== undefined)
    } catch {
      setFailure(true)
    } finally {
      setPending(undefined)
    }
  }
  const filtered = ids.filter((key) =>
    `${key} ${agents[key]?.name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  )
  return h(
    'div',
    { className: css.root, 'data-dsh-acp-panel': '', 'data-dsh-acp-management': '' },
    h(
      'header',
      { className: css.header },
      h('p', { className: css.hint }, t('providerScope')),
      h(
        Button,
        { ref: addRef, variant: 'primary', disabled: readOnly || adding, onClick: () => setAdding(true) },
        '+ ',
        t('providerAdd'),
      ),
    ),
    readOnly ? h('p', { role: 'status' }, t('readOnly')) : null,
    failure ? h('p', { className: css.error, role: 'alert' }, t('providerToggleFailed')) : null,
    snapshot.health.status === 'unreachable'
      ? h('p', { className: css.error, role: 'status' }, t('healthUnreachable'))
      : null,
    h(
      'div',
      { className: css.layout },
      h(
        'aside',
        { className: css.sidebar, 'aria-label': t('providerTitle') },
        h(Input, {
          type: 'search',
          value: query,
          'aria-label': t('providerSearch'),
          placeholder: t('providerSearch'),
          onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
        }),
        h(
          'ul',
          { className: css.list },
          ...filtered.map((key) => {
            const current = agents[key]!
            const health = healthRowOf(snapshot.health.rows, key)
            return h(
              'li',
              {
                key,
                className: `${css.row} ${!adding && key === id ? css.selected : ''}`,
                'data-provider-instance': key,
              },
              h(
                'button',
                {
                  type: 'button',
                  className: css.select,
                  'aria-current': !adding && key === id ? 'true' : undefined,
                  onClick: () => {
                    setSelected(key)
                    setAdding(false)
                  },
                },
                h('strong', null, current.name),
                h(
                  'span',
                  { className: css.type },
                  catalogEntryOf(catalogIdOf(key, current))?.name ?? t('providerGeneric'),
                ),
                h(
                  'span',
                  { className: css.state, 'data-ready': current.enabled !== false && health?.probe.status === 'ok' },
                  current.enabled !== false && current.authentication === 'chatgpt-managed' && !current.authBinding
                    ? t('managedAuthDisconnected')
                    : status(t, current, health),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  role: 'switch',
                  'aria-checked': current.enabled !== false,
                  'aria-label': t('providerEnabled', { name: current.name }),
                  className: css.switch,
                  title: t('providerDisableHelp'),
                  disabled: readOnly || pending !== undefined || adding,
                  onClick: () => void toggle(key),
                },
                h('span', null),
              ),
            )
          }),
        ),
        filtered.length === 0
          ? h('p', { className: css.empty }, t(ids.length === 0 ? 'providerNone' : 'providerNoMatch'))
          : null,
        h(
          Button,
          {
            variant: 'outline',
            disabled: snapshot.health.status === 'loading' || snapshot.health.checkingAgentIds.length > 0,
            onClick: () => panel.refreshHealth(true),
          },
          t('providerCheckAll'),
        ),
      ),
      adding
        ? h(AddProvider, {
            t,
            agents,
            panel,
            readOnly,
            checking: snapshot.health.status === 'loading' || snapshot.health.checkingAgentIds.length > 0,
            onCancel: closeAdd,
            onSaved: (savedId: string) => {
              setSelected(savedId)
              setAdding(false)
            },
          })
        : id !== undefined && config !== undefined
          ? h(ProviderDetail, {
              key: `${id}:${JSON.stringify(config)}`,
              t,
              id,
              config,
              agents,
              readOnly: readOnly || pending !== undefined,
              panel,
              health: healthRowOf(snapshot.health.rows, id),
              checking: snapshot.health.status === 'loading' || snapshot.health.checkingAgentIds.includes(id),
              checkError: snapshot.health.agentErrors[id],
              onDeleted: () => setSelected(''),
            })
          : h('div', { className: css.empty }, t('providerSelect')),
    ),
    h(
      'details',
      { className: css.preferences },
      h('summary', null, t('providerApproval')),
      h('p', { className: css.hint }, t('providerApprovalHint')),
      h(
        'select',
        {
          value: settings.toolApprovalDefault,
          disabled: readOnly || pending !== undefined,
          'aria-label': t('providerApproval'),
          onChange: async (event: { target: { value: string } }) => {
            const policy = event.target.value
            if (policy !== 'auto' && policy !== 'ask') return
            setPending('approval')
            setFailure(false)
            try {
              setFailure((await panel.setToolApprovalDefault(policy)) !== undefined)
            } catch {
              setFailure(true)
            } finally {
              setPending(undefined)
            }
          },
        },
        h('option', { value: 'auto' }, t('toolApprovalAuto')),
        h('option', { value: 'ask' }, t('toolApprovalAsk')),
      ),
    ),
  )
}

function Field({
  label,
  value,
  onChange,
  disabled,
  hint,
  error,
  multiline = false,
}: {
  label: string
  value: string
  onChange(value: string): void
  disabled: boolean
  hint?: string | undefined
  error?: string | undefined
  multiline?: boolean
}): ReactNode {
  const id = `provider-field-${useId()}`
  return h(
    'div',
    { className: css.field },
    h('label', { htmlFor: id }, label),
    multiline
      ? h('textarea', {
          id,
          value,
          disabled,
          'aria-describedby': hint || error ? `${id}-help` : undefined,
          rows: 3,
          'aria-invalid': error !== undefined,
          onChange: (event: { target: { value: string } }) => onChange(event.target.value),
        })
      : h(Input, {
          id,
          value,
          disabled,
          'aria-describedby': hint || error ? `${id}-help` : undefined,
          type: 'text',
          'aria-invalid': error !== undefined,
          onChange: (event: { target: { value: string } }) => onChange(event.target.value),
        }),
    error !== undefined
      ? h('span', { id: `${id}-help`, className: css.error, role: 'alert' }, error)
      : hint
        ? h('span', { id: `${id}-help`, className: css.hint }, hint)
        : null,
  )
}

function RuntimeFields({ t, draft, edit, disabled, open }: EditorProps & { open: boolean }): ReactNode {
  return h(
    'details',
    { className: css.group, open },
    h(
      'summary',
      null,
      t('providerRuntime'),
      h('span', { className: css.hint }, draft.command.split(/[\\/]/).at(-1) || t('providerRuntimeHint')),
    ),
    h(
      'div',
      { className: css.fields },
      h(Field, {
        label: t('fieldCommand'),
        value: draft.command,
        disabled,
        hint: t('fieldCommandHint'),
        onChange: (command: string) => edit({ command }),
      }),
      h(Field, {
        label: t('fieldArgs'),
        value: draft.argsText,
        disabled,
        multiline: true,
        hint: t('fieldArgsHint'),
        onChange: (argsText: string) => edit({ argsText }),
      }),
    ),
  )
}

function EnvironmentFields({ t, draft, edit, disabled }: EditorProps): ReactNode {
  const masked = Object.keys(draft.maskedEnv ?? {})
  return h(
    'section',
    { className: css.group },
    h('h3', null, t('providerEnvironment')),
    h('p', { className: css.hint }, t('providerSharedAuth')),
    h(Field, {
      label: t('fieldEnv'),
      value: draft.envText,
      disabled,
      multiline: true,
      hint: t('providerEnvHelp'),
      onChange: (envText: string) => edit({ envText }),
    }),
    masked.length > 0
      ? h(
          'ul',
          { className: css.masked },
          ...masked.map((key) =>
            h(
              'li',
              { key },
              h('code', null, key),
              h('span', { className: css.hint }, t('providerConfigured')),
              h(
                Button,
                {
                  variant: 'ghost',
                  size: 'sm',
                  disabled,
                  onClick: () => edit({ maskedEnv: dropMaskedEnvKey(draft, key).maskedEnv ?? {} }),
                },
                t('envMaskedRemove'),
              ),
            ),
          ),
        )
      : null,
  )
}

function ProviderDetail({
  t,
  id,
  config,
  agents,
  readOnly,
  panel,
  health,
  checking,
  checkError,
  onDeleted,
}: {
  t: AcpTranslate
  id: string
  config: AcpAgentConfig
  agents: Record<string, AcpAgentConfig>
  readOnly: boolean
  panel: AcpSectionWire
  health: AcpProviderHealth | undefined
  checking: boolean
  checkError: string | undefined
  onDeleted(): void
}): ReactNode {
  const [draft, setDraft] = useState(() => draftFromAgent(id, config))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [count, setCount] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (!confirming) return
    let active = true
    void panel
      .countBoundSessions(id)
      .then((value) => {
        if (active) setCount(value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [confirming, id, panel])
  const validation = validateAgentDraft(draft, agents, id)
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromAgent(id, config))
  const disabled = readOnly || busy
  const edit = (patch: Partial<AgentDraft>): void => {
    setDraft((previous) => ({ ...previous, ...patch }))
    setFailure(undefined)
    setSaved(false)
  }
  const error = (value: DraftError | undefined): string | undefined =>
    value === undefined ? undefined : t(value.key, value.params)
  const save = async (): Promise<void> => {
    if (validation.config === undefined) return
    setBusy(true)
    setFailure(undefined)
    try {
      if ((await panel.saveAgent(id, draft)) !== undefined) {
        setFailure(t('providerSaveFailed'))
        return
      }
      setSaved(true)
      panel.notifyOutcome?.('saved')
      panel.refreshHealth()
    } catch {
      setFailure(t('providerSaveFailed'))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      if (config.authentication === 'chatgpt-managed') {
        if (!panel.managedChatGpt) throw new Error('托管授权服务不可用。')
        await panel.managedChatGpt.logout(id)
      }
      if ((await panel.deleteAgent(id)) !== undefined) {
        setFailure(t('providerDeleteFailed'))
        return
      }
      panel.notifyOutcome?.('deleted')
      onDeleted()
    } catch {
      setFailure(t('providerDeleteFailed'))
    } finally {
      setBusy(false)
    }
  }
  const loginHint = config.authentication === 'chatgpt-managed' ? undefined : agentLoginHint(id, config)
  const probe = health?.probe
  return h(
    'section',
    { className: css.detail, 'data-provider-detail': id, 'aria-label': config.name },
    h(
      'header',
      { className: css.detailHeader },
      h('div', null, h('h2', null, config.name), h('code', { className: css.hint }, `acp-${id}`)),
      h(
        'span',
        { className: css.state },
        config.enabled !== false && config.authentication === 'chatgpt-managed' && !config.authBinding
          ? t('managedAuthDisconnected')
          : status(t, config, health),
      ),
    ),
    h(
      'section',
      { className: css.group },
      h(
        'div',
        { className: css.sectionHeading },
        h('h3', null, t('providerState')),
        h(
          Button,
          {
            variant: 'outline',
            size: 'sm',
            disabled:
              checking ||
              config.enabled === false ||
              dirty ||
              busy ||
              (config.authentication === 'chatgpt-managed' && !config.authBinding),
            onClick: () => panel.refreshAgentHealth(id),
          },
          t(checking ? 'providerChecking' : 'providerCheck'),
        ),
      ),
      h(
        'dl',
        { className: css.facts },
        h('dt', null, t('providerProtocol')),
        h('dd', null, status(t, config, health)),
        h('dt', null, t('providerAuth')),
        h(
          'dd',
          null,
          t(
            config.authentication === 'chatgpt-managed'
              ? 'managedAuthTitle'
              : probe?.status === 'error' && probe.failureKind === 'auth_required'
                ? 'providerAuthRequired'
                : 'providerAuthUnknown',
          ),
        ),
        h('dt', null, t('providerVersion')),
        h(
          'dd',
          null,
          probe?.status === 'ok'
            ? (probe.agentInfo?.version ?? health?.version ?? t('providerVersionUnknown'))
            : t('providerVersionUnknown'),
        ),
      ),
      h(
        'p',
        { className: css.hint },
        probe?.at ? t('providerCheckedAt', { time: new Date(probe.at).toLocaleString() }) : t('providerNotChecked'),
      ),
      dirty || config.authentication !== 'chatgpt-managed'
        ? h('p', { className: css.hint }, t(dirty ? 'providerDirtyCheck' : 'providerAuthHelp'))
        : null,
      loginHint ? h('p', { className: css.hint }, t('providerLoginCommand', { hint: loginHint })) : null,
      checkError !== undefined || probe?.status === 'error'
        ? h(
            'p',
            { className: css.error, role: 'status' },
            localizedDiagnostic(
              t,
              checkError
                ? 'healthCheckTransportFailed'
                : probe?.status === 'error' && probe.failureKind === 'spawn-failure'
                  ? 'probeNotInstalled'
                  : probe?.status === 'error' && probe.failureKind === 'auth_required'
                    ? 'probeAuthRequired'
                    : 'probeProtocolError',
              checkError ?? (probe?.status === 'error' ? probe.message : undefined),
              { command: config.command },
            ),
          )
        : null,
    ),
    config.authentication === 'chatgpt-managed' ? h(ManagedChatGptCard, { id, config, panel, t, readOnly }) : null,
    h(
      'section',
      { className: css.group },
      h(Field, {
        label: t('fieldName'),
        value: draft.name,
        disabled,
        error: error(validation.name),
        onChange: (name: string) => edit({ name }),
      }),
      h(Field, {
        label: t('fieldId'),
        value: id,
        disabled: true,
        hint: t('providerIdHelp'),
        onChange: () => undefined,
      }),
    ),
    h(RuntimeFields, { t, draft, edit, disabled, open: false }),
    h(EnvironmentFields, { t, draft, edit, disabled }),
    validation.env ? h('p', { className: css.error, role: 'alert' }, error(validation.env)) : null,
    h(
      'section',
      { className: css.group },
      h('h3', null, t('providerModels')),
      h(
        'p',
        null,
        probe?.status === 'ok' ? t('providerModelCount', { count: probe.modelCount }) : t('providerModelsUnknown'),
      ),
      h('p', { className: css.hint }, t('providerModelsHelp')),
    ),
    failure ? h('p', { className: css.error, role: 'alert' }, failure) : null,
    h(
      'footer',
      { className: css.actions },
      h(Button, { variant: 'ghost', disabled, onClick: () => setConfirming(true) }, t('providerDelete')),
      h('span', { className: css.hint, role: 'status' }, saved ? t('providerSaved') : ''),
      h(
        Button,
        {
          variant: 'primary',
          disabled: disabled || !dirty || validation.config === undefined,
          onClick: () => void save(),
        },
        t(busy ? 'saving' : 'save'),
      ),
    ),
    confirming
      ? h(
          'section',
          { className: css.confirm, 'aria-label': t('providerDeleteTitle') },
          h('h3', null, t('providerDeleteTitle')),
          h('p', null, t('providerDeleteHelp')),
          count !== undefined ? h('p', null, t('removeConfirmBound', { count })) : null,
          h(
            'div',
            { className: css.actions },
            h(Button, { variant: 'outline', disabled: busy, onClick: () => setConfirming(false) }, t('cancel')),
            h(Button, { variant: 'primary', disabled: busy, onClick: () => void remove() }, t('providerDelete')),
          ),
        )
      : null,
  )
}

function AddProvider({
  t,
  agents,
  panel,
  readOnly,
  checking,
  onCancel,
  onSaved,
}: {
  t: AcpTranslate
  agents: Record<string, AcpAgentConfig>
  panel: AcpSectionWire
  readOnly: boolean
  checking: boolean
  onCancel(): void
  onSaved(id: string): void
}): ReactNode {
  const [step, setStep] = useState(0)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(false)
  const heading = useRef<HTMLHeadingElement | null>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [step])
  const validation = validateAgentDraft(draft, agents, undefined)
  const edit = (patch: Partial<AgentDraft>): void => {
    setDraft((previous) => ({ ...previous, ...patch }))
    setFailure(false)
  }
  const choose = (entryId: string | undefined): void => {
    setDraft(newProviderDraft(entryId, agents))
    setStep(1)
  }
  const chooseManaged = (): void => {
    const seed = newProviderDraft('codex-acp', agents)
    const existing = Object.entries(agents).find(([key, config]) => key === 'codex' || config.runtime === 'codex')?.[1]
    let id = 'codex-chatgpt',
      suffix = 1
    while (agents[id]) id = `codex-chatgpt-${++suffix}`
    setDraft({
      ...seed,
      id,
      name: suffix === 1 ? 'Codex · ChatGPT' : `Codex · ChatGPT ${suffix}`,
      command: existing?.command ?? seed.command,
      argsText: existing?.args.join('\n') ?? seed.argsText,
      envText: '',
      loginHint: '',
      runtime: 'codex',
      authentication: 'chatgpt-managed',
    })
    setStep(1)
  }
  const entry = catalogEntryOf(draft.catalogId ?? '')
  const entries = ACP_CATALOG_ENTRIES.filter((value) =>
    `${value.id} ${value.name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  )
  const save = async (): Promise<void> => {
    if (validation.config === undefined) return
    setBusy(true)
    setFailure(false)
    try {
      if ((await panel.saveAgent(undefined, draft)) !== undefined) {
        setFailure(true)
        return
      }
      panel.notifyOutcome?.('saved')
      onSaved(draft.id.trim())
      if (draft.authentication !== 'chatgpt-managed') panel.refreshAgentHealth(draft.id.trim())
    } catch {
      setFailure(true)
    } finally {
      setBusy(false)
    }
  }
  return h(
    'section',
    {
      className: css.detail,
      'data-provider-wizard': step,
      'aria-label': t('providerAdd'),
      onKeyDown: (event: { key: string; stopPropagation(): void }) => {
        if (event.key === 'Escape' && !busy) {
          event.stopPropagation()
          onCancel()
        }
      },
    },
    h(
      'header',
      { className: css.detailHeader },
      h(
        'div',
        null,
        h('p', { className: css.eyebrow }, t('providerStep', { step: step + 1 })),
        h(
          'h2',
          { ref: heading, tabIndex: -1 },
          t(step === 0 ? 'providerType' : step === 1 ? 'providerIdentity' : 'providerConfigure'),
        ),
      ),
      h(Button, { variant: 'ghost', disabled: busy || readOnly, onClick: onCancel }, t('cancel')),
    ),
    h(
      'ol',
      { className: css.steps, 'aria-label': t('providerAdd') },
      ...(['providerType', 'providerIdentity', 'providerConfigure'] as const).map((key, index) =>
        h('li', { key, 'aria-current': step === index ? 'step' : undefined }, `${index + 1}. ${t(key)}`),
      ),
    ),
    step === 0
      ? h(
          'div',
          { className: css.fields },
          h('p', { className: css.hint }, t('providerCatalogHint')),
          h(
            'button',
            { type: 'button', className: css.local, onClick: chooseManaged },
            h('strong', null, t('managedAuthType')),
            h('span', { className: css.hint }, t('managedAuthTypeHint')),
          ),
          h(Input, {
            type: 'search',
            value: query,
            'aria-label': t('providerCatalogSearch'),
            placeholder: t('providerCatalogSearch'),
            onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
          }),
          h(
            'div',
            { className: css.catalog },
            ...entries.map((value) =>
              h(
                'button',
                { type: 'button', key: value.id, onClick: () => choose(value.id) },
                h('strong', null, value.name),
                h(
                  'span',
                  { className: css.hint },
                  value.verification === 'adapter-tested' ? t('providerCatalogTested') : value.id,
                ),
              ),
            ),
          ),
          entries.length === 0 ? h('p', { className: css.hint }, t('providerCatalogEmpty')) : null,
          h(
            'button',
            { type: 'button', className: css.local, onClick: () => choose(undefined) },
            h('strong', null, t('providerGeneric')),
            h('span', { className: css.hint }, t('providerLocalHint')),
          ),
        )
      : step === 1
        ? h(
            'div',
            { className: css.fields },
            h('p', { className: css.hint }, t('providerExistingHint')),
            h(Field, {
              label: t('fieldName'),
              value: draft.name,
              disabled: busy || readOnly,
              error: draft.name && validation.name ? t(validation.name.key) : undefined,
              onChange: (name: string) => edit({ name }),
            }),
            h(Field, {
              label: t('fieldId'),
              value: draft.id,
              disabled: busy || readOnly,
              hint: t('providerIdHelp'),
              error: draft.id && validation.id ? t(validation.id.key) : undefined,
              onChange: (id: string) => edit({ id }),
            }),
          )
        : h(
            'div',
            { className: css.fields },
            h('p', null, draft.name, ' · ', h('code', { className: css.hint }, `acp-${draft.id}`)),
            entry ? h('p', { className: css.hint }, t('catalogInstallHint', { hint: entry.installHint })) : null,
            h(RuntimeFields, { t, draft, edit, disabled: busy || readOnly, open: draft.runtime === undefined }),
            h(EnvironmentFields, { t, draft, edit, disabled: busy || readOnly }),
            validation.env
              ? h('p', { className: css.error, role: 'alert' }, t(validation.env.key, validation.env.params))
              : null,
            h(
              'p',
              { className: css.hint },
              t(draft.authentication === 'chatgpt-managed' ? 'managedAuthSaveHelp' : 'providerSavedCheck'),
            ),
          ),
    failure ? h('p', { className: css.error, role: 'alert' }, t('providerSaveFailed')) : null,
    step > 0
      ? h(
          'footer',
          { className: css.actions },
          h(
            Button,
            { variant: 'outline', disabled: busy || readOnly, onClick: () => setStep(step - 1) },
            t('providerBack'),
          ),
          h(
            Button,
            {
              variant: 'primary',
              disabled:
                busy ||
                readOnly ||
                (step === 2 && checking) ||
                (step === 1
                  ? validation.id !== undefined || validation.name !== undefined
                  : validation.config === undefined),
              onClick: () => (step === 1 ? setStep(2) : void save()),
            },
            t(
              busy
                ? 'saving'
                : step === 1
                  ? 'providerNext'
                  : draft.authentication === 'chatgpt-managed'
                    ? 'save'
                    : 'providerSaveCheck',
            ),
          ),
        )
      : null,
  )
}
