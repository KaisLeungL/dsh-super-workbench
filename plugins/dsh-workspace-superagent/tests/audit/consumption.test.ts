import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { StewardStore, fingerprint } from '../../src/storage/store.js';
import type { Evidence, EvalRequest, EffectRequest, JobRequest } from '../../src/storage/types.js';

// 可信新存储窄口的组件测试；不把夹具授信声明成实际Host或供应商证据。
function fixture(mode: 'live'|'audit-only'|'unknown'|'legacy') {
 const dir=join(resolve(process.env.E37_RUN_DIR!),'consumption',randomUUID());mkdirSync(dir,{recursive:true});
 const path=dir+'/authority.sqlite',identity={instanceId:randomUUID(),domainId:'consumption'},store=StewardStore.initializeFresh(path,identity);
 store.registerResource('R',{workspaceId:'workspace'});store.registerSource('S','component/source','R');
 store.appendPolicy(0,{resources:['R'],audiences:['lab'],mandate:{actions:['read'],expiresAt:9999999999999},proofRef:'component'});
 store.recordLifecycle(store.manager().revision,'running',true);store.recordVerifiedActor('actor','proof',{source:'native',externalId:'human'});
 const header={version:4,id:randomUUID(),createdAt:1,isSeeded:false},sid=fingerprint({header,inheritedEventCount:0});
 store.registerAuditSession({sessionId:header.id,sessionIdentity:sid,header,inheritedEventCount:0,workspaceId:'workspace',projectionId:'pure-fixture-v4',formatVersion:4,serializer:'e37-json-v1'},()=>true);
 const basis={basisKey:randomUUID(),sessionId:header.id,sessionIdentity:sid,identity,workspaceId:'workspace',turn:0,step:0,stepOffset:0,messageIds:['u'],versions:store.manager().versions,leaseFingerprint:'lease',promptPackageVersion:'v',promptPackageHash:'p'};
 const key=store.prepareRequestAudit(basis,()=>true),request={config:{provider:'fixture',model:'m',maxTokens:100},adapterDefaults:{},messages:[{id:'u',role:'user',content:[{type:'text',text:'输入'}]}],tools:[],toolHistory:{tools:[]}};
 store.bindRequestBoundary(basis.basisKey,{turn:0,step:0,attempt:0,boundaryOffset:0,requestHash:fingerprint(request)},()=>true);
 let evidence: Evidence;
 if(mode==='live'||mode==='audit-only')evidence=store.commitRequestAuditBatch(sid,store.readAuditCursor(sid),{offset:1,prefixHash:'fixed'},[{key,settlementSeq:0,eventHash:'event',settlementType:'assistant/message',request}],mode==='live'?()=>true:undefined)[0]!;
 else{
  if(mode==='unknown')store.commitRequestAuditBatch(sid,store.readAuditCursor(sid),{offset:1,prefixHash:'fixed'},[{key,reason:'REQUEST_SETTLEMENT_UNKNOWN'}]);
  const snapshot=store.saveInput({ref:'arbitrary-input-name',sourceWatermark:'legacy',headers:{system:'s',developer:'d',user:'u',tools:'[]'}});
  evidence={backend:'native',provider:'fixture',model:'m',effort:'not-configured',maxTokens:100,promptPackageVersion:'v',promptPackageHash:'p',inputSnapshotRef:snapshot.ref,inputHash:snapshot.hash};
 }
 const evaluation=(id='eval'):EvalRequest=>({...evidence,evalId:id,versions:store.manager().versions,candidates:[{triggerId:id+'-t',externalEventId:id+'-e',triggerRevision:1,resourceId:'R',threadKey:'thread',body:'请求',neighbors:[],payloadRef:evidence.inputSnapshotRef,payloadHash:evidence.inputHash}],control:false,queuedAt:0});
 const effect=(id='effect'):EffectRequest=>({...evidence,effectKey:id,operationKey:id,boardTaskId:'task',destination:'lab',purpose:'ack',payload:'不外发',requestId:id,audience:'lab',versions:store.manager().versions});
 const job=(id='job'):JobRequest=>({...evidence,operationKey:id,jobId:id,kind:'scan',versions:store.manager().versions,budget:{deadlineMs:100,maxTokens:10}});
 const decision=(id='decision')=>({...evidence,id,actorId:'actor',sourceMessageRef:'native-message',expectedIntent:store.manager().versions.intentRevision,...store.manager().versions,decision:'组件决定'});
 const counts=()=>{const db=new DatabaseSync(path,{readOnly:true});try{return Object.fromEntries(['eval','internal_job','effect','business_decision'].map(t=>[t,db.prepare('SELECT count(*) AS n FROM '+t).get()!.n]));}finally{db.close();}};
 return{store,evidence,evaluation,effect,job,decision,counts};
}
const entries=['acceptEval','createJob','appendDecision','enqueueEffect'] as const;
function consume(f:ReturnType<typeof fixture>,entry:typeof entries[number]) {
 if(entry==='acceptEval')f.store.acceptEval('S',f.store.source('S').revision,'next',f.evaluation());
 if(entry==='createJob')f.store.createJob(f.job());
 if(entry==='appendDecision')f.store.appendDecision(f.decision());
 if(entry==='enqueueEffect')f.store.enqueueEffect(f.effect());
}
for(const mode of['audit-only','unknown','legacy'] as const)test(mode+'在Eval/Job/决定/效果真实公共入口均拒绝且不推进',()=>{
 const f=fixture(mode),before=f.counts(),manager=f.store.manager(),source=f.store.source('S');
 for(const entry of entries)assert.throws(()=>consume(f,entry),/AUDIT_EVIDENCE_NOT_CURRENT/);
 assert.deepEqual(f.counts(),before);assert.deepEqual(f.store.manager(),manager);assert.deepEqual(f.store.source('S'),source);f.store.close();
});
for(const entry of entries)test('当前已核审计输入通过公共入口：'+entry,()=>{
 const f=fixture('live');assert.doesNotThrow(()=>consume(f,entry));assert.equal(Object.values(f.counts()).reduce<number>((sum,n)=>sum+Number(n),0),1);f.store.close();
});
for(const change of['paused','revoked','stopped'] as const)test(change+'后旧依据不能领取或重复消费；迟到回执仅留审计',()=>{
 const f=fixture('live'),store=f.store;
 store.acceptEval('S',store.source('S').revision,'queued',f.evaluation());store.createJob(f.job());const queued=store.enqueueEffect(f.effect());
 store.createJob(f.job('claimed-job'));const job=store.claimJob('claimed-job',0,()=>true)!;
 const sent=store.enqueueEffect({...f.effect('claimed-effect'),destination:'other-lab'}),effect=store.claimEffect('claimed-effect',sent.seq,1,()=>true)!;
 if(change==='paused')store.recordLifecycle(store.manager().revision,'paused',true);
 if(change==='revoked')store.appendPolicy(store.manager().versions.policyVersion,{resources:[],audiences:[],mandate:{actions:[],expiresAt:0},proofRef:'revoked'});
 if(change==='stopped')store.stop(store.manager().revision,'explicit-stop');
 const before=f.counts(),manager=store.manager(),source=store.source('S');
 for(const entry of entries)assert.throws(()=>consume(f,entry),/AUDIT_EVIDENCE_NOT_CURRENT/);
 assert.throws(()=>store.claimJob('job',1,()=>true),/AUDIT_EVIDENCE_NOT_CURRENT|RECOVERY_OR_STOPPED/);
 assert.throws(()=>store.claimEffect('effect',queued.seq,1,()=>true),/AUDIT_EVIDENCE_NOT_CURRENT|RECOVERY_OR_STOPPED/);
 assert.throws(()=>store.beginEval('eval',0,1),/AUDIT_EVIDENCE_NOT_CURRENT|RECOVERY_OR_STOPPED/);
 assert.deepEqual(f.counts(),before);assert.deepEqual(store.manager(),manager);assert.deepEqual(store.source('S'),source);
 assert.equal(store.recordEffectReceipt(effect,{nativeLogRef:'late-native',accepted:true}),false);
 assert.equal(store.completeJob(job,{resultRef:'late-result',hash:'hash',nativeReceiptRef:'late-native'},1),false);
 assert.equal(store.effectState('claimed-effect',1)!.state,'unknown');
 assert.notEqual(store.jobState('claimed-job')!.state,'completed');assert.deepEqual(store.manager(),manager);f.store.close();
});
