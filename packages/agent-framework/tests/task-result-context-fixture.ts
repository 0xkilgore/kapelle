import { digest } from '../src/content.js';
import { dispatchOfferHash, instructionsHash } from '../src/dispatch/contracts.js';
import { sealReceipt } from '../src/publication/context-read-contracts.js';
import { publicationProposal } from '../src/publication/manifest.js';
import { TaskResultContextReader, type TaskResultBinding, type TaskResultReadPorts } from '../src/publication/task-result-context.js';
import { publicationFixture } from './publication-fixtures.js';
import { at, release } from './fixtures.js';

/** Fully fabricated pins; never use as installation configuration. */
export function taskResultFixture(ids: {reportId?:string;reviewId?:string} = {}) {
  const publication=publicationFixture(), m=structuredClone(publication.m), definition=release();
  if(ids.reportId) m.report.id=ids.reportId;
  publication.m=m;
  const manifest={documentRef:'context-manifest:synthetic',documentType:'kilgore/report',contentVersion:1,contentHash:digest('manifest')};
  const input={documentRef:'context-input:synthetic',documentType:'kilgore/report',contentVersion:1,contentHash:digest('input')};
  const offer={contentHash:'',scopeRef:m.scopeRef,task:{authorityRef:m.task.authorityRef,taskRef:m.task.authorityTaskRef,commitmentHash:m.task.commitmentHash},
    originalRequesterId:m.ownerId,senderId:m.ownerId,senderAgent:null,recipient:{instanceId:'original-agent',definitionId:definition.definitionId,definitionVersion:definition.packageVersion,definitionHash:definition.contentHash},
    parentDispatchRef:null,parentContentHash:null,continuationOfRef:null,instructions:'Prepare the synthetic result using the accepted source.',instructionsHash:'',sources:[manifest,input],permissionRef:'permission:synthetic',expiresAt:'2026-10-01T00:00:00.000Z'};
  offer.instructionsHash=instructionsHash(offer.instructions);offer.contentHash=dispatchOfferHash(offer);
  const receipt=sealReceipt({contract:'kapelle/context-receipt/v1',ownerId:m.ownerId,scopeRef:m.scopeRef,instanceId:offer.recipient.instanceId,dispatchId:'producing-dispatch',inputHash:offer.contentHash,
    manifest,requestedInputs:offer.sources,definition:{id:definition.definitionId,version:definition.packageVersion,contentHash:definition.contentHash},task:offer.task,instructionsHash:offer.instructionsHash,observedAt:at,status:'READY',
    entries:[{requested:{...input,authorityRef:'authority:context',ownerId:m.ownerId,scopeRef:m.scopeRef,purpose:'REFERENCE',provenance:{sourceRef:'source:synthetic',producerId:m.ownerId,recordedAt:at},supersedes:null},status:'RESOLVED',resolved:input,reason:'Verified'}],
    manifestStatus:'RESOLVED',assignmentStatus:'CURRENT',omissions:[],contextHash:digest('resolved-context')});
  const binding:TaskResultBinding={ownerId:m.ownerId,scopeRef:m.scopeRef,reviewId:ids.reviewId ?? 'review-publication',proposalHash:publicationProposal(m).contentHash,
    report:{id:m.report.id,contentVersion:1,contentHash:m.report.contentHash},task:{authorityRef:offer.task.authorityRef,id:offer.task.taskRef,nativeOwnerId:'native-owner',projectId:'synthetic-project',sourceRef:'source:task',commitmentHash:offer.task.commitmentHash},
    producer:{dispatchId:receipt.dispatchId,offerHash:offer.contentHash,instructionsHash:offer.instructionsHash,...offer.recipient},context:{workerKind:'saved-context/v1',receiptHash:receipt.receiptHash,contextHash:receipt.contextHash!,requestHash:digest('request')}};
  const state={
    task:{authorityRef:binding.task.authorityRef,taskRef:binding.task.id,ownerId:m.ownerId,scopeRef:m.scopeRef,nativeOwnerId:binding.task.nativeOwnerId,projectId:binding.task.projectId,sourceRef:binding.task.sourceRef,status:'DONE',revision:2,commitmentHash:binding.task.commitmentHash},
    report:{id:m.report.id,ownerId:m.ownerId,scopeRef:m.scopeRef,contentVersion:1,contentHash:m.report.contentHash,documentRevision:9},
    review:{id:binding.reviewId,ownerId:m.ownerId,scopeRef:m.scopeRef,proposalHash:binding.proposalHash,documentRevision:4,report:structuredClone(binding.report)},
    dispatch:{dispatchId:binding.producer.dispatchId,ownerId:m.ownerId,scopeRef:m.scopeRef,revision:3,createdAt:at,updatedAt:at,phase:'RESULT_RECORDED',offer,acceptance:{actorId:offer.recipient.instanceId,inputHash:offer.contentHash,occurredAt:at},result:{reportId:m.report.id,contentVersion:1,contentHash:m.report.contentHash,verificationRef:'verification:synthetic',occurredAt:at},cancellationReason:null},
    instance:{instanceId:offer.recipient.instanceId,ownerId:m.ownerId,scopeRef:m.scopeRef,revision:2,definitionRef:receipt.definition},
    definition:{ownerId:m.ownerId,revision:1,release:definition},
    name:{instanceId:offer.recipient.instanceId,ownerId:m.ownerId,scopeRef:m.scopeRef,value:'Avery',sourceRef:'instance-name:synthetic',sourceRevision:2,observedAt:at,provenance:'RETAINED'},
    receipt,
    attempt:{phase:'LINKED',receiptHash:receipt.receiptHash,contextHash:receipt.contextHash!,dispatchRevision:2,markdown:'Private worker body must never appear',result:{documentRef:m.report.id,documentType:'kilgore/report',contentVersion:1,contentHash:m.report.contentHash} as null|typeof input},
  };
  const requestHash=binding.context!.requestHash;
  const calls:string[]=[];
  const get=(key:keyof typeof state)=>async()=>{calls.push(key);return structuredClone(state[key]);};
  const ports:TaskResultReadPorts={task:get('task'),report:get('report'),review:get('review'),dispatch:get('dispatch'),instance:get('instance'),definition:get('definition'),instanceName:get('name'),contextReceipt:get('receipt'),
    attempt:async()=>{calls.push('attempt');return {dispatchId:binding.producer.dispatchId,requestHash,attemptHash:digest(state.attempt),attempt:structuredClone(state.attempt)};}};
  return {binding,state,ports,calls,publication,reader:()=>new TaskResultContextReader(binding,ports)};
}

