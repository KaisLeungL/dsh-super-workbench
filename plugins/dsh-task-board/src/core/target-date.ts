import { partsInZone } from './schedule.ts'
import type { TaskRecord } from './tasks.ts'

/** A calendar date in the same format as the date picker. */
export function isTargetDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function isTargetTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)
}

export function planTaskForNow(task: TaskRecord, now: number, timeZone: string): TaskRecord {
  const { hour, minute } = partsInZone(timeZone, now)
  return {
    ...task,
    status: 'todo',
    updatedAt: now,
    targetDate: calendarDay(now, timeZone),
    targetTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  }
}

export function unplanTask(task: TaskRecord, now: number): TaskRecord {
  const { targetDate: _targetDate, targetTime: _targetTime, ...rest } = task
  return { ...rest, status: 'backlog', updatedAt: now }
}

const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>()

/** Calendar day of an instant in a time zone (the local zone when absent). */
export function calendarDay(ms: number, timeZone: string | undefined): string {
  const key = timeZone ?? ''
  let format = DAY_FORMATS.get(key)
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone === undefined ? {} : { timeZone }) })
    } catch {
      // An unknown zone id: bucket by the local zone rather than failing the board.
      format = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })
    }
    DAY_FORMATS.set(key, format)
  }
  return format.format(new Date(ms))
}

export function targetDateStatus(targetDate: string | null, today: string): 'backlog' | 'todo' {
  return targetDate !== null && targetDate >= today ? 'todo' : 'backlog'
}

export function isDatedPendingTask(task: TaskRecord): task is TaskRecord & { targetDate: string } {
  return task.status === 'todo' && task.targetDate !== undefined && task.archivedAt === undefined
    && task.executions.length === 0 && task.taskKind === undefined
}

/** Roll overdue, unstarted tasks back in one transition and keep the date for replanning. */
export function expireTargetDates(tasks: readonly TaskRecord[], now: number, timeZone?: string): readonly TaskRecord[] {
  const today = calendarDay(now, timeZone)
  let changed = false
  const next = tasks.map(task => {
    if (!isDatedPendingTask(task) || task.targetDate >= today) return task
    changed = true
    return { ...task, status: 'backlog' as const, updatedAt: now }
  })
  return changed ? next : tasks
}
