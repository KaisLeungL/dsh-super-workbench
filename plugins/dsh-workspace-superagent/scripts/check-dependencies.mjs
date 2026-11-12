import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),req=createRequire(root+'/package.json'),pkg=JSON.parse(readFileSync(root+'/package.json'));
for(const [name,version]of Object.entries(pkg.devDependencies)){const actual=JSON.parse(readFileSync(req.resolve(name+'/package.json'))).version;if(actual!==version)throw Error(name+' '+actual+' != '+version);}
console.log(JSON.stringify({checked:Object.keys(pkg.devDependencies).length,passed:true}));
