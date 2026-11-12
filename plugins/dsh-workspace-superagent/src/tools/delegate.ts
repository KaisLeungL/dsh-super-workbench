import type { Invocation } from './authority.js';

/** Router 把一张已存在看板卡交给 Worker 的模型工具名。 */
export const DELEGATE_TOOL = 'steward_delegate_task';

/** 宿主实际传入的 ToolExecutionInput 还带 callId；operationId 由它稳定派生。 */
export interface DelegateInvocation<A extends { readonly id: string }> extends Invocation<A> {
  readonly name: string;
  readonly callId?: string;
}

const taskId = { type: 'string', minLength: 1, maxLength: 512 };

export interface DelegationToolArgs { readonly taskId: string }

/** 只接受任务 ID；工作区、会话、权限和启动范围均由可信 Host 推导。 */
export function readDelegationToolArgs(value: unknown): DelegationToolArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('DELEGATION_INVALID_ARGUMENTS');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'taskId')) throw Error('DELEGATION_INVALID_ARGUMENTS');
  const id = typeof record.taskId === 'string' ? record.taskId.trim() : '';
  if (!id || id.length > 512) throw Error('DELEGATION_INVALID_ARGUMENTS');
  return { taskId: id };
}

/** 只有 Router 前台轮次内、持有当前读取授权时才注册并放行此工具。 */
export function delegateToolDefinition<A extends { readonly id: string }>(
  execute: (args: unknown, exec: DelegateInvocation<A>) => Promise<unknown>,
) {
  return {
    name: DELEGATE_TOOL,
    description: '把一张已存在的看板任务卡片交给看板启动一次只读 Worker 执行。仅在用户明确要求派工、且任务 ID 来自当前只读工具结果时调用。不会创建卡片、不会修改权限，也不会重复启动已有运行中的卡片。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['taskId'],
      properties: { taskId: { ...taskId, description: '已授权看板中真实存在的任务 ID。' } },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute: (args: unknown, exec: DelegateInvocation<A>) => execute(args, exec),
  };
}
