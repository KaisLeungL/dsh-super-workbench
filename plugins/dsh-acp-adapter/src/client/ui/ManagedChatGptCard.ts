/** 独立授权卡：只接收公开身份快照，令牌留在 Host。 */
import { createElement as h, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ManagedChatGptLogin, ManagedChatGptStatus } from '../../contract/managed-chatgpt.ts'
import type { AcpAgentConfig } from '../../contract/agent-config.ts'
import type { AcpSectionWire, AcpTranslate } from './AcpSection.ts'
import css from './ProviderManagement.module.css'

export interface ManagedChatGptWire {
  status(id: string): Promise<ManagedChatGptStatus>
  start(id: string): Promise<ManagedChatGptLogin>
  cancel(id: string): Promise<ManagedChatGptStatus>
  logout(id: string): Promise<ManagedChatGptStatus>
}

export function ManagedChatGptCard({
  id,
  config,
  panel,
  t,
  readOnly,
}: {
  id: string
  config: AcpAgentConfig
  panel: AcpSectionWire
  t: AcpTranslate
  readOnly: boolean
}): ReactNode {
  const [status, setStatus] = useState<ManagedChatGptStatus | undefined>(undefined)
  const [url, setUrl] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [generation, setGeneration] = useState(0)
  const auth = panel.managedChatGpt
  useEffect(() => {
    if (!auth) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const value = await auth.status(id)
        if (!active) return
        setStatus(value)
        if (value.status === 'connected' && value.bindingId && config.authBinding !== value.bindingId) {
          if (!panel.bindManagedChatGpt) throw new Error('缺少托管账号绑定接口')
          const failure = await panel.bindManagedChatGpt(id, value.bindingId)
          if (failure !== undefined) {
            if (active) setFailed(true)
            return
          }
          panel.refreshAgentHealth(id)
        }
        if (value.status === 'pending') timer = setTimeout(() => void poll(), 1500)
      } catch {
        if (active) setFailed(true)
      }
    }
    void poll()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [id, config, panel, auth, generation])
  const action = async (kind: 'start' | 'cancel' | 'logout'): Promise<void> => {
    if (!auth) return
    setBusy(true)
    setFailed(false)
    try {
      if (kind === 'start') {
        const value = await auth.start(id)
        setStatus(value.status)
        setUrl(value.authorizationUrl)
        window.open(value.authorizationUrl, '_blank', 'noopener,noreferrer')
      } else {
        setStatus(await auth[kind](id))
        setUrl(undefined)
      }
      setGeneration((previous) => previous + 1)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  const pending = status?.status === 'pending'
  const connected = status?.status === 'connected'
  return h(
    'section',
    { className: css.group, 'data-managed-chatgpt': id },
    h('h3', null, t('managedAuthTitle')),
    h(
      'p',
      { role: 'status' },
      t(
        pending
          ? 'managedAuthPending'
          : connected
            ? 'managedAuthConnected'
            : status?.status === 'consent-required'
              ? 'managedAuthConsentRequired'
              : 'managedAuthDisconnected',
      ),
    ),
    status?.email ? h('p', null, status.email) : null,
    h('p', { className: css.hint }, t('managedAuthHelp')),
    status?.message ? h('p', { className: css.error, role: 'status' }, status.message) : null,
    failed || !auth ? h('p', { className: css.error, role: 'alert' }, t('managedAuthFailed')) : null,
    pending && url
      ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, t('managedAuthOpenBrowser'))
      : null,
    h(
      'div',
      { className: css.actions },
      h(
        Button,
        {
          variant: pending || connected ? 'outline' : 'primary',
          disabled: busy || readOnly || !auth,
          onClick: () => void action(pending ? 'cancel' : connected ? 'logout' : 'start'),
          ...{ 'data-oai-siwc-button': pending || connected ? undefined : true },
        },
        t(pending ? 'managedAuthCancel' : connected ? 'managedAuthLogout' : 'managedAuthContinue'),
      ),
    ),
  )
}
