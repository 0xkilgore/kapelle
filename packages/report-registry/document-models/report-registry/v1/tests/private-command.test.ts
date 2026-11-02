import {test,expect} from 'vitest';
import {mkdtempSync,writeFileSync,realpathSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {utils} from '../utils.js';
import {reducer} from '../gen/reducer.js';
import {registerReport} from '../gen/content/creators.js';
import {requestReview} from '../gen/attention/creators.js';
import {loadPromotionRequest,buildPromotionRequestPlan} from '../../../../src/promotion-request.ts';
import {publishPrivateRequest,parsePrivateBinding} from '../../../../src/private-publication.ts';
test('private command recovers lost registration response through actual native reducers and retains metadata/journal',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'native-private-report-')));const contentPath=join(root,'report.md');const markdown='# Research\n'+('a'.repeat(36703-11));writeFileSync(contentPath,markdown);const hash=createHash('sha256').update(markdown).digest('hex');
 const author={id:'claude-code',label:'Claude Code',instanceId:null,definitionId:null,definitionVersion:null,definitionHash:null};
 const publication={publicationId:'publication:fixture',author,publisher:{...author,id:'publishing-agent',label:'Publisher'},runRef:'agent://run/fixture',sourceRef:'agent://source/fixture',provenanceRef:'agent://provenance/fixture',contentHash:hash,contentVersion:1,authorizationRef:'approval://private/fixture',publishedAt:'2026-09-24T19:00:00.000Z'};
 const request={schemaVersion:'report-promotion-request.v2',contentPath,title:'Private research',reportRef:'report:private:fixture',sourceRef:publication.sourceRef,producer:{kind:'AGENT',id:author.id,label:author.label},expectedContentHash:hash,expectedByteSize:Buffer.byteLength(markdown),attention:{request:'READ'},occurredAt:publication.publishedAt,publication};
 const file=join(root,'request.json');writeFileSync(file,JSON.stringify(request));const admitted=loadPromotionRequest(file,root);const runtime={confirmation:'promote-to-live-report-registry',planDigest:buildPromotionRequestPlan(admitted).planDigest,driveId:'drive',actorId:'service:report-publisher',receiptDir:join(root,'receipts'),lockDir:join(root,'locks')};
 const binding=parsePrivateBinding({schemaVersion:'kapelle.private-report-publisher.v1',driveId:runtime.driveId,actorId:runtime.actorId,author,publisher:publication.publisher,reportRef:request.reportRef,sourceRef:request.sourceRef,contentHash:hash,publicationId:publication.publicationId,authorizationRef:publication.authorizationRef,libraryOrigin:'https://private.example',nativePublicationSchema:'kilgore/report.publication.v1'});
 let doc:ReturnType<typeof utils.createDocument>|undefined;let creates=0;let loseResponse=true;
 const mcp={async call(name:string,args:Record<string,unknown>):Promise<unknown>{
  // Complete drive-snapshot envelope: the publisher refuses any listing that does not prove completeness.
  const snapshot=(extra:Record<string,unknown>={})=>{const documentIds=doc?[doc.header.id]:[];return {schemaVersion:'kapelle.report-drive-snapshot.v1',driveId:runtime.driveId,branch:'main',complete:true,documentIds,totalCount:documentIds.length,hasMore:false,nextCursor:null,snapshotDigest:'a'.repeat(64),...extra};};
  if(name==='getReportIdentities')return snapshot({identities:doc?[{header:doc.header,state:{global:{reportRef:doc.state.global.reportRef,publication:doc.state.global.publication??null}}}]:[]});
  if(name==='getDocuments')return snapshot();
  if(name==='getDocument')return args.id==='drive'?{document:{header:{id:'drive',documentType:'powerhouse/document-drive'},state:{global:{nodes:doc?[{kind:'file',id:doc.header.id}]:[]}}}}:{document:structuredClone(doc)};
  if(name==='createDocument'){creates++;doc=utils.createDocument();doc.header.name=String(args.name);return {document:structuredClone(doc)};}
  if(name==='addActions'){
   for(const action of args.actions as Array<{type:string;input:any}>){doc=reducer(doc!,action.type==='REGISTER_REPORT'?registerReport(action.input):requestReview(action.input));expect(doc.operations.global.at(-1)?.error).toBeFalsy();}
   if(loseResponse){loseResponse=false;throw Error('lost response after native commit');}return {ok:true};
  }
  throw Error('unexpected tool');
 }};
 await expect(publishPrivateRequest(admitted,runtime,binding,mcp,mcp)).rejects.toThrow('lost response');
 const result=await publishPrivateRequest(admitted,runtime,binding,mcp,mcp);expect(creates).toBe(1);expect(doc!.operations.global).toHaveLength(2);expect(doc!.state.global.publication).toEqual(publication);expect(doc!.state.global.content?.markdown).toBe(markdown);expect(result.verifiedRevision).toBe(2);
 expect(JSON.parse(readFileSync(result.verificationReceiptPath,'utf8')).receipt.documentId).toBe(doc!.header.id);
});
