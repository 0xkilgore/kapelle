import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';
// Synthetic service state survives a destroyed publisher process. No real host access.
import {existsSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {taskFixture} from './task-publication.ts';
import {PrivateTaskReportPublisher} from '../../src/task-publication.ts';
const [root,mode]=process.argv.slice(2),f=taskFixture(root),stateFile=join(root,'native-fixture.json');
if(existsSync(stateFile)){const s=JSON.parse(readFileSync(stateFile,'utf8'));f.mcp.docs=new Map(s.docs);f.mcp.writes=s.writes;}
if(mode==='kill-retain'||mode==='observe-retain'){
 const link=fs.linkSync;
 fs.linkSync=(source,destination)=>{
  link(source,destination);
  if(String(destination).includes('/.task-plan-')){
   if(mode==='kill-retain')process.kill(process.pid,'SIGKILL');
   const child=spawnSync(process.execPath,['--experimental-strip-types',process.argv[1],root,'lookup-retained'],{encoding:'utf8',timeout:10000});
   if(child.status!==0)throw Error(child.stderr);
   console.log('CONCURRENT='+child.stdout.trim());
  }
 };
 syncBuiltinESMExports();
}
if(mode==='unlink-during-read'){
 const read=fs.readFileSync;let unlinked=false;
 fs.readFileSync=((...args:any[])=>{
  const result=(read as any)(...args);
  if(typeof args[0]==='number'&&!unlinked){
   const state=fs.fstatSync(args[0]),receiptDir=join(root,'receipts');
   for(const name of fs.readdirSync(receiptDir)){
    if(!name.endsWith('.tmp'))continue;const path=join(receiptDir,name),alias=fs.lstatSync(path);
    if(alias.dev===state.dev&&alias.ino===state.ino){fs.unlinkSync(path);unlinked=true;break;}
   }
  }
  return result;
 }) as typeof fs.readFileSync;
 syncBuiltinESMExports();
}
if(mode==='lookup'||mode==='lookup-retained'||mode==='unlink-during-read'){
 const publisher=new PrivateTaskReportPublisher({...f.options,now:()=>{throw Error('lookup called clock');}});
 const result=await publisher.lookup(f.request);console.log(JSON.stringify(mode==='lookup'?result:{result,calls:f.mcp.calls,writes:f.mcp.writes}));
}else{
 const call=f.mcp.call.bind(f.mcp);
 f.mcp.call=async(name,args)=>{
  const result=await call(name,args);
  if(name==='createDocument'||name==='addActions'){
   const fd=openSync(stateFile,'w',0o600);try{writeFileSync(fd,JSON.stringify({docs:[...f.mcp.docs],writes:f.mcp.writes}));fsyncSync(fd);}finally{closeSync(fd);}
   if((mode==='kill-create'&&name==='createDocument')||(mode==='kill-register'&&name==='addActions'))process.kill(process.pid,'SIGKILL');
  }
  return result;
 };
 await f.publisher.publish(f.request);
 if(mode!=='observe-retain')throw Error('expected process destruction');
}