/** Maximum valid saved-context inventory: one manifest plus sixteen resolved inputs. */
export function taskResultBoundaryFixture() {
  const f = taskResultFixture();
  const template = f.state.receipt.entries[0];
  const entries = Array.from({ length: 16 }, (_, index) => {
    const pin = { ...template.resolved!, documentRef: `context-input:synthetic-${index}` };
    return { ...template, requested: { ...template.requested, ...pin }, resolved: pin };
  });
  f.state.dispatch.offer.sources = [f.state.receipt.manifest, ...entries.map(entry => entry.resolved)];
  f.state.dispatch.offer.contentHash = dispatchOfferHash(f.state.dispatch.offer);
  f.state.dispatch.acceptance.inputHash = f.state.dispatch.offer.contentHash;
  f.binding.producer.offerHash = f.state.dispatch.offer.contentHash;
  const { receiptHash: _, ...body } = f.state.receipt;
  f.state.receipt = sealReceipt({ ...body, entries, requestedInputs: f.state.dispatch.offer.sources,
    inputHash: f.state.dispatch.offer.contentHash, contextHash: digest('sixteen-resolved-inputs') });
  f.binding.context!.receiptHash = f.state.receipt.receiptHash;
  f.binding.context!.contextHash = f.state.receipt.contextHash!;
  f.state.attempt.receiptHash = f.state.receipt.receiptHash;
  f.state.attempt.contextHash = f.state.receipt.contextHash!;
  return f;
}
