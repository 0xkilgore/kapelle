import {pilotSchema} from './pilot.js';
import { z } from 'zod';
import { digest } from '../content.js';
import { sourceSchema } from '../worker/contracts.js';
import { inferenceInputSchema, outputEvidenceSchema, runtimeEvidenceSchema } from '../worker/execution.js';
import type { PublicationReaders } from '../publication/facts.js';
import type { DispatchFacts } from '../dispatch/contracts.js';

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(1).max(200);
export const packetSchema = z.object({
  contract: z.literal('kapelle.task-source-packet/v1'),
  sources: z.array(z.object({
    document: sourceSchema,
    reference: z.string().min(1).max(2048),
    capturedAt: z.iso.datetime(),
  }).strict()).min(1).max(8),
}).strict().superRefine((p,c) => {
  if (Buffer.byteLength(JSON.stringify(p)) > 131072 || new Set(p.sources.map(s=>s.document.id)).size !== p.sources.length)
    c.addIssue({code:'custom',message:'packet_size_or_duplicate_identity'});
});
export type TaskSourcePacket = z.infer<typeof packetSchema>;
/** Store in Task notes BEFORE proposal creation. No implicit reference fetching. */
export function packetTaskNotes(packet: TaskSourcePacket, notes: string) {
  return JSON.stringify({contract:'kapelle.task-packet-notes/v1',packetHash:digest(packetSchema.parse(packet)),notes});
}
export const packetNotesSchema = z.object({contract:z.literal('kapelle.task-packet-notes/v1'),packetHash:hash,notes:z.string().max(16000)}).strict();
export const taskWorkerBindingSchema = z.object({
  pilot:pilotSchema.optional(),
  ownerId:id, scopeRef:id, instanceId:id, runtimeBindingRef:id,
  definitionHash:hash, capabilityHash:z.string().regex(/^[a-f0-9]{64}$/),
  modelProfile:id, budgetPolicyRef:id,
  /** Immutable Task-specific native recipient pins. Legacy single-Task bindings omit this. */
  taskCapabilityHashes:z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  /** Explicit host-approved source owner alias; included in the durable binding hash. */
  taskSourceOwnerId:id.optional(),
  inference:inferenceInputSchema.omit({system:true,user:true}),
}).strict();
export type TaskWorkerBinding = z.infer<typeof taskWorkerBindingSchema>;
export function taskCapabilityHash(binding:Readonly<TaskWorkerBinding>,taskId:string):string {
  const pins=binding.taskCapabilityHashes;
  if(!pins)return binding.capabilityHash;
  if(!Object.prototype.hasOwnProperty.call(pins,taskId))throw Error('worker_task_binding_not_admitted');
  return pins[taskId];
}
export const executionReceiptSchema = z.object({
  sessionId:z.string().uuid(), inputHash:hash,
  runtime:runtimeEvidenceSchema, output:outputEvidenceSchema,
}).strict();
export type TaskExecutionReceipt = z.infer<typeof executionReceiptSchema>;
export const publicationRequestSchema = z.object({
  publicationId:id, ownerId:id, scopeRef:id, instanceId:id, dispatchId:z.string().uuid(),
  inputHash:hash, taskId:id, sourceRef:id, packetHash:hash, executionHash:hash,
  markdown:z.string().min(1).max(32000), contentHash:hash,
}).strict();
export type TaskReportRequest = z.infer<typeof publicationRequestSchema>;
export const reportReceiptSchema = z.object({
  publicationId:id, dispatchId:z.string().uuid(), inputHash:hash,
  reportId:id, contentVersion:z.number().int().positive(), contentHash:hash, verificationRef:id,
}).strict();
export type TaskReportReceipt = z.infer<typeof reportReceiptSchema>;
export type TaskReportRead = Awaited<ReturnType<PublicationReaders['report']>> & {
  contentVersion:number; publicationId:string; dispatchId:string; inputHash:string;
  producerId:string; verificationRef:string;
};
/** Host-installed Report Registry bridge. No HTTP endpoint or publisher is enabled here.
 * lookup is a read-only reconciliation of the SAME publication identity, never a write.
 * read must be an independently authenticated immutable Report read, not the publish response.
 * The host's Framework facts provider must independently supply the matching result fact.
 */
export interface TaskReportAdapter {
  readonly publicationStartBoundary?:'transport';
  readonly bindingRef:string;
  admitted(request:TaskReportRequest):Promise<boolean>;
  lookup(request:TaskReportRequest):Promise<TaskReportReceipt|null>;
  publish(request:TaskReportRequest):Promise<TaskReportReceipt>;
  read(receipt:TaskReportReceipt):Promise<TaskReportRead>;
  /** Status reads only: may return a recent SUCCESSFUL full read of exactly this receipt (bounded window); otherwise a
   * full read. Never used to confirm a publication (RECORD_DISPATCH_RESULT always follows a fresh full read). */
  readVerified?(receipt:TaskReportReceipt):Promise<TaskReportRead>;
  /** New-execution publish readiness (model admission bound to the live Registry deployment). Absent = no publish gate. */
  publishReady?():Promise<void>;
}
export function reportResultFact(receipt:TaskReportReceipt):DispatchFacts['results'][number] {
  const {publicationId:_,...fact}=reportReceiptSchema.parse(receipt);return fact;
}
