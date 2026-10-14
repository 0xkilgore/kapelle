import {it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync,renameSync,symlinkSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest} from '../src/command-boundary.js';
const fake=vi.hoisted(()=>({calls:[] as string[],build:()=>{},journal:()=>{},drive:()=>({header:{id:'retained-drive',documentType:'powerhouse/document-drive'}})}));
vi.mock('node:module',async original=>{
 const real=await original<typeof import('node:module')>();
 return {...real,createRequire:(path:string)=>path.endsWith('/packages/reactor/package.json')?(name:string)=>{
  if(name==='@electric-sql/pglite')return {PGlite:class {closed=false;constructor(){fake.calls.push('db-open');}async close(){this.closed=true;fake.calls.push('db-close');}}};
  if(name==='kysely')return {Kysely:class {constructor(){fake.calls.push('kysely-open');}async destroy(){fake.calls.push('destroy');}}};
  if(name==='kysely-pglite-dialect')return {PGliteDialect:class {}};
  throw Error('unexpected dependency');
 }:real.createRequire(path)};
});
vi.mock('../src/service/journal.js',()=>({CommandJournal:class {constructor(_p:string,_b:string,readonly readOnly=false){fake.calls.push('journal-open');fake.journal();}close(){fake.calls.push('journal-close');}}}));
import {openFrameworkRuntime} from '../src/service/runtime.js';
function fixture(){
 fake.calls=[];fake.build=()=>{};fake.journal=()=>{};fake.drive=()=>({header:{id:'retained-drive',documentType:'powerhouse/document-drive'}});
 const dir=mkdtempSync(join(tmpdir(),'existing-authority-')),root=join(dir,'state');mkdirSync(root,{mode:0o700});
 const reactorRoot=join(dir,'injected');mkdirSync(join(reactorRoot,'packages/reactor/dist'),{recursive:true});mkdirSync(join(reactorRoot,'packages/shared/dist/document-drive'),{recursive:true});
 (globalThis as any).__kapelleExistingTest=fake;
 writeFileSync(join(reactorRoot,'packages/reactor/dist/index.js'),`
 const f=globalThis.__kapelleExistingTest;
 export class ReactorBuilder {withKysely(){return this;}withDocumentModels(){return this;}}
 export class ReactorClientBuilder {withReactorBuilder(){return this;}async buildModule(){f.calls.push('build');f.build();return {
 reactor:{kill(){f.calls.push('settle');return {completed:Promise.resolve()};}},
 reactorModule:{database:{},readModelCoordinator:{async drain(){f.calls.push('drain');}}},
 client:{async get(){f.calls.push('drive-read');return f.drive();},executeScopedAuthority(){throw Error('write');},drives:{async create(){f.calls.push('create-drive');return {header:{id:'created-drive'}};},addFile(){throw Error('write');}}}};}}
 export class KyselyScopedAuthorityStore {}
 export const digestScopedAuthorityActions=()=>'';
 export const DriveCollectionId={forDrive:id=>({key:'collection:'+id})};
 `);
 writeFileSync(join(reactorRoot,'packages/shared/dist/document-drive/index.js'),'export const driveDocumentModelModule={};export const addFile=()=>{};');
 const binding=digest({owner:'human:owner',scope:'kapelle',contract:'kapelle-framework/v1'}),meta=join(root,'authority.json');
 const bytes=JSON.stringify({binding,driveId:'retained-drive'});writeFileSync(meta,bytes,{mode:0o600});
 mkdirSync(join(root,'pglite'),{mode:0o700});writeFileSync(join(root,'pglite/PG_VERSION'),'17\n',{mode:0o600});writeFileSync(join(root,'commands.sqlite'),'SQLite format 3\0fixture',{mode:0o600});
 const options={stateRoot:root,reactorRoot,ownerId:'human:owner',scopeRef:'kapelle',facts:async()=>{throw Error('facts forbidden');},requireExistingAuthority:true};
 return {root,meta,bytes,options,dispose(){delete (globalThis as any).__kapelleExistingTest;rmSync(dir,{recursive:true});}};
}
it('opens valid retained authority and settles gracefully without creating metadata/drive',async()=>{
 const f=fixture();try {const runtime=await openFrameworkRuntime(f.options);expect(runtime.authority.backend.driveId).toBe('retained-drive');expect(readFileSync(f.meta,'utf8')).toBe(f.bytes);expect(fake.calls).not.toContain('create-drive');await runtime.close();expect(fake.calls.slice(-5)).toEqual(['journal-close','settle','drain','destroy','db-close']);expect(existsSync(join(f.root,'writer.lock'))).toBe(false);}finally{f.dispose();}
});
it.each(['missing','malformed','binding','drive','symlink','callback-delete','callback-replace'])('refuses %s before DB construction and releases lease',async kind=>{
 const f=fixture();try{
  if(kind==='missing')unlinkSync(f.meta);if(kind==='malformed')writeFileSync(f.meta,'{');if(kind==='binding')writeFileSync(f.meta,JSON.stringify({binding:'other',driveId:'retained-drive'}));if(kind==='drive')writeFileSync(f.meta,JSON.stringify({binding:JSON.parse(f.bytes).binding}));
  if(kind==='symlink'){renameSync(f.meta,join(f.root,'other'));symlinkSync('other',f.meta);}
  const beforeDatabaseOpen=kind==='callback-delete'?()=>unlinkSync(f.meta):kind==='callback-replace'?()=>{renameSync(f.meta,join(f.root,'old'));writeFileSync(f.meta,f.bytes,{mode:0o600});}:undefined;
  await expect(openFrameworkRuntime({...f.options,beforeDatabaseOpen})).rejects.toThrow();expect(fake.calls).toEqual([]);expect(existsSync(join(f.root,'writer.lock'))).toBe(false);
 }finally{f.dispose();}
});
it.each(['delete','malformed','binding','replace','journal-delete'])('refuses %s during injected open; never bootstraps replacement; closes opened resources',async kind=>{
 const f=fixture();try{
  const change=()=>{if(kind==='delete'||kind==='journal-delete')unlinkSync(f.meta);else if(kind==='malformed')writeFileSync(f.meta,'{');else if(kind==='binding')writeFileSync(f.meta,JSON.stringify({binding:'other',driveId:'retained-drive'}));else {renameSync(f.meta,join(f.root,'old'));writeFileSync(f.meta,f.bytes,{mode:0o600});}};
  if(kind==='journal-delete')fake.journal=change;else fake.build=change;
  await expect(openFrameworkRuntime(f.options)).rejects.toThrow();expect(fake.calls).not.toContain('create-drive');if(kind==='journal-delete'){expect(fake.calls).toEqual(['journal-open','journal-close']);}else {expect(fake.calls).toContain('settle');expect(fake.calls).toContain('drain');expect(fake.calls).toContain('destroy');expect(fake.calls).toContain('db-close');}expect(existsSync(join(f.root,'writer.lock'))).toBe(false);
 }finally{f.dispose();}
});
it('absent option retains ordinary new-authority bootstrap',async()=>{
 const f=fixture();try{unlinkSync(f.meta);rmSync(join(f.root,'pglite'),{recursive:true});unlinkSync(join(f.root,'commands.sqlite'));const runtime=await openFrameworkRuntime({...f.options,requireExistingAuthority:undefined});expect(fake.calls).toContain('create-drive');expect(JSON.parse(readFileSync(f.meta,'utf8')).driveId).toBe('created-drive');await runtime.close();}finally{f.dispose();}
});
it('required missing root is not created',async()=>{
 const f=fixture();try{const missing=join(f.root,'missing');await expect(openFrameworkRuntime({...f.options,stateRoot:missing})).rejects.toThrow();expect(existsSync(missing)).toBe(false);expect(fake.calls).toEqual([]);}finally{f.dispose();}
});

