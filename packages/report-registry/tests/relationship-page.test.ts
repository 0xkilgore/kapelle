import {test} from 'node:test';
import assert from 'node:assert/strict';
import {outgoingPage} from '../deploy/report-listing-runtime/outgoing-page.ts';
test('native outgoing reader preserves cursor past 100 and hydrates exactly one page',async()=>{
 const ids=Array.from({length:1804},(_,i)=>'id-'+i);let calls=0;
 const host={documentView:{resolveIdOrSlug:async(id:string)=>{assert.equal(id,'drive');return id;}},documentIndexer:{getOutgoing:async(id:string,types:string[],p:any)=>{assert.equal(id,'drive');assert.deepEqual(types,['child']);const offset=Number(p.cursor);calls++;return {results:ids.slice(offset,offset+p.limit).map(targetId=>({targetId})),nextCursor:offset+p.limit<ids.length?String(offset+p.limit):undefined};}},reactor:{find:async(s:any,v:any,p:any)=>{assert.equal(p.cursor,'0');return {results:s.ids.map((id:string)=>({header:{id}}))};}}};
 const seen:string[]=[];let p:any=await outgoingPage.call(host,'drive','child',undefined,{limit:500},undefined);
 while(true){seen.push(...p.results.map((d:any)=>d.header.id));if(!p.next)break;p=await p.next();}
 assert.deepEqual(seen,ids);assert.equal(calls,4);
 await assert.rejects(outgoingPage.call(host,'drive','child',undefined,{cursor:'-1',limit:500},undefined),/PAGING_INVALID/);
 host.reactor.find=async()=>({results:[]});await assert.rejects(outgoingPage.call(host,'drive','child',undefined,{limit:100},undefined),/PAGE_DRIFT/);
});
