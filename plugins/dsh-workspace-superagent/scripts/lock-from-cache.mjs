// 从已安装 SDK 的标准 pnpm 锁元数据裁剪闭包，不改动来源文件。
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=process.argv[2];if(!source)throw Error('需要 SDK pnpm-lock.yaml 路径');
const req=createRequire(source);const yaml=req('yaml');const bytes=readFileSync(source),lock=yaml.parse(bytes.toString());
const pkg=JSON.parse(readFileSync(root+'/package.json','utf8')),devDependencies={};
for(const [name,version]of Object.entries(pkg.devDependencies)){
 const matches=Object.values(lock.importers).flatMap(i=>[i.dependencies?.[name],i.devDependencies?.[name],i.optionalDependencies?.[name]]).filter(v=>v&&v.version.split('(')[0]===version);
 if(!matches.length)throw Error('缓存锁缺直接依赖 '+name+'@'+version);
 const selected=matches[0].version;if(!lock.snapshots[name+'@'+selected])throw Error('缺 snapshot '+name);
 devDependencies[name]={specifier:version,version:selected};
}
const snapshots={},packages={};
function visit(key){if(snapshots[key])return;const entry=lock.snapshots[key];if(!entry)throw Error('传递锁缺失 '+key);snapshots[key]=entry;const base=key.split('(')[0];if(!lock.packages[base]?.resolution)throw Error('缺包完整性元数据 '+base);packages[base]=lock.packages[base];for(const [name,version]of Object.entries({...entry.dependencies,...entry.optionalDependencies})){if(version.startsWith('link:'))throw Error('不能带工作区 link '+name);visit(name+'@'+version);}}
for(const [name,entry]of Object.entries(devDependencies))visit(name+'@'+entry.version);
const output={lockfileVersion:lock.lockfileVersion,settings:{autoInstallPeers:false,excludeLinksFromLockfile:false},overrides:lock.overrides,importers:{'.':{devDependencies}},packages,snapshots};
writeFileSync(root+'/pnpm-lock.yaml',yaml.stringify(output,{lineWidth:0}));
writeFileSync(root+'/pnpm-workspace.yaml',yaml.stringify({packages:['.'],autoInstallPeers:false,overrides:lock.overrides}));
const receipt={source,sourceSha256:createHash('sha256').update(bytes).digest('hex'),packages:Object.keys(packages).length,snapshots:Object.keys(snapshots).length,direct:Object.keys(devDependencies).length};
writeFileSync(root+'/lock-origin.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
