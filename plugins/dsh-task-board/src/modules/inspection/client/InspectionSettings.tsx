import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InspectionRule, ScanRun, Workspace } from '../core/types.ts'
import { INSPECTION_ID } from '../core/types.ts'
import { validRule } from '../core/recommendations.ts'
import type { Key } from './locales.ts'
import css from './inspection.module.css'

export interface Mirror {
  enabled: boolean
  extensions: Readonly<Record<string, unknown>>
}
export interface ClientBoard {
  snapshot(): Mirror
  subscribe(callback: (mirror: Mirror) => void): () => void
  dispatch(request: { extensionId: string; action: string; payload: Record<string, unknown> }): Promise<boolean>
}
export interface Settings { enabled?: boolean; rules?: InspectionRule[] }
interface SettingsProps { board: ClientBoard; form: ConfigForm<Settings>; t(key: Key): string }

export function InspectionSettings(props: SettingsProps) {
  const [open, setOpen] = useState(false)
  return <section className={css.root} data-dsh-plugin="task-board-inspection">
    <div className={css.launcher}>
      <div><h3>{props.t('title')}</h3><p>{props.t('hint')}</p></div>
      <button className={css.button} type="button" onClick={() => setOpen(true)}>{props.t('configure')}</button>
    </div>
    {open && <InspectionSettingsDialog {...props} onClose={() => setOpen(false)}/>}
  </section>
}

