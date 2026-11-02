import assert from 'node:assert/strict';
import {it} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

it('SIGTERM drains an admitted upstream call before successful CLI exit', {timeout:10000}, async()=>{
 let release!:()=>void;let admitted!:()=>void;
 const gate=new Promise<void>(r=>release=r), started=new Promise<void>(r=>admitted=r);
 const upstream=createServer(async(req,res)=>{for await(const _ of req){} admitted();await gate;res.setHeader('content-type','application/json');res.end(JSON.stringify({result:{structuredContent:{ok:true}}}));});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const source=`import {createMcpAuthProxy,installProxyShutdown} from ${JSON.stringify(new URL('../deploy/mcp-auth-proxy.ts',import.meta.url).href)};
 const server=createMcpAuthProxy({readerToken:'r'.repeat(40),producerToken:'p'.repeat(40),driveId:'synthetic-drive',upstream:'http://127.0.0.1:${(upstream.address() as any).port}/mcp',audit:()=>{}});
 installProxyShutdown(server);server.listen(0,'127.0.0.1',()=>console.log(server.address().port));`;
 const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});
 const exited=once(child,'exit');let didExit=false;child.once('exit',()=>didExit=true);
 try{
  const [output]=await once(child.stdout,'data');const port=Number(output.toString().trim());assert.ok(port>0);
  const responsePromise=fetch('http://127.0.0.1:'+port+'/mcp',{method:'POST',headers:{authorization:'Bearer '+'p'.repeat(40),'content-type':'application/json'},body:JSON.stringify({method:'tools/call',params:{name:'addActions',arguments:{}}})});
  await started;child.kill('SIGTERM');await new Promise(r=>setTimeout(r,100));assert.equal(didExit,false,'must retain the admitted request while draining');
  release();const response=await responsePromise;assert.equal(response.status,200);assert.equal((await response.json() as any).result.structuredContent.ok,true);
  const [code,signal]=await exited;assert.equal(code,0);assert.equal(signal,null);
 }finally{release();if(!didExit)child.kill('SIGTERM');await new Promise<void>(r=>upstream.close(()=>r()));}
});
