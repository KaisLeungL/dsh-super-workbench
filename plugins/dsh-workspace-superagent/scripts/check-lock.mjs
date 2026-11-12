import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),origin=JSON.parse(readFileSync(root+'/lock-origin.json'));
const req=createRequire(origin.source),yaml=req('yaml'),lockBytes=readFileSync(root+'/pnpm-lock.yaml'),lock=yaml.parse(lockBytes.toString()),pkg=JSON.parse(readFileSync(root+'/package.json'));
for(const [name,version]of Object.entries(pkg.devDependencies))assert.equal(lock.importers['.'].devDependencies[name]?.specifier,version,name);
const visited=new Set();function visit(key){if(visited.has(key))return;visited.add(key);const e=lock.snapshots[key];assert.ok(e,'missing '+key);assert.ok(lock.packages[key.split('(')[0]].resolution.integrity,'missing integrity '+key);for(const [n,v]of Object.entries({...e.dependencies,...e.optionalDependencies}))visit(n+'@'+v);}
for(const [n,v]of Object.entries(lock.importers['.'].devDependencies))visit(n+'@'+v.version);
assert.equal(visited.size,Object.keys(lock.snapshots).length);
const receipt={passed:true,kind:'standard-lock-structure-only',direct:Object.keys(pkg.devDependencies).length,packages:Object.keys(lock.packages).length,snapshots:visited.size,sha256:createHash('sha256').update(lockBytes).digest('hex'),cleanInstallVerified:false};
writeFileSync(resolve(root,'../../.superagent-product-lab/b01/build/lock-structure.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
