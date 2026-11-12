import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PersonalService } from '../../src/app/personal/service.js';
import type { CapturedTask } from '../../src/app/projections/types.js';

test('个人待办持久化、请求去重、冲突与作用域变化', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wsa-personal-'));
  let session = 'router-A', allowed = true;
  let taskAvailable = true;
  const task: CapturedTask = { id:'task-A',workspaceId:'workspace-A',resolvedProjectId:'workspace-A',title:'看板卡',
    description:'',status:'todo',updatedAt:1,archivedAt:null,parentId:null,executions:[] };
  let scheduledAt = '2026-11-12T12:00:00.000Z';
  const binding = { workspaceId:'workspace-A',sessionId:()=>session,assertCurrent:()=>{ if (!allowed) throw Error('REVOKED'); },
    tasks:()=>{ if (!taskAvailable) throw Error('UNAVAILABLE'); return [task]; },
    schedule:()=>({view:async ({id}:{id:string})=>({id,title:'日报',status:'active' as const,kind:'daily',time:'20:00:00',scheduledAt})}),
    scheduleIds:()=>['schedule-A'] };
  const path = join(directory, 'personal.sqlite');
  let service = new PersonalService(path,binding);
  try {
    const requestId = randomUUID();
    const create = {op:'create',requestId,title:'查看看板',localDate:'2026-11-11',boardTaskId:'task-A'};
    const one = await service.mutate('router-A',create);
    const two = await service.mutate('router-A',create);
    assert.equal(one.todos.items.length,1);
    assert.equal(two.todos.items[0]?.id,one.todos.items[0]?.id);
    await assert.rejects(service.mutate('router-A',{...create,title:'另一件事'}),/REQUEST_ID_REUSED/);
    await assert.rejects(service.mutate('router-A',{...create,requestId:randomUUID()}));
    const item = one.todos.items[0]!;
    await service.mutate('router-A',{op:'update',requestId:randomUUID(),id:item.id,revision:item.revision,done:true});
    await assert.rejects(service.mutate('router-A',{op:'update',requestId:randomUUID(),id:item.id,revision:item.revision,done:false}),/REVISION_CONFLICT/);
    scheduledAt = '2026-11-13T12:00:00.000Z';
    assert.equal((await service.read('router-A')).schedules.items[0]?.scheduledAt,scheduledAt);
    taskAvailable = false;
    const unavailable = await service.read('router-A');
    assert.equal(unavailable.boardCandidates.available,false);
    assert.equal(unavailable.todos.items[0]?.boardTaskId,undefined);
    service.close();
    service = new PersonalService(path,binding);
    assert.equal((await service.read('router-A')).todos.items[0]?.done,true);
    session = 'router-B';
    await assert.rejects(service.read('router-A'),/CHAT_SESSION_CHANGED/);
    allowed = false;
    await assert.rejects(service.read('router-B'),/REVOKED/);
  } finally { service.close(); rmSync(directory,{recursive:true,force:true}); }
});
