import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {managerQualificationAdapter} from './manager-qualification-adapter.js';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
it.each(['abi','adapter','package','binary','escape'])('refuses %s mismatch before loading a qualification driver',kind=>{
 const dir=mkdtempSync(join(tmpdir(),'manager-dependency-guard-')),installed=join(dir,'installed'),candidate=join(dir,'candidate');
 const adapter='export class SqliteAdapter {}',pkg=JSON.stringify({name:'better-sqlite3',version:'12.8.0',main:'index.cjs'}),binary='not a native module';
 try{
  mkdirSync(join(installed,'dist/db'),{recursive:true});mkdirSync(join(installed,'node_modules/better-sqlite3'),{recursive:true});
  writeFileSync(join(installed,'dist/db/sqlite-adapter.js'),adapter);writeFileSync(join(installed,'node_modules/better-sqlite3/package.json'),pkg);
  mkdirSync(join(candidate,'node_modules/better-sqlite3/build/Release'),{recursive:true});
  writeFileSync(join(candidate,'sqlite-adapter.mjs'),adapter);writeFileSync(join(candidate,'node_modules/better-sqlite3/package.json'),pkg);
  writeFileSync(join(candidate,'node_modules/better-sqlite3/index.cjs'),"throw Error('DRIVER MUST NOT LOAD');");
  const native=join(candidate,'node_modules/better-sqlite3/build/Release/better_sqlite3.node');writeFileSync(native,binary);
  const manifest={contract:'kapelle.manager-test-dependency/v1',modulesAbi:process.versions.modules,platform:process.platform,arch:process.arch,adapterSha256:hash(adapter),packageSha256:hash(pkg),nativeSha256:hash(binary)};
  if(kind==='abi')manifest.modulesAbi='wrong';
  if(kind==='adapter')writeFileSync(join(candidate,'sqlite-adapter.mjs'),adapter+' // different');
  if(kind==='package')manifest.packageSha256=hash('wrong');
  if(kind==='binary')manifest.nativeSha256=hash('wrong');
  if(kind==='escape'){rmSync(native);writeFileSync(join(dir,'outside.node'),binary);symlinkSync(join(dir,'outside.node'),native);}
  writeFileSync(join(candidate,'qualification.json'),JSON.stringify(manifest));
  const expected={abi:'runtime identity mismatch',adapter:'adapter differs',package:'driver package mismatch',binary:'native binary mismatch',escape:'escapes isolated root'}[kind]!;
  expect(()=>managerQualificationAdapter(installed,candidate)).toThrow(expected);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
