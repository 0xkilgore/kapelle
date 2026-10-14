import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HttpReportRegistryMcp} from '../src/mcp-client.ts';

test('request framing failure occurs before durable marker or transport',async()=>{
 const old=globalThis.fetch;let markers=0,sends=0;
 globalThis.fetch=async()=>{sends++;throw Error('unexpected send');};
 try{const args:Record<string,unknown>={};args.cycle=args;
  await assert.rejects(new HttpReportRegistryMcp('http://127.0.0.1:1/mcp','t'.repeat(40)).callWithStart('createDocument',args,()=>{markers++;}),/circular/i);
  assert.equal(markers,0);assert.equal(sends,0);
 }finally{globalThis.fetch=old;}
});
test('marker failure prevents send; possibly-sent rejection retains marker',async()=>{
 const old=globalThis.fetch;let marked=false,sends=0;
 globalThis.fetch=async()=>{sends++;assert.equal(marked,true);throw Error('lost response');};
 try{const client=new HttpReportRegistryMcp('http://127.0.0.1:1/mcp','t'.repeat(40));
  await assert.rejects(client.callWithStart('createDocument',{},()=>{throw Error('marker failed');}),/marker failed/);assert.equal(sends,0);
  await assert.rejects(client.callWithStart('createDocument',{},()=>{marked=true;}),/lost response/);assert.equal(marked,true);assert.equal(sends,1);
 }finally{globalThis.fetch=old;}
});
test('ordinary transport retains response verification with no start hook',async()=>{
 const old=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({jsonrpc:'2.0',result:{structuredContent:{ok:true}}}),{status:200});
 try{assert.deepEqual(await new HttpReportRegistryMcp('http://127.0.0.1:1/mcp','t'.repeat(40)).call('getDocuments',{}),{ok:true});}
 finally{globalThis.fetch=old;}
});
