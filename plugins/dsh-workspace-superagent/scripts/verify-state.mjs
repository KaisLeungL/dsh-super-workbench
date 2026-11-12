import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),lab=workspace+'/.superagent-product-lab/b01';
const root=JSON.parse(await readFile(lab+'/latest.json','utf8')).root,stage=process.argv[2]??'enabled';
const baseline=JSON.parse(await readFile(root+'/baseline-snapshot.json','utf8')),current=JSON.parse(await readFile(root+'/'+stage+'-snapshot.json','utf8'));
const project=s=>{const p=structuredClone(s);delete p.scheduler.lastTickAt;return p;};
assert.deepEqual(project(current),project(baseline),'看板任务及设置快照发生变化');
const http=JSON.parse(await readFile(root+'/'+stage+'-http.json','utf8'));
const index=http.observations.find(o=>o.path==='/'),status=http.observations.find(o=>o.path==='/api/workspace-superagent/status');
assert.equal(status.status,stage==='enabled'?200:404);
assert.equal(index.pluginPaths.some(p=>p.includes('workspace-superagent')),stage==='enabled');
assert.ok(index.pluginPaths.some(p=>p.includes('task-board')));
const result={stage,preserved:true,excludedVolatileFields:['scheduler.lastTickAt'],revision:current.revision,tasks:current.tasks.map(t=>t.id),statusHttp:status.status,productInBoot:stage==='enabled'};
if(stage==='enabled'){
 const local=await readFile(workspace+'/plugins/dsh-workspace-superagent/lib/client.js'),served=await readFile(root+'/enabled-product-served.js');
 assert.ok(served.includes(local),'实际传输包不含完整本地候选');
 result.localClientSha256=createHash('sha256').update(local).digest('hex');
 result.servedClientSha256=createHash('sha256').update(served).digest('hex');
 result.containsExactLocalBytes=true;
}
await writeFile(root+'/'+stage+'-verification.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
