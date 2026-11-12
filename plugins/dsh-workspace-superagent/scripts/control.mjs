import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),lab=workspace+'/.superagent-product-lab/b01';
const stage=process.argv[2],action=process.argv[3];if(!['enabled','enabled-zh','disabled','missing'].includes(stage)||!['stop','cleanup','login'].includes(action))throw Error('需要 stage 与 stop/cleanup/login');
const root=process.argv[4]??JSON.parse(await readFile(lab+'/latest.json','utf8')).root;
if(!root.startsWith(lab+'/runs/')||root.includes('/../'))throw Error('只允许自有隔离根');
if(action==='stop'){await writeFile(root+'/'+stage+'-stop.request','自有验证完成\n');console.log('已请求停止自有 '+stage);process.exit(0);}
const url=(await readFile(root+'/'+stage+'-auth-url.txt','utf8')).trim();
if(action==='login'){
 const c=spawn('/usr/bin/open',[url],{stdio:'ignore'});const code=await new Promise((ok,fail)=>{c.on('error',fail);c.on('exit',ok);});if(code!==0)throw Error('系统浏览器未打开');console.log('已通过官方临时 URL 打开隔离页面，认证材料未输出。');
}else{
 const base=new URL(url).origin,login=await fetch(url,{redirect:'manual'}),cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');if(!cookie)throw Error('认证失败');
 const response=await fetch(base+'/api/b01-lab/cleanup',{method:'POST',headers:{cookie,origin:base}});
 if(!response.ok)throw Error('清理失败 '+response.status);const result=await response.json();if(result.tasks.length!==0)throw Error('隔离卡尚未清理');
 await writeFile(root+'/'+stage+'-cleanup-http.json',JSON.stringify({status:response.status,...result},null,2)+'\n');console.log(JSON.stringify({status:response.status,tasks:result.tasks.length}));
}
