import { observePilotNative } from './pilot-observation.js';
import {activeRecovery,recoveryCommand,recoveryFor,withPilotControl,controlCommand,savedReadCommand} from '../task-delegation/recovery.js';
import {projectDefinition,pilotFor,currentPilot,pilotPlan,pilotConservativeControl,pilotOffer} from '../task-delegation/pilot.js';
import {randomUUID,createHash} from 'node:crypto';
import {generationInput,generationRequestSchema,producerIdentitySchema,type TaskProposalProducer} from '../task-delegation/generation-contract.js';
import { readHistory, makeVersion, versionSchema } from "../task-delegation/proposal-contract.js";
import { acceptedEnvelope, type Draft } from "../task-delegation/contract.js";
import { bindTaskFacts, qualifiedRecipient, taskSchema, taskSource, contract as taskContract, type TaskDelegationOptions } from "../task-delegation/contract.js";
import type { TrustedContext, NativeDocument, Command, ModelType } from "../command-boundary.js";
import { canonical, digest, prepareCommand, requestIdentity } from "../command-boundary.js";
import type { AgentInstanceState } from "../../document-models/agent-instance/v1/index.js";
import { assert, opaque } from "../validation.js";
import { NativeBackend, type NativeReceipt } from "./native-backend.js";
import { CommandJournal, type Entry } from "./journal.js";
import type { DispatchOffer, DispatchState } from "../../document-models/dispatch/v1/index.js";
import { authorizeDispatchLineage, type DispatchContext } from "../dispatch/contracts.js";
export type Facts = Omit<
  TrustedContext,
  "principalId" | "ownerId" | "scopeRef" | "occurredAt" | "instance"
