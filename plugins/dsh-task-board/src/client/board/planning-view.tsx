import { useEffect, useState } from 'react'
import { TASK_BOARD_MESSAGE_MAX_LENGTH } from '../../core/extension.ts'
import { hasOpenExecution } from '../../core/tasks.ts'
import type { BoardController } from '../../core/controller.ts'
import type { TaskRecord } from '../../core/tasks.ts'
import { isUnacceptedRecommendation } from '../../core/planning.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import { formatHostTimestamp } from './TaskCard.tsx'
import css from '../board.module.css'

export function PlanningActions({ task, controller, pending }: { task: TaskRecord; controller: BoardController; pending: boolean }) {
  const [until, setUntil] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState(false)
  if (task.recommendation === undefined || !isUnacceptedRecommendation(task) || task.archivedAt !== undefined) return null
  const expired = task.planning?.state === 'stale' || (task.recommendation.validUntil !== undefined && task.recommendation.validUntil <= Date.now())
  return <section className={css.detailSection} data-dsh-part="planning-actions">
    <p className={css.detailMeta}>{expired ? t('planning.staleHint') : t('planning.gateHint')}</p>
    <label className={css.field}><span className={css.fieldLabel}>{t('planning.until')}</span>
      <input type="datetime-local" className={css.input} value={until} disabled={pending}
        onChange={event => { setUntil(event.target.value); setError(false) }} />
    </label>
    <label className={css.field}><span className={css.fieldLabel}>{t('planning.reason')}</span>
      <input className={css.input} value={reason} disabled={pending} onChange={event => { setReason(event.target.value) }} />
    </label>
    {error && <p className={css.formError}>{t('planning.invalidUntil')}</p>}
    <div className={css.subtaskAddRow}>
      <button type="button" className={css.primaryButton} disabled={pending || expired}
        onClick={() => { void controller.planTask(task.id, 'accept', { fingerprint: task.recommendation!.fingerprint }) }}>{t('planning.accept')}</button>
      <button type="button" className={css.ghostButton} disabled={pending}
        onClick={() => {
          const snoozedUntil = until === '' ? Date.now() + 86400000 : new Date(until).getTime()
          if (!Number.isFinite(snoozedUntil) || snoozedUntil <= Date.now()) { setError(true); return }
          void controller.planTask(task.id, 'snooze', { snoozedUntil })
        }}>{until === '' ? t('planning.snoozeDay') : t('planning.snooze')}</button>
      <button type="button" className={css.ghostButton} disabled={pending}
        onClick={() => { void controller.planTask(task.id, 'dismiss', reason.trim() === '' ? {} : { reason: reason.trim() }) }}>{t('planning.dismiss')}</button>
    </div>
  </section>
}

