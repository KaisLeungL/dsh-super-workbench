import type { NativeBoardReadFace } from '../../src/adapters/task-board/read/source.js';
import type { ReadBranch, ReadLease } from '../../src/app/projections/types.js';
export const rawTask = (id: string, patch: Record<string, unknown> = {}) => ({
  id, title: id, description: '', prompt: 'SECRET_PROMPT', status: 'todo', updatedAt: 1,
  workspaceId: 'A', projectId: 'P1', archivedAt: undefined as number | undefined, executions: [], integrations: { foreign: { token: 'SECRET_TOKEN', alias: 'SECRET_ALIAS' } }, ...patch,
});
type Extension = Parameters<NativeBoardReadFace['registerExtension']>[0];
export class NativeFixture implements NativeBoardReadFace {
  revision = 0;
  rows = [rawTask('one')];
  enabled = true;
  listeners = new Set<() => void>();
  deletions = new Set<(event: { taskId: string }) => void>();
  extensions = new Map<string, Extension>();
  snapshotReads = 0;
  writes = 0;
  snapshot(): unknown { this.snapshotReads++; return structuredClone({ revision: this.revision, tasks: this.rows }); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  isExtensionEnabled(id: string) { return this.enabled && this.extensions.has(id); }
  registerExtension(extension: Extension) {
    if (this.extensions.has(extension.id)) throw Error('重复扩展');
    this.extensions.set(extension.id, extension); if (this.enabled) this.start(extension);
    return () => { if (this.extensions.get(extension.id) === extension) { extension.stop?.(); this.extensions.delete(extension.id); } };
  }
  start(extension: Extension) {
    extension.start?.({ events: { onTaskDeleted: listener => { this.deletions.add(listener); return () => { this.deletions.delete(listener); }; } } });
  }
  setEnabled(value: boolean) {
    this.enabled = value;
    for (const extension of this.extensions.values()) value ? this.start(extension) : extension.stop?.();
    this.notify();
  }
  notify() { for (const listener of this.listeners) listener(); }
  mutate(body: () => void) { body(); this.revision++; this.notify(); }
  delete(id: string) {
    this.mutate(() => { this.rows = this.rows.filter(row => row.id !== id); });
    for (const listener of this.deletions) listener({ taskId: id });
  }
  get apply(): never { this.writes++; throw Error('产品不得读取写口'); }
}
export function authority(branches: readonly ReadBranch[] = [{ workspaceId: 'A', projectIds: ['P1'] }]) {
  let revision = 0, active = true;
  return {
    provider: (): ReadLease => {
      const captured = revision;
      return Object.freeze({
        fingerprint: 'caller-one/' + captured, policyRevision: String(captured), scopeRevision: String(captured),
        branches: Object.freeze(branches.map(branch => Object.freeze({ ...branch, projectIds: Object.freeze([...branch.projectIds]), ...(branch.taskIds ? { taskIds: Object.freeze([...branch.taskIds]) } : {}) }))),
        assertCurrent: () => { if (!active || revision !== captured) throw Error('已撤权'); },
      });
    },
    change(next: readonly ReadBranch[]) { branches = next; revision++; },
    revoke() { active = false; revision++; },
  };
}
