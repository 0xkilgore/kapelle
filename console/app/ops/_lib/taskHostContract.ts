import {z} from 'zod';
import {rosterSchema} from './nativeDelegationContract';
import {approvedReceiptSchema} from './taskProposalContract';
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const taskHostAdmissionSchema=z.object({ok:z.literal(true),contract:z.literal('kapelle.task-host/v1'),instanceId:z.string().min(1).max(200),ready:z.boolean(),reason:z.literal('host_not_admitted').nullable(),packetRequired:z.literal(true),taskRevision:z.number().int().nonnegative(),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),packetHash:digest.nullable()}).strict();
/** Read-only pilot signals from the Framework (GET /task-executions/pilot, kapelle.task-host-pilot/v1). null = not a pilot host;
 * absent = unknown (older Framework or read failed): the console then behaves as before and the Framework still enforces the pilot. */
export const taskHostPilotSignalsSchema=z.object({mode:z.literal('single-task-pilot'),taskBound:z.boolean(),newWorkEndsAt:z.string().datetime(),
 newWorkEnded:z.boolean(),invocationConsumed:z.boolean(),
 pinnedPlan:z.object({operationId:z.string().uuid(),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),planHash:digest}).strict().nullable()}).strict();
export type TaskHostPilotSignals=z.infer<typeof taskHostPilotSignalsSchema>;
export const taskHostPilotSchema=z.object({ok:z.literal(true),contract:z.literal('kapelle.task-host-pilot/v1'),instanceId:z.string().min(1).max(200),taskId:z.string().min(1).max(200),pilot:taskHostPilotSignalsSchema.nullable()}).strict();
export const taskHostContextSchema=z.object({ok:z.literal(true),roster:rosterSchema,admission:taskHostAdmissionSchema,pilot:taskHostPilotSignalsSchema.nullable().optional()}).strict();
export type TaskHostContext=z.infer<typeof taskHostContextSchema>;
export function readyTaskHost(context:TaskHostContext){
 const {roster,admission}=context;
 let packetHash:string|null=null;try{packetHash=packetNotesSchema.parse(JSON.parse(roster.task.notes)).packetHash;}catch{}
 return admission.ready&&admission.reason===null&&admission.packetHash!==null&&admission.packetHash===packetHash&&admission.taskRevision===roster.task.revision&&admission.sourceHash===roster.task.sourceHash&&['OPEN','BLOCKED','SNOOZED'].includes(roster.task.status)&&roster.agents.some(a=>a.id===admission.instanceId&&a.available&&a.recipient?.instanceId===a.id);
}
const resultSchema=z.object({publicationId:z.string().min(1),dispatchId:z.string().uuid(),inputHash:digest,reportId:z.string().uuid(),contentVersion:z.number().int().positive(),contentHash:digest,verificationRef:z.string().min(1)}).strict();
export const taskHostWorkerSchema=z.object({contract:z.literal('kapelle.task-delegation/v1'),dispatchId:z.string().uuid(),status:z.enum(['EXECUTION_RUNNING','EXECUTION_REJECTED','EXECUTION_UNCERTAIN','REPORT_PENDING','REPORT_PUBLISHED']),outputRetained:z.boolean(),reason:z.string().nullable(),result:resultSchema.nullable(),taskCompleted:z.literal(false),effectsAuthorized:z.literal(false)}).strict();
export const taskHostExecutionSchema=z.object({ok:z.literal(true),item:approvedReceiptSchema,worker:taskHostWorkerSchema.nullable()}).strict();
export type TaskHostExecution=z.infer<typeof taskHostExecutionSchema>;
export function validateTaskHostExecution(raw:unknown,taskId:string,operationId:string){
 const v=taskHostExecutionSchema.parse(raw),{item,worker}=v;
 if(item.taskId!==taskId||item.operationId!==operationId||item.assignmentId!==item.dispatchId||worker&&worker.dispatchId!==item.dispatchId)throw Error('Saved work identity differs.');
 if(!worker){if(item.result)throw Error('Worker confirmation is unavailable.');return v;}
 if(worker.status==='REPORT_PUBLISHED'){
  const result=worker.result,native=item.result;
  if(!worker.outputRetained||worker.reason!==null||!result||!native||item.status!=='RESULT_RECORDED'||result.dispatchId!==item.dispatchId||result.inputHash!==item.offerHash||result.reportId!==native.reportId||result.contentVersion!==native.contentVersion||result.contentHash!==native.contentHash||result.verificationRef!==native.verificationRef)throw Error('Report and saved work do not agree.');
 }else{
  // Pending or uncertain work never exposes a Report link. A recorded native result may still exist
  // while the independent reader is unavailable or readback is unconfirmed; the native contract keeps
  // that REPORT_PENDING, so it is accepted here only for those reader-side reasons.
  const readerSide=worker.status==='REPORT_PENDING'&&worker.outputRetained&&['reader_not_admitted','readback_unconfirmed'].includes(worker.reason??'');
  // A rejected attempt produced nothing: it can never carry retained output or a native result.
  const rejectedWithEvidence=worker.status==='EXECUTION_REJECTED'&&(worker.outputRetained||!worker.reason);
  if(worker.result||worker.status==='REPORT_PENDING'&&!worker.outputRetained||item.result&&!readerSide||rejectedWithEvidence)throw Error('Work status cannot confirm a Report.');
 }
 return v;
}

