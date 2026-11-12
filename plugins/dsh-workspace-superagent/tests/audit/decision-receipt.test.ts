import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { StewardStore, fingerprint } from '../../src/storage/store.js';
import type { Evidence, EvalRequest, EffectRequest, JobRequest } from '../../src/storage/types.js';

// 可信审计窄口组件夹具；不是实际 Host、模型调用或耐久证明。
function fixture() {
  const dir=join(resolve(process.env.E37_RUN_DIR!),'decision-receipt',randomUUID()); mkdirSync(dir,{recursive:true});
  const path=join(dir,'authority.sqlite'),identity={instanceId:randomUUID(),domainId:'decision-receipt'};
  let store=StewardStore.initializeFresh(path,identity);
  store.registerResource('R',{workspaceId:'workspace'}); store.registerSource('S','component/source','R');
  store.recordLifecycle(store.manager().revision,'running',true);
  store.recordVerifiedActor('actor','proof',{source:'native',externalId:'human'});
  const probe=new DatabaseSync(path,{readOnly:true});
  const state=()=>({
    tables:Object.fromEntries(probe.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>[String(r.name),probe.prepare('SELECT * FROM "'+String(r.name)+'" ORDER BY rowid').all()])),
    dataVersion:probe.prepare('PRAGMA data_version').get(),
    manager:store.manager(),source:store.source('S'),
  });
  const fresh=(live=true):Evidence=>{
    const header={version:4,id:randomUUID(),createdAt:1,isSeeded:false},sid=fingerprint({header,inheritedEventCount:0});
    store.registerAuditSession({sessionId:header.id,sessionIdentity:sid,header,inheritedEventCount:0,workspaceId:'workspace',projectionId:'pure-fixture-v4',formatVersion:4,serializer:'e37-json-v1'},()=>true);
    const basis={basisKey:randomUUID(),sessionId:header.id,sessionIdentity:sid,identity,workspaceId:'workspace',turn:0,step:0,stepOffset:0,messageIds:['u'],versions:store.manager().versions,leaseFingerprint:'lease',promptPackageVersion:'v',promptPackageHash:'p'};
    const key=store.prepareRequestAudit(basis,()=>true),request={config:{provider:'fixture',model:'m',maxTokens:100},adapterDefaults:{},messages:[{id:'u',role:'user',content:[{type:'text',text:'历史决定组件输入'}]}],tools:[],toolHistory:{tools:[]}};
    store.bindRequestBoundary(basis.basisKey,{turn:0,step:0,attempt:0,boundaryOffset:0,requestHash:fingerprint(request)},()=>true);
    return store.commitRequestAuditBatch(sid,store.readAuditCursor(sid),{offset:1,prefixHash:'fixed'},[{key,settlementSeq:0,eventHash:'event',settlementType:'assistant/message',request}],live?()=>true:undefined)[0]!;
  };
  const decision=(evidence:Evidence,id='D1',supersedesId?:string)=>({...evidence,id,actorId:'actor',sourceMessageRef:'native-message',expectedIntent:store.manager().versions.intentRevision,policyVersion:store.manager().versions.policyVersion,scopeVersion:store.manager().versions.scopeVersion,stopEpoch:store.manager().versions.stopEpoch,...(supersedesId===undefined?{}:{supersedesId}),decision:'组件决定'});
  const cold=(recover=true)=>{store.close();store=StewardStore.openExisting(path,identity);if(recover)store.recover();};
  const close=()=>{probe.close();store.close();};
  return{get store(){return store;},path,identity,state,fresh,decision,cold,close};
}
test('E37.1 最小反例：完整相同D1返回原revision且全部账本零变化',()=>{
  const f=fixture();
  try {
    const d1=f.decision(f.fresh()); assert.equal(f.store.appendDecision(d1),1);
    const before=f.state();
    assert.equal(f.store.appendDecision(d1),1);
    assert.deepEqual(f.state(),before);
  } finally { f.close(); }
});
test('E37.1 同id任一完整payload字段变化均拒绝且零写入',()=>{
  const f=fixture();
  try {
    const d1=f.decision(f.fresh()); f.store.appendDecision(d1);
    const changes:Record<string,unknown>[]=[
      {decision:'变正文'},{actorId:'other-actor'},{sourceMessageRef:'other-message'},
      {inputSnapshotRef:'other-input'},{inputHash:'other-hash'},{expectedIntent:1},
      {policyVersion:1},{scopeVersion:1},{stopEpoch:1},{supersedesId:'other-decision'},
      {backend:'other'},{provider:'other'},{model:'other'},{effort:'other'},{maxTokens:101},
      {promptPackageVersion:'other'},{promptPackageHash:'other'},{extraTarget:'other'},
    ];
    const before=f.state();
    for(const change of changes) {
      assert.throws(()=>f.store.appendDecision({...d1,...change} as typeof d1),/DECISION_CONFLICT/);
      assert.deepEqual(f.state(),before);
    }
  } finally { f.close(); }
});
for(const mode of ['paused','stopped','open-pending','cold','cold-stopped','cold-running'] as const)
test('E37.1 '+mode+'仅返回历史D1；新决定和其它消费均拒绝且账本不变',()=>{
  const f=fixture();
  try {
    const evidence=f.fresh(),d1=f.decision(evidence); f.store.appendDecision(d1);
    if(mode==='paused')f.store.recordLifecycle(f.store.manager().revision,'paused',true);
    if(mode==='stopped'||mode==='cold-stopped')f.store.stop(f.store.manager().revision,'explicit-stop');
    if(mode.startsWith('cold')||mode==='open-pending')f.cold(mode!=='open-pending');
    if(mode==='cold-running')f.store.recordLifecycle(f.store.manager().revision,'running',true);
    const before=f.state();
    assert.equal(f.store.appendDecision(d1),1);
    assert.throws(()=>f.store.appendDecision(f.decision(evidence,'D2','D1')),/AUDIT_EVIDENCE_NOT_CURRENT/);
    const versions=f.store.manager().versions;
    const evaluation:EvalRequest={...evidence,evalId:'eval',versions,candidates:[{triggerId:'t',externalEventId:'e',triggerRevision:1,resourceId:'R',threadKey:'thread',body:'请求',neighbors:[],payloadRef:evidence.inputSnapshotRef,payloadHash:evidence.inputHash}],control:false,queuedAt:0};
    const job:JobRequest={...evidence,operationKey:'job',jobId:'job',kind:'scan',versions,budget:{deadlineMs:100,maxTokens:10}};
    const effect:EffectRequest={...evidence,effectKey:'effect',operationKey:'effect',boardTaskId:'task',destination:'lab',purpose:'ack',payload:'不外发',requestId:'effect',audience:'lab',versions};
    assert.throws(()=>f.store.acceptEval('S',f.store.source('S').revision,'next',evaluation),/AUDIT_EVIDENCE_NOT_CURRENT/);
    assert.throws(()=>f.store.createJob(job),/AUDIT_EVIDENCE_NOT_CURRENT/);
    assert.throws(()=>f.store.enqueueEffect(effect),/AUDIT_EVIDENCE_NOT_CURRENT/);
    assert.deepEqual(f.state(),before);
  } finally { f.close(); }
});
for(const damage of ['missing','hash','body','bytes','ref','revision'] as const)
test('E37.1 历史输入或决定记录损坏拒绝回执：'+damage,()=>{
  const f=fixture();
  try {
    const d1=f.decision(f.fresh()); f.store.appendDecision(d1);
    // 仅故障注入破坏已提交账本；不伪造或授予 live 资格。
    const db=new DatabaseSync(f.path);
    try {
      db.exec('PRAGMA foreign_keys=OFF');
      if(damage==='missing')db.prepare('DELETE FROM input_snapshot WHERE ref=?').run(d1.inputSnapshotRef);
      if(damage==='hash')db.prepare("UPDATE input_snapshot SET hash='changed' WHERE ref=?").run(d1.inputSnapshotRef);
      if(damage==='body')db.prepare("UPDATE input_snapshot SET body=json_set(body,'$.headers.user','changed') WHERE ref=?").run(d1.inputSnapshotRef);
      if(damage==='bytes')db.prepare('UPDATE input_snapshot SET bytes=bytes+1 WHERE ref=?').run(d1.inputSnapshotRef);
      if(damage==='ref')db.prepare("UPDATE input_snapshot SET body=json_set(body,'$.ref','changed') WHERE ref=?").run(d1.inputSnapshotRef);
      if(damage==='revision')db.prepare("UPDATE business_decision SET intent_revision=7 WHERE id='D1'").run();
    } finally { db.close(); }
    const before=f.state();
    assert.throws(()=>f.store.appendDecision(d1),damage==='revision'?/DECISION_CONFLICT/:/INPUT_BINDING_MISMATCH|CORRUPT_INPUT/);
    assert.deepEqual(f.state(),before);
    if(damage!=='revision')assert.throws(()=>StewardStore.openExisting(f.path,f.identity),/CORRUPT_REFERENCES|CORRUPT_INPUT|MISSING_INPUT_LEDGER|CORRUPT_AUDIT/);
    assert.deepEqual(f.state(),before);
  } finally { f.close(); }
});
test('E37.1 旧D1回执不授信；意图1新审计且显式supersedes才可写D2',()=>{
  const f=fixture();
  try {
    const evidence=f.fresh(),d1=f.decision(evidence); f.store.appendDecision(d1);
    const before=f.state();
    assert.equal(f.store.appendDecision(d1),1);
    assert.throws(()=>f.store.appendDecision(f.decision(evidence,'D2','D1')),/AUDIT_EVIDENCE_NOT_CURRENT/);
    assert.deepEqual(f.state(),before);
    const fresh=f.fresh(),d2=f.decision(fresh,'D2','D1'),current=f.state();
    const {supersedesId:_supersedes,...missingSupersedes}=d2;
    for(const invalid of [missingSupersedes,{...d2,supersedesId:'wrong'}])
      assert.throws(()=>f.store.appendDecision(invalid),/EXPLICIT_SUPERSESSION_REQUIRED/);
    for(const invalid of [{...d2,actorId:'unverified'},{...d2,sourceMessageRef:''}])
      assert.throws(()=>f.store.appendDecision(invalid),/DECISION_CONFLICT/);
    for(const invalid of [{...d2,expectedIntent:0},{...d2,policyVersion:1},{...d2,scopeVersion:1},{...d2,stopEpoch:1}])
      assert.throws(()=>f.store.appendDecision(invalid),/VERSION_CONFLICT/);
    assert.deepEqual(f.state(),current);
    assert.equal(f.store.appendDecision(d2),2);
    const after=f.state();
    assert.equal(after.manager.versions.intentRevision,2);
    assert.equal(after.manager.revision,current.manager.revision+1);
    for(const name of Object.keys(current.tables))if(!['manager_instance','business_decision','audit','sqlite_sequence'].includes(name))
      assert.deepEqual(after.tables[name],current.tables[name]);
    assert.deepEqual(after.tables.sqlite_sequence!.map(row=>({...row})),current.tables.sqlite_sequence!.map(row=>({...row,...(row.name==='audit'?{seq:Number(row.seq)+1}:{})})));
    assert.equal(after.tables.business_decision!.length,current.tables.business_decision!.length+1);
    assert.equal(after.tables.audit!.length,current.tables.audit!.length+1);
    assert.equal(f.store.appendDecision(d1),1); assert.equal(f.store.appendDecision(d2),2);
    assert.deepEqual(f.state(),after);
  } finally { f.close(); }
});
for(const mode of ['audit-only','legacy'] as const)test('E37.1 新id仍拒绝'+mode+'输入，零状态变化',()=>{
  const f=fixture();
  try {
    let evidence=f.fresh(false);
    if(mode==='legacy') {
      const saved=f.store.saveInput({ref:'legacy',sourceWatermark:'legacy',headers:{system:'s',developer:'d',user:'u',tools:'[]'}});
      evidence={...evidence,inputSnapshotRef:saved.ref,inputHash:saved.hash};
    }
    const before=f.state();
    assert.throws(()=>f.store.appendDecision(f.decision(evidence)),/AUDIT_EVIDENCE_NOT_CURRENT/);
    assert.deepEqual(f.state(),before);
  } finally { f.close(); }
});
