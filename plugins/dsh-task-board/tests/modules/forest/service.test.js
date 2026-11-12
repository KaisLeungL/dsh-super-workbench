import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createForestService,forestTool} from '../../../src/modules/forest/host-service.js';

test('member 完成事件快照在排队期间被删除，树木仍持久保存；重启及工具操作复用同一账本', async()=>{
  // Given: 给定持久化服务和完成事件快照
  // When: 处理排队事件并重新打开服务
  // Then: 核对种植账本和工具返回状态

  const clock=Date.parse('2026-11-10T10:00:00+08:00');
  const records={};
  const unit={loadAll:async()=>({tables:{state:structuredClone(records)}}),putRecord:async(_table,key,value)=>{
  // Given: 给定持久化服务和完成事件快照
  // When: 处理排队事件并重新打开服务
  // Then: 核对种植账本和工具返回状态
records[key]=structuredClone(value);}};
  let tasks=[];
  const payloads=new Map();
  const board={tasks:{list:()=>tasks,get:id=>tasks.find(task=>task.id===id)},integration:{read:id=>payloads.get(id),write:(id,value)=>payloads.set(id,value)},publish:()=>{}};
  let service=await createForestService({unit,board,now:()=>clock});
  tasks=[{id:'completed',title:'真实完成记录',status:'done',updatedAt:clock,createdAt:clock,executions:[]}];
  const settled=service.reconcile();
  tasks=[];
  await settled;
  assert.equal(service.snapshot().total,1);
  const result=await forestTool(service).execute({action:'profile',nickname:'测试旅人'});
  assert.equal(result.identity.nickname,'测试旅人');
  assert.equal(records.engine.rewards[0].title,'真实完成记录');
  await service.close();
  service=await createForestService({unit,board,now:()=>clock});
  try{
    assert.equal(service.snapshot().total,1);
    assert.equal(service.snapshot().identity.nickname,'测试旅人');
    assert.equal((await service.operate({action:'island',island:1})).island.rewards.length,1);
    await assert.rejects(service.operate({action:'grant'}),/Unknown/);
    await assert.rejects(service.operate({action:'status',extra:true}),/Unknown/);
  }finally{await service.close();}
});