> & {
  inboxReviews?: Array<{
    documentId: string;
    instanceId: string;
    revision: number;
    contentHash: string;
    expiresAt: string;
  }>;
};
export interface ServiceOptions {
  taskProposalProducer?: TaskProposalProducer;
  taskDelegation?: TaskDelegationOptions;
  ownerId: string;
  scopeRef: string;
  facts: () => Promise<Facts>;
  now?: () => string;
  /** Server-installed narrow effect policy; absent in production by default.
   * HTTP owner commands never call this execution-only path. */
  effectPolicy?: (
    command: Command,
    document: NativeDocument,
    context: TrustedContext,
  ) => void | Promise<void>;
}
export interface Admission {
  instanceId: string;
  documentId: string;
  revision: number;
  contentHash: string;
}
export class FrameworkAuthority {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    readonly backend: NativeBackend,
    readonly journal: CommandJournal,
    readonly options: ServiceOptions,
  ) {}
  private exclusive<T>(fn: () => Promise<T>, observation = false): Promise<T> {
    assert(!this.journal.readOnly || observation, "observation_only");
    const task = this.chain.then(fn, fn);
    this.chain = task.catch(() => undefined);
    return task;
  }
  observePilotNative() {
    return this.exclusive(() => observePilotNative(this.backend, this.options.ownerId, this.options.scopeRef), true);
  }
  private identity() {
    return {
      principalId: this.options.ownerId,
      ownerId: this.options.ownerId,
      scopeRef: this.options.scopeRef,
    };
  }
  private now() {
    return this.options.now?.() ?? new Date().toISOString();
  }
  private async context(document: NativeDocument): Promise<TrustedContext> {
    const facts = await this.options.facts();
    let instance: AgentInstanceState | undefined;
    const state = document.state.global;
    if (document.header.documentType === "kapelle/agent-instance" && state.revision > 0)
      instance = state as AgentInstanceState;
    if (
      document.header.documentType === "kapelle/review-intent" &&
      "instanceId" in state &&
      state.instanceId
    )
      instance = (await this.backend.read(state.instanceId, "kapelle/agent-instance")).document
        .state.global as AgentInstanceState;
    // Only actually published native releases may qualify an installation or upgrade.
    const published = await Promise.all(
      (await this.backend.list("kapelle/agent-definition")).map((id) =>
        this.backend.read(id, "kapelle/agent-definition"),
      ),
    );
    const definitions = published.flatMap((p) => {
      const state = p.document.state.global;
      if (!("release" in state) || !state.release) return [];
      return [
        projectDefinition(state.release,facts.definitions),
      ];
    });
    return { ...facts, definitions, ...this.identity(), occurredAt: this.now(), instance };
  }
  private async currentContext(d: NativeDocument, c: Command) {
    const recovery=activeRecovery();if(recovery)assert(c.documentType==='kapelle/dispatch'&&c.documentId===recovery.dispatchId&&c.type==='RECORD_DISPATCH_RESULT','pilot_recovery_context_forbidden');
    const ctx = await this.context(d);
    if (d.header.documentType === "kapelle/review-intent" && d.state.document.version === 3) {
      assert(this.options.taskDelegation, "Task delegation is not configured");
      const h = (d.state.global as any).taskPlanJson ? readHistory((d.state.global as any).taskPlanJson) : null;
      const generation = ["REQUEST_TASK_GENERATION","CLAIM_TASK_GENERATION","RECORD_TASK_GENERATION"].includes(c.type);
      const request = c.type === "REQUEST_TASK_GENERATION" ? generationRequestSchema.parse(JSON.parse(String(c.input.requestJson))) : h?.generationRequests?.find(r=>r.operationId===c.input.requestOperationId);
      if(generation && c.type === "RECORD_TASK_GENERATION" && c.input.outcome !== "APPLIED") {
        assert(request && (d.state.global as any).ownerId===ctx.ownerId && (d.state.global as any).scopeRef===ctx.scopeRef,"Task generation scope differs");
        ctx.taskProposalVerified=true;return ctx; // retain uncertainty/failure even after source revocation
      }
      const v = ["CREATE_TASK_PROPOSAL","REVISE_TASK_PROPOSAL"].includes(c.type) || (c.type === "RECORD_TASK_GENERATION" && c.input.outcome === "APPLIED") ? versionSchema.parse(JSON.parse(String(c.input.versionJson))) : h!.versions.at(-1)!;
      assert(v.provenance.kind !== 'generated' || !["CREATE_TASK_PROPOSAL","REVISE_TASK_PROPOSAL"].includes(c.type),"Task generated provenance requires admitted producer");
      const pilot=pilotFor(ctx.definitions,v.draft.agentId);
      if(pilot){currentPilot(pilot,ctx,v.draft.agentId);assert(!generation,'pilot_generation_forbidden');pilotPlan(pilot,v.draft,v.planHash);}
      if(generation){
        const producer=this.options.taskProposalProducer;
        assert(producer&&request&&canonical(producerIdentitySchema.parse(producer.identity))===canonical(request.producer),"Task generation producer unavailable");
        const base=h!.versions.find(v=>v.version===request.baseVersion)!;
        assert(base&&base.planHash===request.basePlanHash&&await producer.admitted(generationInput(d.header.id,base,request)),"Task generation producer not admitted");
      }
      const task = taskSchema.parse(await this.options.taskDelegation.readTask(v.draft.taskId));
      assert(task.ownerId === ctx.ownerId && canonical(makeVersion(task,v.draft,v.plan,v.version,v.comment,v.provenance)) === canonical({...v,actorId:"",occurredAt:""}), "Task proposal source changed");
      const inst=(await this.backend.read(v.draft.agentId,"kapelle/agent-instance")).document.state.global as AgentInstanceState;
      assert(canonical(qualifiedRecipient(inst,ctx,task.id,this.options.taskDelegation.permissionRef)) === canonical(v.draft.recipient), "Task proposal capability changed");
      // Refuse an undeliverable final envelope before approval locks this version.
      if(c.type === "APPROVE_TASK_PROPOSAL") acceptedEnvelope(task,{...v.draft,approval:{proposalId:d.header.id,version:v.version,planHash:v.planHash,operationId:String(c.input.operationId)}},v.plan);
      ctx.instance=inst;ctx.taskProposalVerified=true;
    }
    if (c.type === "CREATE_REVIEW") {
      const id = c.input.instanceId;
      assert(typeof id === "string", "Invalid instance");
      ctx.instance = (await this.backend.read(id, "kapelle/agent-instance")).document.state
        .global as AgentInstanceState;
    }
    if (c.documentType === "kapelle/dispatch") {
      const base = ctx.dispatch;
      ctx.dispatch = {
        parents: [],
        agents: [],
        tasks: base?.tasks ?? [],
        sources: base?.sources ?? [],
        results: base?.results ?? [],
      };
      if (["CREATE_DISPATCH", "ACCEPT_DISPATCH"].includes(c.type) ||
          (c.type === "RECORD_DISPATCH_RESULT" && (d.state.global as DispatchState).offer?.task.authorityRef === "task-authority")) {
        const offer = (
          c.type === "CREATE_DISPATCH" ? c.input.offer : (d.state.global as DispatchState).offer
        ) as DispatchOffer;
        assert(offer && typeof offer === "object" && offer.recipient, "Invalid dispatch offer");
        const parents: DispatchState[] = [],
          offers = [offer],
          seen = new Set([c.documentId]);
        let parentId = offer.parentDispatchRef;
        while (parentId) {
          opaque(parentId);
          assert(
            !seen.has(parentId) && parents.length < 8,
            "Dispatch parent cycle or depth exceeded",
          );
          seen.add(parentId);
          const p = (await this.backend.read(parentId, "kapelle/dispatch")).document.state
            .global as DispatchState;
          assert(
            p.offer && p.ownerId === ctx.ownerId && p.scopeRef === ctx.scopeRef,
            "Dispatch parent ownership differs",
          );
          parents.push(p);
          offers.push(p.offer);
          parentId = p.offer.parentDispatchRef;
        }
        const ids = new Set(
          offers.flatMap((o) => [
            o.recipient.instanceId,
            ...(o.senderAgent ? [o.senderAgent.instanceId] : []),
          ]),
        );
        const agents: AgentInstanceState[] = [];
        for (const id of ids) {
          opaque(id);
          agents.push(
            (await this.backend.read(id, "kapelle/agent-instance")).document.state
              .global as AgentInstanceState,
          );
        }
        ctx.dispatch = { ...ctx.dispatch, parents, agents };
        if (offer.task.authorityRef === "task-authority" && offer.sources.some(s => s.documentType === "task-authority/task")) {
          assert(this.options.taskDelegation, "Task delegation is not configured");
          // Native create, accept and delivery all derive source facts freshly.
          const taskEnvelope=JSON.parse(offer.instructions);
          assert(canonical(await this.taskProposalPlan(taskEnvelope.draft,c.documentId))===canonical(taskEnvelope.approvedPlan),"Task approved plan differs");
          await bindTaskFacts(ctx, offer, this.options.taskDelegation);
        }
      }
    }
    if(recovery){
      const state=d.state.global as DispatchState;
      assert(state.offer&&state.dispatchId===recovery.dispatchId&&state.offer.contentHash===recovery.offerHash&&state.acceptance?.inputHash===recovery.offerHash&&state.acceptance.actorId===recovery.pilot.instanceId&&!state.cancellationReason&&['ACCEPTED','RESULT_RECORDED'].includes(state.phase),'pilot_recovery_native_claim');
      assert(ctx.dispatch,'Dispatch authority facts unavailable');
      authorizeDispatchLineage(c.documentId,state.offer,ctx as DispatchContext);
    }
    return ctx;
  }
  private terminal(result: NativeReceipt): NativeReceipt | undefined {
    const map: Record<string, string> = {
      MATCH_ACCEPTED: "ACCEPTED",
      MATCH_REJECTED: "REJECTED_BY_MODEL",
      MATCH_REFUSED: "REFUSED",
      MATCH_REVISION_CONFLICT: "REVISION_CONFLICT",
    };
    if (result.disposition in map) return { ...result, disposition: map[result.disposition] };
    if (
      ["ACCEPTED", "REJECTED_BY_MODEL", "REFUSED", "REVISION_CONFLICT"].includes(result.disposition)
    )
      return result;
    assert(result.disposition === "UNRESOLVED", "Native receipt conflict");
    return undefined;
  }
  private async recover(e: Entry) {
    // Pilot pending results may settle only through explicit owned-worker reconciliation.
    // Generic receipt/allocation/pending-command paths cannot become an expiry bypass.
    const pilot=e.pilot??this.options.taskDelegation?.pilot;
    if(pilot&&e.command.type==='RECORD_DISPATCH_RESULT'){
      assert(recoveryFor(pilot,e.command.documentId),'pilot_explicit_reconciliation_required');
      recoveryCommand(e.command.type,e.command.documentId);savedReadCommand();
    }
    const result = this.terminal(await this.backend.reconcile(e.command.documentId, e.prepared));
    if (result) {
      e.result = result;
      this.journal.save(e);
    }
    return result;
  }
  private protectedPilot(e:Entry){return e.command.type==='RECORD_DISPATCH_RESULT'?(e.pilot??this.options.taskDelegation?.pilot):undefined;}
  private async settlePending(target?:()=>Promise<string[]>) {
    for (const e of this.journal.pending()){
      const p=this.protectedPilot(e);
      if(p&&target){
        assert(!activeRecovery(),'pilot_recovery_unrelated_operation_pending');
        const refs=await target();assert(refs.length>0,'pilot_settlement_scope_unknown');refs.forEach(opaque);
        if(!refs.some(id=>[e.command.documentId,p.instanceId,p.taskId,p.permissionRef].includes(id)))continue;
      }
      assert(await this.recover(e), "A saved native operation needs reconciliation");
    }
  }
  /** Only supported native review shapes establish a disjoint target. Unknown
   * shape/owner/references fail closed; this is not authorization to execute. */
  private async reviewSettlementRefs(id:string,version:2|3){
    const d=(await this.backend.read(id,'kapelle/review-intent')).document,s=d.state.global;
    assert(d.header.id===id&&d.state.document.version===version&&s.ownerId===this.options.ownerId&&'scopeRef' in s&&s.scopeRef===this.options.scopeRef,'pilot_settlement_scope_unknown');
    if(version===3){
      assert('taskPlanJson' in s,'pilot_settlement_scope_unknown');const h=readHistory(s.taskPlanJson);
      assert(Array.isArray(h.versions)&&h.versions.length>0,'pilot_settlement_scope_unknown');
      return [id,...h.versions.flatMap(v=>[v.draft.agentId,v.draft.taskId,v.draft.recipient.instanceId]),...(h.dispatchId?[h.dispatchId]:[])];
    }
    assert('instanceId' in s&&s.instanceId&&'proposal' in s&&s.proposal&&Array.isArray(s.proposal.targets)&&s.proposal.targets.length>0&&'effect' in s&&s.effect,'pilot_settlement_scope_unknown');
    return [id,s.instanceId,...s.proposal.targets.map(t=>t.documentRef),s.effect.dispatchRef,s.effect.outboxRef];
  }
  allocate(operationId: string, type: ModelType, name: string, modelVersion = 1) {
    assert(!activeRecovery(),"pilot_recovery_allocation_forbidden");
    return this.exclusive(async () => {
      opaque(operationId);
      assert(name.trim() && name.length <= 150, "Invalid name");
      if(this.journal.pending().some(e=>this.protectedPilot(e))){
        // The backend resolves an existing or new reservation before this callback,
        // so an allocation replay cannot masquerade as an unrelated fresh document.
        return this.backend.allocate(operationId,type,name,modelVersion,async id=>this.settlePending(async()=>[id]));
      }
      await this.settlePending();
      return this.backend.allocate(operationId, type, name, modelVersion);
    });
  }
  read(id: string, type: ModelType) {
    return this.exclusive(async () => {
      const read = await this.backend.read(id, type);
      assert(
        !read.document.state.global.ownerId ||
          read.document.state.global.ownerId === this.options.ownerId,
        "Wrong owner",
      );
      return read.document;
    });
  }
  listInstances() {
    return this.exclusive(async () => {
      const result = [];
      for (const id of await this.backend.list("kapelle/agent-instance")) {
        const s = (await this.backend.read(id, "kapelle/agent-instance")).document.state
          .global as AgentInstanceState;
        if (s.ownerId === this.options.ownerId && s.scopeRef === this.options.scopeRef)
          result.push(s);
      }
      return result;
    });
  }
  /** Read-only Dispatch records for one recipient instance (G1). Filters by this authority's owner
   * and scope before anything leaves the service. A page is bounded; `complete` is true only when
   * the store reported no further page. Dispatch phase is the native record, not confirmed execution. */
  /** Bounded Dispatch page filtered by recipient and/or exact Task (Increment 2). Each request scans at most `limit` owned
   * Dispatch documents and filters within that page (the store has no Task index yet), so `complete`/`nextCursor` stay honest
   * and no full scan hides behind the endpoint. The returned cursor is BOUND to owner, scope, recipient, Task and phases: it
   * cannot be replayed with another filter. */
  listDispatches(query: { recipient?: string; taskRef?: string; phases?: ReadonlyArray<DispatchState["phase"]>; limit?: number; cursor?: string | null }) {
    return this.exclusive(async () => {
      const limit = query.limit ?? 50, phases = query.phases?.length ? new Set(query.phases) : null;
      assert(query.recipient !== undefined || query.taskRef !== undefined, "Recipient or Task required");
      assert(query.recipient === undefined || (typeof query.recipient === "string" && query.recipient.length >= 1 && query.recipient.length <= 200), "Recipient required");
      assert(query.taskRef === undefined || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(query.taskRef), "Task reference invalid");
      const binding = createHash("sha256").update(JSON.stringify([this.options.ownerId, this.options.scopeRef, query.recipient ?? null, query.taskRef ?? null, phases ? [...phases].sort() : null])).digest("hex").slice(0, 24);
      let backendCursor: string | null = null;
      if (query.cursor) {
        const m = /^b1\.(.+)\.([a-f0-9]{24})$/.exec(query.cursor);
        assert(m && m[2] === binding, "Dispatch cursor belongs to another query");
        backendCursor = m![1];
      }
      const page = await this.backend.listPage("kapelle/dispatch", backendCursor, limit);
      const items = [];
      for (const id of page.documentIds) {
        const s = (await this.backend.read(id, "kapelle/dispatch")).document.state.global as DispatchState;
        if (s.ownerId !== this.options.ownerId || s.scopeRef !== this.options.scopeRef) continue;
        if (!s.offer || (query.recipient !== undefined && s.offer.recipient.instanceId !== query.recipient)) continue;
        if (query.taskRef !== undefined && s.offer.task.taskRef !== query.taskRef) continue;
        if (phases && !phases.has(s.phase)) continue;
        let proposalOperationId: string | null = null;
        try { const draft = JSON.parse(s.offer.instructions)?.draft; proposalOperationId = typeof draft?.operationId === "string" ? draft.operationId : null; } catch { proposalOperationId = null; }
        items.push({
          dispatchId: s.dispatchId ?? id, revision: s.revision, phase: s.phase,
          taskRef: s.offer.task.taskRef, authorityRef: s.offer.task.authorityRef,
          recipientInstanceId: s.offer.recipient.instanceId, senderId: s.offer.senderId,
          offeredAt: s.createdAt ?? null, updatedAt: s.updatedAt ?? null, expiresAt: s.offer.expiresAt,
          acceptedAt: s.acceptance?.occurredAt ?? null,
          result: s.result ? { reportId: s.result.reportId, contentVersion: s.result.contentVersion, contentHash: s.result.contentHash, occurredAt: s.result.occurredAt } : null,
          cancellationReason: s.cancellationReason ?? null,
          parentDispatchRef: s.offer.parentDispatchRef ?? null, proposalOperationId,
        });
      }
      const nextCursor = page.nextCursor === null ? null : `b1.${page.nextCursor}.${binding}`;
      // Recipient-only queries keep their exact v1 shape; Task queries add taskRef (and a null recipient when unfiltered).
      return { contract: "kapelle.dispatch-list/v1" as const, recipient: query.recipient ?? null, ...(query.taskRef !== undefined ? { taskRef: query.taskRef } : {}), items, scanned: page.documentIds.length, nextCursor, complete: page.nextCursor === null };
    });
  }
  async taskProposalDispatch(draft: Draft, dispatchId?:string) {
    assert(draft.approval, "Task proposal approval required");
    const d = (await this.backend.read(draft.approval.proposalId,"kapelle/review-intent")).document;
    assert(d.state.document.version===3 && d.state.global.ownerId===this.options.ownerId && (d.state.global as any).scopeRef===this.options.scopeRef, "Task proposal approval scope differs");
    const h=readHistory((d.state.global as any).taskPlanJson),v=h.versions.at(-1)!,a=h.approval;
    const {approval:_,...plain}=draft;
    assert((d.state.global as any).status==='APPROVED' && a && h.dispatchId && a.version===draft.approval.version && a.planHash===draft.approval.planHash && a.operationId===draft.approval.operationId && v.version===a.version && v.planHash===a.planHash && canonical(v.draft)===canonical(plain) && (!dispatchId || dispatchId===h.dispatchId), "Task proposal approval differs");
    return h.dispatchId;
  }
  async taskProposalPlan(draft:Draft,dispatchId?:string) {
    await this.taskProposalDispatch(draft,dispatchId);
    const d=(await this.backend.read(draft.approval!.proposalId,"kapelle/review-intent")).document;
    return readHistory((d.state.global as any).taskPlanJson).versions.at(-1)!.plan;
  }
  taskDelegationAgents(taskId: string) {
    return this.exclusive(async () => {
      assert(this.options.taskDelegation, "Task delegation is not configured");
      const task = taskSchema.parse(await this.options.taskDelegation.readTask(taskId));
      assert(task.id === taskId && task.ownerId === this.options.ownerId, "Task identity or owner differs");
      const agents = [];
      for (const id of await this.backend.list("kapelle/agent-instance")) {
        const d = (await this.backend.read(id, "kapelle/agent-instance")).document;
        const s = d.state.global as AgentInstanceState;
        if (s.ownerId !== this.options.ownerId || s.scopeRef !== this.options.scopeRef) continue;
        try {
          const pin = qualifiedRecipient(s, await this.context(d), taskId, this.options.taskDelegation.permissionRef);
          agents.push({id, name:s.name, available:true, contract:taskContract, workKind:"task", recipient:pin, reason:null});
        } catch {
          agents.push({id, name:s.name, available:false, contract:taskContract, workKind:"task", recipient:null, reason:"Task capability, runtime, grant or availability is not qualified"});
        }
      }
      return {task:taskSource(task), agents};
    });
  }
  receipt(id: string) {
    assert(!activeRecovery(),"pilot_recovery_unscoped_receipt_forbidden");
    return this.exclusive(async () => {
      const e = this.journal.get(id);
      assert(e, "Operation not found");
      return {
        operationId: id,
        documentId: e.command.documentId,
        result: e.result ?? (await this.recover(e)) ?? { disposition: "UNRESOLVED" },
      };
    });
  }
  command(raw: unknown) {
    assert(!this.journal.readOnly, "observation_only");
    recoveryCommand(String((raw as any)?.type),String((raw as any)?.documentId));controlCommand(String((raw as any)?.type),String((raw as any)?.documentId));savedReadCommand();
    assert(!["REQUEST_TASK_GENERATION","CLAIM_TASK_GENERATION","RECORD_TASK_GENERATION"].includes((raw as any)?.type),"Task generation host operation required");
    const c=requestIdentity(raw,this.identity()).command;
    if(pilotConservativeControl(c.type)||c.type==='REQUEST_DISPATCH_CANCEL'){
      return this.exclusive(async()=>{
        const pilots=[this.options.taskDelegation?.pilot,...this.journal.pending().map(e=>e.pilot)].filter(p=>p!==undefined);
        if(!pilots.length)return this.commandLocked(raw);
        const d=(await this.backend.read(c.documentId,c.documentType)).document,s=d.state.global;
        const pilot=pilots.find(p=>c.documentType==='kapelle/agent-instance'?c.documentId===p.instanceId:
          c.documentType==='kapelle/dispatch'&&'offer' in s&&s.offer?.recipient.instanceId===p.instanceId);
        // A configured pilot does not own the whole store. Other targets use the
        // ordinary context, authorization, qualification and revision path.
        if(!pilot)return this.commandLocked(raw);
        assert(pilot.ownerId===this.options.ownerId&&pilot.scopeRef===this.options.scopeRef,'pilot_control_owner_changed');
        assert(s.ownerId===pilot.ownerId&&'scopeRef' in s&&s.scopeRef===pilot.scopeRef,'pilot_control_scope_changed');
        if(c.type==='REQUEST_DISPATCH_CANCEL'){
          assert(c.documentType==='kapelle/dispatch'&&'offer' in s&&s.offer&&s.offer.recipient.instanceId===pilot.instanceId,'pilot_control_scope_changed');pilotOffer(pilot,s.offer);
        }else assert(c.documentType==='kapelle/agent-instance'&&c.documentId===pilot.instanceId,'pilot_control_scope_changed');
        return withPilotControl({pilot,documentId:c.documentId,type:c.type},()=>this.commandLocked(raw));
      });
    }
    return this.exclusive(() => this.commandLocked(raw));
  }
  /** In-process generation seam; never exposed through the generic owner command route. */
  taskGenerationCommand(raw: unknown) {
    assert(!activeRecovery(),"pilot_recovery_other_effect_forbidden");
    assert(["REQUEST_TASK_GENERATION","RECORD_TASK_GENERATION"].includes((raw as any)?.type),"Task generation operation invalid");
    return this.exclusive(()=>this.commandLocked(raw));
  }
  claimTaskGeneration(proposalId:string,operationId:string) {
    assert(!activeRecovery(),"pilot_recovery_generation_forbidden");
    return this.exclusive(async()=>{
      await this.settlePending(()=>this.reviewSettlementRefs(proposalId,3));
      const d=(await this.backend.read(proposalId,"kapelle/review-intent")).document;
      assert(d.state.document.version===3,"Task proposal unavailable");
      const h=readHistory((d.state.global as any).taskPlanJson),g=h.generationRequests?.find(r=>r.operationId===operationId);
      assert(g&&!h.dispatchId&&!['FAILED','APPLIED'].includes(g.status),"Task generation request unavailable");
      const key='task-generation-claim:'+operationId,prior=this.journal.get(key);
      if(g.status!=='PENDING'||prior)return {invoke:false,invocationId:g.invocationId};
      const invocationId=randomUUID();
      const receipt=await this.commandLocked({operationId:key,documentId:proposalId,documentType:'kapelle/review-intent',expectedRevision:d.state.global.revision,type:'CLAIM_TASK_GENERATION',input:{requestOperationId:operationId,invocationId}});
      assert(receipt.result.disposition==='ACCEPTED','Task generation claim uncertain');
      return {invoke:true,invocationId};
    });
  }
  /** In-process seam for a separately authenticated agent credential. No HTTP
   * route accepts principalId, and an agent cannot use this to decide a review. */
  dispatchCommand(raw: unknown, authenticatedPrincipalId: string) {
    recoveryCommand(String((raw as any)?.type),String((raw as any)?.documentId));
    return this.exclusive(async () => {
      const { command } = requestIdentity(raw, {
        ...this.identity(),
        principalId: authenticatedPrincipalId,
      });
      assert(
        command.documentType === "kapelle/dispatch",
        "Dispatch credential cannot operate another model",
      );
      return this.commandLocked(raw, authenticatedPrincipalId);
    });
  }
  private async commandLocked(raw: unknown, principalId = this.options.ownerId) {
    const { command: c, requestHash } = requestIdentity(raw, { ...this.identity(), principalId });
    recoveryCommand(c.type,c.documentId);controlCommand(c.type,c.documentId);
    if(activeRecovery()){const current=await this.backend.read(c.documentId,c.documentType);await this.currentContext(current.document,c);}
    let e = this.journal.get(c.operationId);
    if (e) {
      assert(e.requestHash === requestHash, "Operation ID conflicts with original request");
      const result = e.result ?? (await this.recover(e));
      if (result) return { operationId: c.operationId, documentId: c.documentId, result };
      assert(!activeRecovery(),"pilot_recovery_native_result_uncertain");
    }
    // The initial runtime has no qualified cross-service effect executor. Keep that boundary closed.
    const effect = ["RESERVE_EFFECT", "CLAIM_EXECUTION", "RECORD_DELIVERY"].includes(c.type);
    assert(!effect || this.options.effectPolicy, "External effect integration is not activated");
    for (const pending of this.journal.pending())
      if (pending.command.operationId !== c.operationId){
        assert(!activeRecovery(),"pilot_recovery_unrelated_operation_pending");
        const p=pending.pilot??this.options.taskDelegation?.pilot;
        const ownerReduction=p&&pending.command.type==='RECORD_DISPATCH_RESULT'&&principalId===p.ownerId&&
          ((pilotConservativeControl(c.type)&&c.documentType==='kapelle/agent-instance'&&c.documentId===p.instanceId)||
           (c.type==='REQUEST_DISPATCH_CANCEL'&&c.documentType==='kapelle/dispatch'&&c.documentId===pending.command.documentId));
        // Keep the pending result untouched. Fresh native revision preconditions arbitrate
        // a same-Dispatch cancel versus a possibly committed/in-flight result.
        if(ownerReduction)continue;
        if(p&&pending.command.type==='RECORD_DISPATCH_RESULT'){
          const ids=[pending.command.documentId,p.instanceId,p.taskId,p.permissionRef];
          const target=(await this.backend.read(c.documentId,c.documentType)).document.state.global;
          const offer=(c.type==='CREATE_DISPATCH'?c.input.offer:('offer' in target?target.offer:undefined)) as DispatchOffer|undefined;
          const refs=[c.documentId,c.input.instanceId,c.input.resourceRef,
            (c.input.grant as {principalId?:string;resourceRef?:string}|undefined)?.principalId,
            (c.input.grant as {resourceRef?:string}|undefined)?.resourceRef,
            'instanceId' in target?target.instanceId:undefined,
            offer?.recipient.instanceId,offer?.senderAgent?.instanceId,offer?.task.taskRef,offer?.permissionRef];
          // Skip only disjoint native work, never settle the protected entry or
          // bypass ordering on its Dispatch, instance, Task or permission resource.
          if(!refs.some(ref=>typeof ref==='string'&&ids.includes(ref)))continue;
        }
        assert(await this.recover(pending), "A saved native operation needs reconciliation");
      }
    const current = await this.backend.read(c.documentId, c.documentType);
    const ctx = await this.currentContext(current.document, c);
    ctx.principalId = principalId;
    if (effect) await this.options.effectPolicy!(c, current.document, ctx);
    const validated = prepareCommand(c, current.document, ctx);
    if (!e) {
      e = {
        requestHash,
        ...(c.type==='RECORD_DISPATCH_RESULT'&&this.options.taskDelegation?.pilot?{pilot:this.options.taskDelegation.pilot}:{}),
        command: c,
        prepared: await this.backend.prepare(
          c.documentId,
          c.documentType,
          c.operationId,
          current.nativeRevision,
          validated.action,
        ),
      };
      this.journal.save(e);
    }
    // Serialized private-scope writer; retained actions are retried unchanged. No generic write endpoint.
    if(activeRecovery()){
      const fresh=await this.backend.read(c.documentId,c.documentType);
      const freshContext=await this.currentContext(fresh.document,c);freshContext.principalId=principalId;
      prepareCommand(c,fresh.document,freshContext);recoveryCommand(c.type,c.documentId);
    }
    const result = this.terminal(await this.backend.commit(c.documentId, e.prepared));
    assert(result, "Native result unresolved");
    e.result = result;
    this.journal.save(e);
    return { operationId: c.operationId, documentId: c.documentId, result };
  }
  /** Cold-start context comes from native records. Instructions are data, never grants. */
  dispatchBundle(id: string, authenticatedRecipientId: string) {
    return this.exclusive(async () => {
      const d = (await this.backend.read(id, "kapelle/dispatch")).document,
        s = d.state.global as DispatchState;
      assert(
        s.offer &&
          s.ownerId === this.options.ownerId &&
          s.scopeRef === this.options.scopeRef &&
          s.offer.recipient.instanceId === authenticatedRecipientId,
        "Dispatch recipient differs",
      );
      const recovery=activeRecovery();
      assert(!recovery||(recovery.dispatchId===id&&s.acceptance?.inputHash===s.offer.contentHash&&s.acceptance.actorId===authenticatedRecipientId&&!s.cancellationReason),'pilot_recovery_native_claim');
      assert(s.phase === "OFFERED" || s.phase === "ACCEPTED" || (recovery&&s.phase==='RESULT_RECORDED'), "Dispatch is no longer active");
      const ctx = await this.currentContext(d, {
        documentId: id,
        documentType: "kapelle/dispatch",
        expectedRevision: s.revision,
        operationId: "dispatch-read",
        type: recovery?'RECORD_DISPATCH_RESULT':'ACCEPT_DISPATCH',
        input: { inputHash: s.offer.contentHash },
      });
      assert(ctx.dispatch, "Dispatch authority facts unavailable");
      authorizeDispatchLineage(id, s.offer, {
        ...ctx,
        principalId: authenticatedRecipientId,
        dispatch: ctx.dispatch,
      });
      return {
        document: d,
        originalRequesterId: s.offer.originalRequesterId,
        instructions: s.offer.instructions,
        sources: s.offer.sources,
        task: s.offer.task,
        parents: ctx.dispatch.parents,
      };
    });
  }
  /** True is an ephemeral right returned only to the process that newly
   * commits the native claim. A prior claim or ambiguous acknowledgement never
   * issues another invocation right, even when its original receipt is accepted. */
  claimPublicationInvocation(reviewId: string, effectOperationId: string) {
    assert(!activeRecovery(),"pilot_recovery_other_effect_forbidden");
    return this.exclusive(async () => {
      await this.settlePending(()=>this.reviewSettlementRefs(reviewId,2));
      const d = (await this.backend.read(reviewId, "kapelle/review-intent")).document,
        s = d.state.global;
      assert(
        d.state.document.version === 2 &&
          "execution" in s &&
          s.effect &&
          s.proposal &&
          s.ownerId === this.options.ownerId &&
          s.scopeRef === this.options.scopeRef &&
          s.effect.operationId === effectOperationId,
        "Unknown publication reservation",
      );
      if (s.execution) return false;
      const operationId = "publication-invoke:" + digest({ reviewId, effectOperationId }).slice(7);
      const prior = this.journal.get(operationId);
      const result = await this.commandLocked(
        prior?.command ?? {
          operationId,
          documentId: reviewId,
          documentType: "kapelle/review-intent",
          expectedRevision: s.revision,
          type: "CLAIM_EXECUTION",
          input: {
            operationId: effectOperationId,
            attemptId: "attempt:" + digest({ reviewId, effectOperationId }).slice(7),
            executorId: s.instanceId,
            dispatchRef: s.effect.dispatchRef,
            outboxRef: s.effect.outboxRef,
            proposalHash: s.proposal.contentHash,
            proposalVersion: s.proposal.version,
          },
        },
      );
      assert(result.result.disposition === "ACCEPTED", "Native invocation claim was not accepted");
      return !prior;
    });
  }
  /** Recheck the consumed intent immediately before the executor's mutation.
   * A reservation is not durable permission to ignore a later pause/revocation. */
  effectAdmission(reviewId: string, operationId: string) {
    assert(!activeRecovery(),"pilot_recovery_other_effect_forbidden");
    return this.exclusive(async () => {
      await this.settlePending(()=>this.reviewSettlementRefs(reviewId,2));
      const d = (await this.backend.read(reviewId, "kapelle/review-intent")).document;
      const s = d.state.global;
      assert(
        "effect" in s &&
          s.effect &&
          s.proposal &&
          s.status === "APPROVED" &&
          s.decision?.approved &&
          s.effect.operationId === operationId &&
          "execution" in s &&
          s.execution?.operationId === operationId &&
          s.delivery.length === 0,
        "Effect is not an unreported reservation",
      );
      const c: Command = {
        operationId: "effect-admission:" + operationId,
        documentId: reviewId,
        documentType: "kapelle/review-intent",
        expectedRevision: s.revision,
        type: "RESERVE_EFFECT",
        input: {
          operationId,
          dispatchRef: s.effect.dispatchRef,
          outboxRef: s.effect.outboxRef,
          proposalHash: s.proposal.contentHash,
          proposalVersion: s.proposal.version,
        },
      };
      const ctx = await this.currentContext(d, c);
      assert(this.options.effectPolicy, "External effect integration is not activated");
      await this.options.effectPolicy(c, d, ctx);
      prepareCommand(c, d, ctx);
      return {
        reviewId,
        operationId,
        proposalHash: s.proposal.contentHash,
        checkedAt: ctx.occurredAt,
      };
    });
  }
  /** Owner-accepted source supplies the scope; callers cannot nominate arbitrary grants. */
  async grantInboxReview(input: Admission) {
    assert(!activeRecovery(),"pilot_recovery_other_effect_forbidden");
    const facts = await this.options.facts();
    const match = facts.inboxReviews?.find(
      (i) =>
        i.documentId === input.documentId &&
        i.instanceId === input.instanceId &&
        i.revision === input.revision &&
        i.contentHash === input.contentHash,
    );
    assert(
      match && match.expiresAt > this.now(),
      "Source is not an accepted inbox review for this instance",
    );
    const operationId = "inbox-read:" + input.instanceId + ":" + input.documentId;
    const prior = this.journal.get(operationId);
    const d = await this.read(input.instanceId, "kapelle/agent-instance");
    const command = prior?.command ?? {
      operationId,
      documentId: input.instanceId,
      documentType: "kapelle/agent-instance",
      expectedRevision: d.state.global.revision,
      type: "GRANT_CAPABILITY",
      input: {
        grant: {
          id: "inbox-read:" + input.documentId,
          principalId: input.instanceId,
          resourceRef: input.documentId,
          actions: ["read"],
          expiresAt: match.expiresAt,
          reviewPolicy: "ALWAYS",
        },
      },
    };
    const result = await this.command(command);
    assert(result.result.disposition === "ACCEPTED", "Grant was not accepted");
    return this.admission(input);
  }
  /** Fresh check used before queue admission AND immediately before worker delivery. */
  admission(input: Admission) {
    assert(!activeRecovery(),"pilot_recovery_other_effect_forbidden");
    return this.exclusive(async () => {
      await this.settlePending(async()=>{
        const d=(await this.backend.read(input.instanceId,'kapelle/agent-instance')).document,s=d.state.global;
        assert(d.header.id===input.instanceId&&'instanceId' in s&&s.instanceId===input.instanceId&&s.ownerId===this.options.ownerId&&'scopeRef' in s&&s.scopeRef===this.options.scopeRef,'pilot_settlement_scope_unknown');
        return [input.instanceId,input.documentId];
      });
      const d = (await this.backend.read(input.instanceId, "kapelle/agent-instance")).document;
      const s = d.state.global as AgentInstanceState,
        ctx = await this.context(d);
      assert(
        s.ownerId === this.options.ownerId && s.scopeRef === this.options.scopeRef,
        "Wrong instance scope",
      );
      assert(s.desiredState === "READY", "Instance is paused or retired");
      const proof = ctx.definitions.find(
        (p) =>
          p.qualified &&
          p.release.definitionId === s.definitionRef?.id &&
          p.release.packageVersion === s.definitionRef?.version &&
          p.release.contentHash === s.definitionRef?.contentHash,
      );
      assert(proof, "Definition unavailable");
      assert(
        s.runtimeBindingRef && ctx.runtimeBindingRefs.includes(s.runtimeBindingRef),
        "Runtime binding unavailable",
      );
      const fact = ctx.resources.find((r) => r.id === input.documentId);
      assert(
        fact &&
          fact.revision === input.revision &&
          fact.contentHash === input.contentHash &&
          fact.allowedActions.includes("read"),
        "Source changed or read access denied",
      );
      assert(
        s.grants.some(
          (g) =>
            g.principalId === s.instanceId &&
            g.resourceRef === input.documentId &&
            g.actions.includes("read") &&
            !g.revokedAt &&
            g.expiresAt > ctx.occurredAt,
        ),
        "Instance read grant unavailable",
      );
      assert(s.modelPolicy && !s.modelPolicy.paidFallback, "Paid runtime is not activated");
      assert(
        proof.release.runtimeContracts.includes(
          ctx.runtimeBindingContracts[s.runtimeBindingRef!],
        ) && proof.release.modelProfiles.includes(s.modelPolicy.preferredProfile),
        "Runtime contract or model profile changed",
      );
      assert(
        proof.release.capabilities.some(
          (cap) => cap.resourceType === fact.resourceType && cap.actions.includes("read"),
        ),
        "Instance read capability is not declared",
      );
      assert(
        ctx.budgetPolicyRefs.includes(s.modelPolicy.budgetPolicyRef),
        "Budget policy unavailable",
      );
      return {
        instanceId: s.instanceId!,
        instanceRevision: s.revision,
        definitionHash: s.definitionRef!.contentHash,
        runtimeBindingRef: s.runtimeBindingRef!,
        documentId: input.documentId,
        revision: input.revision,
        contentHash: input.contentHash,
        checkedAt: ctx.occurredAt,
        scopeRef: this.options.scopeRef,
        receiptHash: digest({
          instanceId: s.instanceId,
          instanceRevision: s.revision,
          source: input,
        }),
      };
    });
  }
}
