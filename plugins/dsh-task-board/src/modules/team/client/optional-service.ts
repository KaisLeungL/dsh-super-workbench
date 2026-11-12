/**
 * Optional service access for the browser half.
 *
 * The web shell's context throws when a plugin reads a service it did not
 * declare in its inject contract — an entry that wants to tolerate a deployment
 * without a settings surface or slot registry therefore cannot read those names
 * as plain properties. `ctx.get` resolves the same service without the inject
 * requirement, and answers undefined when nothing serves it.
 *
 * @module dsh-task-board-team/client/optional-service
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'

/**
 * Read one optional service by name, outside the inject contract.
 *
 * One external plugin must never take the GUI down: an unsupported read is
 * reported as "no such service" instead of reaching the shell's boot check.
 * @param ctx - the browser plugin context.
 * @param name - the service name to resolve.
 * @returns the service, or undefined when this deployment serves none.
 */
export function optionalService(ctx: ClientContext, name: string): unknown {
  try {
    const get = (ctx as unknown as { get?: (name: string) => unknown }).get
    return get === undefined ? undefined : get.call(ctx, name)
  } catch {
    return undefined
  }
}
