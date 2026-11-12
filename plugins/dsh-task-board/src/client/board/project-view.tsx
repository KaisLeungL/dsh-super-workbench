import type { ExecutionWorkspaceOption } from '../../core/controller.ts'
import type { TaskRecord } from '../../core/tasks.ts'
import { resolveProjectId } from '../../core/planning.ts'
import { t } from '../locales.ts'
import { IconFolder } from './icons.tsx'
import css from '../board.module.css'

export const UNASSIGNED_PROJECT = '__dsh_unassigned_project__'

/** Labels follow the live registry, while unavailable references stay visible. */
export function projectLabel(id: string | null | undefined, projects: readonly ExecutionWorkspaceOption[]): string {
  if (id === null || id === undefined) return t('project.unassigned')
  return projects.find(project => project.workspaceId === id)?.title ?? t('project.unavailable', { id })
}

export function ProjectField({ value, projects, onChange, disabled = false }: {
  value: string | null
  projects: readonly ExecutionWorkspaceOption[]
  onChange: (id: string | null) => void
  disabled?: boolean
}) {
  const known = value === null || projects.some(project => project.workspaceId === value)
  return (
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('project.assignment')}</span>
      <select className={css.select} data-dsh-part="project-field" value={value ?? ''} disabled={disabled}
        onChange={event => { onChange(event.target.value === '' ? null : event.target.value) }}>
        <option value="">{t('project.unassigned')}</option>
        {!known && <option value={value!}>{projectLabel(value, projects)}</option>}
        {projects.map(project => <option key={project.workspaceId} value={project.workspaceId}>{project.title}</option>)}
      </select>
      <span className={css.fieldHint}>{t('project.independentHint')}</span>
    </label>
  )
}

export function ProjectBadge({ task, projects, onSelect }: {
  task: TaskRecord
  projects: readonly ExecutionWorkspaceOption[]
  onSelect?: (id: string) => void
}) {
  const id = resolveProjectId(task)
  const label = projectLabel(id, projects)
  const content = <><IconFolder size={13} /><span>{label}</span></>
  return onSelect === undefined
    ? <span className={css.projectBadge} data-dsh-part="project-badge" title={label}>{content}</span>
    : <button type="button" className={css.projectBadge} data-dsh-part="project-badge"
        title={t('project.filterHint', { project: label })} aria-label={t('project.filterHint', { project: label })}
        onClick={() => { onSelect(id ?? UNASSIGNED_PROJECT) }}>{content}</button>
}

export function groupTasksByProject(tasks: readonly TaskRecord[], projects: readonly ExecutionWorkspaceOption[]) {
  const groups = new Map<string, { id: string; label: string; local: boolean; items: TaskRecord[] }>()
  for (const task of tasks) {
    const project = resolveProjectId(task)
    const id = project ?? UNASSIGNED_PROJECT
    const bucket = groups.get(id) ?? { id, label: projectLabel(project, projects), local: false, items: [] }
    bucket.items.push(task)
    groups.set(id, bucket)
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
}
