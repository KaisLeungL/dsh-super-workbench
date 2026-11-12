/**
 * The two rendering seats of the team provider: the task-detail section and the
 * card decoration.
 *
 * Both read the published summary the Host pushes through the board mirror; the
 * card payload itself (the issue id, attempt id and lease) is read off the card
 * the seat was handed, so a mirror card is recognizable even before the first
 * summary arrives.
 *
 * @module dsh-task-board-team/client/team/sections
 */
import type { CSSProperties, ReactElement } from 'react'
import type { TaskBoardCardDecorationProps, TaskBoardDetailSectionProps } from '../../core/contract.ts'
import { readTaskIssueLink, type TeamIssueLink } from '../../core/identity.ts'
import type { TeamCardView } from '../../host/service.ts'
import { t, type TeamKey } from '../locales.ts'
import { useTeamSummary } from './summary.ts'
import styles from './team.module.css'

/** Hub status the badge renders; the key set is the protocol's own status column. */
const STATUS_KEYS: Record<string, TeamKey> = {
  todo: 'status.todo',
  assigned: 'status.assigned',
  waiting_host: 'status.waiting_host',
  running: 'status.running',
  in_review: 'status.in_review',
  done: 'status.done',
  canceled: 'status.canceled',
  failed: 'status.failed',
}

/**
 * Translate one hub status.
 * @param status - the collaboration status the hub reported.
 * @returns the localized label, or the raw status for a value this build predates.
 */
export function statusLabel(status: string | undefined): string {
  if (status === undefined) return t('detail.empty')
  const key = STATUS_KEYS[status]
  return key === undefined ? status : t(key)
}

/**
 * The hub status badge of one mirrored card.
 * @param props - the card the board renders.
 * @returns the badge, or nothing for a card that mirrors no issue.
 */
export function TeamCardDecoration({ task }: TaskBoardCardDecorationProps): ReactElement | null {
  useTeamSummary()
  const link = readTaskIssueLink(task as never)
  if (link === undefined) return null
  const status = link.hubStatus
  if (status === undefined) {
    return <span className={styles.badge} data-dsh-plugin="task-board-team" data-dsh-part="team-badge">{t('detail.title')}</span>
  }
  return (
    <span className={styles.badge} data-dsh-plugin="task-board-team" data-dsh-part="team-badge" data-hub-status={status}>
      {statusLabel(status)}
    </span>
  )
}

/** One line of the detail block: label and value. */
function Field({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
    </div>
  )
}

/** The comments and activity one card carries, newest last. */
function Streams({ view }: { view: TeamCardView | undefined }): ReactElement {
  const comments = view?.comments ?? []
  const activity = view?.activity ?? []
  return (
    <>
      <div>
        <p className={styles.title}>{t('detail.comments')}</p>
        {comments.length === 0
          ? <p className={styles.empty}>{t('detail.empty')}</p>
          : (
              <ul className={styles.list} data-dsh-part="team-comments">
                {comments.map(comment => (
                  <li key={comment.id} className={styles.entry}>
                    <span className={styles.meta}>{comment.author}</span>
                    <span className={styles.body}>{comment.content}</span>
                  </li>
                ))}
              </ul>
            )}
      </div>
      <div>
        <p className={styles.title}>{t('detail.activity')}</p>
        {activity.length === 0
          ? <p className={styles.empty}>{t('detail.empty')}</p>
          : (
              <ul className={styles.list} data-dsh-part="team-activity">
                {activity.map(entry => (
                  <li key={entry.id} className={styles.entry}>
                    <span className={styles.meta}>{entry.type}</span>
                    <span className={styles.body}>{entry.text}</span>
                  </li>
                ))}
              </ul>
            )}
      </div>
    </>
  )
}

/**
 * The team section of one card's detail view.
 * @param props - the card the board renders, plus the action dispatcher.
 * @returns the section, or nothing for a card that mirrors no issue.
 */
export function TeamDetailSection({ task }: TaskBoardDetailSectionProps): ReactElement | null {
  const summary = useTeamSummary()
  const link = readTaskIssueLink(task as never)
  if (link === undefined) return null
  const view = summary?.cards[task.id]
  const pending = (summary?.pendingQuestions ?? []).filter(question => question.taskId === task.id)
  const agent = summary?.agents.find(candidate => candidate.memberId === link.agentMemberId)
  const style: CSSProperties = {}
  return (
    <div className={styles.section} data-dsh-plugin="task-board-team" data-dsh-part="team-detail" style={style}>
      <p className={styles.title}>{t('detail.title')}</p>
      <Field label={t('detail.issue')} value={issueLabel(link)} />
      <Field label={t('detail.status')} value={statusLabel(view?.hubStatus ?? link.hubStatus)} />
      <Field label={t('detail.agent')} value={agent?.name ?? link.agentId ?? t('detail.empty')} />
      <Field label={t('detail.assignee')} value={link.assignee ?? t('detail.empty')} />
      <Field label={t('detail.reviewer')} value={link.reviewer ?? t('detail.empty')} />
      {pending.length === 0 ? null : (
        <div>
          <p className={styles.title}>{t('detail.pending')}</p>
          <ul className={styles.list} data-dsh-part="team-questions">
            {pending.map(question => (
              <li key={question.id} className={styles.entry}>
                <span className={styles.body}>{question.question}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Streams view={view} />
      {view?.lastError === undefined ? null : <p className={styles.error}>{t('detail.error')}: {view.lastError}</p>}
    </div>
  )
}

/**
 * Render the issue identity of one linkage.
 * @param link - the card's linkage back to the hub.
 * @returns the label, e.g. "issue #12".
 */
export function issueLabel(link: TeamIssueLink): string {
  return link.issueNumber === undefined ? link.issueId : 'issue #' + String(link.issueNumber)
}