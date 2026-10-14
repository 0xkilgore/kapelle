import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Fake} from './private-publication.ts';
import {PrivateTaskReportPublisher,type TaskPublicationRequest,type TaskPublisherAdmission} from '../../src/task-publication.ts';
import {modelInventoryDigest} from '../../src/private-publication.ts';
export function taskFixture(root:string){
 const sha=(s:string)=>'sha256:'+createHash('sha256').update(s).digest('hex');
 const dispatchId='a39b67b6-41b8-4c09-af8b-49c693311298',inputHash=sha('input'),markdown='# Task result\nSynthetic evidence.\n';
 const request:TaskPublicationRequest={publicationId:'task-report:'+sha(JSON.stringify({dispatchId,inputHash})).slice(7),ownerId:'owner',scopeRef:'scope',instanceId:'instance',dispatchId,inputHash,taskId:'task',sourceRef:'dispatch:'+dispatchId,packetHash:sha('packet'),executionHash:sha('execution'),markdown,contentHash:sha(markdown)};
 const author={id:'instance',label:'Synthetic author',instanceId:'instance',definitionId:'definition',definitionVersion:'1',definitionHash:sha('definition')};
 const admission:TaskPublisherAdmission={bindingRef:'synthetic-host-admission',ownerId:'owner',scopeRef:'scope',driveId:'drive',actorId:'publisher-actor',authorizationRef:'synthetic:approval',libraryOrigin:'https://private.example',author,publisher:{...author,id:'publisher',instanceId:'publisher'}};
 const mcp=new Fake(),options={bindingRef:admission.bindingRef,receiptDir:join(root,'receipts'),lockDir:join(root,'locks'),mcp,reader:{call:mcp.call.bind(mcp)},authorize:async()=>admission,now:()=> '2026-09-28T12:00:00.000Z',modelAdmission:{value:qualifiedModelAdmission('http://127.0.0.1:4251/mcp','drive'),endpoint:'http://127.0.0.1:4251/mcp'}};
 return {request,admission,mcp,options,publisher:new PrivateTaskReportPublisher(options)};
}
/** A QUALIFIED_LIVE admission for the composed 49-file model shipped in this package (synthetic receipt ref). */
export function qualifiedModelAdmission(endpoint:string,driveId:string,validUntil='2026-10-20T00:00:00.000Z'){
 const inventory=JSON.parse(readFileSync(new URL('../../deploy/report-listing-runtime/model-inventory.json',import.meta.url),'utf8'));
 const nativeSchemaHash=createHash('sha256').update(readFileSync(new URL('../../document-models/report-registry/v1/schema.graphql',import.meta.url))).digest('hex');
 return {schemaVersion:'kapelle.report-publication-model-admission.v2',status:'QUALIFIED_LIVE',endpoint,driveId,nativeSchemaHash,releaseReceiptRef:'fixture://qualified-runtime',runtimeInventory:inventory,
  deployment:{releaseId:'fixture-release',modelDigest:modelInventoryDigest(inventory)},validUntil};
}
