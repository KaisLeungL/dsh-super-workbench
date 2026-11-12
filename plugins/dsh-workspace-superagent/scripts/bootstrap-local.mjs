// 仅在本插件目录建立依赖链接；不安装或修改被引用的 SDK。
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync,symlinkSync,existsSync,realpathSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sdk=resolve(process.argv[2]??resolve(root,'../../.superagent-integration-lab/patched-board'));
const req=createRequire(sdk+'/package.json');
const pkg=JSON.parse(readFileSync(root+'/package.json','utf8'));
const records=[];
for(const [name,version] of Object.entries(pkg.devDependencies)){
 const manifest=req.resolve(name+'/package.json');const bytes=readFileSync(manifest);const actual=JSON.parse(bytes);
 if(actual.version!==version)throw Error(name+' 版本不匹配: '+actual.version+' != '+version);
 const target=realpathSync(dirname(manifest)),link=root+'/node_modules/'+name;
 mkdirSync(dirname(link),{recursive:true});
 if(existsSync(link)){if(realpathSync(link)!==target)throw Error('已有依赖链接指向不同版本: '+name);}else symlinkSync(target,link,'dir');
 records.push({name,version,manifest:realpathSync(manifest),sha256:createHash('sha256').update(bytes).digest('hex')});
}
const lockPath=root+'/sdk-lock.json';
if(process.argv.includes('--record')){if(existsSync(lockPath))throw Error('禁止覆盖既有 SDK 锁');writeFileSync(lockPath,JSON.stringify({kind:'local-sdk-snapshot',records},null,2)+'\n',{flag:'wx'});}
else {const lock=JSON.parse(readFileSync(lockPath,'utf8'));if(JSON.stringify(lock.records)!==JSON.stringify(records))throw Error('SDK 锁定快照不匹配');}
console.log(JSON.stringify({checked:records.length,root,sdk}));
