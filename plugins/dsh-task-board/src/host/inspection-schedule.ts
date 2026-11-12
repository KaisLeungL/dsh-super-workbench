import type { HostTaskLedger, OpenedRun } from '../host-ledger.ts'
import type { TaskBoardInspectionRule as InspectionScheduleRule } from '../core/extension.ts'

/** Callbacks stay in memory; durable control tasks use the board's original Cron. */
export class InspectionScheduleRegistry {
  private readonly handlers = new Map<string, InspectionScheduleRule>()
  private readonly registrations = new Set<string>()
  constructor(private readonly ledger: HostTaskLedger, private readonly changed: () => void) {}

  register(extensionId: string, rule: InspectionScheduleRule): () => void {
    if (typeof rule.run !== 'function') throw new Error('inspection callback required')
    const key = JSON.stringify([extensionId, rule.id])
    if (this.registrations.has(key)) throw new Error('inspection schedule already registered')
    const task = this.ledger.upsertInspectionControl(extensionId, rule.id, rule.cron, rule.timeZone)
    this.registrations.add(key)
    this.handlers.set(task.id, rule)
    this.changed()
    return () => {
      if (this.handlers.get(task.id) !== rule) return
      this.handlers.delete(task.id)
      this.registrations.delete(key)
      this.ledger.disableInspectionControl(task.id)
      this.changed()
    }
  }

  async execute(opened: OpenedRun, occurrence: number): Promise<void> {
    const rule = this.handlers.get(opened.task.id)
    if (rule === undefined || opened.task.taskKind !== 'inspection') throw new Error('inspection provider unavailable')
    await rule.run(occurrence)
    if (this.handlers.get(opened.task.id) !== rule) throw new Error('inspection rule changed during execution')
  }
}
