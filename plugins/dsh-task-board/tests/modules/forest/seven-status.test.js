import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createForestEngine } from '../../../src/modules/forest/engine.js';

const time = Date.parse('2026-11-10T18:00:00+08:00');
const task = (id, status, parentId) => ({
  id, title: id, status, createdAt: time, updatedAt: time,
  executions: [{ id: 'run-' + id, startedAt: time, endedAt: time, result: 'succeeded' }],
  ...(parentId ? { parentId } : {}),
});

test('member 待输入和待人工验收不发树，也不阻断其他完成任务结算', async () => {
  // Given: 给定七态看板和现有森林状态
  // When: 核对待输入、待验收及完成任务
  // Then: 仅为满足完整完成条件的任务发树

  const engine = createForestEngine({ now: () => time, save: async () => {
  // Given: 给定七态看板和现有森林状态
  // When: 核对待输入、待验收及完成任务
  // Then: 仅为满足完整完成条件的任务发树
} });
  try {
    const waiting = task('waiting', 'needs_input');
    const review = task('review', 'review');
    assert.equal((await engine.reconcile([waiting, review, task('done', 'done')])).total, 1);
    assert.equal((await engine.reconcile([waiting, { ...review, status: 'done' }, task('done', 'done')])).total, 2);
    assert.equal((await engine.reconcile([waiting, { ...review, status: 'done' }, task('done', 'done')])).total, 2);
  } finally { await engine.close(); }
});

test('member 子任务待输入或待验收时父任务不发树，全部完成后只发一棵', async () => {
  // Given: 给定七态看板和现有森林状态
  // When: 核对待输入、待验收及完成任务
  // Then: 仅为满足完整完成条件的任务发树

  const engine = createForestEngine({ now: () => time, save: async () => {
  // Given: 给定七态看板和现有森林状态
  // When: 核对待输入、待验收及完成任务
  // Then: 仅为满足完整完成条件的任务发树
} });
  try {
    const root = task('root', 'done');
    const child = task('child', 'needs_input', 'root');
    assert.equal((await engine.reconcile([root, child])).total, 0);
    assert.equal((await engine.reconcile([root, { ...child, status: 'review' }])).total, 0);
    assert.equal((await engine.reconcile([root, { ...child, status: 'done' }])).total, 1);
  } finally { await engine.close(); }
});
