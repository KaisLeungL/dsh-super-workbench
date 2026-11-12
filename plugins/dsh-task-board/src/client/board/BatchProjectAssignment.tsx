import { useEffect, useState } from 'react'
import type { BoardController, ControllerSnapshot } from '../../core/controller.ts'
import { resolveProjectId } from '../../core/planning.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'
import { ProjectField, projectLabel } from './project-view.tsx'

/** A preview keeps its revision and rows until the Host accepts or rejects it. */
export function BatchProjectAssignment({ controller, snapshot, selectedIds, onClear, onPending }: {
  controller: BoardController
  snapshot: ControllerSnapshot
  selectedIds: string[]
  onClear: () => void
  onPending: (pending: boolean) => void
}) {
  const [projectId, setProjectId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ revision: number; projectId: string | null; ids: string[]; rows: { id: string; title: string; from: string | null }[] }>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const selectionKey = JSON.stringify(selectedIds)
  useEffect(() => { setPreview(undefined) }, [selectionKey])
  const projects = snapshot.executionOptions.workspaces
  return <section className={css.batchAssignment} data-dsh-part="batch-project-assignment" aria-label={t('project.batch.title')}>
    <strong>{t('project.batch.selected', { count: String(selectedIds.length) })}</strong>
    <ProjectField value={projectId} projects={projects} disabled={pending || preview !== undefined}
      onChange={value => { setProjectId(value); setError(false) }} />
    <p className={css.fieldHint}>{t('project.batch.reacceptHint')}</p>
    {error && <p role="alert" className={css.formError}>{t('project.batch.conflict')}</p>}
    {preview === undefined ? <button type="button" className={css.primaryButton}
      disabled={pending || selectedIds.length === 0 || snapshot.host === undefined || selectedIds.some(id => snapshot.pendingTaskIds.includes(id))}
      onClick={() => {
        setError(false)
        setPreview({ revision: snapshot.host!.revision, projectId, ids: [...selectedIds],
          rows: selectedIds.map(id => {
            const task = snapshot.tasks.find(task => task.id === id)
            return { id, title: task?.title ?? id, from: task === undefined ? null : resolveProjectId(task) }
          }) })
      }}>{t('project.batch.preview')}</button>
      : <div>
        <ul className={css.batchPreview}>{preview.rows.map(row => <li key={row.id}>
          <strong>{row.title}</strong><span>{projectLabel(row.from, projects)} → {projectLabel(preview.projectId, projects)}</span>
        </li>)}</ul>
        <div className={css.subtaskAddRow}>
          <button type="button" className={css.primaryButton} disabled={pending} onClick={() => {
            setPending(true); onPending(true)
            void controller.assignProjects(preview.ids, preview.projectId, preview.revision).then(ok => {
              setPreview(undefined)
              setError(!ok)
              if (ok) onClear()
            }).finally(() => { setPending(false); onPending(false) })
          }}>{t('project.batch.commit')}</button>
          <button type="button" className={css.ghostButton} disabled={pending}
            onClick={() => { setPreview(undefined) }}>{t('project.batch.back')}</button>
        </div>
      </div>}
  </section>
}
