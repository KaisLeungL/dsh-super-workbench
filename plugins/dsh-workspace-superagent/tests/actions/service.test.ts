import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionService } from '../../src/actions/service.js';
import { BOARD, SCHEDULE, parseCandidate } from '../../src/actions/protocol.js';

function fixture(path = ':memory:') {
  const tasks: { id: string; workspaceId: string; projectId: string; status: string }[] = [];
  const results = new Map<string, { id: string; scheduledAt: string }>();
  let boardWrites = 0, scheduleWrites = 0, reject = false, loseReceipt = false;
  const at = '2026-11-12T01:00:00.000Z';
  const binding = {
    workspaceId:'workspace-A', workspacePath:'/fixture', check() { if (reject) throw Error('DRAFT_SCOPE_CHANGED'); },
    board: () => ({ snapshot: () => ({tasks}), isExtensionEnabled: () => true,
      apply: async (_key: string, action: { id: string; input: { workspaceId: string; projectId: string; status: string } }) => {
        boardWrites++;
        tasks.push({ id:action.id, workspaceId:action.input.workspaceId, projectId:action.input.projectId, status:action.input.status });
      },
    }),
    schedule: () => ({
      previewConfirmedCreate: () => ({scheduledAt:at}),
      createConfirmed: async (_request: unknown, key: string) => {
        scheduleWrites++;
        results.set(key,{ id:'schedule-'+key,scheduledAt:at });
        if (loseReceipt) throw Error('transport interrupted');
        return results.get(key);
      },
      viewConfirmedCreate: async (_request: unknown,key: string) => results.get(key) ?? { code:'schedule_not_found' },
    }),
  };
  return { tasks, results, at, binding, service:new ActionService(path,binding), get boardWrites() {return boardWrites;}, get scheduleWrites() {return scheduleWrites;},
    revoke(){reject=true;}, loseReceipt(){loseReceipt=true;} };
}
const proposal = (actionId: string, params: object = {}) => parseCandidate({actionId,version:1,params});
const candidate = () => proposal(SCHEDULE, { title:'日报', instruction:'生成验收日报',schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Shanghai'} });

test('创建入口掉线时仍可编辑并保存；入口恢复后才能确认', async () => {
  const f = fixture(), svc = f.service;
  const schedule = f.binding.schedule;
  let available = false;
  Object.assign(f.binding, { schedule: () => available ? schedule() : undefined });
  try {
    const draft = svc.propose('s',1,proposal(SCHEDULE),false);
    assert.equal(draft.status,'needs_input');
    assert.equal(draft.submissionIssue,'entry_unavailable');
    const saved = await svc.handle('s',{ op:'save',id:draft.id,revision:draft.revision,proposal:candidate() },()=>{});
    assert.equal(saved?.status,'unavailable');
    assert.equal(saved?.candidate.params.title,'日报');
    const confirm = { op:'confirm',id:draft.id,revision:saved!.revision };
    assert.equal((await svc.handle('s',confirm,()=>{}))?.status,'unavailable');
    assert.equal(f.scheduleWrites,0);
    available = true;
    const ready = await svc.handle('s',{ op:'read',turn:1 },()=>{});
    assert.equal(ready?.status,'ready');
    assert.equal((await svc.handle('s',{ ...confirm,expectedNextRunAt:ready?.nextRunAt },()=>{}))?.status,'succeeded');
    assert.equal(f.scheduleWrites,1);
  } finally { svc.close(); }
});

test('草稿只准备数据；精确修订和工作区确认后建一张看板卡，不自动执行', async () => {
  const f = fixture(), svc=f.service, auth=()=>{};
  try {
    const first=svc.propose('s',0,proposal(BOARD),false);
    assert.equal(first.status,'needs_input');
    assert.equal(f.boardWrites,0);
    await assert.rejects(svc.handle('s',{op:'confirm',id:first.id,revision:1},auth),/DRAFT_NOT_READY/);
    await assert.rejects(svc.handle('s',{op:'save',id:first.id,revision:1,proposal:proposal(BOARD,{title:'卡',projectId:'other'})},auth),/DRAFT_SCOPE_CHANGED/);
    const ready=await svc.handle('s',{op:'save',id:first.id,revision:1,proposal:proposal(BOARD,{title:'卡',column:'backlog'})},auth);
    assert.equal(ready?.status,'ready');
    assert.equal((await svc.handle('s',{op:'confirm',id:first.id,revision:1},auth))?.revision,2);
    await assert.rejects(svc.handle('other',{op:'confirm',id:first.id,revision:2},auth),/DRAFT_NOT_FOUND/);
    const confirm={op:'confirm',id:first.id,revision:2};
    const [one,two]=await Promise.all([svc.handle('s',confirm,auth),svc.handle('s',confirm,auth)]);
    assert.equal(one?.status,'succeeded');
    assert.ok(['submitting','succeeded'].includes(two!.status));
    assert.equal(f.boardWrites,1);
    assert.deepEqual(f.tasks,[{id:first.id,workspaceId:'workspace-A',projectId:'workspace-A',status:'backlog'}]);
    assert.equal((await svc.handle('s',{op:'open',id:first.id,revision:2},auth))?.resultId,first.id);
    f.revoke();
    await assert.rejects(svc.handle('s',{op:'open',id:first.id,revision:2},auth),/DRAFT_SCOPE_CHANGED/);
  } finally { svc.close(); }
});

test('定时创建回执丢失时重启只查同一确认，结果可回读且不重复创建', async () => {
  const folder=mkdtempSync(join(tmpdir(),'wsa-actions-')), path=join(folder,'actions.sqlite');
  const f=fixture(path), svc=f.service, auth=()=>{};
  try {
    const ready=svc.propose('s',3,candidate(),false);
    assert.equal(ready.nextRunAt,f.at);
    const input={op:'confirm',id:ready.id,revision:ready.revision,expectedNextRunAt:f.at};
    assert.equal((await svc.handle('s',{...input,expectedNextRunAt:'changed'},auth))?.status,'ready');
    assert.equal(f.scheduleWrites,0);
    f.loseReceipt();
    assert.equal((await svc.handle('s',input,auth))?.status,'unknown');
    svc.close();
    const recovered=new ActionService(path,f.binding);
    try {
      assert.equal((await recovered.handle('s',input,auth))?.status,'unknown');
      const back=await recovered.handle('s',{op:'reconcile',id:ready.id,revision:ready.revision},auth);
      assert.equal(back?.resultId,'schedule-'+ready.id);
      assert.equal(back?.nextRunAt,f.at);
      assert.equal(f.scheduleWrites,1);
    } finally { recovered.close(); }
  } finally { rmSync(folder,{recursive:true,force:true}); }
});

test('补充上张草稿换到真实新回合；模型参数不能携带权限或执行指令', async () => {
  const f=fixture(), svc=f.service;
  try {
    const one=svc.propose('s',7,proposal(SCHEDULE,{instruction:'日报'}),false);
    const next=svc.propose('s',8,proposal(SCHEDULE,{schedule:{kind:'daily',time:'09:00'}}),true);
    assert.equal(next.id,one.id);
    assert.equal(next.revision,2);
    assert.equal(next.status,'ready');
    assert.equal(await svc.handle('s',{op:'read',turn:7},()=>{}),null);
    assert.throws(()=>proposal(BOARD,{title:'卡',runAfterCreate:true}),/INVALID_DRAFT/);
    assert.throws(()=>proposal(SCHEDULE,{target:'manager'}),/INVALID_DRAFT/);
    assert.throws(()=>proposal(SCHEDULE,{schedule:{kind:'daily',time:'25:00'}}),/INVALID_DRAFT/);
  } finally { svc.close(); }
});
