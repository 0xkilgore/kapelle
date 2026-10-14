import {generationSchemas,generationActive,reduceGeneration,lateReceiptReserve} from './generation.js';
export {RequestTaskGenerationInputSchema,ClaimTaskGenerationInputSchema,RecordTaskGenerationInputSchema} from './generation.js';
/** Authored native extension. Only fresh v3 allocations; v1/v2 replay remains unchanged. */
import { z } from 'zod';
import { createAction, createReducer, isDocumentAction, baseCreateDocument, baseSaveToFileHandle, baseLoadFromInputVersioned, type PHDocument, type DocumentModelModule, type DocumentModelUtils } from 'document-model';
import { ReviewIntent as v2, type ReviewIntentPHState as V2State } from '../v2/index.js';
import { assert, touch } from '../../../src/validation.js';
import { planHash, readHistory, versionSchema, type PlanHistory } from '../../../src/task-delegation/proposal-contract.js';
export type ReviewIntentPHState=V2State&{global:V2State['global']&{taskPlanJson:string|null}};
export type ReviewIntentDocument=PHDocument<ReviewIntentPHState>;
const common={actorId:z.string().min(1),occurredAt:z.iso.datetime(),expectedRevision:z.number().int().nonnegative()};
export const CreateTaskProposalInputSchema=()=>z.object({...common,reviewId:z.string().min(1),instanceId:z.string().min(1),scopeRef:z.string().min(1),versionJson:z.string().max(40000)}).strict();
export const ReviseTaskProposalInputSchema=()=>z.object({...common,baseVersion:z.number().int().positive(),basePlanHash:z.string(),versionJson:z.string().max(40000)}).strict();
export const ApproveTaskProposalInputSchema=()=>z.object({...common,version:z.number().int().positive(),planHash:z.string(),operationId:z.string().uuid(),dispatchId:z.string().uuid()}).strict();
export const schemas={...generationSchemas,CREATE_TASK_PROPOSAL:CreateTaskProposalInputSchema,REVISE_TASK_PROPOSAL:ReviseTaskProposalInputSchema,APPROVE_TASK_PROPOSAL:ApproveTaskProposalInputSchema};
export const actions=Object.fromEntries(Object.entries(schemas).map(([name,schema])=>[name,(input:unknown)=>createAction<any>(name,input,undefined,schema,'global')])) as Record<keyof typeof schemas,(input:any)=>any>;
const reducer=createReducer<ReviewIntentPHState>((state,action)=>{
 if(isDocumentAction(action))return state;
 assert(action.type in schemas,'Unknown Task proposal operation');
 const i=(schemas[action.type as keyof typeof schemas]() as z.ZodType<any>).parse(action.input),s=state.global;
 assert(s.revision===i.expectedRevision,'Stale Task proposal revision');
 assert(!s.updatedAt||s.updatedAt<=i.occurredAt,'Task proposal timestamp regressed');
 if(action.type==='CREATE_TASK_PROPOSAL'){
  assert(s.revision===0&&!s.ownerId&&!s.taskPlanJson,'Task proposal already exists');
  const v=versionSchema.parse(JSON.parse(i.versionJson));assert(v.version===1&&v.planHash===planHash(v)&&v.draft.agentId===i.instanceId,'Task proposal version differs');
  v.actorId=i.actorId;v.occurredAt=i.occurredAt;
  Object.assign(s,{reviewId:i.reviewId,ownerId:i.actorId,instanceId:i.instanceId,scopeRef:i.scopeRef,taskPlanJson:JSON.stringify({versions:[v],approval:null,dispatchId:null}),status:'PROPOSED'});
 }else{
  assert(s.ownerId===i.actorId,'Task proposal owner differs');const h=readHistory(s.taskPlanJson),last=h.versions.at(-1)!;
  if(action.type in generationSchemas){
   reduceGeneration(action.type,i,h,s.reviewId!);s.taskPlanJson=JSON.stringify(h);
   if(action.type==='REQUEST_TASK_GENERATION'||i.outcome==='APPLIED'){s.decision=null;s.status='PROPOSED';}
  }else if(action.type==='REVISE_TASK_PROPOSAL'){
   assert(!h.dispatchId&&h.versions.length<20&&last.version===i.baseVersion&&last.planHash===i.basePlanHash,'Stale or already sent Task proposal');
   const v=versionSchema.parse(JSON.parse(i.versionJson));assert(v.version===last.version+1&&v.planHash===planHash(v),'Task proposal version differs');
   assert(v.draft.taskId===last.draft.taskId&&v.draft.operationId===last.draft.operationId,'Task proposal identity differs');
   for(const g of h.generationRequests??[])if(['PENDING','RUNNING','UNCERTAIN'].includes(g.status)){g.status='FAILED';g.errorCode='SUPERSEDED';}
   v.actorId=i.actorId;v.occurredAt=i.occurredAt;h.versions.push(v);h.approval=null;s.decision=null;s.status='PROPOSED';s.instanceId=v.draft.agentId;s.taskPlanJson=JSON.stringify(h);
  }else{
   assert(!generationActive(h),'Task generation must settle before approval');
   assert(!h.dispatchId&&last.version===i.version&&last.planHash===i.planHash,'Stale or already sent Task proposal');
   h.approval={operationId:i.operationId,actorId:i.actorId,occurredAt:i.occurredAt,version:i.version,planHash:i.planHash};h.dispatchId=i.dispatchId;s.status='APPROVED';s.decision={actorId:i.actorId,occurredAt:i.occurredAt,proposalHash:i.planHash,proposalVersion:i.version,approved:true,reason:null};s.taskPlanJson=JSON.stringify(h);
  }
 }
 assert(Buffer.byteLength(s.taskPlanJson!)+lateReceiptReserve(readHistory(s.taskPlanJson))<=180000,'Task proposal history too large');touch(s,i);
});
const initial=()=>({...v2.utils.createState(),document:{...v2.utils.createState().document,version:3},global:{...v2.utils.createState().global,taskPlanJson:null}});
export const utils:DocumentModelUtils<ReviewIntentPHState>={...v2.utils,createState(partial){const d=initial();return {...d,...partial,document:{...d.document,...partial?.document,version:3},global:{...d.global,...partial?.global}};},createDocument(state){return baseCreateDocument(utils.createState,state,'kapelle/review-intent');},saveToFileHandle:baseSaveToFileHandle,loadFromInput(input){return baseLoadFromInputVersioned(input,{reducers:{3:reducer as any},upgradeManifest:{documentType:'kapelle/review-intent',latestVersion:3,supportedVersions:[3],upgrades:{}}});},isStateOfType(state):state is ReviewIntentPHState{return v2.utils.isStateOfType(state)&&typeof (state as ReviewIntentPHState).global.taskPlanJson!=='undefined';},assertIsStateOfType(state):asserts state is ReviewIntentPHState{assert(utils.isStateOfType(state),'Invalid Task proposal state');},isDocumentOfType(doc):doc is ReviewIntentDocument{return v2.utils.isDocumentOfType(doc)&&utils.isStateOfType(doc.state);},assertIsDocumentOfType(doc):asserts doc is ReviewIntentDocument{assert(utils.isDocumentOfType(doc),'Invalid Task proposal document');}};
const operationSchemas:Record<string,string>={
 REQUEST_TASK_GENERATION:'input RequestTaskGenerationInput { actorId: ID! occurredAt: DateTime! expectedRevision: Int! requestJson: String! }',
 CLAIM_TASK_GENERATION:'input ClaimTaskGenerationInput { actorId: ID! occurredAt: DateTime! expectedRevision: Int! requestOperationId: ID! invocationId: ID! }',
 RECORD_TASK_GENERATION:'input RecordTaskGenerationInput { actorId: ID! occurredAt: DateTime! expectedRevision: Int! requestOperationId: ID! outcome: String! receiptJson: String versionJson: String errorCode: String }',
 CREATE_TASK_PROPOSAL:'input CreateTaskProposalInput { actorId: ID! occurredAt: DateTime! expectedRevision: Int! reviewId: ID! instanceId: ID! scopeRef: ID! versionJson: String! }',
 REVISE_TASK_PROPOSAL:'input ReviseTaskProposalInput { actorId: ID! occurredAt: DateTime! expectedRevision: Int! baseVersion: Int! basePlanHash: String! versionJson: String! }',
 APPROVE_TASK_PROPOSAL:'input ApproveTaskProposalInput { actorId: ID! occurredAt: DateTime! expectedRevision: Int! version: Int! planHash: String! operationId: ID! dispatchId: ID! }'
};
const documentModel=structuredClone(v2.documentModel);const spec=structuredClone(documentModel.global.specifications.find(s=>s.version===2)!);spec.version=3;spec.state.global.schema+='\nextend type ReviewIntentState { taskPlanJson: String }';spec.state.global.initialValue=JSON.stringify(initial().global);
spec.modules=[{id:'task-proposal-control',name:'control',description:'Owner-reviewed Task plan history and exact approval',operations:Object.keys(schemas).map(name=>({id:name.toLowerCase(),name,description:name,schema:operationSchemas[name],template:'',reducer:'',errors:[],examples:[],scope:'global' as const}))}];documentModel.global.specifications=[spec];
export const ReviewIntent={version:3,reducer,actions,utils,documentModel} satisfies DocumentModelModule<ReviewIntentPHState>;
