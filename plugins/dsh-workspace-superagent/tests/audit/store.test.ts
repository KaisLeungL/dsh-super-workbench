import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Worker } from 'node:worker_threads';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { StewardStore, fingerprint } from '../../src/storage/store.js';
import { V1_SCHEMA, APPLICATION_ID } from '../../src/storage/schema.js';
import type { RequestAuditBasis, AuditRequestDescription } from '../../src/storage/types.js';

const identity={instanceId:'e37-component',domainId:'component-domain'};
const pathFor=()=>{const root=process.env.E37_RUN_DIR;assert.ok(root);const dir=join(resolve(root),'db',randomUUID());mkdirSync(dir,{recursive:true});return join(dir,'audit.sqlite');};
function oldDatabase(path: string) {
  const db=new DatabaseSync(path);db.exec(V1_SCHEMA);
  const hash=fingerprint(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name").all());
  db.prepare('INSERT INTO deployment VALUES(1,?,?,1,?)').run(identity.instanceId,identity.domainId,hash);
  db.exec("INSERT INTO manager_instance VALUES(1,5,'stopped',1,'old-session','bound','workspace','preset',0,0,7,2)");
  db.prepare('INSERT INTO policy_revision VALUES(0,?)').run(JSON.stringify({resources:[],audiences:[],mandate:{actions:[],expiresAt:0},proofRef:'old'}));
  db.exec('PRAGMA application_id='+APPLICATION_ID+';PRAGMA user_version=1');
  return db;
}
function prepared() {
  const path=pathFor(),store=StewardStore.initializeFresh(path,identity);
  store.recordLifecycle(store.manager().revision,'running',true);
  const header={version:4,id:'native-session',createdAt:1,isSeeded:false};
  const sessionIdentity=fingerprint({header,inheritedEventCount:0});
  store.registerAuditSession({sessionId:header.id,sessionIdentity,header,inheritedEventCount:0,workspaceId:'workspace',projectionId:'pure-fixture-v4',formatVersion:4,serializer:'e37-json-v1'},()=>true);
  const basis:RequestAuditBasis={basisKey:randomUUID(),sessionId:header.id,sessionIdentity,identity,workspaceId:'workspace',turn:0,step:0,stepOffset:0,messageIds:['user-id'],
    versions:store.manager().versions,leaseFingerprint:'component-current-lease',promptPackageVersion:'frozen-fixture',promptPackageHash:'fixture-package'};
  const key=store.prepareRequestAudit(basis,()=>true);
  const request:AuditRequestDescription={config:{provider:'fixture',model:'model',reasoningEffort:'medium',maxTokens:100},adapterDefaults:{},
    messages:[{id:'system-id',role:'system',content:[{type:'text',text:'系统'}]},{id:'user-id',role:'user',content:[{type:'text',text:'真实输入夹具'}]}],tools:[],toolHistory:{tools:[]}};
  store.bindRequestBoundary(basis.basisKey,{turn:0,step:0,attempt:0,boundaryOffset:3,requestHash:fingerprint(request)},()=>true);
  return{store,path,basis,key,request};
}
test('显式v1迁移保留身份、旧行、停止墓碑；普通open拒v1',()=>{
  const path=pathFor(),db=oldDatabase(path);
  const manager=db.prepare('SELECT * FROM manager_instance').all(),policy=db.prepare('SELECT * FROM policy_revision').all();db.close();
  assert.throws(()=>StewardStore.openExisting(path,identity),/MIGRATION_REQUIRED/);
  assert.equal(StewardStore.migrateV1ToV2(path,identity).migrated,true);
  const verify=new DatabaseSync(path,{readOnly:true});
  assert.deepEqual(verify.prepare('SELECT * FROM manager_instance').all(),manager);
  assert.deepEqual(verify.prepare('SELECT * FROM policy_revision').all(),policy);
  assert.equal(verify.prepare('SELECT instance_id FROM deployment').get()!.instance_id,identity.instanceId);
  assert.equal(verify.prepare('PRAGMA user_version').get()!.user_version,2);verify.close();
  assert.equal(StewardStore.migrateV1ToV2(path,identity).migrated,false);
  const opened=StewardStore.openExisting(path,identity);assert.equal(opened.manager().lifecycle,'stopped');opened.close();
});
test('缺失、错误身份、伪造自洽DDL均不迁移、不fresh',()=>{
  const missing=pathFor();assert.throws(()=>StewardStore.migrateV1ToV2(missing,identity));assert.equal(existsSync(missing),false);
  const path=pathFor(),db=oldDatabase(path);
  assert.throws(()=>StewardStore.migrateV1ToV2(path,{...identity,domainId:'wrong'}),/IDENTITY_MISMATCH/);
  db.exec('CREATE TABLE rogue(id TEXT)');
  const hash=fingerprint(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name").all());
  db.prepare('UPDATE deployment SET schema_hash=?').run(hash);db.close();
  assert.throws(()=>StewardStore.migrateV1ToV2(path,identity),/SCHEMA_SHAPE_MISMATCH/);
  const check=new DatabaseSync(path,{readOnly:true});assert.equal(check.prepare('PRAGMA user_version').get()!.user_version,1);
  assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='native_request_audit'").get()!.n,0);check.close();
});
test('请求basis/边界不可变；snapshot与游标同事务且幂等',()=>{
  const f=prepared(),cursor=f.store.readAuditCursor(f.basis.sessionIdentity);
  assert.throws(()=>f.store.prepareRequestAudit({...f.basis,leaseFingerprint:'changed'},()=>true),/IMMUTABLE_AUDIT_CONFLICT/);
  assert.throws(()=>f.store.bindRequestBoundary(f.basis.basisKey,{turn:0,step:0,attempt:0,boundaryOffset:4,requestHash:'changed'},()=>true),/IMMUTABLE_AUDIT_CONFLICT/);
  assert.throws(()=>f.store.commitRequestAuditBatch(f.basis.sessionIdentity,cursor,{offset:5,prefixHash:'next'},[{key:f.key,settlementSeq:4,eventHash:'event',settlementType:'assistant/message',request:{...f.request,tools:['changed']}}],()=>true),/REQUEST_INPUT_MISMATCH/);
  assert.deepEqual(f.store.readAuditCursor(f.basis.sessionIdentity),cursor);
  const facts=[{key:f.key,settlementSeq:4,eventHash:'native-event-fixture',settlementType:'assistant/message' as const,request:f.request}];
  const evidence=f.store.commitRequestAuditBatch(f.basis.sessionIdentity,cursor,{offset:5,prefixHash:'next'},facts,()=>true)[0]!;
  assert.equal(f.store.readRequestAudit(f.key)!.eligibility,'live');
  f.store.createJob({...evidence,operationKey:'job-op',jobId:'job',kind:'scan',versions:f.basis.versions,budget:{deadlineMs:10,maxTokens:10}});
  const next=f.store.readAuditCursor(f.basis.sessionIdentity);
  assert.equal(f.store.commitRequestAuditBatch(f.basis.sessionIdentity,next,{offset:5,prefixHash:'next'},facts,()=>true).length,0);
  assert.throws(()=>f.store.commitRequestAuditBatch(f.basis.sessionIdentity,cursor,{offset:5,prefixHash:'next'},facts),/AUDIT_CURSOR_CONFLICT/);
  f.store.close();
  const restored=StewardStore.openExisting(f.path,identity);restored.recover();
  assert.throws(()=>restored.createJob({...evidence,operationKey:'cold-op',jobId:'cold-job',kind:'scan',versions:restored.manager().versions,budget:{deadlineMs:10,maxTokens:10}}),/AUDIT_EVIDENCE_NOT_CURRENT/);
  restored.close();
});
test('历史补账仅audit-only；任意inputRef名称不能绕过门禁',()=>{
  const f=prepared(),cursor=f.store.readAuditCursor(f.basis.sessionIdentity);
  const evidence=f.store.commitRequestAuditBatch(f.basis.sessionIdentity,cursor,{offset:5,prefixHash:'next'},[{key:f.key,settlementSeq:4,eventHash:'event',settlementType:'assistant/message',request:f.request}])[0]!;
  assert.equal(f.store.readRequestAudit(f.key)!.eligibility,'audit-only');
  assert.throws(()=>f.store.createJob({...evidence,operationKey:'a',jobId:'a',kind:'scan',versions:f.basis.versions,budget:{deadlineMs:1,maxTokens:1}}),/AUDIT_EVIDENCE_NOT_CURRENT/);
  const arbitrary=f.store.saveInput({ref:'not-a-native-prefix',sourceWatermark:'legacy',headers:{system:'s',developer:'d',user:'u',tools:'[]'}});
  assert.throws(()=>f.store.createJob({...evidence,inputSnapshotRef:arbitrary.ref,inputHash:arbitrary.hash,operationKey:'b',jobId:'b',kind:'scan',versions:f.basis.versions,budget:{deadlineMs:1,maxTokens:1}}),/AUDIT_EVIDENCE_NOT_CURRENT/);
  f.store.close();
});
test('模拟磁盘容量不足拒绝迁移和补账；原行及游标不变',()=>{
 const f=prepared(),cursor=f.store.readAuditCursor(f.basis.sessionIdentity),path=pathFor(),old=oldDatabase(path);
 const manager=old.prepare('SELECT * FROM manager_instance').all();old.close();
 const original=fs.statfsSync;
 try{
  const observed=original(path);fs.statfsSync=(()=>({...observed,bavail:0})) as unknown as typeof fs.statfsSync;syncBuiltinESMExports();
  assert.throws(()=>StewardStore.migrateV1ToV2(path,identity),/CAPACITY_UNHEALTHY/);
  assert.throws(()=>f.store.commitRequestAuditBatch(f.basis.sessionIdentity,cursor,{offset:5,prefixHash:'next'},[{key:f.key,settlementSeq:4,eventHash:'event',settlementType:'assistant/message',request:f.request}],()=>true),/CAPACITY_UNHEALTHY/);
 }finally{fs.statfsSync=original;syncBuiltinESMExports();}
 assert.deepEqual(f.store.readAuditCursor(f.basis.sessionIdentity),cursor);assert.equal(f.store.readRequestAudit(f.key)!.evidence,undefined);
 const check=new DatabaseSync(path,{readOnly:true});assert.equal(check.prepare('PRAGMA user_version').get()!.user_version,1);
 assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='native_request_audit'").get()!.n,0);
 assert.deepEqual(check.prepare('SELECT * FROM manager_instance').all(),manager);check.close();f.store.close();
});
test('两独立SQLite连接并行迁移仅一次应用；原停止状态保留',async()=>{
 const path=pathFor(),db=oldDatabase(path),before=db.prepare('SELECT * FROM manager_instance').all();db.close();
 const workers:Worker[]=[],ready:Promise<void>[]=[],results:Promise<{migrated:boolean}>[]=[];
 try{
  for(let i=0;i<2;i++){
   const worker=new Worker(`const{parentPort,workerData:d}=require('node:worker_threads');(async()=>{const{StewardStore}=await import(d.url);parentPort.postMessage({ready:true});parentPort.once('message',()=>{try{parentPort.postMessage({result:StewardStore.migrateV1ToV2(d.path,d.identity)});}catch(error){parentPort.postMessage({error:String(error)});}parentPort.close();});})();`,{eval:true,workerData:{url:new URL('../../src/storage/store.js',import.meta.url).href,path,identity}});
   workers.push(worker);
   ready.push(new Promise((resolve,reject)=>{worker.on('message',m=>{if(m.ready)resolve();});worker.on('error',reject);}));
   results.push(new Promise((resolve,reject)=>{worker.on('message',m=>{if(m.result)resolve(m.result);if(m.error)reject(Error(m.error));});worker.on('error',reject);}));
  }
  await Promise.all(ready);workers.forEach(w=>w.postMessage('go'));const values=await Promise.all(results);
  assert.deepEqual(values.map(v=>v.migrated).sort(),[false,true]);
  const check=new DatabaseSync(path,{readOnly:true});assert.deepEqual(check.prepare('SELECT * FROM manager_instance').all(),before);assert.equal(check.prepare('PRAGMA user_version').get()!.user_version,2);check.close();
 }finally{await Promise.all(workers.map(w=>w.terminate()));}
});
