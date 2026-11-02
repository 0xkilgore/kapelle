import { constants, existsSync, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonical, digest, releaseHash } from "../command-boundary.js";
import type { FrameworkAuthority } from "../service/authority.js";
import type { PublicationTaskReader } from "./task-reader.js";
import type { PublicationReaders } from "./facts.js";
import { bytesHash, publicationArtifact, publicationProposal } from "./manifest.js";
import { taskResultBindingSchema, TaskContextReadError, type TaskResultReadPorts } from "./task-result-context.js";
import { verifyReceipt } from "./context-read-contracts.js";

function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new TaskContextReadError("CHANGED", reason);
}
/** Compose reads on existing authorities; never opens a native/worker store.
 * report must return the Registry's immutable contentVersion, not its document revision.
 * authorize checks the current owner ACL on every exact read (including rechecks).
 */
export function nativeTaskResultReadPorts(config: {
  binding: unknown; manifest: unknown; publicationInstanceId: string;
  authority: Pick<FrameworkAuthority, "read">; task: Pick<PublicationTaskReader,"read">;
  report: (id: string, signal: AbortSignal) => Promise<Awaited<ReturnType<PublicationReaders["report"]>> & {contentVersion:number}>;
  authorize: (kind: string, id: string, signal: AbortSignal) => Promise<void>;
  retained?: Pick<TaskResultReadPorts,"contextReceipt"|"attempt">;
  instanceName?: TaskResultReadPorts["instanceName"];
}): TaskResultReadPorts {
  const b = taskResultBindingSchema.parse(config.binding), m = publicationArtifact(config.manifest).manifest;
  check(b.ownerId===m.ownerId && b.scopeRef===m.scopeRef && b.report.id===m.report.id && b.report.contentHash===m.report.contentHash && b.proposalHash===publicationProposal(m).contentHash,"READ_ADAPTER_BINDING_CHANGED");
  const auth = async (kind:string,id:string,signal:AbortSignal) => {signal.throwIfAborted(); await config.authorize(kind,id,signal);signal.throwIfAborted();};
  const native = async (id:string,type:Parameters<FrameworkAuthority["read"]>[1],signal:AbortSignal) => {
    await auth(type,id,signal); const document=await config.authority.read(id,type);signal.throwIfAborted();
    return document.state.global;
  };
  return {
    task: async signal => {await auth("task",b.task.id,signal);return config.task.read();},
    report: async (id,signal) => {
      check(id===b.report.id,"REPORT_ID_CHANGED");await auth("report",id,signal);
      const r=await config.report(id,signal);signal.throwIfAborted();
      check(r.reportRef===m.report.reportRef && r.sourceRef===m.report.sourceRef && r.bytes.byteLength===m.report.bytes && bytesHash(r.bytes)===b.report.contentHash,"REPORT_CONTENT_CHANGED");
      return {id:r.id,ownerId:r.ownerId,scopeRef:r.scopeRef,contentVersion:r.contentVersion,contentHash:bytesHash(r.bytes),documentRevision:r.revision};
    },
    review: async (id,signal) => {
      check(id===b.reviewId,"REVIEW_ID_CHANGED");const s=await native(id,"kapelle/review-intent",signal);
      check("proposal" in s && s.instanceId===config.publicationInstanceId && canonical(s.proposal)===canonical(publicationProposal(m)),"REVIEW_BINDING_CHANGED");
      return {id,ownerId:s.ownerId,scopeRef:s.scopeRef,proposalHash:s.proposal!.contentHash,documentRevision:s.revision,report:b.report};
    },
    dispatch: async (id,signal) => {check(id===b.producer.dispatchId,"DISPATCH_ID_CHANGED");return native(id,"kapelle/dispatch",signal);},
    instance: async (id,signal) => {check(id===b.producer.instanceId,"INSTANCE_ID_CHANGED");return native(id,"kapelle/agent-instance",signal);},
    definition: async (id,signal) => {
      check(id===b.producer.definitionId,"DEFINITION_ID_CHANGED"); const s=await native(id,"kapelle/agent-definition",signal);
      check("release" in s && s.release && releaseHash(s.release)===b.producer.definitionHash,"PINNED_DEFINITION_UNAVAILABLE"); return s;
    },
    ...(config.instanceName ? {instanceName:async(id:string,signal:AbortSignal)=>{check(id===b.producer.instanceId,"INSTANCE_ID_CHANGED");await auth("instance-name",id,signal);return config.instanceName!(id,signal);}} : {}),
    ...(config.retained?.contextReceipt ? {contextReceipt:async(hash:string,signal:AbortSignal)=>{check(hash===b.context?.receiptHash,"RECEIPT_ID_CHANGED");await auth("context-receipt",hash,signal);return config.retained!.contextReceipt!(hash,signal);}} : {}),
    ...(config.retained?.attempt ? {attempt:async(id:string,signal:AbortSignal)=>{check(id===b.producer.dispatchId,"DISPATCH_ID_CHANGED");await auth("context-attempt",id,signal);return config.retained!.attempt!(id,signal);}} : {}),
  };
}

