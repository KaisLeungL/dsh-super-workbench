import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delegationTargetRejection } from '../../src/app/delegation/guard.js';

const request = { operationId: 'delegate:call-1', taskId: 'task-1' };
const board = (permission: string | undefined) => ({ tasks: [{ id: 'task-1', permission }] });

test('只读卡片允许继续派工', () => {
  assert.equal(delegationTargetRejection(board('read-only'), request), undefined);
});

test('宽权限卡片直接拒绝，不改写原卡配置', () => {
  for (const permission of ['workspace-write', 'danger-full-access', undefined]) {
    const receipt = delegationTargetRejection(board(permission), request);
    assert.deepEqual(receipt, {
      state: 'rejected',
      operationId: request.operationId,
      taskId: request.taskId,
      reason: '该看板卡片权限宽于只读，主理不能派工；请改用只读卡片。',
    });
  }
});

test('目标卡片不可用时拒绝', () => {
  assert.deepEqual(delegationTargetRejection({ tasks: [] }, request), {
    state: 'rejected',
    operationId: request.operationId,
    taskId: request.taskId,
    reason: '目标看板卡片不可用。',
  });
  assert.equal(delegationTargetRejection(undefined, request)?.state, 'rejected');
});
