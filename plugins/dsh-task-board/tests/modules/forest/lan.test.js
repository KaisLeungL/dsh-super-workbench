import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ForestLan,isPrivateAddress} from '../../../src/modules/forest/lan.js';
const start=Date.parse('2026-11-01T23:59:00+08:00');
const profile=(id,name,count)=>({id,nickname:name,total:count,counts:{day:count,week:count,month:count},days:{'2026-11-01':count}});
test('member 两个独立成员真实 HTTP 加入、同步、跨日、断线重连和退出',async()=>{
  // Given: 给定隔离成员和临时HTTP房间
  // When: 同步排名或提交非法邀请数据
  // Then: 核对成员状态与地址验证结果

 let clock=start, hostSaved, memberSaved;
 const id=randomUUID(),other=randomUUID();
 let guest=profile(other,'伙伴',3);
 const host=new ForestLan({now:()=>clock,save:async v=>{hostSaved=v;},getLocal:()=>profile(id,'房主',2)});
 const member=new ForestLan({now:()=>clock,save:async v=>{memberSaved=v;},getLocal:()=>guest});
 try{
   const created=await host.operate({action:'room-create',roomName:'测试森林'});
   const invite=created.invite.replace(/dshforest:\/\/[^/]+\//,'dshforest://127.0.0.1:'+hostSaved.port+'/');
   await member.operate({action:'room-join',invite});
   assert.equal(host.snapshot().members.length,2);
   assert.equal(member.snapshot().members.find(m=>m.id===other).counts.day,3);
   assert.equal(JSON.stringify(member.snapshot()).includes('auth'),false);
   clock+=120000;
   assert.equal(host.snapshot().members.find(m=>m.id===other).counts.day,0);
   assert.equal(host.snapshot().members.find(m=>m.id===other).counts.week,0);
   assert.equal(host.snapshot().members.find(m=>m.id===other).counts.month,3);
   guest={...guest,total:4,counts:{day:1,week:1,month:4},days:{'2026-11-01':3,'2026-11-02':1}};
   await member.sync();await member.sync();
   assert.equal(host.snapshot().members.find(m=>m.id===other).total,4);
   await host.close();
   await assert.rejects(member.sync());
   assert.equal(member.snapshot().status,'disconnected');
   const restored=new ForestLan({saved:hostSaved,now:()=>clock,save:async v=>{hostSaved=v;},getLocal:()=>profile(id,'房主',2)});
   try{await restored.restore();await member.sync();assert.equal(member.snapshot().status,'connected');
     await member.operate({action:'room-leave'});assert.equal(restored.snapshot().members.length,1);
   }finally{await restored.close();}
   assert.equal(memberSaved.mode,'none');
 }finally{await member.close();await host.close();}
});
test('member 拒绝公网邀请与非法数据',async()=>{
  // Given: 给定隔离成员和临时HTTP房间
  // When: 同步排名或提交非法邀请数据
  // Then: 核对成员状态与地址验证结果

 assert.equal(isPrivateAddress('8.8.8.8'),false);assert.equal(isPrivateAddress('192.168.1.2'),true);
 const room=new ForestLan({save:async()=>{
  // Given: 给定隔离成员和临时HTTP房间
  // When: 同步排名或提交非法邀请数据
  // Then: 核对成员状态与地址验证结果
},getLocal:()=>profile(randomUUID(),'我',0)});
 try{await assert.rejects(room.operate({action:'room-join',invite:'dshforest://8.8.8.8:80/'+randomUUID()+'#'+'a'.repeat(64)}),/private/i);}
 finally{await room.close();}
});