it.each(['missing-store','missing-marker','empty-marker','missing-journal','empty-journal','wrong-journal','wrong-drive','wrong-type'])('X1 refuses %s without replacement or empty observation',async kind=>{
 const f=fixture();try {
 if(kind==='missing-store')rmSync(join(f.root,'pglite'),{recursive:true});
 if(kind==='missing-marker')unlinkSync(join(f.root,'pglite/PG_VERSION'));
 if(kind==='empty-marker')writeFileSync(join(f.root,'pglite/PG_VERSION'),'');
 if(kind==='missing-journal')unlinkSync(join(f.root,'commands.sqlite'));
 if(kind==='empty-journal')writeFileSync(join(f.root,'commands.sqlite'),'');
 if(kind==='wrong-journal')writeFileSync(join(f.root,'commands.sqlite'),'not SQLite');
 if(kind==='wrong-drive')fake.drive=()=>({header:{id:'other',documentType:'powerhouse/document-drive'}});
 if(kind==='wrong-type')fake.drive=()=>({header:{id:'retained-drive',documentType:'other'}});
 await expect(openFrameworkRuntime(f.options)).rejects.toThrow();expect(fake.calls).not.toContain('create-drive');
 if(kind.startsWith('wrong-d')||kind==='wrong-type'){expect(fake.calls).toContain('drive-read');expect(fake.calls).toContain('db-close');}else expect(fake.calls).toEqual([]);
 expect(existsSync(join(f.root,'writer.lock'))).toBe(false);
 }finally{f.dispose();}
});

it('rechecks exact drive before observations after readiness',async()=>{
 const f=fixture();try{const runtime=await openFrameworkRuntime(f.options);fake.drive=()=>({header:{id:'other',documentType:'powerhouse/document-drive'}});await expect(runtime.authority.backend.readPilotAllocations!()).rejects.toThrow('existing_authority_drive_unavailable');expect(fake.calls).not.toContain('create-drive');await runtime.close();}finally{f.dispose();}
});

it('admits umask022-created0755/0644 store paths under private root',async()=>{
 const f=fixture();const prior=process.umask(0o022);try{
 rmSync(join(f.root,'pglite'),{recursive:true});unlinkSync(join(f.root,'commands.sqlite'));
 mkdirSync(join(f.root,'pglite'));writeFileSync(join(f.root,'pglite/PG_VERSION'),'17\n');writeFileSync(join(f.root,'commands.sqlite'),'SQLite format 3\0fixture');
 const runtime=await openFrameworkRuntime(f.options);await runtime.close();
 }finally{process.umask(prior);f.dispose();}
});
it.each(['root','pglite','pglite/PG_VERSION','commands.sqlite','root-after-check'])('refuses unsafe permissions on %s',async target=>{
 const f=fixture();try{
 if(target!=='root-after-check')chmodSync(target==='root'?f.root:join(f.root,target),target==='root'?0o755:0o777);
 await expect(openFrameworkRuntime({...f.options,beforeDatabaseOpen:target==='root-after-check'?()=>chmodSync(f.root,0o755):undefined})).rejects.toThrow();expect(fake.calls).toEqual([]);
 }finally{chmodSync(f.root,0o700);f.dispose();}
});
