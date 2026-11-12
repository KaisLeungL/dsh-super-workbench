import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(plugin, '../..');
const base = project + '/.superagent-product-lab/actions-web';
await mkdir(base, { recursive:true, mode:0o700 });
const supplied = process.argv[2];
const root = supplied ? await realpath(supplied) : await mkdtemp(base + '/run-');
if (dirname(root) !== base || !root.startsWith(base + '/run-')) throw Error('只允许本脚本创建的隔离运行目录');
const dsh = project + '/host/cap4-built-dsh';
const board = '/Users/kaisleung/Documents/deepseek-harness/default-workspace/output/task-board-layout-20261111/artifacts/linxin666-dsh-client-ui-task-board-0.4.16-local.20261111.15.tgz';
const pluginSpec = process.env.WSA_PLUGIN_SPEC ?? plugin;
const contextLab = process.env.WSA_CONTEXT_LAB === '1';
const allBoardProjects = contextLab && process.env.WSA_CONTEXT_ALL_BOARD === '1';
const contextBundle = project + '/plugins/dsh-workspace-context';
const profile = ['--profile','superagent-actions-lab'];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^DSH_|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|^(DEEPSEEK|OPENAI|ANTHROPIC|AWS|AZURE|GOOGLE)_/i.test(key)));
Object.assign(env,{ DSH_HOME:root+'/home',DSH_AGENTS_HOME:root+'/agents',DSH_TELEMETRY_DISABLED:'1',WSA_ACTIONS_LAB:root });
const redact = text => text.replace(/([?&]token=)[^\s&"']+/g,'$1[已脱敏]');
function cmd(args) {
  const r=spawnSync(dsh,args,{cwd:root,env,encoding:'utf8',timeout:120_000});
  if (r.status!==0) throw Error(redact(r.stderr || r.stdout || String(r.error)));
}
async function boot(path) {
  const host=spawn(dsh,[...profile,'--patch',path,'--no-open','--host','127.0.0.1','--port','0'],{
    cwd:root+'/workspace',env,stdio:['ignore','pipe','pipe'],
  });
  let log='', outcome;
  const stopped=new Promise(done=>{
    host.on('error',error=>{outcome={error:error.message};done(outcome);});
    host.on('close',(code,signal)=>{outcome={code,signal};done(outcome);});
  });
  for (const pipe of [host.stdout,host.stderr]) pipe.on('data',value=>{log+=value;});
  async function stop() {
    if (!outcome) host.kill('SIGTERM');
    const timer=setTimeout(()=>{ if (!outcome) host.kill('SIGKILL'); },8000);
    try { await stopped; } finally { clearTimeout(timer); await writeFile(path+'.log',redact(log),{mode:0o600}); }
  }
  for (let i=0;i<350&&!outcome;i++) {
    const url=log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
    if (url) return { url,pid:host.pid,stop,stopped };
    await delay(100);
  }
  await stop(); throw Error('隔离 DSH 启动失败，日志：'+path+'.log');
}
if (!supplied) {
  await mkdir(root+'/workspace');
  await mkdir(root+'/private',{ mode:0o700 });
  cmd([...profile,'--from-default-profile','web','--help']);
  cmd(['plugin',...profile,'add',project+'/plugins/dsh-input-admission-cap4',pluginSpec,board,...(contextLab ? [contextBundle] : []),'--ignore-scripts','--offline']);
  const provider='superagent-actions-fixture';
  const schedule='dsh.schedule.create', task='dsh.taskBoard.create';
  const cases=[
    ['可以帮我创建一个自动化定时任务吗？',schedule,{}],
    ['在看板帮我创建一张任务卡片。',task,{}],
    ['每天早上九点帮我整理隔离日报。',schedule,{title:'隔离日报',instruction:'生成一份演示日报',schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Shanghai'}}],
    ['把登录页移动端验收加到待办。',task,{title:'登录页移动端验收',description:'检查移动端登录页',column:'todo'}],
    ['让 Worker 检查这张卡片。','steward_delegate_task',{}],
  ];
  await writeFile(root+'/model.mjs',`
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
export const inject=['workspaceRegistry','llm'];
export async function apply(ctx){
  const root=process.env.WSA_ACTIONS_LAB;
  if (!root.includes('/.superagent-product-lab/actions-web/run-') || process.env.DSH_HOME!==root+'/home') throw Error('ISOLATION_REQUIRED');
  const cwd=root+'/workspace';
  if (!await ctx.workspaceRegistry.resolveByPath(cwd)) await ctx.workspaceRegistry.create(cwd,'快捷操作验收工作区');
  const provider=${JSON.stringify(provider)}, model={provider,id:'controlled',name:'快捷操作验收模型',defaultMaxTokens:1000,context:{contextWindow:8192}};
  const cases=${JSON.stringify(cases)};
  const adapter={
    providerInfo:()=>({id:provider,name:'快捷操作验收模型'}),
    providerRetryPolicy:()=>undefined,
    listModels:async()=>[model],resolveModel:async()=>model,
    async prepareCall(){return {model,stream:options=>adapter.stream(options)};},
    async *stream(options){
      const user=options.messages.filter(m=>m.role==='user'&&m.source?.kind==='user').at(-1);
      const input=user?.content?.find?.(p=>p.type==='text')?.text;
      const matched=cases.find(([text])=>text===input);
      const id='actions-'+user?.id;
      if (${contextLab} && input === '工作区上下文验收') {
        const calls = [['dsh_context_catalog', {}], ['dsh_context_query', { capability:'task-board.list', filter:{status:'backlog'} }],
          ['dsh_context_query', { capability:'schedule.upcoming' }]];
        if (${allBoardProjects}) calls.push(
          ['steward_list_tasks', {selector:{status:'backlog',archived:'exclude'}}],
          ['steward_read_task', {taskId:readFileSync(root+'/other-board-id','utf8')}],
          ['dsh_context_query', {capability:'task-board.list',filter:{archived:true}}],
        );
        for (const [index, [name, args]] of calls.entries()) {
          const toolCallId = id + '-context-' + index;
          const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === toolCallId);
          if (result) continue;
          yield {type:'block-start',index:0,blockType:'tool-call'};
          yield {type:'tool-call-delta',index:0,id:toolCallId,name,argumentsDelta:JSON.stringify(args)};
          yield {type:'finish',reason:{kind:'tool-calls'}};
          return;
        }
        const results = options.messages.filter(message => message.role === 'tool' && message.toolCallId?.startsWith(id + '-context-'));
        appendFileSync(root+'/context-results.jsonl', JSON.stringify(results.map(({content,isError})=>({content,isError})))+'\\n');
      }
      const result=options.messages.find(m=>m.role==='tool'&&m.toolCallId===id);
      const delegate=matched&&matched[1]==='steward_delegate_task';
      if(matched&&!result){
        appendFileSync(root+'/model-events.jsonl',JSON.stringify({type:'proposal',actionId:matched[1]})+'\\n');
        yield {type:'block-start',index:0,blockType:'tool-call'};
        if(delegate){
          const taskId=readFileSync(root+'/delegate-task.txt','utf8').trim();
          yield {type:'tool-call-delta',index:0,id,name:'steward_delegate_task',argumentsDelta:JSON.stringify({taskId})};
        }else{
          yield {type:'tool-call-delta',index:0,id,name:'steward_propose_action',argumentsDelta:JSON.stringify({proposal:{actionId:matched[1],version:1,params:matched[2]}})};
        }
        yield {type:'finish',reason:{kind:'tool-calls'}};
        return;
      }
      const text=result?(result.isError?'隔离模型收到工具错误。':'请在下面的卡片核对或填写。'):'隔离模型收到请求。';
      if (result) appendFileSync(root+'/model-events.jsonl',JSON.stringify({type:'result',ok:!result.isError})+'\\n');
      yield {type:'block-start',index:0,blockType:'text'};
      yield {type:'text-delta',index:0,text};
      yield {type:'block-end',index:0,block:{type:'text',text}};
      yield {type:'finish',reason:{kind:'stop'}};
    },
  };
  ctx.llm.registerAdapter([provider],adapter);
  writeFileSync(root+'/fixture-ready','ready\\n');
}
`);
  const disabled=['agent-loop','headless-runner','session-title-llm','session-telemetry-otel','llm-pi-ai','llm-deepseek','llm-deepseek-account',
    'tool-web','web-search-deepseek','web-deepseek-api','tool-subagent','tool-subagent-fork','tool-workflow','tool-goal','tool-bash','tool-pwsh','tool-fs',
    'tool-jobs','ui-task-board-inspection','ui-task-board-github','ui-task-board-team','task-board-remote'];
  const baseYaml=disabled.map(id=>'- id: '+id+'\n  disabled: true').join('\n')+'\n- insert:\n';
  const rows=[
    {id:'actions-lab-model',name:root+'/model.mjs'},
  ];
  const yaml=entries=>baseYaml+entries.map(row=>'    - '+JSON.stringify(row)).join('\n')+'\n';
  await writeFile(root+'/setup.yml',yaml(rows));
  const setup=await boot(root+'/setup.yml');
  try { for(let i=0;i<80;i++){ if(await readFile(root+'/fixture-ready','utf8').catch(()=>undefined)) break; await delay(100); }
    await readFile(root+'/fixture-ready'); } finally { await setup.stop(); }
  const deployment={databasePath:root+'/private/manager.sqlite',workspacePath:root+'/workspace',
    identity:{instanceId:randomUUID(),domainId:randomUUID()},model:{provider,model:'controlled'},
    firstInstall:{expiresAt:Date.now()+86400000,proofRef:'isolated-actions-lab'},
    ...(contextLab && {contextSources:{'schedule.upcoming':'@local/dsh-workspace-context/schedule'}}),
    ...(allBoardProjects && {boardReadScope:'all-projects'})};
  const add='- id: workspace-superagent\n  config: '+JSON.stringify({deployment})+'\n';
  if (contextLab) {
    await mkdir(root+'/other-workspace');
    await writeFile(root+'/context-data.mjs', `
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
export const inject = ['workspaceRegistry', 'taskBoard', 'schedule'];
export async function apply(ctx) {
  const root = process.env.WSA_ACTIONS_LAB;
  const local = await ctx.workspaceRegistry.resolveByPath(root+'/workspace');
  const other = await ctx.workspaceRegistry.create(root+'/other-workspace','另一工作区');
  for (const [workspace, key] of [[local,'local'],[other,'other']]) {
    const id = randomUUID();
    await ctx.taskBoard.apply(id, {kind:'create', id, input:{title:'看板-'+key, description:'仅用于验收', prompt:'仅用于验收',
      workspaceId:workspace.id, projectId:workspace.id, status:'backlog', permission:'read-only'}});
    if (key === 'other') writeFileSync(root+'/other-board-id', id);
    await ctx.schedule.createConfirmed({title:'自动化-'+key, prompt:'仅用于验收，不外发',
      timing:{kind:'at',at:new Date(Date.now()+24*60*60*1000).toISOString()},
      target:{kind:'new_once',create:{cwd:workspace.path}}}, randomUUID());
  }
  for (const [title, options] of [['看板-unassigned', {}], ['看板-hidden', {hidden:true}], ['看板-archived', {}]]) {
    const id = randomUUID();
    await ctx.taskBoard.apply(id, {kind:'create', id, input:{title, description:'仅用于验收', prompt:'仅用于验收',
      projectId:null, status:'backlog', permission:'read-only', ...options}});
    if (title === '看板-archived') await ctx.taskBoard.apply(randomUUID(), {kind:'archive', taskId:id});
  }
  writeFileSync(root+'/context-data-ready', 'ready');
}
`);
    rows.push({id:'context-lab-data',name:root+'/context-data.mjs'});
    const withoutData = rows.filter(row => row.id !== 'context-lab-data');
    await writeFile(root+'/app-without-board.yml', yaml(withoutData)+add+'- id: ui-task-board\n  disabled: true\n');
    await writeFile(root+'/app-without-schedule.yml', yaml(withoutData)+add+'- id: workspace-context-schedule\n  disabled: true\n');
  }
  await writeFile(root+'/app.yml',yaml(rows)+add);
}
const disabledSource = contextLab && process.env.WSA_CONTEXT_DISABLED_SOURCE;
const patch = disabledSource === 'board' ? '/app-without-board.yml' : disabledSource === 'schedule' ? '/app-without-schedule.yml' : '/app.yml';
const host=await boot(root+patch);
await writeFile(root+'/login-url',host.url,{mode:0o600});
console.log(JSON.stringify({root,origin:new URL(host.url).origin,pid:host.pid}));
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{void host.stop();});
await host.stopped;
await rm(root+'/login-url',{force:true});
