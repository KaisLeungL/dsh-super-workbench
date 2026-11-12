import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),lab=workspace+'/.superagent-product-lab/b01';
const stage=process.argv[2];if(!['baseline','enabled','enabled-zh','disabled','missing'].includes(stage))throw Error('需要 baseline/enabled/disabled/missing');
const root=stage==='baseline'||stage==='missing'?lab+'/runs/'+randomUUID():JSON.parse(await readFile(lab+'/latest.json','utf8')).root;
await mkdir(root,{recursive:true,mode:0o700});
const env={...process.env};for(const k of Object.keys(env))if(/^DSH_|API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^ANTHROPIC_|^OPENAI_|^DEEPSEEK_|^AZURE_|^GOOGLE_|^GEMINI_|^AWS_/i.test(k))delete env[k];
Object.assign(env,{DSH_HOME:root+'/home',DSH_AGENTS_HOME:root+'/agent-config',DSH_TELEMETRY_DISABLED:'1',B01_ROOT:root,B01_STAGE:stage});
const redact=s=>s.replace(/([?&#](?:token|key)=)[^\s&#"']+/gi,'$1[已脱敏]');
async function cmd(args,ms){
 const c=spawn('/usr/local/bin/dsh',args,{env,stdio:['ignore','pipe','pipe']});let output='';c.stdout.on('data',b=>output+=b);c.stderr.on('data',b=>output+=b);
 const soft=setTimeout(()=>c.kill('SIGTERM'),ms),hard=setTimeout(()=>c.kill('SIGKILL'),ms+5000);
 const result=await new Promise((ok,fail)=>{c.on('error',fail);c.on('close',(code,signal)=>ok({code,signal,pid:c.pid}));});clearTimeout(soft);clearTimeout(hard);return {...result,args,output:redact(output)};
}
if(stage==='baseline'||stage==='missing'){
 await mkdir(root+'/home/task-board',{recursive:true,mode:0o700});
 await writeFile(root+'/home/task-board/execution-inputs-v1.json','[]\n',{flag:'wx',mode:0o600});
 await writeFile(root+'/owners.json','{"version":1,"taskIds":[]}\n',{flag:'wx',mode:0o600});
 const boot=await cmd(['--profile','b01','--from-default-profile','web','web','--help'],20000);
 await writeFile(root+'/bootstrap.json',JSON.stringify(boot,null,2));if(boot.code!==0)throw Error(boot.output);
 if(stage==='baseline')await writeFile(lab+'/latest.json',JSON.stringify({root}));
}
const board=workspace+'/.superagent-integration-lab/patched-board/lib/index.js',factory=workspace+'/.superagent-integration-lab/host-proposal/agent-loop.js';
const expected=['29ce4bca23599ed2d6efcebdccef3935511ab9f45c972dbf1117d19f2ad7778a','b955555a5c4a00710c3dff0c42b72475527ebb1b312a1f27bbead47a29cffa4f'];
const provenance=[];for(const [i,p]of[board,factory].entries()){const sha256=createHash('sha256').update(await readFile(p)).digest('hex');if(sha256!==expected[i])throw Error('冻结运行产物 hash 不匹配 '+p);provenance.push({path:p,sha256});}
await writeFile(root+'/'+stage+'-provenance.json',JSON.stringify(provenance,null,2));
const disabled=['headless-runner','session-title-llm','session-telemetry-otel','llm-pi-ai','llm-deepseek','llm-deepseek-account','tool-web','web-search-deepseek','web-deepseek-api','tool-subagent','tool-subagent-fork','tool-workflow','tool-goal','tool-bash','tool-pwsh','tool-fs','tool-jobs'];
let patch=disabled.map(id=>'- id: '+id+'\n  disabled: true').join('\n')+'\n';
if(stage!=='missing')patch+='- id: agent-loop\n  disabled: true\n';
patch+='- insert:\n';
if(stage!=='missing')patch+='    - id: b01-native-factory\n      name: '+factory+'\n      config: { agents: [] }\n    - id: b01-board\n      name: '+board+'\n      config:\n        enabled: true\n        announceToAgent: false\n        preventIdleSleep: false\n        goalRunEnabled: false\n        executionOwnershipFile: '+root+'/owners.json\n    - id: b01-fixture\n      name: '+lab+'/fixture.mjs\n';
if(stage.startsWith('enabled')||stage==='missing')patch+='    - id: b01-product\n      name: '+workspace+'/plugins/dsh-workspace-superagent/lib/index.js\n';
await writeFile(root+'/'+stage+'.patch.yml',patch);
const args=['--profile','b01','--patch',root+'/'+stage+'.patch.yml','--no-open','--host','127.0.0.1','--port','0'];
const child=spawn('/usr/local/bin/dsh',args,{env,stdio:['ignore','pipe','pipe']});
const runtime={stage,root,wrapperPid:process.pid,pid:child.pid,args,startedAt:new Date().toISOString()};
let pending='',url,writes=Promise.resolve(),closedResult,fatal,ready=false,stopReason='bound';
function emit(b){pending+=b;const lines=pending.split('\n');pending=lines.pop();for(const line of lines){const match=line.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/);if(match&&!url)url=match[0];writes=writes.then(()=>writeFile(root+'/'+stage+'-process.log',redact(line)+'\n',{flag:'a'}));}}
child.stdout.on('data',emit);child.stderr.on('data',emit);
const closed=new Promise(resolve=>{child.on('error',e=>{fatal=String(e);});child.on('close',(code,signal)=>{closedResult={code,signal};resolve(closedResult);});});
process.on('SIGTERM',()=>{stopReason='wrapper-signal';child.kill('SIGTERM');});
try{
 const launchDeadline=Date.now()+30000;
 while(!url&&!closedResult&&Date.now()<launchDeadline)await pause(100);
 if(!url)throw Error('官方 CLI 未产生隔离 URL');
 runtime.baseUrl=new URL(url).origin;
 await writeFile(root+'/'+stage+'-auth-url.txt',url,{mode:0o600});
 await writeFile(root+'/'+stage+'-runtime.json',JSON.stringify(runtime,null,2));
 console.log(JSON.stringify({stage,root,pid:child.pid,baseUrl:runtime.baseUrl}));
 const login=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});
 const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');if(!cookie)throw Error('官方登录未返回 Cookie');
 const headers={cookie,origin:runtime.baseUrl};
 await fetch(runtime.baseUrl+'/',{headers,signal:AbortSignal.timeout(10000)});
 const warmups=[],readyDeadline=Date.now()+30000;
 while(!closedResult&&Date.now()<readyDeadline){
  const r=await fetch(runtime.baseUrl+(stage==='missing'?'/api/workspace-superagent/status':'/api/b01-lab/snapshot'),{headers,signal:AbortSignal.timeout(8000)});
  const text=await r.text();let value;try{value=JSON.parse(text);}catch{}
  warmups.push({status:r.status,body:value});
  let fixtureError;try{fixtureError=JSON.parse(await readFile(root+'/'+stage+'-error.json','utf8'));}catch{}if(fixtureError)throw Error(fixtureError.message);
  if(stage==='missing')ready=r.ok&&value?.stage==='skeleton'&&value.capabilities.taskBoard===false;
  else {try{const saved=JSON.parse(await readFile(root+'/'+stage+'-snapshot.json','utf8'));ready=r.ok&&saved.tasks.some(t=>t.id==='b01-preserved-card')&&value?.snapshot.tasks.some(t=>t.id==='b01-preserved-card');}catch{}}
  if(ready)break;await pause(500);
 }
 await writeFile(root+'/'+stage+'-warmup.json',JSON.stringify({ready,warmups},null,2));
 if(!ready)throw Error('未达到精确自有卡与持久快照就绪条件');
 console.log(JSON.stringify({stage,ready,root}));
 const deadline=Date.now()+(stage==='baseline'?1000:1200000);
 while(!closedResult&&Date.now()<deadline){try{await access(root+'/'+stage+'-stop.request');stopReason='request';break;}catch{}await pause(250);}
}catch(error){fatal=String(error.stack??error);stopReason='failure';}
finally{
 if(!closedResult)child.kill('SIGTERM');const hard=setTimeout(()=>child.kill('SIGKILL'),5000);
 const exit=await closed;clearTimeout(hard);await writes;if(pending)await writeFile(root+'/'+stage+'-process.log',redact(pending)+'\n',{flag:'a'});
 await writeFile(root+'/'+stage+'-exit.json',JSON.stringify({...runtime,...exit,ready,fatal,stopReason,stoppedAt:new Date().toISOString()},null,2));
 console.log(JSON.stringify({stage,root,...exit,ready,fatal,stopReason}));if(fatal||exit.code!==0&&exit.signal!=='SIGTERM')process.exitCode=1;
}
