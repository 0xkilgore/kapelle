import 'server-only';
import {createHash} from 'node:crypto';
import {boundedReportMcpBody} from './reportRegistryBounds';
import {validatedMcpEndpoint,reportRegistryAuthorizationHeader} from './reportRegistryTransport';
import {normalizeReportDocument} from './reportRegistryContract';
import type {ReportBindingRead} from './reportRegistryUncached';

const READ_BUDGET_MS=6000, RETRY_BACKOFF_MS=250, RETRY_MIN_ATTEMPT_MS=1500;
const TRANSIENT_REFUSALS=new Set(['report_projection_unavailable','reader_busy']);
async function transientRefusal(response:Response){
  if(response.status!==503)return false;
  try {return TRANSIENT_REFUSALS.has(JSON.parse(await boundedReportMcpBody(response))?.error);} catch {return false;}
}
function pause(ms:number,signal:AbortSignal){
  return new Promise<void>((resolve,reject)=>{
    if(signal.aborted)return reject(signal.reason);
    const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);
    function stop(){clearTimeout(timer);reject(signal.reason);}
    signal.addEventListener('abort',stop,{once:true});
  });
}

/** A summary is discovery only. Every open requires this independent authority read. */
export async function readSelectedReport(documentId:string, signal?:AbortSignal):Promise<ReportBindingRead> {
  try {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(documentId)) throw Error('Invalid identity');
    const configured=process.env.KAPELLE_REPORT_DETAIL_URL?.trim();
    const driveId=process.env.KAPELLE_REPORT_REGISTRY_DRIVE_ID?.trim();
    const auth=reportRegistryAuthorizationHeader(process.env.KAPELLE_REPORT_REGISTRY_MCP_TOKEN);
    const base=configured && validatedMcpEndpoint(configured,(process.env.KAPELLE_REPORT_REGISTRY_ALLOWED_HOSTS??'').split(',').map(v=>v.trim()).filter(Boolean));
    if(!base||!driveId||!auth)throw Error('Unconfigured reader');
    const url=new URL(base);
    if(url.pathname!=='/v2/reports'||url.search||url.hash)throw Error('Invalid reader endpoint');
    url.pathname+='/'+encodeURIComponent(documentId);
    const started=Date.now(),deadline=AbortSignal.any([AbortSignal.timeout(READ_BUDGET_MS),...(signal?[signal]:[])]);
    const read=()=>fetch(url,{method:'GET',headers:{authorization:auth,accept:'application/json'},cache:'no-store',redirect:'error',signal:deadline});
    let response=await read();
    // One bounded retry for a transient Registry refusal (busy reader, or the proxy's 5 s Reactor budget), only while the same
    // 6 s budget still leaves room for a real attempt. Any other status, or a second refusal, fails closed as before.
    if(await transientRefusal(response)&&READ_BUDGET_MS-(Date.now()-started)-RETRY_BACKOFF_MS>=RETRY_MIN_ATTEMPT_MS){
      await pause(RETRY_BACKOFF_MS,deadline);
      response=await read();
    }
    if(!response.ok||!/application\/json/i.test(response.headers.get('content-type')??''))throw Error('Read unavailable');
    const value=JSON.parse(await boundedReportMcpBody(response));
    const expected=['schemaVersion','source','driveId','observedAt','availability','document'];
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==expected.length||!expected.every(k=>Object.hasOwn(value,k))||value.schemaVersion!=='kapelle.report-detail.v2'||value.source!=='vetra-report-registry'||value.driveId!==driveId)throw Error('Invalid read');
    const at=Date.parse(value.observedAt);
    if(typeof value.observedAt!=='string'||!Number.isFinite(at)||Date.now()-at>30_000||at>Date.now()+1000)throw Error('Stale read');
    if(value.availability==='withdrawn'||value.availability==='superseded') {
      if(value.document!==null)throw Error('Invalid historical response');
      return {availability:'unavailable',report:null,error:value.availability==='withdrawn'?'This report was withdrawn.':'This report was replaced by a newer result.'};
    }
    if(value.availability!=='available')throw Error('Report unavailable');
    const report=normalizeReportDocument(value.document);
    if(!report||report.documentId!==documentId||report.lifecycle!=='FINAL'||report.sourceRef?.startsWith('fixture://'))throw Error('Report changed');
    // Private publications are descriptors only. The page must independently read
    // and verify their bytes through the existing owner-scoped publication store.
    const content=report.content;
    if(content.storage==='BLOB') {
      const publication=/^report:publication:([a-f0-9]{64}):[a-f0-9]{64}:v[1-9][0-9]*$/.exec(report.reportRef);
      if(!publication||!['text/markdown','text/csv'].includes(content.mimeType)||content.markdown!==null||content.byteSize<0||content.byteSize>256*1024||!/^[a-f0-9]{64}$/.test(content.contentHash)||content.blobRef!==`blob:kapelle:${publication[1]}:${content.contentHash}`)throw Error('Unsupported publication descriptor');
      return {availability:'authoritative',report,error:null};
    }
    if(content.storage!=='INLINE_MARKDOWN'||typeof content.markdown!=='string'||content.mimeType!=='text/markdown'||content.byteSize>1_000_000||Buffer.byteLength(content.markdown,'utf8')!==content.byteSize||createHash('sha256').update(content.markdown,'utf8').digest('hex')!==content.contentHash.replace(/^sha256:/,''))throw Error('Unverified content');
    return {availability:'authoritative',report,error:null};
  } catch {return {availability:'unavailable',report:null,error:'This report could not be verified. Try again shortly.'};}
}
