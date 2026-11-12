import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(root,'../../.superagent-product-lab/b01/artifacts');
mkdirSync(out,{recursive:true});
const node='/Users/kaisleung/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node',pnpm='/Users/kaisleung/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs';
const args=[pnpm,'pack','--pack-destination',out],r=spawnSync(node,args,{cwd:root,encoding:'utf8'});
const pkg=JSON.parse(readFileSync(root+'/package.json')),tgz=out+'/local-dsh-workspace-superagent-'+pkg.version+'.tgz';
const receipt={command:[node,...args],exitCode:r.status,stdout:r.stdout,stderr:r.stderr};
if(r.status===0){receipt.path=tgz;receipt.sha256=createHash('sha256').update(readFileSync(tgz)).digest('hex');const list=spawnSync('/usr/bin/tar',['-tzf',tgz],{encoding:'utf8'});receipt.tarExitCode=list.status;receipt.entries=list.stdout.trim().split('\n');if(list.status!==0)throw Error(list.stderr);for(const p of ['lib/index.js','lib/client.js','locale/zh.json','locale/en.json','icon.svg','cordis.patch.yml'])if(!receipt.entries.includes('package/'+p))throw Error('缺打包产物 '+p);}
writeFileSync(out+'/pack-receipt.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));process.exitCode=r.status??1;
