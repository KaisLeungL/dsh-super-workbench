import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),req=createRequire(root+'/package.json');
const evidence=resolve(root,'../../.superagent-product-lab/b04-deployment/build-'+randomUUID());mkdirSync(evidence,{recursive:true});
for(const [name,args] of [['dependencies',[root+'/scripts/check-dependencies.mjs']],['typecheck',[req.resolve('typescript/bin/tsc'),'--noEmit']],['declarations',[req.resolve('typescript/bin/tsc'),'--emitDeclarationOnly']],['bundle',[req.resolve('tsdown/run')]]]){
 const result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8'});
 writeFileSync(evidence+'/'+name+'.json',JSON.stringify({at:new Date().toISOString(),node:process.version,command:[process.execPath,...args],exitCode:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr,error:result.error?.message},null,2)+'\n');
 console.log(name+': '+result.status);if(result.status!==0){process.stderr.write(result.stderr??'');process.stdout.write(result.stdout??'');process.exit(result.status??1);}
}
