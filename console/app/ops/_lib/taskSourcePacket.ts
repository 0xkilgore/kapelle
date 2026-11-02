import {z} from 'zod';
import {rosterSchema} from './nativeDelegationContract';
import {readyTaskHost,type TaskHostContext} from './taskHostContract';
import {canonicalProposal} from './taskProposalContract';

// Mirrors the admitted worker's kapelle.task-source-packet/v1 content contract.
// A reference identifier alone never supplies document contents.
const documentSchema=z.object({
  id:z.string().uuid(),version:z.number().int().nonnegative(),
  hash:z.string().regex(/^[a-f0-9]{64}$/),title:z.string().min(1).max(1024),
  project:z.string().max(200).nullable(),mimeType:z.enum(['text/markdown','text/csv']),
  content:z.string().max(262144),
}).strict();
export const taskSourcePacketSchema=z.object({
  contract:z.literal('kapelle.task-source-packet/v1'),
  sources:z.array(z.object({document:documentSchema,reference:z.string().min(1).max(2048),capturedAt:z.iso.datetime()}).strict()).min(1).max(8),
}).strict();
export type TaskSourcePacket=z.infer<typeof taskSourcePacketSchema>;

/** Verify both the approved packet identity and each document's exact bytes. */
export async function validateTaskSourcePacket(raw:unknown,expectedHash:string,hash:(text:string)=>Promise<string>):Promise<TaskSourcePacket>{
  const packet=taskSourcePacketSchema.parse(raw);
  if(!/^sha256:[a-f0-9]{64}$/.test(expectedHash)
    ||new TextEncoder().encode(JSON.stringify(packet)).length>131072
    ||new Set(packet.sources.map(s=>s.document.id)).size!==packet.sources.length
    ||'sha256:'+await hash(canonicalProposal(packet))!==expectedHash)
    throw Error('Supplied sources differ from the approved packet.');
  for(const {document} of packet.sources){
    if(await hash(document.content)!==document.hash)throw Error('Supplied document contents could not be verified.');
  }
  return packet;
}

const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const taskHostSourcesSchema=z.object({
  ok:z.literal(true),contract:z.literal('kapelle.task-host-sources/v1'),
  instanceId:z.string().min(1).max(200),ready:z.literal(true),
  taskRevision:z.number().int().nonnegative(),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),
  packetHash:digest,task:rosterSchema.shape.task,packet:taskSourcePacketSchema,
}).strict();
export type TaskHostSources=z.infer<typeof taskHostSourcesSchema>;
export async function validateTaskHostSources(raw:unknown,context:TaskHostContext,hash:(text:string)=>Promise<string>):Promise<TaskHostSources>{
  const sources=taskHostSourcesSchema.parse(raw),a=context.admission;
  if(!readyTaskHost(context)||sources.instanceId!==a.instanceId||sources.taskRevision!==a.taskRevision
    ||sources.sourceHash!==a.sourceHash||sources.packetHash!==a.packetHash
    ||canonicalProposal(sources.task)!==canonicalProposal(context.roster.task))
    throw Error('Supplied sources no longer match this task and agent. Refresh before approval.');
  await validateTaskSourcePacket(sources.packet,sources.packetHash,hash);
  return sources;
}
