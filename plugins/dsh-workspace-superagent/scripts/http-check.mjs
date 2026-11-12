import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),lab=workspace+'/.superagent-product-lab/b01',stage=process.argv[2]??'enabled';
const root=process.argv[3]??JSON.parse(await readFile(lab+'/latest.json','utf8')).root;
const url=(await readFile(root+'/'+stage+'-auth-url.txt','utf8')).trim(),base=new URL(url).origin;
const login=await fetch(url,{redirect:'manual'}),cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');if(!cookie)throw Error('官方登录未返回 Cookie');
const headers={cookie,origin:base},observations=[];
for(const path of ['/api/workspace-superagent/status','/api/b01-lab/snapshot','/']){
 const r=await fetch(base+path,{headers}),bytes=Buffer.from(await r.arrayBuffer());
 const row={path,status:r.status,sha256:createHash('sha256').update(bytes).digest('hex')};
 if(path.startsWith('/api/')){try{row.body=JSON.parse(bytes.toString());}catch{row.contentType=r.headers.get('content-type');}}else{
  await writeFile(root+'/'+stage+'-index.html',bytes);const html=bytes.toString();
  const marker=html.indexOf('__DSH_BOOT__'),begin=html.indexOf('{',marker),end=html.indexOf('</script>',begin);const boot=JSON.parse(html.slice(begin,end).trim().replace(/;$/,''));const paths=[];function visit(v){if(!v||typeof v!=='object')return;if(['@local/dsh-workspace-superagent','@linxin666/dsh-client-ui-task-board'].includes(v.id))paths.push(v.url??v.bundleUrl);for(const c of Object.values(v))if(c&&typeof c==='object')Array.isArray(c)?c.forEach(visit):visit(c);}visit(boot);
  row.pluginPaths=paths;for(const p of paths.filter(p=>p.includes('workspace-superagent')||p.includes('task-board'))){const served=await fetch(new URL(p,base),{headers}),data=Buffer.from(await served.arrayBuffer());observations.push({path:p,status:served.status,sha256:createHash('sha256').update(data).digest('hex')});await writeFile(root+'/'+stage+'-'+(p.includes('workspace-superagent')?'product':'board')+'-served.js',data);}
 }
 observations.push(row);
}
await writeFile(root+'/'+stage+'-http.json',JSON.stringify({base,observations},null,2)+'\n');console.log(JSON.stringify({base,observations}));
