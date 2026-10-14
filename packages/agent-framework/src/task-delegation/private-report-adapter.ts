import {createHash} from 'node:crypto';
import {z} from 'zod';
import {digest} from '../content.js';
import {publicationRequestSchema,reportReceiptSchema,reportResultFact,type TaskReportAdapter,type TaskReportRequest,type TaskReportReceipt,type TaskReportRead} from './worker-contract.js';

/** Structural library boundary, implemented by report-registry-package's
 * PrivateTaskReportPublisher. No runtime import across worktrees or legacy Manager.
 * Ports are installed by the host, never selected/configured by a browser request. */
export interface PrivateTaskPublicationPort {
 readonly bindingRef:string;
 readonly publicationStartBoundary?:'transport';
 admitted(request:TaskReportRequest):Promise<boolean>;
 publish(request:TaskReportRequest):Promise<unknown>;
 lookup(request:TaskReportRequest):Promise<unknown|null>;
 read(publicationId:string):Promise<unknown>;
 /** Publisher d089023+: model admission + live deployment check with no artifacts (host binds the Drive). */
 publishReady?():Promise<void>;
}
const id=z.string().min(1).max(200),bare=z.string().regex(/^[a-f0-9]{64}$/);
const agent=z.object({id:z.string(),label:z.string(),instanceId:z.string().nullable(),definitionId:z.string().nullable(),definitionVersion:z.string().nullable(),definitionHash:bare.nullable()}).strict();
const evidence=z.object({
 documentId:id,driveId:z.string().min(1),reportRef:z.string(),sourceRef:z.string(),producerId:id,revision:z.number().int().positive(),
 publication:z.object({publicationId:id,author:agent,publisher:agent,runRef:z.string(),sourceRef:z.string(),provenanceRef:z.string(),contentHash:bare,contentVersion:z.number().int().positive(),authorizationRef:z.string().min(1),publishedAt:z.iso.datetime()}).strict(),
 markdown:z.string().min(1).max(32000),planDigest:bare,verificationRef:id,
 scope:z.object({ownerId:id,scopeRef:id,driveId:z.string().min(1),admissionRef:id}).strict(),
}).strict();
function assert(ok:unknown):asserts ok{if(!ok)throw Error('task_report_native_evidence_mismatch');}
function hash(s:string){return createHash('sha256').update(s).digest('hex');}
function parse(value:unknown,bindingRef:string){
 const e=evidence.parse(value),p=e.publication;
 const match=/^kapelle-task:\/\/dispatch\/([a-f0-9-]{36})\?input=([a-f0-9]{64})$/.exec(p.runRef);
 assert(match);const dispatchId=z.uuid().parse(match[1]),inputHash='sha256:'+match[2];
 assert(/^kapelle-task:\/\/execution\/[a-f0-9]{64}\?packet=[a-f0-9]{64}$/.test(p.provenanceRef));
 assert(p.publicationId==='task-report:'+digest({dispatchId,inputHash}).slice(7));
 assert(e.scope.admissionRef===bindingRef&&e.scope.driveId===e.driveId);
 assert(e.sourceRef==='dispatch:'+dispatchId&&p.sourceRef===e.sourceRef);
 assert(e.reportRef==='report:task:'+p.publicationId.slice(12));
 assert(e.producerId===p.author.id&&e.producerId===p.author.instanceId);
 assert(hash(e.markdown)===p.contentHash);
 assert(e.verificationRef==='private-report:'+hash(JSON.stringify({driveId:e.driveId,documentId:e.documentId,planDigest:e.planDigest})));
 return {e,dispatchId,inputHash};
}
function receipt(value:ReturnType<typeof parse>):TaskReportReceipt {
 const {e,dispatchId,inputHash}=value;
 return reportReceiptSchema.parse({publicationId:e.publication.publicationId,dispatchId,inputHash,reportId:e.documentId,contentVersion:e.publication.contentVersion,contentHash:'sha256:'+e.publication.contentHash,verificationRef:e.verificationRef});
}
export class PrivateTaskReportAdapter implements TaskReportAdapter {
 readonly bindingRef:string;
 readonly publicationStartBoundary?:'transport';
 private readonly port:PrivateTaskPublicationPort;
 constructor(port:PrivateTaskPublicationPort){this.bindingRef=id.parse(port.bindingRef);this.publicationStartBoundary=port.publicationStartBoundary;this.port=port;}
 async admitted(request:TaskReportRequest){return this.port.admitted(publicationRequestSchema.parse(request));}
 /** Defined only when the publisher has a publish gate; existing-Report reads never use it. */
 get publishReady(){const port=this.port;return port.publishReady?()=>port.publishReady!():undefined;}
 private match(request:TaskReportRequest,value:unknown){
  const parsed=parse(value,this.bindingRef),{e,dispatchId,inputHash}=parsed;
  assert(e.publication.publicationId===request.publicationId&&dispatchId===request.dispatchId&&inputHash===request.inputHash);
  assert(e.scope.ownerId===request.ownerId&&e.scope.scopeRef===request.scopeRef&&e.producerId===request.instanceId);
  assert(e.markdown===request.markdown&&'sha256:'+e.publication.contentHash===request.contentHash);
  assert(e.publication.provenanceRef==='kapelle-task://execution/'+request.executionHash.slice(7)+'?packet='+request.packetHash.slice(7));
  // This bridge creates version 1; a changed native version is not a retry receipt.
  assert(e.publication.contentVersion===1);return receipt(parsed);
 }
 async publish(value:TaskReportRequest){const request=publicationRequestSchema.parse(value);return this.match(request,await this.port.publish(request));}
 async lookup(value:TaskReportRequest){const request=publicationRequestSchema.parse(value),result=await this.port.lookup(request);return result===null?null:this.match(request,result);}
 async read(value:TaskReportReceipt):Promise<TaskReportRead>{
  const expected=reportReceiptSchema.parse(value),parsed=parse(await this.port.read(expected.publicationId),this.bindingRef),actual=receipt(parsed);
  assert(Object.entries(expected).every(([key,v])=>actual[key as keyof TaskReportReceipt]===v));
  const {e,dispatchId,inputHash}=parsed;
  return {id:e.documentId,ownerId:e.scope.ownerId,scopeRef:e.scope.scopeRef,reportRef:e.reportRef,sourceRef:e.sourceRef,bytes:Buffer.from(e.markdown),revision:e.revision,
   contentVersion:e.publication.contentVersion,publicationId:e.publication.publicationId,dispatchId,inputHash,producerId:e.producerId,verificationRef:e.verificationRef};
 }
}
/** Host facts must perform an independent read; never install reportResultFact on
 * an unverified publisher/browser receipt. This helper does not issue native commands. */
export async function verifiedPrivateTaskResultFact(adapter:PrivateTaskReportAdapter,value:TaskReportReceipt){
 const receipt=reportReceiptSchema.parse(value);await adapter.read(receipt);return reportResultFact(receipt);
}
