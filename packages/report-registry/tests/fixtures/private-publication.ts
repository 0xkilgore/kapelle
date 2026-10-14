import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadPromotionRequest,buildPromotionRequestPlan,promotePromotionRequest} from '../../src/promotion-request.ts';
import {publishPrivateRequest,parsePrivateBinding,CompletePrivateReportMcp,assertNativeModelAdmission} from '../../src/private-publication.ts';
import type {ReportRegistryMcp} from '../../src/mcp-client.ts';
import {promotionIntentName} from '../../src/promote.ts';
import {modelInventoryDigest} from '../../src/private-publication.ts';
export function packageModelDigest(){return modelInventoryDigest(JSON.parse(readFileSync(new URL('../../deploy/report-listing-runtime/model-inventory.json',import.meta.url),'utf8')));}
export class Fake implements ReportRegistryMcp {
 docs=new Map<string,any>();writes=0;calls=0;fault='';incomplete=false;corrupt=false;lookupFault='';lookupMemberSkew=0;pointFault='';deploymentFault='';
 /** The deployment behind this fake endpoint: the composed 49-file model under release 'fixture-release'. */
 deployment:{bootId:string;releaseId:string;modelDigest:string;currentReleaseId?:string;currentModelDigest?:string}={bootId:'boot-1',releaseId:'fixture-release',modelDigest:packageModelDigest()};
 /** Old 47-file Registry model (live Registry until the publication overlay is adopted): REGISTER_REPORT drops `publication`. */
 legacyModel=false;
 async call(name:string,args:Record<string,unknown>):Promise<any>{
  this.calls++;
  const envelope={schemaVersion:'kapelle.report-drive-snapshot.v1',driveId:'drive',branch:'main',complete:!this.incomplete,totalCount:this.docs.size,hasMore:false,nextCursor:null,snapshotDigest:'a'.repeat(64)};
  if(name==='getReportIdentities')return {...envelope,documentIds:[...this.docs.keys()],identities:[...this.docs.values()].map(d=>({header:d.header,state:{global:{reportRef:d.state.global.reportRef??'',publication:d.state.global.publication??null}}}))};
  if(name==='getDocuments')return {...envelope,documentIds:this.incomplete?[]:[...this.docs.keys()]};
  if(name==='getRegistryDeploymentV1'){
   // Mirrors deploy/report-summary-read/deployment.mjs: this process's release id and loaded model digest (boot and now).
   if(this.deploymentFault==='unavailable')throw Error('REGISTRY_DEPLOYMENT_UNAVAILABLE');
   const d=this.deployment;return {deployment:{schemaVersion:'kapelle.registry-deployment.v1',driveId:'drive',bootId:d.bootId,startedAt:'2026-09-28T00:00:00.000Z',bootReleaseId:d.releaseId,releaseId:d.currentReleaseId??d.releaseId,
    bootModelDigest:d.modelDigest,currentModelDigest:d.currentModelDigest??d.modelDigest,observedAt:new Date().toISOString()}};
  }
  if(name==='getReportDocumentV1'){
   // Mirrors deploy/report-summary-read/detail.mjs pointReader: a scoped proof for a current Drive member only; a member with
   // no registration yet is returned as blank (the publisher's own create intent).
   const d=this.docs.get(String(args.id));if(!d||this.pointFault==='unavailable')throw Error('REPORT_DETAIL_UNAVAILABLE');
   const doc=structuredClone(d);if(this.corrupt&&doc.state.global.content)doc.state.global.content.markdown='tampered';
   const g=doc.state.global,blank=!g.reportRef;
   const global=blank?{...g,reportRef:'',revision:0,lifecycle:'DRAFT'}:g;
   return {read:{schemaVersion:'kapelle.report-document-read.v1',driveId:'drive',documentId:doc.header.id,stamp:'b'.repeat(64),lifecycle:global.lifecycle,revision:global.revision,blank,observedAt:new Date().toISOString(),
    document:{header:{id:doc.header.id,name:doc.header.name??'',documentType:doc.header.documentType??'kilgore/report'},state:{global}}}};
  }
  if(name==='lookupReportPublicationV1'){
   // Mirrors deploy/report-summary-read/publication-lookup.mjs over the document map (both model modes): registered by
   // reportRef, pending by intent name with an empty ref, the selected body only for an unambiguous 1/0 or 0/1.
   if(this.lookupFault==='unverified')throw Error('PUBLICATION_LOOKUP_UNVERIFIED');
   const reportRef=String(args.reportRef),intentName=promotionIntentName(reportRef),docs=[...this.docs.values()];
   const registered=docs.filter(d=>d.state.global.reportRef===reportRef),pending=docs.filter(d=>!d.state.global.reportRef&&d.header.name===intentName);
   const selected=registered.length===1&&pending.length===0?registered:registered.length===0&&pending.length===1?pending:[];
   return {lookup:{schemaVersion:'kapelle.publication-lookup.v1',driveId:'drive',reportRef,intentName,observedAt:new Date().toISOString(),registeredCount:registered.length,pendingCount:pending.length,
    memberCount:this.docs.size+this.lookupMemberSkew,documents:selected.map(d=>structuredClone({header:{id:d.header.id,name:d.header.name,documentType:d.header.documentType},state:{global:d.state.global}}))}};
  }
  if(name==='getDocument'){
   if(args.id==='drive')return {document:{header:{id:'drive',documentType:'powerhouse/document-drive'},state:{global:{nodes:[...this.docs.keys()].map(id=>({id,kind:'file'}))}}}};
   const doc=structuredClone(this.docs.get(String(args.id)));if(this.corrupt&&doc.state.global.content)doc.state.global.content.markdown='tampered';return {document:doc};
  }
  if(name==='createDocument'){
   this.writes++;const id='doc-'+(this.docs.size+1);const doc={header:{id,name:args.name,documentType:'kilgore/report'},state:{global:{}}};this.docs.set(id,doc);if(this.fault==='create'){this.fault='';throw Error('lost create response');}return {document:structuredClone(doc)};
  }
  if(name==='addActions'){
   this.writes++;const doc=this.docs.get(String(args.documentId));
   for(const action of args.actions as any[]){
    if(action.type==='REGISTER_REPORT'){
     assert.equal(doc.state.global.reportRef,undefined);const input=structuredClone(action.input);if(this.legacyModel)delete input.publication;doc.state.global={...input,createdBy:action.input.actorId,revision:1,attention:{request:'NONE',reasonCode:null,reason:null,reviewBy:null,expiresAt:null}};
     if(this.fault==='register'){this.fault='';throw Error('lost register response');}
    }else {assert.equal(action.input.expectedRevision,doc.state.global.revision);doc.state.global.attention={...action.input};doc.state.global.revision++;}
   }
   if(this.fault==='actions'){this.fault='';throw Error('lost batch response');}return {ok:true};
  }
  throw Error('unexpected tool');
 }
}
export function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'private-report-')));const contentPath=join(root,'report.md');const body='# Synthetic private report\n';writeFileSync(contentPath,body);const hash=createHash('sha256').update(body).digest('hex');
 const agent={id:'author',label:'Author',instanceId:null,definitionId:null,definitionVersion:null,definitionHash:null};
 const publication={publicationId:'private:test:1',author:agent,publisher:{...agent,id:'publisher',label:'Publisher'},runRef:'agent://run/1',sourceRef:'agent://source/1',provenanceRef:'agent://evidence/1',contentHash:hash,contentVersion:1,authorizationRef:'approval://private/1',publishedAt:'2026-09-24T19:00:00.000Z'};
 const request={schemaVersion:'report-promotion-request.v2',contentPath,title:'Synthetic',reportRef:'report:test:private:1',sourceRef:publication.sourceRef,expectedContentHash:hash,expectedByteSize:Buffer.byteLength(body),producer:{kind:'AGENT',id:'author',label:'Author'},attention:{request:'READ'},occurredAt:publication.publishedAt,publication};const path=join(root,'request.json');writeFileSync(path,JSON.stringify(request));const admitted=loadPromotionRequest(path,root);
 const binding=parsePrivateBinding({schemaVersion:'kapelle.private-report-publisher.v1',driveId:'drive',actorId:'service:publisher',author:publication.author,publisher:publication.publisher,authorizationRef:publication.authorizationRef,reportRef:request.reportRef,sourceRef:request.sourceRef,contentHash:hash,publicationId:publication.publicationId,libraryOrigin:'https://private.example',nativePublicationSchema:'kilgore/report.publication.v1'});
 const runtime={confirmation:'promote-to-live-report-registry',planDigest:buildPromotionRequestPlan(admitted).planDigest,driveId:'drive',actorId:'service:publisher',receiptDir:join(root,'receipts'),lockDir:join(root,'locks')};return {admitted,binding,runtime};
}
