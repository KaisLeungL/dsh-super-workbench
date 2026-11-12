export interface ContextScope {
  readonly workspaceId: string;
  readonly projectIds: readonly (string | null)[];
  readonly allBoardProjects?: true;
}
export interface ContextItem {
  readonly workspaceId: string | null;
  readonly projectId?: string | null;
  readonly ref: { readonly kind: string; readonly id: string };
  readonly [field: string]: unknown;
}
export interface ContextCapability {
  readonly protocol: 1;
  readonly id: string;
  readonly source: string;
  readonly description: string;
  readonly scope: 'workspace' | 'project';
  readonly filters: Readonly<Record<string, { readonly type: 'string' | 'boolean' | 'integer'; readonly description: string; readonly enum?: readonly string[] }>>;
  read(request: {
    readonly scope: ContextScope;
    readonly filter: Readonly<Record<string, string | boolean | number>>;
    readonly offset: number;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): { readonly items: readonly ContextItem[]; readonly more: boolean; readonly revision: string } | Promise<{ readonly items: readonly ContextItem[]; readonly more: boolean; readonly revision: string }>;
}
export interface ContextAccess {
  readonly scope: ContextScope;
  readonly grants: Readonly<Record<string, string>>;
  readonly binding: string;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export interface WorkspaceContextService {
  register(owner: unknown, capability: ContextCapability): () => void;
  catalog(access: ContextAccess): unknown;
  status(grants: ContextAccess['grants']): readonly { id: string; available: boolean }[];
  query(access: ContextAccess, input: unknown): Promise<unknown>;
}
