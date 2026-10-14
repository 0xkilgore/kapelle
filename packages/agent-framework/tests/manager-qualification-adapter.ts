/** Qualification-only dependency selection. Never installs or rebuilds a module. */
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const sha=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
export function managerQualificationAdapter(root:string,qualificationRoot=process.env.KAPELLE_MANAGER_QUALIFICATION_ROOT){
 const installed=join(root,'dist/db/sqlite-adapter.js');
 if(!qualificationRoot)return {adapterPath:installed,adapterSha256:sha(installed),qualificationRoot:null};
 // Ops supplies an isolated, hash-recorded tree. The adapter, driver entry and native binary must resolve inside it.
 const directory=realpathSync(qualificationRoot);
 if(directory===realpathSync(root)||directory.startsWith(realpathSync(root)+sep))throw Error('Manager qualification must be outside the installed source');
 const inside=(name:string)=>{const path=realpathSync(join(directory,name));if(!path.startsWith(directory+sep))throw Error('Manager qualification dependency escapes isolated root');return path;};
 const manifest=JSON.parse(readFileSync(inside('qualification.json'),'utf8'));
 if(manifest.contract!=='kapelle.manager-test-dependency/v1'||manifest.modulesAbi!==process.versions.modules||manifest.platform!==process.platform||manifest.arch!==process.arch)throw Error('Manager qualification runtime identity mismatch');
 const adapterPath=inside('sqlite-adapter.mjs');
 if(sha(adapterPath)!==sha(installed)||sha(adapterPath)!==manifest.adapterSha256)throw Error('Manager qualification adapter differs from installed code');
 const require=createRequire(pathToFileURL(adapterPath));
 const packagePath=inside('node_modules/better-sqlite3/package.json');
 const installedPackage=createRequire(pathToFileURL(installed)).resolve('better-sqlite3/package.json');
 const pkg=JSON.parse(readFileSync(packagePath,'utf8')),expected=JSON.parse(readFileSync(installedPackage,'utf8'));
 if(pkg.name!=='better-sqlite3'||pkg.version!==expected.version||sha(packagePath)!==manifest.packageSha256)throw Error('Manager qualification driver package mismatch');
 const entry=realpathSync(require.resolve('better-sqlite3'));
 if(!entry.startsWith(directory+sep))throw Error('Manager qualification driver escapes isolated root');
 const nativePath=inside('node_modules/better-sqlite3/build/Release/better_sqlite3.node');
 if(sha(nativePath)!==manifest.nativeSha256)throw Error('Manager qualification native binary mismatch');
 // Preflight an in-memory database under the SAME process as Framework. No fallback driver.
 const Driver=require('better-sqlite3');const probe=new Driver(':memory:');probe.close();
 if(!require.cache[nativePath])throw Error('Manager qualification loaded an unrecorded native binary');
 return {adapterPath,adapterSha256:sha(adapterPath),qualificationRoot:resolve(directory),driverVersion:pkg.version,packageSha256:manifest.packageSha256,nativePath,nativeSha256:manifest.nativeSha256};
}
