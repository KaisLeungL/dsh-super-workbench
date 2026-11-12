import { constants } from 'node:fs'
import { lstat, open, realpath, opendir } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
import { LIMITS, type EvidenceBundle, type InspectionRule, type Workspace } from '../core/types.ts'

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
export function within(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}
const excluded = /(^|[/\\])(?:\.[^/\\]+|node_modules|vendor|dist|build|coverage|lib|target|secrets?(?:\.[^/\\]+)?|credentials?(?:\.[^/\\]+)?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)(?:[/\\]|$)|(?:\.pem|\.key|\.p12|\.pfx|\.keystore|\.sqlite|\.db)$/i
const textFile = /\.(?:md|txt|json|ya?ml|[cm]?[jt]sx?|py|swift|rs|go|css|html)$/i
export function containsSecret(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,})|(?:api[_-]?key|password|secret|token|authorization)\s*["']?\s*[:=]\s*["']?[^\s"'<>]{8,}/i.test(text)
}
/** 仅遍历显式授权路径；不跟随任何符号链接，不执行仓库命令。 */
export async function collectEvidence(rule: InspectionRule, workspace: Workspace, signal?: AbortSignal): Promise<EvidenceBundle> {
  if (!rule.enabled || workspace.id !== rule.workspaceId || !workspace.path) throw new Error('project-not-authorized')
  const workspaceRoot = await realpath(workspace.path)
  if ((await lstat(rule.root)).isSymbolicLink()) throw new Error('symlink-root')
  const root = await realpath(rule.root)
  if (!within(workspaceRoot, root)) throw new Error('root-outside-workspace')
  const bundle: EvidenceBundle = { evidence: [], coverage: { files: 0, bytes: 0, visited: 0, omitted: 0, truncated: false, git: 'not-requested' } }
  const seen = new Set<string>()
  const check = (): void => { signal?.throwIfAborted() }
  const visit = async (path: string): Promise<void> => {
    check()
    if (bundle.coverage.visited >= LIMITS.visited || bundle.coverage.files >= LIMITS.files || bundle.coverage.bytes >= LIMITS.totalBytes) {
      bundle.coverage.truncated = true
      return
    }
    bundle.coverage.visited++
    const rel = relative(root, path)
    if (!within(root, path) || excluded.test(rel)) { bundle.coverage.omitted++; return }
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) { bundle.coverage.omitted++; return }
    const resolved = await realpath(path)
    if (!within(root, resolved) || seen.has(resolved)) { bundle.coverage.omitted++; return }
    seen.add(resolved)
    if (stat.isDirectory()) {
      for await (const entry of await opendir(path)) {
        await visit(resolve(path, entry.name))
        if (bundle.coverage.truncated) break
      }
      return
    }
    if (!stat.isFile() || !textFile.test(rel) || stat.size > LIMITS.fileBytes || stat.size + bundle.coverage.bytes > LIMITS.totalBytes) {
      bundle.coverage.omitted++; return
    }
    // O_NOFOLLOW closes the final-component replacement race; realpath is
    // checked again after opening so changed ancestor links cannot escape.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const actual = await handle.stat()
      if (!actual.isFile() || actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size > LIMITS.fileBytes || !within(root, await realpath(path))) throw new Error('unsafe-file-change')
      const buffer = Buffer.alloc(LIMITS.fileBytes + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      check()
      if (bytesRead > LIMITS.fileBytes || bundle.coverage.bytes + bytesRead > LIMITS.totalBytes) { bundle.coverage.truncated = true; return }
      const text = buffer.subarray(0, bytesRead).toString('utf8')
      if (text.includes('\0') || containsSecret(text)) { bundle.coverage.omitted++; return }
      bundle.evidence.push({ id: digest(rel).slice(0, 24), path: rel, text, fingerprint: digest(text) })
      bundle.coverage.files++
      bundle.coverage.bytes += bytesRead
    } finally { await handle.close() }
  }
  for (const path of rule.paths) {
    check()
    const target = resolve(root, path)
    if (!within(root, target)) throw new Error('path-outside-root')
    // Check every component before following it, including an authorized
    // directory itself; a symlink cannot make excluded files appear elsewhere.
    let current = root
    for (const component of relative(root, target).split(sep).filter(Boolean)) {
      current = resolve(current, component)
      if ((await lstat(current)).isSymbolicLink()) throw new Error('symlink-in-scope')
    }
    await visit(target)
  }
  if (rule.includeGit) {
    try {
      check()
      const git = resolve(root, '.git')
      if (!(await lstat(git)).isDirectory() || (await lstat(git)).isSymbolicLink() || !within(root, await realpath(git))) throw new Error('git-boundary')
      // Fixed read-only commands, no shell, hooks, fsmonitor, lazy fetch,
      // optional locks, external diff, pager or inherited Git configuration.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
      Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' })
      const base = ['--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never']
      const options = { cwd: root, env, timeout: 2000, maxBuffer: 8192, signal }
      const status = await exec('git', [...base, 'diff', '--cached', '--name-only', '--no-ext-diff', '--no-textconv', '--ignore-submodules', '--no-renames'], options)
      const log = await exec('git', [...base, 'log', '-5', '--format=%h %s', '--no-show-signature'], options)
      const text = [...status.stdout.split('\n').filter(line => !excluded.test(line)), ...log.stdout.split('\n')].join('\n')
      if (containsSecret(text)) throw new Error('git-secret')
      const bytes = Buffer.byteLength(text)
      if (bundle.coverage.bytes + bytes > LIMITS.totalBytes) { bundle.coverage.truncated = true; throw new Error('git-budget') }
      bundle.evidence.push({ id: digest('git-summary').slice(0, 24), path: 'git-summary', text, fingerprint: digest(text) })
      bundle.coverage.bytes += bytes
      bundle.coverage.git = 'collected'
    } catch { check(); bundle.coverage.git = 'unavailable' }
  }
  check()
  bundle.evidence.sort((a, b) => a.path.localeCompare(b.path))
  return bundle
}
