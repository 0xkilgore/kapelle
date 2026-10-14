import { z } from "zod";
import { canonical, digest } from "../content.js";
import { dispatchOfferHash, instructionsHash } from "../dispatch/contracts.js";
import { DispatchStateSchema } from "../../document-models/dispatch/v1/gen/schema/zod.js";
import { verifyReceipt, contextPinSchema } from "./context-read-contracts.js";

const id = z.string().min(1).max(256), hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative(), time = z.iso.datetime();
export const taskResultBindingSchema = z.object({
  ownerId: id, scopeRef: id, reviewId: id, proposalHash: hash,
  report: z.object({ id, contentVersion: z.number().int().positive(), contentHash: hash }).strict(),
  task: z.object({ authorityRef: id, id, nativeOwnerId: id, projectId: id, sourceRef: id, commitmentHash: hash }).strict(),
  producer: z.object({ dispatchId: id, offerHash: hash, instructionsHash: hash, instanceId: id, definitionId: id, definitionVersion: id, definitionHash: hash }).strict(),
  context: z.object({ workerKind: z.literal("saved-context/v1"), receiptHash: hash, contextHash: hash, requestHash: hash }).strict().nullable(),
}).strict();
export type TaskResultContextBinding = z.infer<typeof taskResultBindingSchema>;
export type TaskResultBinding = z.infer<typeof taskResultBindingSchema>;
export type Availability = "VERIFIED" | "UNAVAILABLE" | "CHANGED" | "DENIED" | "UNBOUND";
export type Section<T> = { availability: Availability; reasonCode: string | null; data: T | null };
export class TaskContextReadError extends Error {
  constructor(readonly availability: Exclude<Availability, "VERIFIED">, readonly reasonCode: string) { super(reasonCode); }
}
const taskSchema = z.object({ authorityRef: id, taskRef: id, ownerId: id, scopeRef: id, nativeOwnerId: id,
  projectId: id, sourceRef: id, status: z.enum(["OPEN", "BLOCKED", "SNOOZED", "DONE", "ARCHIVED"]), revision, commitmentHash: hash });
const reportSchema = z.object({ id, ownerId: id, scopeRef: id, contentVersion: z.number().int().positive(),
  contentHash: hash, documentRevision: revision });
const reviewSchema = z.object({ id, ownerId: id, scopeRef: id, proposalHash: hash, documentRevision: revision,
  report: taskResultBindingSchema.shape.report });
const agentSchema = z.object({ instanceId: id, ownerId: id, scopeRef: id, revision,
  definitionRef: z.object({ id, version: id, contentHash: hash }) });
const definitionSchema = z.object({ ownerId: id, revision, release: z.object({ definitionId: id, packageVersion: id, contentHash: hash, title: z.string().min(1).max(500) }) });
export type InstanceName = { value: string; sourceRef: string; sourceRevision: number; observedAt: string; provenance: "CURRENT" | "RETAINED" };
const nameSchema = z.object({ instanceId: id, ownerId: id, scopeRef: id, value: z.string().min(1).max(500), sourceRef: id,
  sourceRevision: revision, observedAt: time, provenance: z.enum(["CURRENT", "RETAINED"]) });
