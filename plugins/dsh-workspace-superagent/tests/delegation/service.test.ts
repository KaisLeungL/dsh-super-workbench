import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DelegationService } from '../../src/app/delegation/service.ts';
import type { BoardLaunchFace, BoardLaunchReceipt } from '../../src/app/delegation/launch.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-delegation-service-'));
  const path = join(root, 'delegation.sqlite');
  const receipts = new Map<string, BoardLaunchReceipt>();
  let state = { allowed: true, current: false }, calls = 0;
  const board: BoardLaunchFace = {
    durableLaunchReceiptVersion: 1,
    async startWithReceipt(request) {
      calls++;
      const receipt: BoardLaunchReceipt = { state: 'accepted', operationId: request.operationId, taskId: request.taskId, executionId: 'run-1' };
      receipts.set(request.operationId, receipt);
      return receipt;
    },
    async readLaunchReceipt(request) {
      return receipts.get(request.operationId) ?? { state: 'unknown', operationId: request.operationId, taskId: request.taskId };
    },
  };
  const service = new DelegationService(path, {
    workspaceId: 'work-1',
    assertScope() { if (!state.allowed) throw Error('SCOPE_REVOKED'); },
    assertCurrent(sessionId) {
      if (sessionId !== 'router-1' || !state.current) throw Error('SESSION_CHANGED');
    },
    board: () => board,
  });
  state.current = true;
  return {
    root, service, receipts,
    get calls() { return calls; },
    revoke() { state.allowed = false; },
    detach() { state.current = false; },
    dispose() { service.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('同一 operationId 的重复启动返回同一次执行，且每个会话独立', async () => {
  const f = fixture();
  try {
    const first = await f.service.start('router-1', 'delegate:call-1', 'task-1');
    assert.equal(first.state, 'accepted');
    assert.equal(first.executionId, 'run-1');
    const retry = await f.service.start('router-1', 'delegate:call-1', 'task-1');
    assert.equal(retry.executionId, 'run-1');
    assert.equal(f.calls, 1);
    assert.equal(f.service.list('router-1').length, 1);
  } finally { f.dispose(); }
});

test('会话不再是当前主理绑定后拒绝启动', async () => {
  const f = fixture();
  try {
    f.detach();
    await assert.rejects(() => f.service.start('router-1', 'delegate:call-2', 'task-1'), /SESSION_CHANGED|DELEGATION_SCOPE_CHANGED/);
    assert.equal(f.calls, 0);
  } finally { f.dispose(); }
});

test('所有者或授权撤销后拒绝启动，已有记录仍可读取', async () => {
  const f = fixture();
  try {
    await f.service.start('router-1', 'delegate:call-1', 'task-1');
    f.revoke();
    await assert.rejects(() => f.service.start('router-1', 'delegate:call-2', 'task-1'));
    assert.throws(() => f.service.list('router-1'), /SCOPE_REVOKED/);
  } finally { f.dispose(); }
});

test('reconcile 只读取原操作回执，不重新启动', async () => {
  const f = fixture();
  try {
    const record = await f.service.start('router-1', 'delegate:call-1', 'task-1');
    assert.equal(record.state, 'accepted');
    const reconciled = await f.service.reconcile('router-1', 'delegate:call-1', 'task-1');
    assert.equal(reconciled.executionId, 'run-1');
    assert.equal(f.calls, 1);
  } finally { f.dispose(); }
});
