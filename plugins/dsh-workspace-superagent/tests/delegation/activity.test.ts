import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delegationActivities } from '../../src/app/delegation/activity.ts';
import type { DelegationRecord } from '../../src/app/delegation/launch.ts';
import type { CapturedExecution, CapturedTask } from '../../src/app/projections/types.ts';

function execution(overrides: Partial<CapturedExecution> = {}): CapturedExecution {
  return {
    id: 'run-1', sessionId: 'worker-1', resolvedProjectId: 'work-1', projectKnown: true,
    startedAt: 1_700_000_100_000, endedAt: 1_700_000_200_000, result: 'succeeded', external: false,
    summary: '', summarySeq: null, ...overrides,
  };
}

function task(overrides: Partial<CapturedTask> = {}, executions: readonly CapturedExecution[] = [execution()]): CapturedTask {
  return {
    id: 'task-1', workspaceId: 'work-1', resolvedProjectId: 'work-1', title: '检查自动化任务可用性',
    description: '', status: 'running', updatedAt: 1_700_000_200_000, archivedAt: null, parentId: null,
    executions, ...overrides,
  };
}

function record(overrides: Partial<DelegationRecord> = {}): DelegationRecord {
  return {
    operationId: 'delegate:call-1', workspaceId: 'work-1', routerSessionId: 'router-1', taskId: 'task-1',
    state: 'accepted', executionId: 'run-1', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_050_000, ...overrides,
  };
}

test('accepted 回执投影为进行中活动，并带提交与启动事件', () => {
  const items = delegationActivities([record()], [task({ status: 'running' }, [execution({ endedAt: null, result: null })])]);
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.status, 'running');
  assert.equal(item.title, '检查自动化任务可用性');
  assert.equal(item.worker, '看板 Worker');
  assert.deepEqual(item.events.map(event => event.title), ['大肥鱼提交委派', '看板确认启动']);
  assert.equal(item.sessionId, 'worker-1');
});

test('执行成功但卡片仍在 review 时显示待我验收，并带回传事件', () => {
  const [item] = delegationActivities([record()], [task({ status: 'review' })]);
  assert.equal(item!.status, 'review');
  assert.deepEqual(item!.events.map(event => event.title), ['大肥鱼提交委派', '看板确认启动', '等待人工验收']);
});

test('有回传摘要时生成 Worker 回传节点', () => {
  const [item] = delegationActivities([record()], [task({ status: 'done' }, [execution({ summary: '调度入口可用，实际投递还需要验证。' })])]);
  assert.equal(item!.status, 'done');
  assert.deepEqual(item!.events.map(event => event.title), ['大肥鱼提交委派', '看板确认启动', 'Worker 回传结果']);
  assert.equal(item!.events[2]!.summary, '调度入口可用，实际投递还需要验证。');
});

test('失败与取消按真实结算显示，不补写成功状态', () => {
  const failed = delegationActivities([record()], [task({ status: 'failed' }, [execution({ result: 'failed' })])])[0]!;
  assert.equal(failed.status, 'failed');
  assert.ok(failed.events.some(event => event.title === '执行失败'));
  const cancelled = delegationActivities([record()], [task({ status: 'todo' }, [execution({ result: 'cancelled' })])])[0]!;
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.events.some(event => event.title === '执行已取消'));
});

test('拒绝与待核实只展示持久回执，不伪造执行', () => {
  const rejected = delegationActivities([record({ state: 'rejected', executionId: undefined, reason: '任务已有进行中的执行' })], [task()])[0]!;
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.events.at(-1)!.title, '启动被拒绝');
  assert.equal(rejected.events.at(-1)!.summary, '任务已有进行中的执行');
  const unknown = delegationActivities([record({ state: 'unknown', executionId: undefined })], [task()])[0]!;
  assert.equal(unknown.status, 'unknown');
  assert.deepEqual(unknown.events.map(event => event.title), ['大肥鱼提交委派', '派工回执待核实']);
});

test('卡片读不到时仍有可信活动行，并用缩短的任务 ID', () => {
  const [item] = delegationActivities([record()], []);
  assert.equal(item!.title, '看板任务 task-1');
  assert.equal(item!.status, 'running');
});

test('活动按最后有效进展倒序', () => {
  const items = delegationActivities([
    record({ operationId: 'op-old', taskId: 'task-old', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }),
    record({ operationId: 'op-new', taskId: 'task-new', createdAt: 1_700_000_300_000, updatedAt: 1_700_000_300_000 }),
  ], []);
  assert.deepEqual(items.map(item => item.id), ['op-new', 'op-old']);
});
