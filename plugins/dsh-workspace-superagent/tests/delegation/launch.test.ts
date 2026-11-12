import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DelegationLaunch, type BoardLaunchReceipt, type BoardLaunchFace, type DelegationRequest } from '../../src/app/delegation/launch.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-delegation-'));
  const path = join(root, 'launch.sqlite');
  const request: DelegationRequest = { operationId: 'op-1', workspaceId: 'work-1', routerSessionId: 'router-1', taskId: 'task-1' };
  const receipts = new Map<string, BoardLaunchReceipt>();
  let calls = 0, throwAfterCommit = false, allowed = true, available = true;
  const board: BoardLaunchFace = {
    durableLaunchReceiptVersion: 1,
    async startWithReceipt(value) {
      calls++;
      const receipt: BoardLaunchReceipt = { state: 'accepted', operationId: value.operationId, taskId: value.taskId, executionId: 'run-1' };
      receipts.set(value.operationId, receipt);
      if (throwAfterCommit) throw Error('connection lost after commit');
      return receipt;
    },
    async readLaunchReceipt(value) {
      return receipts.get(value.operationId) ?? { state: 'unknown', operationId: value.operationId, taskId: value.taskId };
    },
  };
  const binding = {
    workspaceId: 'work-1', routerSessionId: 'router-1',
    assertScope() { if (!allowed) throw Error('SCOPE_REVOKED'); },
    assertCurrent(value: DelegationRequest) { if (value.taskId !== 'task-1') throw Error('TASK_NOT_ALLOWED'); },
    board: () => available ? board : undefined,
  };
  return {
    root, path, request, receipts, board, binding,
    get calls() { return calls; },
    disconnect() { throwAfterCommit = true; },
    revoke() { allowed = false; },
    restore() { allowed = true; },
    unavailable() { available = false; },
    dispose() { rmSync(root, { recursive: true, force: true }); },
  };
}

test('确认同一请求只调用看板一次，并持久读取原 executionId', async () => {
  const f = fixture(), service = new DelegationLaunch(f.path, f.binding);
  try {
    assert.equal((await service.start(f.request)).executionId, 'run-1');
    assert.equal((await service.start(f.request)).executionId, 'run-1');
    assert.equal(service.list()[0]?.state, 'accepted');
    assert.equal(f.calls, 1);
  } finally { service.close(); f.dispose(); }
});

test('看板已提交但响应丢失时，重启后只查持久回执，不再次派工', async () => {
  const f = fixture();
  f.disconnect();
  const first = new DelegationLaunch(f.path, f.binding);
  try { assert.equal((await first.start(f.request)).state, 'unknown'); }
  finally { first.close(); }
  const reopened = new DelegationLaunch(f.path, f.binding);
  try {
    assert.equal((await reopened.reconcile(f.request)).executionId, 'run-1');
    assert.equal((await reopened.start(f.request)).state, 'accepted');
    assert.equal(f.calls, 1);
  } finally { reopened.close(); f.dispose(); }
});

test('不支持持久回执的旧宿主不会启动或登记', async () => {
  const f = fixture();
  f.unavailable();
  const service = new DelegationLaunch(f.path, f.binding);
  try {
    await assert.rejects(service.start(f.request), /DELEGATION_RECEIPT_UNAVAILABLE/);
    assert.equal(service.list().length, 0);
    assert.equal(f.calls, 0);
  } finally { service.close(); f.dispose(); }
});

test('并发使用同一 operationId 至多执行一次，重用其他卡片不能冒领', async () => {
  const f = fixture();
  const one = new DelegationLaunch(f.path, f.binding), two = new DelegationLaunch(f.path, f.binding);
  try {
    const results = await Promise.all([one.start(f.request), two.start(f.request)]);
    assert.ok(results.every(result => ['unknown', 'accepted'].includes(result.state)));
    assert.equal(f.calls, 1);
    await assert.rejects(two.start({ ...f.request, taskId: 'task-2' }), /TASK_NOT_ALLOWED/);
    assert.equal(one.list().length, 1);
  } finally { one.close(); two.close(); f.dispose(); }
});

test('不同工作区和失效授权不能读取或启动', async () => {
  const f = fixture(), service = new DelegationLaunch(f.path, f.binding);
  try {
    await assert.rejects(service.start({ ...f.request, workspaceId: 'work-2' }), /DELEGATION_SCOPE_CHANGED/);
    f.revoke();
    await assert.rejects(service.start(f.request), /SCOPE_REVOKED/);
    assert.throws(() => service.list(), /SCOPE_REVOKED/);
    assert.equal(f.calls, 0);
  } finally { service.close(); f.dispose(); }
});

test('错误的执行回执不能归属，保留待核实', async () => {
  const f = fixture();
  f.board.startWithReceipt = async () => ({ state: 'accepted', operationId: 'other', taskId: 'task-1', executionId: 'run-other' });
  const service = new DelegationLaunch(f.path, f.binding);
  try {
    await assert.rejects(service.start(f.request), /DELEGATION_RECEIPT_INVALID/);
    assert.equal((await service.reconcile(f.request)).state, 'unknown');
  } finally { service.close(); f.dispose(); }
});
