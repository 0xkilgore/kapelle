/** Increment 2 test fixtures: valid task-host receipts/worker statuses (same shapes the served contract validates), a
 * Dispatch-list page builder, and a fetch double that records every host call (method, path) for side-effect assertions. */
export const taskId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',agentId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const recipient={instanceId:agentId,definitionId:'definition',definitionVersion:'1',definitionHash:'sha256:'+'b'.repeat(64),runtimeBindingRef:'host',capabilityHash:'c'.repeat(64)};
export const context={ok:true,roster:{ok:true,task:{taskId,revision:1,title:'Research',status:'OPEN',projectId:null,notes:JSON.stringify({contract:'kapelle.task-packet-notes/v1',packetHash:'sha256:'+'d'.repeat(64),notes:'supplied packet'}),comments:[],references:[],sourceHash:'a'.repeat(64)},
 agents:[{id:agentId,name:'Task worker',available:true,contract:'kapelle.task-delegation/v1',workKind:'task',reason:null,recipient}]},
 admission:{ok:true,contract:'kapelle.task-host/v1',instanceId:agentId,ready:true,reason:null,packetRequired:true,taskRevision:1,sourceHash:'a'.repeat(64),packetHash:'sha256:'+'d'.repeat(64)}};
export function receipt(operationId:string,dispatchId:string,opts:{status?:'ACCEPTED'|'RESULT_RECORDED';reportId?:string;taskRef?:string;instanceId?:string;contentHash?:string}={}){
 const status=opts.status??'ACCEPTED',reportId=opts.reportId??'ffffffff-ffff-4fff-8fff-ffffffffffff';
 const result=status==='RESULT_RECORDED'?{reportId,contentVersion:1,contentHash:opts.contentHash??'sha256:'+'1'.repeat(64),verificationRef:'v',occurredAt:'2026-10-05T12:00:00.000Z'}:null;
 const inst=opts.instanceId??agentId;
 return {contract:'kapelle.task-delegation/v1',operationId,assignmentId:dispatchId,dispatchId,taskId:opts.taskRef??taskId,revision:1,agentId:inst,recipient:{...recipient,instanceId:inst},instructionHash:'a'.repeat(64),sourceHash:'a'.repeat(64),
  source:{authority:'task-authority',content:'{}',hash:'b'.repeat(64)},accepted:true,offerHash:'sha256:'+'2'.repeat(64),taskCompleted:false,effectsAuthorized:false,
  approvedPlan:{recommendedAction:'Prepare',instructions:'Prepare a brief',deliverable:'Brief',effectLimit:'PREPARE_ONLY'},
  approval:{proposalId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',version:1,planHash:'sha256:'+'3'.repeat(64),operationId:'abababab-abab-4bab-8bab-abababababac'},status,result};
}
export function worker(dispatchId:string,status:string,opts:{reason?:string|null;outputRetained?:boolean;published?:{reportId:string;contentHash?:string}}={}){
 return {contract:'kapelle.task-delegation/v1',dispatchId,status,outputRetained:opts.outputRetained??(status!=='EXECUTION_RUNNING'&&status!=='EXECUTION_REJECTED'&&status!=='EXECUTION_UNCERTAIN'),reason:opts.reason??null,
  result:opts.published?{publicationId:'p',dispatchId,inputHash:'sha256:'+'2'.repeat(64),reportId:opts.published.reportId,contentVersion:1,contentHash:opts.published.contentHash??'sha256:'+'1'.repeat(64),verificationRef:'v'}:null,taskCompleted:false,effectsAuthorized:false};
}
export function dispatchItem(dispatchId:string,opts:{taskRef?:string;recipient?:string;phase?:string;proposalOperationId?:string|null}={}){
 return {dispatchId,revision:1,phase:opts.phase??'ACCEPTED',taskRef:opts.taskRef??taskId,authorityRef:'task-authority',recipientInstanceId:opts.recipient??agentId,senderId:'owner',offeredAt:null,updatedAt:null,expiresAt:'2026-12-01T00:00:00.000Z',acceptedAt:null,
  result:opts.phase==='RESULT_RECORDED'?{reportId:'ffffffff-ffff-4fff-8fff-ffffffffffff',contentVersion:1,contentHash:'sha256:'+'1'.repeat(64),occurredAt:'2026-10-05T12:00:00.000Z'}:null,cancellationReason:null,parentDispatchRef:null,proposalOperationId:opts.proposalOperationId??null};
}
export type Call={method:string;path:string};
/** A fetch double: route(path, method, body) returns a Response (or throws to simulate transport failure). Records calls. */
export function hostDouble(route:(path:string,method:string,body:unknown)=>Response|Promise<Response>){
 const calls:Call[]=[];
 const fetch=async(url:RequestInfo|URL,o?:RequestInit)=>{const u=new URL(String(url)),path=u.pathname+u.search,method=o?.method??'GET';calls.push({method,path});
  return route(path,method,o?.body?JSON.parse(String(o.body)):undefined);};
 return {calls,fetch:fetch as typeof globalThis.fetch,posts:()=>calls.filter(c=>c.method==='POST')};
}
export function hostEnv(t:{after:(fn:()=>void)=>void}){
 const e={...process.env},f=globalThis.fetch;t.after(()=>{process.env=e;globalThis.fetch=f;});
 Object.assign(process.env,{KAPELLE_OPS_ENABLED:'1',KAPELLE_OPS_TOKEN:'synthetic-host',KAPELLE_TASK_HOST_ENABLED:'1',KAPELLE_TASK_HOST_URL:'http://127.0.0.1:4494',KAPELLE_TASK_HOST_TOKEN:'s'.repeat(40)});
}
import {createHash} from 'node:crypto';
import {canonicalProposal} from '../../app/ops/_lib/taskProposalContract';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
/** A saved proposal that passes validateProposal (same construction as tests/task-host.test.ts). */
export function proposal(operationId:string,opts:{agent?:string;task?:string;dispatchId?:string|null;status?:string}={}){
 const agent=opts.agent??agentId,task=opts.task??taskId;
 const draft={operationId,taskId:task,revision:1,agentId:agent,recipient:{...recipient,instanceId:agent},instructions:'Prepare a brief',includeNotes:true,includeComments:true,includeReferences:true,sourceHash:'a'.repeat(64)};
 const plan={recommendedAction:'Prepare',instructions:draft.instructions,deliverable:'Brief',effectLimit:'PREPARE_ONLY'};
 const content=JSON.stringify({taskId:task,revision:1,title:'Research',notes:'Original',comments:[],references:[]});
 const version={version:1,provenance:{kind:'owner-authored',id:'owner-initial-v1'},plan,draft,source:{authority:'task-authority',content,hash:sha(content)},instructionHash:sha(JSON.stringify(draft.instructions)),comment:''};
 const planHash='sha256:'+sha(canonicalProposal(version));
 const dispatchId=opts.dispatchId??null;
 return {proposalId:'dddddddd-dddd-4ddd-8ddd-'+operationId.slice(-12),revision:dispatchId?2:1,status:opts.status??(dispatchId?'APPROVED':'PROPOSED'),currentVersion:1,versions:[{...version,planHash,actorId:'owner',occurredAt:'2026-10-05T12:00:00.000Z'}],
  approval:dispatchId?{operationId:'abababab-abab-4bab-8bab-abababababac',version:1,planHash,actorId:'owner',occurredAt:'2026-10-05T12:01:00.000Z'}:null,dispatchId,generationRequests:[]};
}

/** A kapelle.report-detail.v2 answer for the selected-Report reader (same shape as tests/ops-report-selected-source.test.ts). */
export function reportDetail(id:string,opts:{markdown:string;sourceRef:string}){
 const at=new Date().toISOString(),md=opts.markdown;
 return {schemaVersion:'kapelle.report-detail.v2',source:'vetra-report-registry',availability:'available',driveId:'drive',observedAt:at,document:{header:{id,documentType:'kilgore/report'},state:{global:{
  reportRef:'report:task:'+'9'.repeat(64),title:'Task result',revision:1,createdAt:at,updatedAt:at,lifecycle:'FINAL',sourceRef:opts.sourceRef,projectRef:null,producer:{kind:'AGENT',id:'synthetic',label:'Synthetic author'},
  attention:{request:'NONE',resolvedAt:null,reviewBy:null},content:{storage:'INLINE_MARKDOWN',mimeType:'text/markdown',markdown:md,contentHash:createHash('sha256').update(md).digest('hex'),byteSize:Buffer.byteLength(md),blobRef:null,filename:'task-result.md'}}}}};
}

/** A receipt bound to an APPROVED fixture proposal (passes bindExecution: same approval, version, plan bytes and source). */
export function receiptFor(p:ReturnType<typeof proposal>,opts:{status?:'ACCEPTED'|'RESULT_RECORDED';contentHash?:string}={}){
 const v=p.versions.at(-1)!,base=receipt(v.draft.operationId,p.dispatchId!,{...opts,instanceId:v.draft.agentId});
 return {...base,revision:v.draft.revision,instructionHash:v.instructionHash,sourceHash:v.draft.sourceHash,source:v.source,approvedPlan:v.plan,
  approval:{proposalId:p.proposalId,version:v.version,planHash:v.planHash,operationId:p.approval!.operationId}};
}
