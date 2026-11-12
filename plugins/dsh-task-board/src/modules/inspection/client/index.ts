import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createServedEntryForm } from './settings-entry-form.ts'
import { InspectionSettings, type ClientBoard, type Settings } from './InspectionSettings.tsx'
import { zh, en, type Key } from './locales.ts'

export const inject = ['slots', 'locale', 'configForms']
export function apply(ctx: Context): void {
  const namespace = 'task-board-inspection' as never
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }))
  const translate = ctx.locale.bind(namespace as never) as unknown as (key: Key) => string
  const form = createServedEntryForm<Settings>({
    forms: ctx.configForms as ConfigForms,
    entryIds: ['web-ui-task-board-inspection', 'ui-task-board-inspection', 'task-board-inspection'],
  })
  ctx.inject(['taskBoard'], scope => {
    const board = scope.get('taskBoard') as unknown as ClientBoard
    const slots = scope.get('slots') as unknown as {
      inject(key: string, callback: () => () => void): () => void
      register(options: Record<string, unknown>, component: unknown): () => void
    }
    scope.effect(() => slots.inject('task-board.settings.section', () => slots.register({
      name: 'task-board.settings.section', id: 'inspection', locale: namespace,
    }, () => createElement(InspectionSettings, { board, form, t: translate }))))
  })
}
