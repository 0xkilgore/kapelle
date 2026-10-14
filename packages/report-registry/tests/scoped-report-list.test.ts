import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scopedReportList} from '../deploy/scoped-report-list.ts';
function fixture(count=1205){
 const members=Array.from({length:count},(_,i)=>'id-'+i);let calls=0;
 const query=async(q:string,v:any)=>{calls++;const start=Number(v.paging.cursor),limit=v.paging.limit;const page={items:members.slice(start,start+limit).map(id=>({id,name:id,documentType:'kilgore/report',state:{global:{reportRef:'report:'+id,publication:null}}})),hasNextPage:start+limit<count,cursor:start+limit<count?String(start+limit):null};return {data:q.includes('ReportRegistry {')?{ReportRegistry:{documentOutgoingRelationships:page}}:{documentOutgoingRelationships:page}};};
 return {members,query,calls:()=>calls,membership:async()=>[...members]};
}
test('complete metadata-only identity scan spans pages and repeats a stable snapshot',async()=>{const f=fixture();const result=await scopedReportList('drive',true,f.query,f.membership);assert.equal(result.identities?.length,1205);assert.equal(f.calls(),6);});
for(const fault of ['truncated','duplicate','cursor','drift','graphql','missing-publication'])test('rejects '+fault+' without partial result',async()=>{
 const f=fixture();let calls=0;
 const query=async(q:string,v:any)=>{const result:any=await f.query(q,v);const p=result.data.ReportRegistry.documentOutgoingRelationships;calls++;
 if(fault==='truncated'){p.items=p.items.slice(0,100);p.cursor=null;p.hasNextPage=false;}
 if(fault==='duplicate'&&calls===2)p.items[0].id='id-0';
 if(fault==='cursor')p.cursor='0';
 if(fault==='drift'&&calls===4)p.items[0].state.global.reportRef='changed';
 if(fault==='graphql')result.errors=[{message:'missing native publication schema'}];
 if(fault==='missing-publication')delete p.items[0].state.global.publication;
 return result;};
 await assert.rejects(scopedReportList('drive',true,query,f.membership),/SCOPED_LIST/);
});
test('membership change, byte excess, and deadline reject before returning scope',async()=>{
 const f=fixture(1);let m=0;await assert.rejects(scopedReportList('drive',false,f.query,async()=>++m===1?f.members:[]),/INCOMPLETE/);
 await assert.rejects(scopedReportList('drive',false,async()=>({padding:'x'.repeat(16000001)}),f.membership),/BYTE_BOUND/);
 await assert.rejects(scopedReportList('drive',false,f.query,f.membership,0),/DEADLINE/);
});
