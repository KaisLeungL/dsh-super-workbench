/**
 * Host-side custody of the team-hub Host Token.
 *
 * The token is a credential, so it lives where the harness keeps credentials —
 * never in this extension's own settings entry, never in a board snapshot, never
 * in a published summary and never in any agent payload. The browser sends a
 * pasted value exactly once; the host half stores it and afterwards only reports
 * whether one is configured, where it came from and whether it can be written.
 *
 * @module dsh-task-board-team/host/credentials
 */
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'

/** Credential reference name the Host Token is stored under by default. */
export const DEFAULT_TOKEN_REF = 'DSH_TEAM_HUB_TOKEN'

/** Credential facts one reference reports; no slot carries a value. */
interface CredentialInfo {
  configured: boolean
  source?: string
  writable: boolean
}

/** The slice of the credential seam this extension uses. */
export interface CredentialFace {
  resolve(ref: unknown): Promise<{ value: string; source?: string } | undefined>
  describe(ref: unknown): Promise<CredentialInfo>
  set(ref: unknown, value: string): Promise<void>
  unset(ref: unknown): Promise<void>
}

/**
 * Resolve the optional credential service without declaring a required
 * injection: a deployment that serves none keeps working on the environment.
 * @param ctx - host context.
 * @returns the seam, or undefined.
 */
export function resolveCredentialFace(ctx: Context): CredentialFace | undefined {
  try {
    const get = (ctx as { get?: (name: string) => unknown }).get
    if (typeof get !== 'function') return undefined
    const face = get.call(ctx, 'credentials') as CredentialFace | undefined
    if (face === undefined) return undefined
    const usable = typeof face.resolve === 'function'
      && typeof face.describe === 'function'
      && typeof face.set === 'function'
      && typeof face.unset === 'function'
    return usable ? face : undefined
  } catch {
    return undefined
  }
}

/** The ambient fallback: the configured reference name only. */
function ambientToken(env: Record<string, string | undefined>, ref: string): string | undefined {
  const value = env[ref]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Report one reference's credential facts for a settings surface.
 * @param ctx - host context.
 * @param ref - the configured reference name.
 * @param env - environment consulted for the ambient fallback.
 * @returns the status the settings section renders.
 */
export async function describeHostToken(
  ctx: Context,
  ref: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ configured: boolean; writable: boolean; source?: string; ref: string }> {
  const face = resolveCredentialFace(ctx)
  let info: CredentialInfo | undefined
  if (face !== undefined && isCredentialRefName(ref)) {
    try {
      info = await face.describe(credentialRef(ref))
    } catch {
      info = undefined
    }
  }
  const ambient = ambientToken(env, ref)
  if (info !== undefined && info.configured) {
    return {
      configured: true,
      writable: info.writable,
      ref,
      ...(info.source === undefined ? {} : { source: info.source }),
    }
  }
  if (ambient !== undefined) {
    return { configured: true, writable: info?.writable ?? false, ref, source: 'environment' }
  }
  return { configured: false, writable: info?.writable ?? face !== undefined, ref }
}

/**
 * Resolve the effective Host Token for one reference.
 * @param ctx - host context.
 * @param ref - the configured reference name.
 * @param env - environment consulted for the ambient fallback.
 * @returns the token, or undefined when none is configured.
 */
export async function resolveHostToken(
  ctx: Context,
  ref: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  if (ref.trim() === '') return undefined
  const face = resolveCredentialFace(ctx)
  if (face !== undefined && isCredentialRefName(ref)) {
    try {
      const resolved = await face.resolve(credentialRef(ref))
      if (resolved?.value !== undefined && resolved.value.trim() !== '') return resolved.value.trim()
    } catch {
      // An unreadable store falls through to the environment.
    }
  }
  return ambientToken(env, ref)
}

/**
 * Store one Host Token in the credential seam.
 * @param ctx - host context.
 * @param ref - the reference to write.
 * @param token - the secret value.
 * @throws when no credential store is served or the store refuses the write.
 */
export async function setHostToken(ctx: Context, ref: string, token: string): Promise<void> {
  const face = resolveCredentialFace(ctx)
  if (face === undefined) throw new Error('this deployment serves no credential store; set the Host Token through the environment instead')
  if (!isCredentialRefName(ref)) throw new Error('"' + ref + '" is not a valid credential reference name')
  await face.set(credentialRef(ref), token)
}

/**
 * Remove one stored Host Token. Absent values are a no-op.
 * @param ctx - host context.
 * @param ref - the reference to clear.
 * @throws when no credential store is served.
 */
export async function clearHostToken(ctx: Context, ref: string): Promise<void> {
  const face = resolveCredentialFace(ctx)
  if (face === undefined) throw new Error('this deployment serves no credential store')
  if (!isCredentialRefName(ref)) throw new Error('"' + ref + '" is not a valid credential reference name')
  await face.unset(credentialRef(ref))
}
