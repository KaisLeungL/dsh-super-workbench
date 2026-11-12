import { CallerDenied, CONTEXT_TOOLS, type CallerAgent, type CallerAuthority, type Invocation } from './authority.js';

export const BOARD_CONTEXT = Object.freeze({ 'task-board.list': '@local/dsh-workspace-context/task-board' });

export interface ContextAccess {
  readonly scope: { readonly workspaceId: string; readonly projectIds: readonly (string | null)[]; readonly allBoardProjects?: true };
  readonly grants: Readonly<Record<string, string>>;
  readonly binding: string;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export interface ContextService {
  catalog(access: ContextAccess): unknown;
  status(grants: ContextAccess['grants']): readonly { id: string; available: boolean }[];
  query(access: ContextAccess, input: unknown): Promise<unknown>;
}
export interface ContextBinding {
  readonly grants: ContextAccess['grants'];
  service(): ContextService | undefined;
}

/** Only the foreground Router can use the Host's per-capability grants. */
export function contextToolDefinitions<A extends CallerAgent>(authority: CallerAuthority<A>, binding: ContextBinding, workspaceId: string) {
  const shape = [
    { name: CONTEXT_TOOLS[0], description: '发现当前获准读取的上下文来源、读取范围和查询筛选条件。', properties: {}, required: [] },
    { name: CONTEXT_TOOLS[1], description: '通过能力目录返回的标识，读取任务看板、自动化等来源。每次按一个来源查询。', properties: {
      capability: { type: 'string', maxLength: 100 }, filter: { type: 'object', additionalProperties: true },
      limit: { type: 'integer', minimum: 1, maximum: 20 }, cursor: { type: 'string', maxLength: 36 },
    }, required: ['capability'] },
  ];
  return shape.map(tool => ({
    name: tool.name, description: tool.description,
    parameters: { type: 'object', additionalProperties: false, properties: tool.properties, required: tool.required },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(input: unknown, exec: Invocation<A>) {
      const lease = authority.capture(exec);
      lease.require(tool.name, 'read');
      if (lease.role !== 'router' || !lease.foreground) throw new CallerDenied('CONTEXT_FOREGROUND_REQUIRED');
      const projectIds = Object.freeze([...new Set(lease.branches.filter(branch => branch.workspaceId === workspaceId).flatMap(branch => branch.projectIds))]);
      if (!projectIds.length) throw new CallerDenied('CONTEXT_WORKSPACE_DENIED');
      const service = binding.service();
      if (!service) return { status: 'unavailable' };
      const access = Object.freeze({ scope: Object.freeze({ workspaceId, projectIds, ...(lease.allBoardProjects ? { allBoardProjects: true as const } : {}) }), grants: binding.grants,
        binding: lease.fingerprint, signal: exec.signal, assertCurrent() {
          lease.assertCurrent();
          if (binding.service() !== service) throw new CallerDenied('CONTEXT_SERVICE_CHANGED');
        } });
      const result = tool.name === CONTEXT_TOOLS[0] ? service.catalog(access) : await service.query(access, input);
      access.assertCurrent();
      return result;
    },
  }));
}
