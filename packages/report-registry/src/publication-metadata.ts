/** Immutable, plan-bound publication provenance; absent legacy data stays absent. */
export type AgentSnapshot = { id: string; label: string; instanceId: string | null; definitionId: string | null; definitionVersion: string | null; definitionHash: string | null };
export type PublicationMetadata = {
  publicationId: string; author: AgentSnapshot; publisher: AgentSnapshot;
  runRef: string; sourceRef: string; provenanceRef: string; contentHash: string;
  contentVersion: number; authorizationRef: string; publishedAt: string;
};
function record(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('PUBLICATION_METADATA_INVALID');
  return value as Record<string,unknown>;
}
function text(value:unknown,max=1000):string {
  if(typeof value!=='string'||!value.trim()||value.trim()!==value||value.length>max)throw Error('PUBLICATION_METADATA_INVALID');return value;
}
function keys(value:Record<string,unknown>,names:string[]) {if(Object.keys(value).some(k=>!names.includes(k)))throw Error('PUBLICATION_METADATA_UNKNOWN_FIELD');}
export function parseAgentSnapshot(value:unknown):AgentSnapshot {
  const v=record(value);keys(v,['id','label','instanceId','definitionId','definitionVersion','definitionHash']);
  const result={id:text(v.id,500),label:text(v.label,500),instanceId:v.instanceId==null?null:text(v.instanceId,500),definitionId:v.definitionId==null?null:text(v.definitionId,500),definitionVersion:v.definitionVersion==null?null:text(v.definitionVersion,100),definitionHash:v.definitionHash==null?null:text(v.definitionHash,64)};
  if(result.definitionHash&&!/^[a-f0-9]{64}$/.test(result.definitionHash))throw Error('PUBLICATION_DEFINITION_HASH_INVALID');return result;
}
export function parsePublicationMetadata(value:unknown):PublicationMetadata {
  const v=record(value);keys(v,['publicationId','author','publisher','runRef','sourceRef','provenanceRef','contentHash','contentVersion','authorizationRef','publishedAt']);
  const result={publicationId:text(v.publicationId,500),author:parseAgentSnapshot(v.author),publisher:parseAgentSnapshot(v.publisher),runRef:text(v.runRef,2000),sourceRef:text(v.sourceRef,4000),provenanceRef:text(v.provenanceRef,2000),contentHash:text(v.contentHash,64),contentVersion:Number(v.contentVersion),authorizationRef:text(v.authorizationRef,2000),publishedAt:text(v.publishedAt,40)};
  if(typeof v.contentVersion!=='number'||!Number.isSafeInteger(result.contentVersion)||result.contentVersion<1||!/^[a-f0-9]{64}$/.test(result.contentHash)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result.publishedAt)||new Date(result.publishedAt).toISOString()!==result.publishedAt)throw Error('PUBLICATION_METADATA_INVALID');
  return result;
}
