import {isDeepStrictEqual} from 'node:util';
const LIMIT=500, MAX_IDS=10000, MAX_BYTES=16000000;
type Call = (query:string,variables:Record<string,unknown>,remainingMs:number)=>Promise<unknown>;
export async function scopedReportList(driveId:string, identities:boolean, query:Call, membership:()=>Promise<string[]>, timeoutMs=15000) {
 const started=Date.now();let bytes=0;const before=await membership();
 const check=()=>{if(Date.now()-started>=timeoutMs)throw Error('SCOPED_LIST_DEADLINE');};
 const scan=async()=>{
  const rows:any[]=[];const seen=new Set<string>();let cursor='0';
  while(true){
   check();
   const fields=identities?'id name documentType state { global { reportRef publication { publicationId } } }':'id name documentType';
   const body=`query($drive:String!,$paging:${identities?'ReportRegistry_':''}PagingInput){${identities?'ReportRegistry {':''}documentOutgoingRelationships(sourceIdentifier:$drive,relationshipType:"child",paging:$paging){items{${fields}} hasNextPage cursor}${identities?'}':''}}`;
   const result:any=await query(body,{drive:driveId,paging:{cursor,limit:LIMIT}},timeoutMs-(Date.now()-started));
   bytes+=Buffer.byteLength(JSON.stringify(result));if(bytes>MAX_BYTES)throw Error('SCOPED_LIST_BYTE_BOUND');check();
   if(result?.errors?.length)throw Error('SCOPED_LIST_QUERY_FAILED');
   const page=identities?result?.data?.ReportRegistry?.documentOutgoingRelationships:result?.data?.documentOutgoingRelationships;
   if(!page||!Array.isArray(page.items)||page.items.length>LIMIT||typeof page.hasNextPage!=='boolean')throw Error('SCOPED_LIST_INVALID');
   for(const row of page.items){
    if(typeof row.id!=='string'||!row.id||row.id.length>256||typeof row.name!=='string'||typeof row.documentType!=='string'||seen.has(row.id))throw Error('SCOPED_LIST_DUPLICATE_OR_INVALID');
    if(identities&&(row.documentType!=='kilgore/report'||typeof row.state?.global?.reportRef!=='string'||!Object.hasOwn(row.state.global,'publication')||(row.state.global.publication!==null&&typeof row.state.global.publication?.publicationId!=='string')))throw Error('SCOPED_LIST_IDENTITY_INVALID');
    seen.add(row.id);rows.push(row);if(rows.length>MAX_IDS)throw Error('SCOPED_LIST_COUNT_BOUND');
   }
   if(!page.hasNextPage){if(page.cursor!=null)throw Error('SCOPED_LIST_CURSOR_INVALID');break;}
   if(!page.items.length||typeof page.cursor!=='string'||! /^(0|[1-9][0-9]*)$/.test(page.cursor)||Number(page.cursor)!==Number(cursor)+page.items.length)throw Error('SCOPED_LIST_CURSOR_INVALID');
   cursor=page.cursor;
  }
  return rows.sort((a,b)=>a.id.localeCompare(b.id));
 };
 const rows=await scan();
 // Identity scans fence metadata changes as well as membership drift.
 if(identities&&!isDeepStrictEqual(rows,await scan()))throw Error('SCOPED_LIST_IDENTITY_CHANGED');
 const after=await membership();check();
 const expected=[...before].sort(),actual=rows.map(x=>x.id).sort();
 if(before.length>MAX_IDS||new Set(before).size!==before.length||!isDeepStrictEqual(expected,actual)||!isDeepStrictEqual(actual,[...after].sort()))throw Error('SCOPED_LIST_INCOMPLETE');
 return {documentIds:actual,totalCount:actual.length,hasMore:false,nextCursor:null,...(identities?{identities:rows.map(row=>({header:{id:row.id,name:row.name,documentType:row.documentType},state:{global:row.state.global}}))}:{})};
}
