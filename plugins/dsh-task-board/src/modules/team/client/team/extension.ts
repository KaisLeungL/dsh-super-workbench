/**
 * Browser-half installer for the team provider.
 *
 * A provider's browser half registers its own contributions into the child seats
 * the board declares; it resolves the board's client capability face from the
 * shared service name and adds no HTTP surface of its own. The board publishes
 * that service inside its own apply and the aggregate mounts client children
 * without ordering those applies, so the seats live behind a cordis dependency
 * scope (ctx.inject) rather than a one-shot lookup: the scope mounts when the
 * board serves the service and unloads — releasing every seat — when it is
 * withdrawn.
 *
 * @module dsh-task-board-team/client/team/extension
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { TEAM_EXTENSION_ID } from '../../core/identity.ts'
import {
  resolveTaskBoardClientFace,
  TASK_BOARD_CARD_DECORATION,
  TASK_BOARD_DETAIL_SECTION,
  TASK_BOARD_SETTINGS_SECTION,
  type TaskBoardClientFace,
} from '../../core/contract.ts'
import { TeamCardDecoration, TeamDetailSection } from './sections.tsx'
import { TeamSettingsSection } from './settings.tsx'
import { optionalService } from '../optional-service.ts'
import { acceptPublishedSummaries, clearSummary } from './summary.ts'

/** Locale namespace the seats bind to. */
const LOCALE_NS = 'task-board-team'

/** The live switch the installer follows; the settings form supplies it. */
export interface ExtensionEnabledSource {
  /** Whether the extension is currently enabled (absent config means enabled). */
  read(): boolean
  /** Observe switch changes; the returned disposer removes the listener. */
  subscribe(listener: () => void): () => void
}

/** The slice of the slot registry this installer uses. */
interface SlotRegistry {
  register(options: Record<string, unknown>, component: unknown): () => void
  inject?(key: string, callback: () => () => void): () => void
}

/**
 * Register one contribution, then keep it registered across every re-declaration
 * of the seat it lives in.
 * @param slots - the slot registry.
 * @param seat - the seat key.
 * @param component - the component to render into it.
 * @param withLocale - whether the seat passes a locale namespace to the component.
 * @returns disposer releasing the contribution.
 */
function registerSeat(
  slots: SlotRegistry,
  seat: string,
  component: unknown,
  withLocale: boolean,
): () => void {
  const register = (): (() => void) => {
    try {
      const dispose = slots.register({
        name: seat,
        id: TEAM_EXTENSION_ID,
        ...(withLocale ? { locale: LOCALE_NS } : {}),
      }, component)
      return () => {
        try { dispose() } catch { /* best-effort */ }
      }
    } catch (error) {
      console.error('[dsh-task-board-team] seat registration failed: ' + seat, error)
      return () => {}
    }
  }
  if (typeof slots.inject !== 'function') return register()
  try {
    return slots.inject(seat, register)
  } catch (error) {
    console.error('[dsh-task-board-team] seat could not follow its declaration: ' + seat, error)
    return register()
  }
}

/**
 * Install the team browser half.
 * @param ctx - client context (slot registry).
 * @param source - the extension's live enabled switch.
 * @returns disposer releasing every contribution.
 */
export function installTeamClientHalf(ctx: ClientContext, source: ExtensionEnabledSource): () => void {
  let rendering: ReturnType<ClientContext['inject']> | undefined
  let configuration: ReturnType<ClientContext['inject']> | undefined
  // The shell throws on an undeclared service property, so the registry is
  // probed instead of read: a page that serves no slot registry loses only this
  // provider's contributions, never the whole boot.
  const slots = optionalService(ctx, 'slots') as SlotRegistry | undefined
  if (slots === undefined) return () => {}

  const install = (): void => {
    if (rendering !== undefined) return
    rendering = ctx.inject(['taskBoard'], (scope: ClientContext) => {
      scope.effect(() => installSeats(scope, slots), 'task-board-team: provider seats')
    })
  }

  const release = (): void => {
    const current = rendering
    rendering = undefined
    if (current === undefined) return
    void current.dispose()
    // A hidden provider publishes no summary; keep the last one from looking
    // like live state on a settings page that is still open.
    clearSummary()
  }

  const apply = (): void => {
    if (source.read()) install()
    else release()
  }

  // The configuration block outlives the extension's own switch: it is where the
  // switch and the credential live.
  configuration = ctx.inject(['taskBoard'], (scope: ClientContext) => {
    scope.effect(
      () => registerSeat(slots, TASK_BOARD_SETTINGS_SECTION, TeamSettingsSection, true),
      'task-board-team: provider settings section',
    )
  })

  const unsubscribe = source.subscribe(apply)
  apply()

  return () => {
    unsubscribe()
    release()
    const currentConfiguration = configuration
    configuration = undefined
    if (currentConfiguration !== undefined) void currentConfiguration.dispose()
  }
}

/**
 * Register the rendering seats and the mirror subscription for as long as the
 * board's own master switch is on.
 * @param ctx - client context.
 * @param slots - the slot registry.
 * @returns disposer releasing every contribution.
 */
function installSeats(ctx: ClientContext, slots: SlotRegistry): () => void {
  const face: TaskBoardClientFace | undefined = resolveTaskBoardClientFace(ctx)
  if (face === undefined) {
    console.error('[dsh-task-board-team] the taskBoard service does not answer the client contract')
    return () => {}
  }
  const seats: Array<() => void> = []
  let registered = false

  const ensure = (): void => {
    if (registered) return
    registered = true
    seats.push(registerSeat(slots, TASK_BOARD_DETAIL_SECTION, TeamDetailSection, true))
    seats.push(registerSeat(slots, TASK_BOARD_CARD_DECORATION, TeamCardDecoration, false))
  }
  const release = (): void => {
    registered = false
    for (const dispose of seats.splice(0)) {
      try { dispose() } catch { /* best-effort */ }
    }
  }

  const unsubscribe = face.subscribe(mirror => {
    if (mirror.enabled) ensure()
    else release()
    acceptPublishedSummaries(mirror.extensions)
  })
  const current = face.snapshot()
  if (current.enabled) ensure()
  acceptPublishedSummaries(current.extensions)

  return () => {
    unsubscribe()
    release()
  }
}