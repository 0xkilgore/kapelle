import {z} from 'zod';
const id=z.string().min(1).max(256);
export const nativeSourceTargetSchema=z.object({driveId:id,documentId:id,documentType:z.enum(['kapelle/reference','kapelle/collection']),versionId:id,contentHash:z.string().regex(/^sha256:[a-f0-9]{64}$/)}).strict();
export type NativeSourceTarget=z.infer<typeof nativeSourceTargetSchema>;
export function sameNativeTarget(a:NativeSourceTarget|undefined,b:NativeSourceTarget|undefined) {
 return !a&&!b||!!a&&!!b&&a.driveId===b.driveId&&a.documentId===b.documentId&&a.documentType===b.documentType&&a.versionId===b.versionId&&a.contentHash===b.contentHash;
}
/** Task Authority keeps this exact source pin in its accepted CREATE operation. */
export function nativeTaskSourceRef(target:NativeSourceTarget) {
 const t=nativeSourceTargetSchema.parse(target);
 const value=`kapelle://document/${encodeURIComponent(t.driveId)}/${encodeURIComponent(t.documentType)}/${encodeURIComponent(t.documentId)}?versionId=${encodeURIComponent(t.versionId)}&contentHash=${encodeURIComponent(t.contentHash)}`;
 if(value.length>1000)throw new Error('Document source identity is too long.');
 return value;
}
export function parseNativeTaskSourceRef(value:unknown):NativeSourceTarget|null {
 if(typeof value!=='string'||value.length>1000)return null;
 try {
  const url=new URL(value),segments=url.pathname.split('/').slice(1).map(decodeURIComponent);
  if(url.protocol!=='kapelle:'||url.hostname!=='document'||url.username||url.password||url.port||url.hash||segments.length!==3)return null;
  const target=nativeSourceTargetSchema.parse({driveId:segments[0],documentType:segments[1],documentId:segments[2],versionId:url.searchParams.get('versionId'),contentHash:url.searchParams.get('contentHash')});
  return nativeTaskSourceRef(target)===value?target:null;
 }catch{return null;}
}
export function nativeSourceHref(target:NativeSourceTarget) {
 const type=target.documentType==='kapelle/reference'?'references':'collections';
 return `/ops/library/${type}/${encodeURIComponent(target.documentId)}?${new URLSearchParams({version:target.versionId,hash:target.contentHash})}`;
}