export function RecommendationDetails({ task, timeZone }: { task: TaskRecord; timeZone?: string }) {
  const recommendation = task.recommendation
  if (recommendation === undefined) return null
  return <section className={css.detailSection} data-dsh-part="recommendation-evidence">
    <h4>{t('planning.recommendation')}</h4>
    <p className={css.detailText}>{recommendation.reasonNow}</p>
    <p className={css.detailMeta}>{t('planning.scope')}: {recommendation.scope} · {t('planning.effort')}: {recommendation.effortBand}</p>
    <h4>{t('planning.evidence')}</h4>
    <ul>{recommendation.evidenceRefs.map((ref, index) => <li key={index}>{/^https?:\/\//i.test(ref)
      ? <a href={ref} target="_blank" rel="noopener noreferrer">{ref}</a> : ref}</li>)}</ul>
    <h4>{t('planning.criteria')}</h4>
    <ul>{recommendation.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
    <p className={css.detailMeta}>{t('planning.observed')}: {formatHostTimestamp(recommendation.observedAt, timeZone)}</p>
    {recommendation.validUntil !== undefined && <p className={css.detailMeta}>{t('planning.validUntil')}: {formatHostTimestamp(recommendation.validUntil, timeZone)}</p>}
    {task.planning?.acceptedAt !== undefined && <p className={css.detailMeta}>{t('planning.acceptedAudit', {
      time: formatHostTimestamp(task.planning.acceptedAt, timeZone), actor: task.planning.acceptedBy ?? '', revision: String(task.planning.acceptedRevision ?? ''),
    })}</p>}
    {task.planning?.snoozedUntil !== undefined && <p className={css.detailMeta}>{t('planning.snoozedAudit', { time: formatHostTimestamp(task.planning.snoozedUntil, timeZone) })}</p>}
    {task.planning?.dismissReason !== undefined && <p className={css.detailText}>{t('planning.reason')}: {task.planning.dismissReason}</p>}
  </section>
}

export function CollaborationSection({ task, controller, pending, timeZone }: { task: TaskRecord; controller: BoardController; pending: boolean; timeZone?: string }) {
  const [confirmReview, setConfirmReview] = useState<string | undefined>(undefined)
  const [instructions, setInstructions] = useState('')
  const [reworkError, setReworkError] = useState(false)
  const currentExecutionId = task.executions.at(-1)?.id
  useEffect(() => { setConfirmReview(undefined); setInstructions(''); setReworkError(false) }, [task.id, currentExecutionId])
  const latest = task.executions.at(-1)
  const reviewable = latest?.result === 'succeeded' && latest.endedAt !== undefined && !hasOpenExecution(task) && task.archivedAt === undefined
  const waiting = task.waiting
  const waitingSession = waiting === undefined ? undefined : task.executions.find(execution => execution.id === waiting.executionId)?.sessionId
  return <>
    {waiting !== undefined && <section className={css.detailSection} data-dsh-part="waiting">
      <h4>{t('waiting.title')} · {t(('waiting.' + waiting.kind) as TaskBoardKey)}</h4>
      <p className={css.detailText}>{waiting.reason ?? t('waiting.noReason')}</p>
      <p className={css.detailMeta}>{formatHostTimestamp(waiting.since, timeZone)}</p>
      {waitingSession !== undefined && <button type="button" className={css.ghostButton}
        onClick={() => { controller.openSession(waitingSession) }}>{t('waiting.takeOver')}</button>}
    </section>}
    {task.status === 'review' && <section className={css.detailSection} data-dsh-part="human-review">
      <h4>{t('review.title')}</h4><p className={css.detailMeta}>{t('review.hint')}</p>
      <button type="button" className={css.primaryButton} disabled={pending || !reviewable}
        onClick={() => { setConfirmReview(latest?.id) }}>{t('review.accept')}</button>
      <label className={css.field}><span className={css.fieldLabel}>{t('review.instructions')}</span>
        <textarea className={css.textarea} value={instructions} maxLength={TASK_BOARD_MESSAGE_MAX_LENGTH} disabled={pending || !reviewable}
          onChange={event => { setInstructions(event.target.value); setReworkError(false) }} />
      </label>
      <button type="button" className={css.ghostButton} disabled={pending || !reviewable || instructions.trim() === ''}
        onClick={() => { void controller.reworkTask(task.id, instructions.trim(), latest!.id).then(ok => {
          setReworkError(!ok)
          if (ok) { setInstructions(''); setConfirmReview(undefined) }
        }) }}>{t('review.rework')}</button>
      {reworkError && <p role="alert" className={css.formError}>{t('review.reworkFailed')}</p>}
      {confirmReview !== undefined && <div role="alert">
        <p>{t('review.confirm')}</p>
        <button type="button" className={css.primaryButton} disabled={pending}
          onClick={() => { void controller.acceptReview(task.id, confirmReview).then(ok => { if (ok) setConfirmReview(undefined) }) }}>{t('review.confirmAccept')}</button>
        <button type="button" className={css.ghostButton} disabled={pending} onClick={() => { setConfirmReview(undefined) }}>{t('new.cancel')}</button>
      </div>}
    </section>}
  </>
}

export function BusinessTimeline({ task, timeZone }: { task: TaskRecord; timeZone?: string }) {
  const [page, setPage] = useState(0)
  const timeline = [...(task.timeline ?? [])].reverse()
  const pageCount = Math.max(1, Math.ceil(timeline.length / 20))
  const activePage = Math.min(page, pageCount - 1)
  const days = new Map<string, typeof timeline>()
  const dateFormat = timelineFormatter({ dateStyle: 'long' }, timeZone)
  const timeFormat = timelineFormatter({ timeStyle: 'medium' }, timeZone)
  for (const event of timeline.slice(activePage * 20, (activePage + 1) * 20)) {
    const date = dateFormat.format(event.at)
    const events = days.get(date) ?? []
    events.push(event)
    days.set(date, events)
  }

  return <div className={css.detailSection} data-dsh-part="business-timeline">
    {timeline.length === 0 ? <p className={css.detailMeta}>{t('timeline.empty')}</p>
      : [...days].map(([date, events]) => (
        <section key={date} className={css.timelineDay}>
          <h4>{date}</h4>
          <ol className={css.businessTimeline}>
            {events.map(event => {
              const key = ('timeline.event.' + event.kind) as TaskBoardKey
              const label = t(key)
              return <li key={event.id}>
                <time dateTime={new Date(event.at).toISOString()} title={formatHostTimestamp(event.at, timeZone)}>
                  {timeFormat.format(event.at)}
                </time>
                <div>
                  <strong>{label === key ? event.kind : label}</strong>
                  {event.detail !== undefined && <p>{event.detail}</p>}
                </div>
                {event.actor !== undefined && <span className={css.detailMeta}>
                  {event.actor === 'authenticated-ui' ? t('timeline.actor.board') : event.actor}
                </span>}
              </li>
            })}
          </ol>
        </section>
      ))}
    {pageCount > 1 && <div className={css.subtaskAddRow}>
      <button type="button" className={css.ghostButton} disabled={activePage === 0} onClick={() => { setPage(activePage - 1) }}>{t('timeline.previous')}</button>
      <span>{activePage + 1} / {pageCount}</span>
      <button type="button" className={css.ghostButton} disabled={activePage + 1 >= pageCount} onClick={() => { setPage(activePage + 1) }}>{t('timeline.next')}</button>
    </div>}
  </div>
}

function timelineFormatter(options: Intl.DateTimeFormatOptions, timeZone?: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone })
  } catch {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' })
  }
}