const packetNotesSchema=z.object({contract:z.literal("kapelle.task-packet-notes/v1"),packetHash:digest,notes:z.string().max(16000)}).strict();
export function readableTaskNotes(value:string):string{try{const parsed=packetNotesSchema.safeParse(JSON.parse(value));return parsed.success?parsed.data.notes:value;}catch{return value;}}

// ---- Increment 2 contracts (v2). The Task panel reads only these since step 4; v1 discovery remains server-side for the Agents page. ----
const uuid=z.string().uuid();
/** Fixed public reason codes for discovery/status (never raw exception text or private runtime detail). */
export const taskHostReadReasonSchema=z.enum(['deadline','host_unavailable','execution_unavailable','worker_bound_elsewhere','admission_unavailable','page_limit','reader_unavailable','report_changed']);
export type TaskHostReadReason=z.infer<typeof taskHostReadReasonSchema>;
const roundV2Schema=z.object({round:z.number().int().min(1).max(12),operationId:uuid,proposal:z.unknown(),execution:taskHostExecutionSchema.nullable(),executionError:taskHostReadReasonSchema.nullable()}).strict();
/** An assignment found through the Task-filtered Dispatch list that is NOT one of the deterministic page slots (an assignment created outside the page).
 * It carries no fabricated round. Its proposal is present only when its operation id could be read and validated. */
const externalSchema=z.object({dispatchId:uuid,operationId:uuid.nullable(),recipientInstanceId:z.string().min(1).max(200),phase:z.enum(['OFFERED','ACCEPTED','CANCEL_REQUESTED','RESULT_RECORDED']),
 proposal:z.unknown().nullable(),execution:taskHostExecutionSchema.nullable(),executionError:taskHostReadReasonSchema.nullable()}).strict();
export const taskHostDelegationsV2Schema=z.object({ok:z.literal(true),contract:z.literal('kapelle.task-host-delegations/v2'),taskId:z.string().min(1).max(200),
 /** The currently admitted instance, or null when current admission could not be read (history is still returned). */
 instanceId:z.string().min(1).max(200).nullable(),
 rounds:z.array(roundV2Schema).max(12),external:z.array(externalSchema).max(150),
 /** complete=false whenever any page/slot/item was not resolved; a partial result can never enable prepare/start. */
 discovery:z.object({complete:z.boolean(),nextCursor:z.string().min(1).max(500).nullable(),reason:taskHostReadReasonSchema.nullable()}).strict(),
 /** Assignments that are not terminal: they block a new UI-created assignment (console policy, not a scheduler). */
 blockingOperationIds:z.array(uuid).max(162),
 /** EVERY unresolved Dispatch (with or without a proposal operation id): the authoritative blocker list. An external
  * Dispatch whose operation id is unknown is still displayed and still blocks new work. */
 blockingDispatchIds:z.array(uuid).max(162),
 next:z.object({round:z.number().int().min(1).max(12),operationId:uuid}).strict().nullable(),
 /** Pilot signals of the current host (see taskHostPilotSignalsSchema); absent = unknown. */
 pilot:taskHostPilotSignalsSchema.nullable().optional()}).strict()
 .superRefine((v,ctx)=>{if(!v.discovery.complete&&v.discovery.reason===null)ctx.addIssue({code:'custom',message:'incomplete discovery needs a reason'});
  if(v.discovery.complete&&v.discovery.nextCursor!==null)ctx.addIssue({code:'custom',message:'complete discovery has no cursor'});});
export type TaskHostDelegationsV2=z.infer<typeof taskHostDelegationsV2Schema>;
/** Status v2: durable execution/result facts PLUS the separate present-readback fact. 'unavailable' never means "newly
 * verified"; a previously verified result is preserved with its timestamp. */
export const taskHostStatusV2Schema=z.object({ok:z.literal(true),contract:z.literal('kapelle.task-host-status/v2'),execution:taskHostExecutionSchema,
 readback:z.object({state:z.enum(['verified','unavailable','changed','not_applicable']),checkedAt:z.string().datetime().nullable(),reason:taskHostReadReasonSchema.nullable()}).strict()}).strict()
 .superRefine((v,ctx)=>{const published=v.execution.worker?.status==='REPORT_PUBLISHED';
  if(published!==(v.readback.state!=='not_applicable'))ctx.addIssue({code:'custom',message:'readback applies exactly to published results'});
  if(v.readback.state==='verified'&&(v.readback.checkedAt===null||v.readback.reason!==null))ctx.addIssue({code:'custom',message:'verified readback needs a time and no reason'});
  if(['unavailable','changed'].includes(v.readback.state)&&v.readback.reason===null)ctx.addIssue({code:'custom',message:'unverified readback needs a fixed reason'});});
export type TaskHostStatusV2=z.infer<typeof taskHostStatusV2Schema>;
/** Prompt claim response for "run" (no synchronous post-run read). status is the Framework's own claim/settled answer. */
export const taskHostClaimSchema=z.object({ok:z.literal(true),contract:z.literal('kapelle.task-host-claim/v1'),operationId:uuid,dispatchId:uuid,worker:taskHostWorkerSchema}).strict();
export type TaskHostClaim=z.infer<typeof taskHostClaimSchema>;

/** Cancellation is a recorded REQUEST on the native assignment. It never asserts process exit. */
export const CANCELLATION_NOTE='Cancellation is a request recorded on the assignment. The worker checks the record about once a second and then shuts its child process down gracefully, which can take longer than ten seconds and may end unconfirmed. Nothing is repeated automatically, and the connection stays readable until it expires.';
