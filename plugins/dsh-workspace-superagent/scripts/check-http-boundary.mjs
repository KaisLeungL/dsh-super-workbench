import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=process.argv[2],stage=process.argv[3]??'missing';
if(!root?.startsWith('/Users/kaisleung/EnginProjects/dsh-make-it-best/.superagent-product-lab/b01/runs/'))throw Error('需要精确自有隔离根');
const url=(await readFile(root+'/'+stage+'-auth-url.txt','utf8')).trim(),base=new URL(url).origin,path=base+'/api/workspace-superagent/status';
const login=await fetch(url,{redirect:'manual'}),cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');assert.ok(cookie);
const before=await (await fetch(path,{headers:{cookie,origin:base}})).json(),checks=[];
for(const [name,options]of [
 ['无认证请求',{headers:{origin:base}}],
 ['错误 Origin',{headers:{cookie,origin:'https://untrusted.invalid'}}],
 ['非 GET 请求',{method:'POST',headers:{cookie,origin:base,'content-type':'application/json'},body:'{}'}],
]){
 const response=await fetch(path,options);const body=await response.text();
 checks.push({name,status:response.status,body});assert.ok(!response.ok,name+' 意外被接受');
 if(name==='无认证请求')assert.equal(response.status,401);
 if(name==='错误 Origin')assert.equal(response.status,403);
}
const after=await (await fetch(path,{headers:{cookie,origin:base}})).json();assert.deepEqual(after,before);
const result={checks,statusUnchanged:true};await writeFile(root+'/'+stage+'-http-boundary.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