export function InspectionSettingsDialog({ board, form, t, onClose }: SettingsProps & { onClose(): void }) {
  const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
  const mirror = useSyncExternalStore(listener => board.subscribe(listener), () => board.snapshot())
  const summary = mirror.extensions[INSPECTION_ID] as { scheduleAvailable?: boolean; workspaces?: Workspace[]; runs?: ScanRun[] } | undefined
  const [rules, setRules] = useState<InspectionRule[]>(snapshot.value?.rules ?? [])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => { setRules(snapshot.value?.rules ?? []) }, [snapshot.value])
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    element?.showModal()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  const edit = (index: number, patch: Partial<InspectionRule>): void => {
    setRules(values => values.map((rule, i) => i === index ? { ...rule, ...patch } : rule))
    setMessage('')
  }
  const save = async (): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      if (!rules.every(validRule) || rules.some(rule => rule.daily && !summary?.scheduleAvailable)) throw new Error('invalid-rule')
      const revisioned = rules.map(rule => {
        const previous = snapshot.value?.rules?.find(value => value.id === rule.id)
        return { ...rule, revision: previous && JSON.stringify({ ...previous, revision: 0 }) !== JSON.stringify({ ...rule, revision: 0 }) ? previous.revision + 1 : rule.revision }
      })
      if (!await form.set('rules', revisioned)) throw new Error('save-failed')
      onClose()
    } catch { setMessage(t('failed')) } finally { setBusy(false) }
  }
  const inspect = async (rule: InspectionRule): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      const ok = await board.dispatch({ extensionId: INSPECTION_ID, action: 'run', payload: { ruleId: rule.id } })
      setMessage(t(ok ? 'requested' : 'failed'))
    } catch { setMessage(t('failed')) } finally { setBusy(false) }
  }
  return <dialog ref={dialog} className={css.dialog} data-dsh-plugin="task-board-inspection" aria-labelledby={id + '-title'} aria-describedby={id + '-hint'}
    onCancel={event => { event.preventDefault(); if (!busy) onClose() }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
        .filter(element => element.getClientRects().length > 0)
      const first = controls[0]
      const last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}
    onClick={event => {
      if (busy || event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
    }}>
    <form className={css.form} onSubmit={event => { event.preventDefault(); void save() }}>
      <header className={css.header}>
        <div><h2 id={id + '-title'}>{t('dialogTitle')}</h2><p id={id + '-hint'}>{t('hint')}</p></div>
        <button className={css.close} type="button" aria-label={t('close')} disabled={busy} onClick={onClose}>
          <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>
        </button>
      </header>
      <div className={css.body}>
        {!summary && <p className={css.notice} role="status">{t('missing')}</p>}
        {rules.length === 0 && <p className={css.empty}>{t('noRules')}</p>}
        {rules.map((rule, index) => {
          const workspace = summary?.workspaces?.find(value => value.id === rule.workspaceId)
          const unchanged = snapshot.value?.rules?.some(value => JSON.stringify(value) === JSON.stringify(rule))
          return <fieldset key={rule.id} className={css.rule} data-dsh-part="rule" disabled={busy || !snapshot.writable}>
            <legend>{workspace?.title ?? t('newRule')}</legend>
            <label className={css.check}><input type="checkbox" checked={rule.enabled} onChange={event => edit(index, { enabled: event.target.checked })}/><span>{t('enabled')}</span></label>
            <div className={css.grid}>
              <label className={css.field}>{t('workspace')}<select autoFocus={index === 0} required value={rule.workspaceId} onChange={event => edit(index, { workspaceId: event.target.value })}>
                <option value="">{t('chooseWorkspace')}</option>
                {(summary?.workspaces ?? []).map(option => <option key={option.id} value={option.id}>{option.title ?? option.path ?? option.id}</option>)}
              </select></label>
              <label className={css.field}>{t('model')}<input required value={rule.model} placeholder="provider/model" onChange={event => edit(index, { model: event.target.value })}/></label>
              <label className={css.fullField}>{t('goal')}<textarea rows={2} required value={rule.goal} onChange={event => edit(index, { goal: event.target.value })}/></label>
              <label className={css.fullField}>{t('root')}<input required value={rule.root} onChange={event => edit(index, { root: event.target.value })}/></label>
              <label className={css.fullField}>{t('paths')}<textarea rows={2} value={rule.paths.join('\n')} onChange={event => edit(index, { paths: event.target.value.split('\n').filter(Boolean) })}/><span className={css.help}>{t('pathsHint')}</span></label>
            </div>
            <div className={css.schedule}>
              <label className={css.check}><input type="checkbox" checked={rule.daily} disabled={!summary?.scheduleAvailable} onChange={event => edit(index, { daily: event.target.checked })}/><span>{t('daily')}</span></label>
              {!summary?.scheduleAvailable && <p className={css.help}>{t('unavailable')}</p>}
              {rule.daily && <div className={css.grid}>
                <label className={css.field}>{t('cron')}<input required value={rule.cron} onChange={event => edit(index, { cron: event.target.value })}/></label>
                <label className={css.field}>{t('timezone')}<input required value={rule.timeZone} onChange={event => edit(index, { timeZone: event.target.value })}/></label>
                <p className={css.fullHelp}>{t('scheduleHint')}</p>
              </div>}
            </div>
            <details className={css.disclosure}>
              <summary>{t('advanced')}<span>{t('advancedHint')}</span></summary>
              <div className={css.detailsBody}>
                <label className={css.check}><input type="checkbox" checked={rule.includeGit ?? false} onChange={event => edit(index, { includeGit: event.target.checked })}/><span>{t('git')}</span></label>
                <label className={css.field}>{t('sessions')}<textarea rows={2} value={(rule.sessionIds ?? []).join('\n')} onChange={event => edit(index, { sessionIds: event.target.value.split('\n').map(value => value.trim()).filter(Boolean) })}/><span className={css.help}>{t('sessionsHint')}</span></label>
              </div>
            </details>
            <div className={css.ruleActions}>
              <button className={css.button} type="button" disabled={busy || !rule.enabled || !unchanged} onClick={() => { void inspect(rule) }}>{t('run')}</button>
              {!unchanged && <span className={css.help}>{t('saveFirst')}</span>}
            </div>
          </fieldset>
        })}
        <button className={css.add} type="button" disabled={busy || !snapshot.writable} onClick={() => setRules(values => [...values, {
          id: crypto.randomUUID(), workspaceId: '', enabled: false, root: '', goal: '', revision: 1, paths: ['README.md'], model: '',
          daily: false, cron: '0 9 * * *', timeZone: 'Asia/Shanghai', maxRecommendations: 3,
        }])}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>{t('add')}
        </button>
        <details className={css.disclosure}>
          <summary>{t('history')}<span>{summary?.runs?.length ?? 0}</span></summary>
          {!summary?.runs?.length && <p className={css.empty}>{t('empty')}</p>}
          <ul className={css.history} data-dsh-part="history">{summary?.runs?.map(run => <li key={run.id}>
            <div><time>{new Date(run.startedAt).toLocaleString()}</time><span>{t('run.' + run.status as Key)}</span></div>
            <ul>{run.results.map(result => <li key={result.ruleId}>
              {rules.find(value => value.id === result.ruleId)?.goal ?? result.ruleId} · {t('run.' + result.status as Key)} · {result.taskIds.length} {t('recommendations')}{result.error ? ' · ' + result.error : ''}
            </li>)}</ul>
          </li>)}</ul>
        </details>
      </div>
      <footer className={css.footer}>
        <p role="status">{message || t('footerHint')}</p>
        <div className={css.footerActions}>
          <button className={css.button} type="button" disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button className={css.primary} type="submit" disabled={busy || !snapshot.writable}>{t(busy ? 'working' : 'save')}</button>
        </div>
      </footer>
    </form>
  </dialog>
}