/** Retained saved-context/v1 artifact read, with an ALREADY OPEN host query handle.
 * No constructor calls, new SQLite connections, schema/lock acquisition or mkdir.
 * select must be an already-open SQLITE_OPEN_READONLY handle on a checkpointed
 * non-WAL artifact. Active WAL/SHM is refused: even SELECT can change read marks.
 * Installation must provide a qualified read-only snapshot; GET never checkpoints.
 */
export function retainedContextReadPorts(config: {
  binding: unknown; root: string;
  select: (sql:string,...parameters:string[]) => unknown;
}): Required<Pick<TaskResultReadPorts,"contextReceipt"|"attempt">> {
  const b=taskResultBindingSchema.parse(config.binding), root=resolve(config.root);
  const storeBinding=digest({contract:"kapelle/context-store/v1",ownerId:b.ownerId,scopeRef:b.scopeRef,instanceId:b.producer.instanceId});
  const bound = (signal:AbortSignal) => {
    signal.throwIfAborted();
    if (existsSync(join(root,"attempts.sqlite-wal")) || existsSync(join(root,"attempts.sqlite-shm")))
      throw new TaskContextReadError("UNAVAILABLE","CONTEXT_WAL_READER_UNQUALIFIED");
    const directory=lstatSync(root);
    check(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid===process.getuid?.() && !(directory.mode&0o077),"CONTEXT_DIRECTORY_CHANGED");
    const fd=openSync(join(root,"attempts.sqlite"),constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const stat=fstatSync(fd),header=Buffer.alloc(20);
      check(stat.isFile() && stat.nlink===1 && stat.uid===process.getuid?.() && !(stat.mode&0o077),"CONTEXT_ARTIFACT_CHANGED");
      check(readSync(fd,header,0,20,0)===20 && header.subarray(0,16).toString()==="SQLite format 3\0","CONTEXT_ARTIFACT_CHANGED");
      if(header[18]!==1 || header[19]!==1) throw new TaskContextReadError("UNAVAILABLE","CONTEXT_WAL_READER_UNQUALIFIED");
    } finally {closeSync(fd);}
    check((config.select("SELECT value FROM binding") as {value?:string})?.value===storeBinding,"CONTEXT_STORE_BINDING_CHANGED");
  };
  return {
    contextReceipt:async(hash,signal)=>{
      bound(signal);check(hash===b.context?.receiptHash,"RECEIPT_ID_CHANGED");
      for(const directory of [root,join(root,"receipts")]) {
        const st=lstatSync(directory);check(st.isDirectory() && !st.isSymbolicLink() && st.uid===process.getuid?.() && !(st.mode&0o077),"CONTEXT_DIRECTORY_CHANGED");
      }
      const fd=openSync(join(root,"receipts",hash.slice(7)+".json"),constants.O_RDONLY|constants.O_NOFOLLOW);
      try {
        const st=fstatSync(fd);check(st.isFile() && st.nlink===1 && st.uid===process.getuid?.() && !(st.mode&0o077) && st.size<=131072,"CONTEXT_ARTIFACT_CHANGED");
        const buffer=Buffer.alloc(st.size+1);let n=0,read=0;
        while(n<buffer.length && (read=readSync(fd,buffer,n,buffer.length-n,null))) n+=read;
        check(n===st.size,"CONTEXT_ARTIFACT_CHANGED");
        const receipt=verifyReceipt(JSON.parse(buffer.subarray(0,n).toString("utf8")));
        check(receipt.receiptHash===hash && receipt.ownerId===b.ownerId && receipt.scopeRef===b.scopeRef && receipt.instanceId===b.producer.instanceId,"CONTEXT_BINDING_CHANGED");return receipt;
      } finally {closeSync(fd);}
    },
    attempt:async(id,signal)=>{
      bound(signal);check(id===b.producer.dispatchId,"DISPATCH_ID_CHANGED");
      const row=config.select("SELECT request_hash,body FROM attempts WHERE id=?",id) as {request_hash?:string;body?:string}|undefined;
      if(!row?.body) throw new TaskContextReadError("UNAVAILABLE","ATTEMPT_UNAVAILABLE");
      check(Buffer.byteLength(row.body)<=131072,"ATTEMPT_SIZE_CHANGED"); const attempt=JSON.parse(row.body);
      return {dispatchId:id,requestHash:row.request_hash,attemptHash:digest(attempt),attempt};
    },
  };
}
