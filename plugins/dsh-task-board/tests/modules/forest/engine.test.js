import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createForestEngine,countRewards,rewardDays} from '../../../src/modules/forest/engine.js';
const start=Date.parse('2026-11-09T00:00:00+08:00');
const task=(id,time,parentId)=>({id,title:id,status:'done',executions:[],updatedAt:time,createdAt:time,...(parentId?{parentId}:{})});
test('member 启用前任务不补奖，完整父子任务只得一树，重开和拆分不重复',async()=>{
  // Given: 给定持久化森林引擎和明确的任务完成记录
  // When: 投递完成事件、重试写入或跨越日历边界
  // Then: 核对树木数量、岛位和奖励日期

 let time=start, saved;const engine=createForestEngine({now:()=>time,save:async v=>{saved=v;}});
 assert.equal((await engine.reconcile([task('old',start-1)])).total,0);
 const root=task('root',time),child=task('child',time,'root');
 assert.equal((await engine.reconcile([root,{...child,status:'todo'}])).total,0);
 assert.equal((await engine.reconcile([root,child])).total,1);
 assert.equal((await engine.reconcile([root,child])).total,1);
 assert.equal((await engine.reconcile([{...root,status:'todo'},child])).total,1);
 assert.equal((await engine.reconcile([root,{...child,parentId:undefined}])).total,1);
 await engine.close();
 const restored=createForestEngine({saved,save:async()=>{
  // Given: 给定持久化森林引擎和明确的任务完成记录
  // When: 投递完成事件、重试写入或跨越日历边界
  // Then: 核对树木数量、岛位和奖励日期
},now:()=>time});
 assert.equal((await restored.reconcile([])).total,1);
 await restored.close();
});
test('member 并发结算 17 项任务，岛位唯一且第 17 棵进入下一岛',async()=>{
  // Given: 给定持久化森林引擎和明确的任务完成记录
  // When: 投递完成事件、重试写入或跨越日历边界
  // Then: 核对树木数量、岛位和奖励日期

 const engine=createForestEngine({now:()=>start,save:async()=>{
  // Given: 给定持久化森林引擎和明确的任务完成记录
  // When: 投递完成事件、重试写入或跨越日历边界
  // Then: 核对树木数量、岛位和奖励日期
}});
 const tasks=Array.from({length:17},(_,i)=>task('task-'+i,start));
 await Promise.all([engine.reconcile(tasks),engine.reconcile(tasks)]);
 const view=engine.snapshot({island:2});
 assert.equal(view.total,17);assert.equal(view.completedIslands,1);assert.equal(view.currentCount,1);
 assert.equal(view.island.rewards[0].position,1);
 assert.equal(new Set(engine.exportState().rewards.map(r=>r.island+':'+r.position)).size,17);
 await engine.close();
});
test('member 落盘失败不公布树木，重试可恢复',async()=>{
  // Given: 给定持久化森林引擎和明确的任务完成记录
  // When: 投递完成事件、重试写入或跨越日历边界
  // Then: 核对树木数量、岛位和奖励日期

 let fail=true;const engine=createForestEngine({now:()=>start,save:async()=>{
  // Given: 给定持久化森林引擎和明确的任务完成记录
  // When: 投递完成事件、重试写入或跨越日历边界
  // Then: 核对树木数量、岛位和奖励日期
if(fail)throw Error('disk failed');}});
 await assert.rejects(engine.reconcile([task('one',start)]),/disk failed/);
 assert.equal(engine.snapshot().total,0);fail=false;
 assert.equal((await engine.reconcile([task('one',start)])).total,1);await engine.close();
});
test('member 失败执行不发树，周期实例重试只发一次，下一周期再发',async()=>{
  // Given: 给定持久化森林引擎和明确的任务完成记录
  // When: 投递完成事件、重试写入或跨越日历边界
  // Then: 核对树木数量、岛位和奖励日期

 let clock=start;const engine=createForestEngine({now:()=>clock,save:async()=>{
  // Given: 给定持久化森林引擎和明确的任务完成记录
  // When: 投递完成事件、重试写入或跨越日历边界
  // Then: 核对树木数量、岛位和奖励日期
}});
 const make=(trigger,result='succeeded')=>({...task('scheduled',clock),schedule:{mode:'cron',lastTriggeredAt:trigger},executions:[{id:'run-'+clock,startedAt:trigger,endedAt:clock,result}]});
 assert.equal((await engine.reconcile([make(start,'failed')])).total,0);
 assert.equal((await engine.reconcile([make(start)])).total,1);
 assert.equal((await engine.reconcile([make(start)])).total,1);
 clock+=86400000;assert.equal((await engine.reconcile([make(clock)])).total,2);await engine.close();
});
test('member 上海时间午夜、周一、月初采用实际完成日，离线补交不改完成时间',()=>{
 // Given: 已记录实际完成时间的任务。
 // When: 按上海日历统计历史奖励。
 // Then: 午夜、周一和月初边界按实际完成日归属。

 const at=Date.parse('2026-11-02T00:01:00+08:00');
 const rewards=['2026-10-31T23:59:00+08:00','2026-11-01T23:59:00+08:00','2026-11-02T00:00:00+08:00'].map(completedAt=>({completedAt}));
 assert.deepEqual(countRewards(rewards,at),{day:1,week:1,month:2});
 assert.deepEqual(rewardDays(rewards,at),{'2026-10-31':1,'2026-11-01':1,'2026-11-02':1});
});
