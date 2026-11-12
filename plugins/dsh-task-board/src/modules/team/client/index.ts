import type { ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createServedEntryForm } from '../../../client/settings-entry-form.ts'
/**
 * Browser half of the task-board team provider extension.
 *
 * It registers this extension's copy, then contributes three seats: the card
 * decoration and the task-detail section (both behind the extension's own
 * switch, which is read from the settings form), and the configuration block
 * inside the board's own settings card (behind the board service alone, because
 * that block is where the switch and the Host Token live).
 *
 * Failure policy: a missing slot registry, locale service or board service is
 * handled, never thrown — the web shell fails the whole boot when a plugin apply
 * throws, and one external plugin must not take the GUI down.
 *
 * @module dsh-task-board-team/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the settings-surface Context merge (ctx.configForms).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) and its
// LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { installTeamClientHalf, type ExtensionEnabledSource } from './team/extension.ts'
import { optionalService } from './optional-service.ts'
import { en, setRuntimeTranslate, t, zh, type TeamKey } from './locales.ts'

/** Locale namespace this half owns. */
export const NS = 'task-board-team'

/** Settings namespace the block edits. */
export const SETTINGS_NAMESPACE = 'task-board-team'

/** Profile entry ids this package's patch rows carry, most specific first. */
export const ENTRY_IDS: readonly string[] = ['web-ui-task-board-team', 'ui-task-board-team', SETTINGS_NAMESPACE]

/** The settings value this extension's own form carries. */
export interface TeamSettingsValue {
  enabled?: boolean
}

declare module '@deepseek-ai/dsh-client-ui-slots' {


  interface LocaleNamespaceMap {
    /** The team provider extension copy. */
    'task-board-team': TeamKey
  }
}

/**
 * A form for a page that serves this namespace to nobody: it never answers, so
 * the seats follow the documented default (enabled) instead of failing.
 * @returns an inert configuration form.
 */
function unavailableForm(): ConfigForm<TeamSettingsValue> {
  const snapshot: ConfigFormSnapshot<TeamSettingsValue> = {
    status: 'unavailable',
    value: undefined,
    base: undefined,
    user: undefined,
    revision: undefined,
    writable: false,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => false,
    unset: async () => false,
    mutate: async () => false,
  }
}

/**
 * Bind the settings form this extension's switch is read from.
 * @param ctx - the browser plugin context.
 * @returns the form, or an inert one when the page serves no such namespace.
 */
export function bindSettingsForm(ctx: ClientContext): ConfigForm<TeamSettingsValue> {
  const forms = optionalService(ctx, 'configForms') as ConfigForms | undefined
  if (forms === undefined) return unavailableForm()
  return createServedEntryForm<TeamSettingsValue>({ forms, entryIds: ENTRY_IDS })
}

/** Runtime face of the locale service this half registers its copy into. */
interface LocaleSeat {
  register(namespace: string, dictionaries: { zh: unknown; en: unknown }): () => void
  bind(namespace: string): unknown
}

/**
 * Mount the extension's browser half.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const locale = optionalService(ctx, 'locale') as LocaleSeat | undefined

  ctx.effect(() => {
    if (locale === undefined) return () => {}
    try {
      return locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'task-board-team: dictionaries')

  // Wire the SDK translate seat into the module-level t the seats use, so a
  // runtime language switch reaches them without a reload.
  if (locale !== undefined) {
    try { setRuntimeTranslate(locale.bind(NS) as (key: TeamKey) => string) } catch { void t }
  }

  const scope = bindSettingsForm(ctx)
  const enabledSource: ExtensionEnabledSource = {
    read: () => scope.getSnapshot().value?.enabled !== false,
    subscribe: listener => scope.subscribe(listener),
  }

  ctx.effect(() => installTeamClientHalf(ctx, enabledSource), 'task-board-team: provider seats')
}
