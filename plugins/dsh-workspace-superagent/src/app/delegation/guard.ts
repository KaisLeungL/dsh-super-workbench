import type { BoardLaunchReceipt } from './launch.js';

/** 看板当前任务快照里与派工有关的字段。 */
export interface DelegationTargetSnapshot {
  readonly tasks?: readonly { readonly id: string; readonly permission?: string }[];
}

export interface DelegationTargetRequest {
  readonly operationId: string;
  readonly taskId: string;
}

/**
 * 只读派工前置校验：主理不能把宽权限卡交给 Worker，也不能改写原卡配置。
 * 返回 undefined 表示可继续派工；否则返回持久的拒绝回执。
 */
export function delegationTargetRejection(
  snapshot: DelegationTargetSnapshot | undefined,
  request: DelegationTargetRequest,
): BoardLaunchReceipt | undefined {
  const target = snapshot?.tasks?.find(item => item.id === request.taskId);
  if (!target) {
    return { state: 'rejected', operationId: request.operationId, taskId: request.taskId, reason: '目标看板卡片不可用。' };
  }
  if (target.permission !== 'read-only') {
    return {
      state: 'rejected', operationId: request.operationId, taskId: request.taskId,
      reason: '该看板卡片权限宽于只读，主理不能派工；请改用只读卡片。',
    };
  }
  return undefined;
}
