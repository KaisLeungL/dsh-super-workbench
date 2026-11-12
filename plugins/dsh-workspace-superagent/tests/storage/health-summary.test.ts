import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { StewardStore } from '../../src/storage/store.js';
const fixture=()=>{assert.ok(process.env.E37_RUN_DIR);const dir=join(resolve(process.env.E37_RUN_DIR!),randomUUID());mkdirSync(dir,{recursive:true});const path=join(dir,'health.sqlite');return{path,store:StewardStore.initializeFresh(path,{instanceId:'health',domainId:'health-domain'})};};
test('健康只读快照不将空审计升级为完整；无正文/政策泄露',()=>{
 const f=fixture(),db=new DatabaseSync(f.path,{readOnly:true});
 const before=db.prepare('SELECT * FROM manager_instance').all(),audit=db.prepare('SELECT * FROM audit').all();
 const result=f.store.readHealthSummary(123);
 assert.equal(result.sampledAt,123);assert.equal(result.manager.lifecycle,'paused');
 assert.equal(result.audit.status,'pending');assert.equal(result.audit.pending,0);assert.deepEqual(result.audit.verifiedScope,[]);
 assert.equal(result.queues.normal.items,0);assert.equal(result.queues.normal.oldestQueuedAt,null);
 assert.equal(result.capacity.artifactIndexedBytes,0);assert.equal(typeof result.capacity.observedAt,'number');
 assert.deepEqual(db.prepare('SELECT * FROM manager_instance').all(),before);assert.deepEqual(db.prepare('SELECT * FROM audit').all(),audit);
 assert.ok(!JSON.stringify(result).includes('proofRef'));db.close();f.store.close();
});
test('非有限采样时间拒绝，不写状态',()=>{
 const f=fixture();for(const n of [NaN,Infinity,-Infinity])assert.throws(()=>f.store.readHealthSummary(n),/INVALID_TIME/);f.store.close();
});
test('异常超限仅白名单截断，状态聚合和容量索引仍准确',()=>{
 const f=fixture(),db=new DatabaseSync(f.path);
 db.exec('BEGIN');
 const evalInsert=db.prepare("INSERT INTO eval VALUES(?,0,'queued',0,100,10,0,NULL,NULL,60000,?,NULL)");
 for(let n=0;n<289;n++)evalInsert.run('eval-'+n,JSON.stringify({candidates:[{threadKey:'thread-'+n}],secret:'不得外露'}));
 const jobInsert=db.prepare("INSERT INTO internal_job VALUES(?,?,'hash','running',1,0,0,10,?)");
 for(let n=0;n<3;n++)jobInsert.run('job-'+n,'op-'+n,JSON.stringify({budget:{deadlineMs:120000},secret:'不得外露'}));
 db.prepare('INSERT INTO artifact_index VALUES(?,?,?,0,NULL)').run('indexed','hash',42);db.exec('COMMIT');
 const result=f.store.readHealthSummary(20);
 assert.equal(result.evals.counts.queued,289);assert.equal(result.evals.active.length,288);assert.equal(result.evals.truncated,true);
 assert.equal(result.queues.normal.items,289);assert.equal(result.queues.normal.bytes,28900);
 assert.equal(result.jobs.counts.running,3);assert.equal(result.jobs.occupied,3);assert.equal(result.jobs.active.length,2);assert.equal(result.jobs.truncated,true);
 assert.equal(result.capacity.artifactIndexedBytes,42);assert.ok(!JSON.stringify(result).includes('不得外露'));
 db.close();f.store.close();
});
