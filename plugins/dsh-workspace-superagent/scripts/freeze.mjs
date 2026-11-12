// 独立候选快照；已有冻结目录一律拒绝覆盖。
import {readFile,writeFile,mkdir,readdir,lstat,copyFile,realpath,access} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),plugin=workspace+'/plugins/dsh-workspace-superagent',lab=workspace+'/.superagent-product-lab/b01',frozen=lab+'/frozen-b01-v1';
try{await access(frozen);throw Error('冻结已存在，禁止覆盖');}catch(e){if(e.code!=='ENOENT')throw e;}
if(await realpath(plugin)!==plugin)throw Error('主体目录不允许符号链接');
async function walk(dir){const files=[];for(const e of await readdir(dir,{withFileTypes:true})){if(e.name==='node_modules'||e.name==='pnpm-store'||e.name==='pnpm-cache')continue;const p=dir+'/'+e.name;if(e.isSymbolicLink())throw Error('快照不接受符号链接 '+p);if(e.isDirectory())files.push(...await walk(p));else if(e.isFile())files.push(p);}return files.sort();}
const entries=[];
async function add(path,kind){const bytes=await readFile(path);entries.push({path:relative(workspace,path),kind,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});}
for(const file of await walk(plugin)){const dest=frozen+'/'+relative(plugin,file);await mkdir(dirname(dest),{recursive:true});await copyFile(file,dest,constants.COPYFILE_EXCL);await add(file,'source-or-build');await add(dest,'frozen-candidate');}
for(const file of await walk(lab)){
 if(file.startsWith(frozen+'/')||file.endsWith('final-hashes.json')||file.endsWith('freeze-receipt.json')||file.endsWith('-auth-url.txt')||file.includes('/home/')||file.includes('/agent-config/'))continue;
 await add(file,'evidence');
}
await add(workspace+'/docs/super-agent/实施证据/B01-插件骨架.md','delivery');
const manifest={candidate:'b01-v1',version:'0.1.0-b01.1',frozenAt:new Date().toISOString(),root:relative(workspace,frozen),entries:entries.length,files:entries.sort((a,b)=>a.path.localeCompare(b.path))};
const bytes=JSON.stringify(manifest,null,2)+'\n',sha256=createHash('sha256').update(bytes).digest('hex');
await writeFile(lab+'/final-hashes.json',bytes,{flag:'wx'});
await writeFile(lab+'/freeze-receipt.json',JSON.stringify({manifest:relative(workspace,lab+'/final-hashes.json'),sha256,entries:entries.length,version:manifest.version},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sha256,entries:entries.length,root:manifest.root}));
