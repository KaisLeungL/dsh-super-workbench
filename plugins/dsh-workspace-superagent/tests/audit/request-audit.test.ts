import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { StewardStore, fingerprint } from '../../src/storage/store.js';
import { RequestAuditor, type AuditLogEvent, type PassiveSessionPersistence } from '../../src/sessions/request-audit.js';
import type { RequestAuditBasis, AuditRequestDescription } from '../../src/storage/types.js';

// 此文件验证审计编排/SQLite，不把内存日志夹具声明成真实Host或durability证据。
function fixture(events: AuditLogEvent[]) {
 const dir=join(resolve(process.env.E37_RUN_DIR!),'audit-components',randomUUID());mkdirSync(dir,{recursive:true});
 const identity={instanceId:randomUUID(),domainId:'audit-component'},store=StewardStore.initializeFresh(join(dir,'audit.sqlite'),identity);
 store.recordLifecycle(store.manager().revision,'running',true);
 const header={version:4,id:randomUUID(),createdAt:1,isSeeded:false};
 let persistenceIdentity=Symbol('fixture');
  let current=true,projectionError=false,hook:((phase:string)=>void)|undefined;
 const reads:{offset:number,length:number}[]=[];
 const persistence:PassiveSessionPersistence={get identity(){return persistenceIdentity;},
  async stat(){hook?.('stat');return{header,eventCount:events.length};},
  async open(){hook?.('open');return{header,inheritedEventCount:0,
   async read(offset=0,length=256){reads.push({offset,length});const value=structuredClone(events.slice(offset,offset+length));hook?.('read');return{events:value,eventState:'detached' as const};},
   async close(){hook?.('close');}};}};
 const request:AuditRequestDescription={config:{provider:'fixture',model:'m',maxTokens:100},adapterDefaults:{},messages:[{id:'input',role:'user',content:[{type:'text',text:'输入'}]}],tools:[],toolHistory:{tools:[]}};
 const auditor=new RequestAuditor(store,persistence,{id:'fixture-pure-v4',validate(log){assert.ok(log.every((e,i)=>e.seq===i));},describe(){if(projectionError)throw Error('PURE_PROJECTION_MISSING');return request;}},()=>{assert.ok(current,'PORT_CHANGED');});
 const sid=auditor.register({id:header.id,header,inheritedEventCount:0},'workspace',()=>true);
 const prepare=(boundary:number,turn=7)=>{
  const basis:RequestAuditBasis={basisKey:randomUUID(),sessionId:header.id,sessionIdentity:sid,identity,workspaceId:'workspace',turn,step:0,stepOffset:0,messageIds:['input'],versions:store.manager().versions,leaseFingerprint:'fixture',promptPackageVersion:'v',promptPackageHash:'h'};
  const key=store.prepareRequestAudit(basis,()=>true);
  store.bindRequestBoundary(basis.basisKey,{turn,step:0,attempt:0,boundaryOffset:boundary,requestHash:fingerprint(request)},()=>true);return{key,basis};
 };
 return{store,auditor,sid,request,prepare,reads,events,header,replacePersistence:()=>{persistenceIdentity=Symbol('replacement');},projectionUnavailable:()=>{projectionError=true;},setHook:(h:typeof hook)=>{hook=h;},change:()=>{current=false;}};
}
const log=(n:number):AuditLogEvent[]=>Array.from({length:n},(_,seq)=>({type:'fixture',seq,data:{}}));
const settlement=(seq:number,turn:number):AuditLogEvent=>({type:'assistant/message',seq,data:{turn,step:0}});
test('5000条历史、300条孤立settlement后仍可补新合法请求；固定目标且每次read不超过256',async()=>{
 const events=log(5000);for(let i=0;i<300;i++)events[i]=settlement(i,100+i);
 events.push(settlement(5000,7));const f=fixture(events),p=f.prepare(4999);
 let appended=false;f.setHook(phase=>{if(phase==='read'&&!appended){appended=true;events.push(settlement(5001,999));}});
 const result=await f.auditor.reconcile(f.sid,new AbortController().signal,events.length,()=>true);
 assert.equal(result.length,1);assert.equal(f.store.readRequestAudit(p.key)!.eligibility,'live');
 assert.equal(f.store.readAuditCursor(f.sid).offset,5001);
 assert.ok(f.reads.every(r=>r.length<=256));assert.equal(f.store.pendingRequestAudits(f.sid).length,0);
 await f.auditor.reconcile(f.sid,new AbortController().signal,f.events.length);
 assert.equal(f.store.readAuditCursor(f.sid).offset,5002);
 const stable=f.store.readAuditCursor(f.sid);assert.equal((await f.auditor.reconcile(f.sid,new AbortController().signal,f.events.length)).length,0);assert.deepEqual(f.store.readAuditCursor(f.sid),stable);
 f.store.close();
});
test('跨256边界的prepared在后批settlement到达前不误降unknown',async()=>{
 const events=log(260);events[257]=settlement(257,7);const f=fixture(events),p=f.prepare(255);
 assert.equal((await f.auditor.reconcile(f.sid,new AbortController().signal,events.length,()=>true)).length,1);
 assert.equal(f.store.readRequestAudit(p.key)!.eligibility,'live');f.store.close();
});
for(const phase of ['open','read','close'])test('await '+phase+'期间换端口即拒且不推进',async()=>{
 const f=fixture([settlement(0,7)]);f.prepare(0);const before=f.store.readAuditCursor(f.sid);f.setHook(value=>{if(value===phase)f.change();});
 await assert.rejects(f.auditor.reconcile(f.sid,new AbortController().signal,f.events.length),/PORT_CHANGED/);
 assert.deepEqual(f.store.readAuditCursor(f.sid),before);f.store.close();
});
test('已验前缀缩短或改写拒绝且水位不变',async()=>{
 const f=fixture(log(300));await f.auditor.reconcile(f.sid,new AbortController().signal,f.events.length);const before=f.store.readAuditCursor(f.sid);
 f.events[0]={type:'fixture',seq:0,data:{changed:true}};
 await assert.rejects(f.auditor.reconcile(f.sid,new AbortController().signal,f.events.length),/AUDIT_PREFIX_CONFLICT/);assert.deepEqual(f.store.readAuditCursor(f.sid),before);
 f.events.length=299;await assert.rejects(f.auditor.reconcile(f.sid,new AbortController().signal,f.events.length),/AUDIT_LOG_BOUND_UNKNOWN/);assert.deepEqual(f.store.readAuditCursor(f.sid),before);f.store.close();
});
test('同turn/step重复边界保持歧义；无snapshot且未知不等审计完整',async()=>{
 const f=fixture([settlement(0,7)]),a=f.prepare(0),b=f.prepare(0);
 assert.equal((await f.auditor.reconcile(f.sid,new AbortController().signal,1,()=>true)).length,0);
 for(const key of[a.key,b.key]){const row=f.store.readRequestAudit(key)!;assert.equal(row.state,'unknown');assert.equal(row.reason,'REQUEST_SETTLEMENT_AMBIGUOUS');assert.equal(row.evidence,undefined);}
 assert.equal(f.store.readHealthSummary(1).audit.status,'pending');f.store.close();
});
test('相同header retry按逐次边界独立绑定；失败attempt不授live',async()=>{
 const first={...settlement(0,7),type:'assistant/attempt'},f=fixture([first,settlement(1,7)]),p=f.prepare(0);
 const retry=f.store.bindRequestBoundary(p.basis.basisKey,{turn:7,step:0,attempt:1,boundaryOffset:1,requestHash:fingerprint(f.request)},()=>true);
 assert.equal((await f.auditor.reconcile(f.sid,new AbortController().signal,2,()=>true)).length,2);
 assert.equal(f.store.readRequestAudit(p.key)!.eligibility,'audit-only');assert.equal(f.store.readRequestAudit(retry)!.eligibility,'live');
 assert.notEqual(f.store.readRequestAudit(p.key)!.evidence!.inputSnapshotRef,f.store.readRequestAudit(retry)!.evidence!.inputSnapshotRef);f.store.close();
});
for(const kind of['projection','message-id','hash'])test('缺纯projection/输入或hash不符只保留未知：'+kind,async()=>{
 const f=fixture([settlement(0,7)]);
 if(kind==='message-id')f.request.messages=[];
 const p=f.prepare(0);
 if(kind==='projection')f.projectionUnavailable();
 if(kind==='hash')f.request.config.model='changed';
 assert.equal((await f.auditor.reconcile(f.sid,new AbortController().signal,1,()=>true)).length,0);
 const row=f.store.readRequestAudit(p.key)!;assert.equal(row.state,'unknown');assert.equal(row.evidence,undefined);
 assert.equal(row.reason,kind==='projection'?'REQUEST_PROJECTION_UNAVAILABLE':'REQUEST_INPUT_MISMATCH');
 assert.equal(f.store.readAuditCursor(f.sid).offset,1);f.store.close();
});
test('两补账调用并发只一次提交；旧CAS拒且重试幂等',async()=>{
 const f=fixture([settlement(0,7)]),p=f.prepare(0);
 const results=await Promise.allSettled([f.auditor.reconcile(f.sid,new AbortController().signal,1,()=>true),f.auditor.reconcile(f.sid,new AbortController().signal,1,()=>true)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.match(String(rejected.reason),/AUDIT_CURSOR_CONFLICT/);
 const before=f.store.readAuditCursor(f.sid);assert.equal((await f.auditor.reconcile(f.sid,new AbortController().signal,1,()=>true)).length,0);
 assert.deepEqual(f.store.readAuditCursor(f.sid),before);assert.equal(f.store.readRequestAudit(p.key)!.state,'verified');f.store.close();
});
test('256个有basis未知不堵住keyset下一页合法请求；prepared容量仍有界',async()=>{
 const f=fixture(log(1));for(let i=0;i<256;i++)f.prepare(0,100+i);
 assert.throws(()=>f.prepare(0,999),/AUDIT_PREPARED_CAPACITY/);
 await f.auditor.reconcile(f.sid,new AbortController().signal,1);
 f.events.push(settlement(1,7));const p=f.prepare(1);
 assert.equal((await f.auditor.reconcile(f.sid,new AbortController().signal,2,()=>true)).length,1);
 assert.equal(f.store.readRequestAudit(p.key)!.eligibility,'live');f.store.close();
});
test('创建身份改变拒绝且游标不变',async()=>{
 const f=fixture([settlement(0,7)]);f.prepare(0);const before=f.store.readAuditCursor(f.sid);f.header.createdAt=2;
 await assert.rejects(f.auditor.reconcile(f.sid,new AbortController().signal,1),/AUDIT_SESSION_CONFLICT/);
 assert.deepEqual(f.store.readAuditCursor(f.sid),before);f.store.close();
});
test('read await期间取消拒绝且游标不变',async()=>{
 const f=fixture([settlement(0,7)]);f.prepare(0);const before=f.store.readAuditCursor(f.sid),controller=new AbortController();
 f.setHook(phase=>{if(phase==='read')controller.abort(Error('CANCELLED'));});
 await assert.rejects(f.auditor.reconcile(f.sid,controller.signal,1),/CANCELLED/);assert.deepEqual(f.store.readAuditCursor(f.sid),before);f.store.close();
});
for(const phase of['open','read','close'])test('冷读公开persistence identity在await换代拒绝：'+phase,async()=>{
 const f=fixture([settlement(0,7)]),p=f.prepare(0),before=f.store.readAuditCursor(f.sid);
 f.setHook(value=>{if(value===phase)f.replacePersistence();});
 await assert.rejects(f.auditor.reconcileCold(f.sid,new AbortController().signal,()=>{}),/AUDIT_PERSISTENCE_CHANGED/);
 assert.deepEqual(f.store.readAuditCursor(f.sid),before);assert.equal(f.store.readRequestAudit(p.key)!.evidence,undefined);
 assert.equal(f.store.readRequestAudit(p.key)!.state,'prepared');const db=new DatabaseSync(f.store.path,{readOnly:true});assert.equal(db.prepare('SELECT count(*) AS n FROM input_snapshot').get()!.n,0);db.close();f.store.close();
});
test('公开identity不变的冷读正例仅补audit-only且重试幂等',async()=>{
 const f=fixture([settlement(0,7)]),p=f.prepare(0);
 assert.equal((await f.auditor.reconcileCold(f.sid,new AbortController().signal,()=>{})).length,1);
 assert.equal(f.store.readRequestAudit(p.key)!.eligibility,'audit-only');
 const before=f.store.readAuditCursor(f.sid);assert.equal((await f.auditor.reconcileCold(f.sid,new AbortController().signal,()=>{})).length,0);
 assert.deepEqual(f.store.readAuditCursor(f.sid),before);f.store.close();
});
for(const phase of['open','read','close'])test('冷读每await重核隔离上下文：'+phase,async()=>{
 const f=fixture([settlement(0,7)]);f.prepare(0);const before=f.store.readAuditCursor(f.sid);let isolated=true;
 f.setHook(value=>{if(value===phase)isolated=false;});
 await assert.rejects(f.auditor.reconcileCold(f.sid,new AbortController().signal,()=>{assert.ok(isolated,'COLD_CONTEXT_CHANGED');}),/COLD_CONTEXT_CHANGED/);
 assert.deepEqual(f.store.readAuditCursor(f.sid),before);f.store.close();
});