export interface TaskResultReadPorts {
  /** Host-installed reads only. Implementations must honor abort and perform no initialization,
   * listing, mutation, resolution, provider contact or lazy store construction. */
  task(signal: AbortSignal): Promise<unknown>;
  report(id: string, signal: AbortSignal): Promise<unknown>;
  review(id: string, signal: AbortSignal): Promise<unknown>;
  dispatch(id: string, signal: AbortSignal): Promise<unknown>;
  instance(id: string, signal: AbortSignal): Promise<unknown>;
  definition(id: string, signal: AbortSignal): Promise<unknown>;
  instanceName?(id: string, signal: AbortSignal): Promise<unknown>;
  contextReceipt?(hash: string, signal: AbortSignal): Promise<unknown>;
  attempt?(dispatchId: string, signal: AbortSignal): Promise<unknown>;
}
export interface TaskResultContext {
  contract: "kapelle/task-result-context/v1"; binding: TaskResultBinding; observedAt: string;
  task: Section<z.infer<typeof taskSchema> & { acceptedCommitmentHash: string; commitmentMatches: boolean }>;
  report: Section<z.infer<typeof reportSchema>>;
  originalRun: Section<{ dispatchId: string; revision: number; phase: string; acceptance: {actorId:string;inputHash:string;occurredAt:string}; result: {reportId:string;contentVersion:number;contentHash:string;verificationRef:string;occurredAt:string} }>;
  agent: Section<{ instanceId: string; instanceRevision: number; definitionId: string; definitionVersion: string; definitionHash: string;
    pinnedDefinitionLabel: Section<{ value: string; sourceRevision: number }> ; instanceDisplayName: Section<InstanceName> }>;
  instructions: Section<{ text: string; instructionsHash: string; offerHash: string; acceptedAt: string }>;
  context: Section<{ offered: z.infer<typeof contextPinSchema>[]; resolved: Section<{ receiptHash: string; contextHash: string;
    observedAt: string; inputs: z.infer<typeof contextPinSchema>[]; workerKind: "saved-context/v1";
    attemptPhase: string; attemptHash: string }> }>;
}
/** Offered inventory includes the manifest itself; resolved entries exclude it. */
export const TASK_RESULT_MAX_OFFERED_PINS = 17;
export const TASK_RESULT_MAX_RESOLVED_INPUTS = 16;
export const TASK_RESULT_MAX_ENVELOPE_BYTES = 65536;
/** One UTF-8 budget for the reader, owner HTTP response and downstream reader. */
export function taskResultContextEnvelope(context: TaskResultContext) {
  const envelope = { ok: true as const, context };
  if (Buffer.byteLength(JSON.stringify(envelope)) > TASK_RESULT_MAX_ENVELOPE_BYTES)
    throw new TaskContextReadError("UNAVAILABLE", "RESPONSE_SIZE_EXCEEDED");
  return envelope;
}
const good = <T>(data: T): Section<T> => ({ availability: "VERIFIED", reasonCode: null, data });
const bad = <T>(availability: Exclude<Availability,"VERIFIED">, reasonCode: string): Section<T> => ({ availability, reasonCode, data: null });
function requireMatch(ok: unknown, reason: string): asserts ok { if (!ok) throw new TaskContextReadError("CHANGED", reason); }
function failure<T>(error: unknown): Section<T> {
  return error instanceof TaskContextReadError ? bad(error.availability, /^[A-Z_]{1,80}$/.test(error.reasonCode) ? error.reasonCode : "READ_REFUSED") : bad("UNAVAILABLE", "SOURCE_UNAVAILABLE");
}
/** Pure projection over already-owned readers. Construction and reads create no store. */
export class TaskResultContextReader {
  readonly binding: TaskResultBinding;
  constructor(binding: unknown, private readonly ports: TaskResultReadPorts) {
    this.binding = taskResultBindingSchema.parse(binding);
    // Detached binding: caller mutations cannot retarget a reader after installation.
    const freeze = (value: any) => { for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child); Object.freeze(value); };
    freeze(this.binding);
  }
  async read(): Promise<TaskResultContext> {
    const b = this.binding, controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10000);
    const checks: Array<() => Promise<void>> = [];
    const call = async (fn: () => Promise<unknown>) => {
      if (controller.signal.aborted) throw Error("deadline");
      let cancel!: () => void;
      const aborted = new Promise<never>((_, reject) => { cancel = () => reject(Error("deadline")); controller.signal.addEventListener("abort", cancel, { once: true }); });
      try {
        const raw = await Promise.race([Promise.resolve().then(fn), aborted]);
        if (Buffer.byteLength(JSON.stringify(raw) ?? "") > 262144) throw Error("source size");
        return structuredClone(raw);
      } finally { controller.signal.removeEventListener("abort", cancel); }
    };
    const stable = async <T>(fn: () => Promise<unknown>, parse: (raw: unknown) => T): Promise<T> => {
      const raw = await call(fn), first = parse(raw), fingerprint = digest(raw);
      checks.push(async () => { const next = await call(fn); parse(next); requireMatch(digest(next) === fingerprint, "CONCURRENT_CHANGE"); });
      return first;
    };
    const result: TaskResultContext = { contract: "kapelle/task-result-context/v1", binding: b, observedAt: new Date().toISOString(),
      task: bad("UNAVAILABLE","SOURCE_UNAVAILABLE"), report: bad("UNAVAILABLE","SOURCE_UNAVAILABLE"),
      originalRun: bad("UNAVAILABLE","PRODUCER_UNVERIFIED"), agent: bad("UNAVAILABLE","PRODUCER_UNVERIFIED"),
      instructions: bad("UNAVAILABLE","PRODUCER_UNVERIFIED"), context: bad("UNAVAILABLE","PRODUCER_UNVERIFIED") };
    const signal = controller.signal;
    try {
      try {
        const t = await stable(() => this.ports.task(signal), x => taskSchema.parse(x));
        requireMatch(t.authorityRef === b.task.authorityRef && t.taskRef === b.task.id && t.ownerId === b.ownerId && t.scopeRef === b.scopeRef &&
          t.nativeOwnerId === b.task.nativeOwnerId && t.projectId === b.task.projectId && t.sourceRef === b.task.sourceRef, "TASK_BINDING_CHANGED");
        result.task = { availability: t.commitmentHash === b.task.commitmentHash ? "VERIFIED" : "CHANGED", reasonCode: t.commitmentHash === b.task.commitmentHash ? null : "TASK_COMMITMENT_CHANGED",
          data: { ...t, acceptedCommitmentHash: b.task.commitmentHash, commitmentMatches: t.commitmentHash === b.task.commitmentHash } };
      } catch (e) { result.task = failure(e); }
      try {
        const r = await stable(() => this.ports.report(b.report.id, signal), x => reportSchema.parse(x));
        requireMatch(r.id === b.report.id && r.ownerId === b.ownerId && r.scopeRef === b.scopeRef && r.contentVersion === b.report.contentVersion && r.contentHash === b.report.contentHash, "REPORT_CONTENT_CHANGED");
        const review = await stable(() => this.ports.review(b.reviewId, signal), x => reviewSchema.parse(x));
        requireMatch(review.id === b.reviewId && review.ownerId === b.ownerId && review.scopeRef === b.scopeRef && review.proposalHash === b.proposalHash && canonical(review.report) === canonical(b.report), "REVIEW_BINDING_CHANGED");
        result.report = good(r);
      } catch (e) { result.report = failure(e); }
      try {
        if (result.report.availability !== "VERIFIED") throw new TaskContextReadError("UNAVAILABLE","REVIEWED_REPORT_UNVERIFIED");
        const d = await stable(() => this.ports.dispatch(b.producer.dispatchId, signal), x => DispatchStateSchema().parse(x));
        const o = d.offer, a = d.acceptance, r = d.result;
        requireMatch(d.dispatchId === b.producer.dispatchId && d.ownerId === b.ownerId && d.scopeRef === b.scopeRef && o && a && r, "PRODUCER_JOIN_CHANGED");
        requireMatch(o.scopeRef === b.scopeRef && o.sources.length <= TASK_RESULT_MAX_OFFERED_PINS && Buffer.byteLength(o.instructions) <= 32768 &&
          o.contentHash === b.producer.offerHash && dispatchOfferHash(o) === o.contentHash && instructionsHash(o.instructions) === o.instructionsHash && o.instructionsHash === b.producer.instructionsHash &&
          a.inputHash === o.contentHash && a.actorId === b.producer.instanceId &&
          canonical(o.recipient) === canonical({ instanceId:b.producer.instanceId, definitionId:b.producer.definitionId, definitionVersion:b.producer.definitionVersion, definitionHash:b.producer.definitionHash }) &&
          canonical(o.task) === canonical({ authorityRef:b.task.authorityRef,taskRef:b.task.id,commitmentHash:b.task.commitmentHash }) &&
          r.reportId === b.report.id && r.contentVersion === b.report.contentVersion && r.contentHash === b.report.contentHash && d.phase === "RESULT_RECORDED", "PRODUCER_JOIN_CHANGED");
        result.originalRun = good({ dispatchId:d.dispatchId,revision:d.revision,phase:d.phase,acceptance:a,result:r });
        result.instructions = good({text:o.instructions,instructionsHash:o.instructionsHash,offerHash:o.contentHash,acceptedAt:a.occurredAt});
        result.context = good({ offered: o.sources.map(s => contextPinSchema.parse(s)), resolved: bad("UNBOUND","CONTEXT_NOT_BOUND") });
        try {
          const instance = await stable(() => this.ports.instance(b.producer.instanceId, signal), x => agentSchema.parse(x));
          requireMatch(instance.instanceId === b.producer.instanceId && instance.ownerId === b.ownerId && instance.scopeRef === b.scopeRef &&
            canonical(instance.definitionRef) === canonical({id:b.producer.definitionId,version:b.producer.definitionVersion,contentHash:b.producer.definitionHash}), "INSTANCE_BINDING_CHANGED");
          const data = {instanceId:instance.instanceId,instanceRevision:instance.revision,definitionId:b.producer.definitionId,definitionVersion:b.producer.definitionVersion,
            definitionHash:b.producer.definitionHash,pinnedDefinitionLabel:bad<{value:string;sourceRevision:number}>("UNAVAILABLE","DEFINITION_UNAVAILABLE"),instanceDisplayName:bad<InstanceName>("UNBOUND","INSTANCE_NAME_NOT_BOUND")};
          try {
            const def = await stable(() => this.ports.definition(b.producer.definitionId, signal), x => definitionSchema.parse(x));
            requireMatch(def.ownerId === b.ownerId && def.release.definitionId === b.producer.definitionId && def.release.packageVersion === b.producer.definitionVersion && def.release.contentHash === b.producer.definitionHash,"PINNED_DEFINITION_UNAVAILABLE");
            data.pinnedDefinitionLabel = good({value:def.release.title,sourceRevision:def.revision});
          } catch(e) { data.pinnedDefinitionLabel = failure(e); }
          if(this.ports.instanceName) try {
            const n = await stable(() => this.ports.instanceName!(b.producer.instanceId,signal),x=>nameSchema.parse(x));
            requireMatch(n.instanceId===b.producer.instanceId&&n.ownerId===b.ownerId&&n.scopeRef===b.scopeRef,"INSTANCE_NAME_BINDING_CHANGED");
            data.instanceDisplayName=good({value:n.value,sourceRef:n.sourceRef,sourceRevision:n.sourceRevision,observedAt:n.observedAt,provenance:n.provenance});
          } catch(e){data.instanceDisplayName=failure(e);}
          result.agent = good(data);
        } catch(e) { result.agent=failure(e); }
        if (b.context) try {
          if (!this.ports.contextReceipt || !this.ports.attempt) throw new TaskContextReadError("UNAVAILABLE","CONTEXT_READER_UNAVAILABLE");
          const receipt = await stable(() => this.ports.contextReceipt!(b.context!.receiptHash,signal),verifyReceipt);
          requireMatch(receipt.receiptHash===b.context.receiptHash && receipt.contextHash===b.context.contextHash && receipt.ownerId===b.ownerId && receipt.scopeRef===b.scopeRef && receipt.instanceId===b.producer.instanceId &&
            receipt.dispatchId===d.dispatchId && receipt.inputHash===o.contentHash && receipt.instructionsHash===o.instructionsHash && canonical(receipt.task)===canonical(o.task) &&
            canonical(receipt.definition)===canonical(instanceDefinition(b)) && receipt.status==='READY' && canonical(receipt.requestedInputs)===canonical(o.sources),"CONTEXT_BINDING_CHANGED");
          const attempt = await stable(() => this.ports.attempt!(d.dispatchId!,signal),parseAttempt);
          requireMatch(attempt.dispatchId===d.dispatchId && attempt.requestHash===b.context.requestHash && attempt.attempt.receiptHash===receipt.receiptHash && attempt.attempt.contextHash===receipt.contextHash,"ATTEMPT_BINDING_CHANGED");
          if(attempt.attempt.phase==='RETIRED') throw new TaskContextReadError("UNAVAILABLE","ATTEMPT_RETIRED");
          if(!attempt.attempt.result) throw new TaskContextReadError("UNAVAILABLE","ATTEMPT_RESULT_UNCONFIRMED");
          requireMatch(canonical(attempt.attempt.result)===canonical({documentRef:b.report.id,documentType:'kilgore/report',contentVersion:b.report.contentVersion,contentHash:b.report.contentHash}),"ATTEMPT_RESULT_UNCONFIRMED");
          result.context.data!.resolved=good({receiptHash:receipt.receiptHash,contextHash:receipt.contextHash!,observedAt:receipt.observedAt,
            inputs:receipt.entries.map(e=>e.resolved!),workerKind:b.context.workerKind,attemptPhase:attempt.attempt.phase,attemptHash:attempt.attemptHash});
        } catch(e) { result.context.data!.resolved=failure(e); }
      } catch(e) { result.originalRun=failure(e);result.agent=failure(e);result.instructions=failure(e);result.context=failure(e); }
      try { for(const check of checks) await check(); }
      catch(e) { for(const key of ['task','report','originalRun','agent','instructions','context'] as const) result[key]=e instanceof TaskContextReadError && e.availability === "DENIED" ? bad("DENIED","ACCESS_REVOKED") : bad("UNAVAILABLE","CONCURRENT_OR_UNAVAILABLE"); }
      result.observedAt=new Date().toISOString();
      taskResultContextEnvelope(result);
      return result;
    } finally { clearTimeout(deadline); controller.abort(); }
  }
}
function instanceDefinition(b:TaskResultBinding){return {id:b.producer.definitionId,version:b.producer.definitionVersion,contentHash:b.producer.definitionHash};}
function parseAttempt(raw:unknown){
  const value=z.object({dispatchId:id,requestHash:hash,attemptHash:hash,attempt:z.object({phase:z.enum(['CLAIMED','PREPARED','REPORTED','LINKED','RETIRED']),receiptHash:hash,contextHash:hash,dispatchRevision:revision,markdown:z.string().nullable(),result:contextPinSchema.nullable()}).passthrough()}).strict().parse(raw);
  requireMatch(digest(value.attempt)===value.attemptHash,'ATTEMPT_INTEGRITY_CHANGED');return value;
}
