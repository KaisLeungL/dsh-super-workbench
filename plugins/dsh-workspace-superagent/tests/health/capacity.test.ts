import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityBlocks, unavailableHealth } from '../../src/app/health/view.js';
import { LIMITS } from '../../src/storage/types.js';
import { fixture } from '../lifecycle/fixture.js';

test('健康投影容量边界按数据库加WAL、索引与磁盘预留分别拒绝', t => {
  const f = fixture(t), summary = f.store.readHealthSummary(Date.now()), manager = f.store.manager();
  summary.capacity = { ...summary.capacity, dbBytes: LIMITS.dbBytes - 2, walBytes: 1,
    artifactIndexedBytes: LIMITS.artifactsBytes - 1, diskAvailableBytes: LIMITS.diskReserveBytes };
  assert.deepEqual(capacityBlocks(summary), []);
  summary.capacity.walBytes = 2;
  assert.deepEqual(capacityBlocks(summary), ['数据库与WAL已达容量阈值']);
  summary.capacity.dbBytes = 1; summary.capacity.walBytes = 1;
  summary.capacity.artifactIndexedBytes = LIMITS.artifactsBytes;
  assert.deepEqual(capacityBlocks(summary), ['工件索引已达容量阈值']);
  summary.capacity.artifactIndexedBytes = 0; summary.capacity.diskAvailableBytes = LIMITS.diskReserveBytes - 1;
  assert.deepEqual(capacityBlocks(summary), ['磁盘预留不足']);
  assert.deepEqual(f.store.manager(), manager);
});

test('容量缺失、摘要截断和待恢复均保守降级，完整审计门禁保持关闭', t => {
  const f = fixture(t), summary = f.store.readHealthSummary(Date.now());
  summary.capacity.dbBytes = null; summary.capacity.walBytes = null; summary.capacity.diskAvailableBytes = null;
  summary.evals.truncated = true; summary.jobs.truncated = true; summary.diagnostics.recoveryPending = true;
  assert.deepEqual(capacityBlocks(summary), ['存储不健康或尚待冷恢复', '持久运行项超出可观测上限', '数据库或WAL容量未提供', '磁盘可用量未提供']);
  assert.notEqual(summary.audit.status, 'verified_scope');
  const view = unavailableHealth('受信宿主未就绪', 1000);
  assert.equal(view.auditGate.completeE37, false); assert.equal(view.control.enabled, false);
  assert.equal(view.nativeExecution.status, 'unavailable');
});
