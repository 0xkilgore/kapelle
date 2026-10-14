import {recoveryCommand,controlCommand,savedReadCommand} from './task-delegation/recovery.js';
import {currentPilot,pilotIdentity,pilotConservativeControl,pilotFor,pilotLifecycle,type TaskPilot} from './task-delegation/pilot.js';
import * as taskReview from "../document-models/review-intent/v3/index.js";
/** Native model command preparation. The hosting authority supplies verified identity
 * and current scoped reads. Never accept TrustedContext from an HTTP request body. */
import { canonical, digest } from "./content.js";
export { canonical, digest } from "./content.js";
import type { Action, PHDocument } from "document-model";
import * as definition from "../document-models/agent-definition/v1/index.js";
import * as instance from "../document-models/agent-instance/v1/index.js";
import * as reviewV1 from "../document-models/review-intent/v1/index.js";
import * as review from "../document-models/review-intent/v2/index.js";
import * as dispatch from "../document-models/dispatch/v1/index.js";
import { authorizeDispatchLineage, type DispatchFacts } from "./dispatch/contracts.js";
import { assert, opaque, timestamp } from "./validation.js";
import { z } from "zod";

export const modules = [
  definition.AgentDefinition,
  instance.AgentInstance,
  reviewV1.ReviewIntent,
  review.ReviewIntent,
  taskReview.ReviewIntent,
  dispatch.Dispatch,
] as const;
export type NativeDocument =
  | definition.AgentDefinitionDocument
  | instance.AgentInstanceDocument
  | reviewV1.ReviewIntentDocument
  | taskReview.ReviewIntentDocument
  | review.ReviewIntentDocument
  | dispatch.DispatchDocument;
export function nativeModel(type: string, version = 1) {
  const model = modules.find((m) => m.documentModel.global.id === type && m.version === version);
  assert(model, "Unknown native model version");
  return model;
}
export type ModelType =
  | "kapelle/agent-definition"
  | "kapelle/agent-instance"
  | "kapelle/review-intent"
  | "kapelle/dispatch";
export function releaseHash(release: definition.DefinitionReleaseInput) {
  const { contentHash: _, ...rest } = release;
  return digest({
    ...rest,
    previousVersionRef: rest.previousVersionRef ?? null,
    avatarRef: rest.avatarRef ?? null,
    instructionTokenCount: rest.instructionTokenCount ?? null,
    tokenizerRef: rest.tokenizerRef ?? null,
  });
}
export function proposalHash(proposal: review.ProposalInput | reviewV1.ProposalInput) {
  const { contentHash: _, expiresAt, ...rest } = proposal as review.ProposalInput;
  // Null expiry must not change a retained v1 proposal/decision hash on upgrade.
  return digest({
    ...rest,
    senderConnectionRef: rest.senderConnectionRef ?? null,
    ...(expiresAt == null ? {} : { expiresAt }),
  });
}
export interface DefinitionProof {
  release: definition.DefinitionRelease;
  qualified: boolean;
  pilot?: TaskPilot;
}
export interface ResourceFact {
  id: string;
  resourceType: string;
  revision: number;
  contentHash: string;
  allowedActions: readonly string[];
}
export interface TrustedContext {
  taskProposalVerified?: boolean;
  dispatch?: DispatchFacts;
  /** Derived by the host from a verified session/token, not actorId/profile/loopback. */
  principalId: string;
  /** Bound by the host to this authenticated request; never inferred from its payload. */
  ownerId: string;
  scopeRef: string;
  instance?: instance.AgentInstanceState;
  occurredAt: string;
  definitions: readonly DefinitionProof[];
  resources: readonly ResourceFact[];
  /** Host-admitted Task reads, each bound to one instance. Consulted only for that instance's own
   * GRANT_CAPABILITY and REQUEST_RESUME checks; never a general resource for other commands or instances. */
  admittedTaskReads?: readonly { instanceId: string; resource: ResourceFact }[];
  /** Scope-owned bindings resolved by the host; no credentials in a document. */
  connectionRefs: readonly string[];
  runtimeBindingRefs: readonly string[];
  runtimeBindingContracts: Readonly<Record<string, string>>;
  scheduleRefs: readonly string[];
  budgetPolicyRefs: readonly string[];
  artifacts: readonly { id: string; version: number; contentHash: string }[];
  effects: readonly {
    operationId: string;
    instanceId: string;
    scopeRef: string;
    dispatchRef: string;
    outboxRef: string;
    proposalHash: string;
  }[];
  deliveryReceipts: readonly {
    id: string;
    operationId: string;
    status: review.DeliveryStatus;
    providerRef: string;
    receiptRef: string;
  }[];
}
const commandSchema = z
  .object({
    operationId: z.string().min(1).max(200),
    documentId: z.string().min(1).max(200),
    documentType: z.enum([
      "kapelle/agent-definition",
      "kapelle/agent-instance",
      "kapelle/review-intent",
      "kapelle/dispatch",
    ]),
    expectedRevision: z.number().int().min(0),
    type: z.string().min(1).max(80),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;
export interface Prepared {
  command: Command;
  requestHash: string;
  action: Action;
}

// Explicit operations map keeps generated action creators as the native ABI.
const creators = {
  CREATE_DISPATCH: dispatch.createDispatch,
  ACCEPT_DISPATCH: dispatch.acceptDispatch,
  REQUEST_DISPATCH_CANCEL: dispatch.requestDispatchCancel,
  RECORD_DISPATCH_RESULT: dispatch.recordDispatchResult,
  PUBLISH_DEFINITION: definition.publishDefinition,
  CREATE_INSTANCE: instance.createInstance,
  SET_RESPONSIBILITIES: instance.setResponsibilities,
  SET_OPERATING_POLICY: instance.setOperatingPolicy,
  ENABLE_SKILL: instance.enableSkill,
  DISABLE_SKILL: instance.disableSkill,
  GRANT_CAPABILITY: instance.grantCapability,
  REVOKE_CAPABILITY: instance.revokeCapability,
  BIND_CONNECTION: instance.bindConnection,
  REVOKE_CONNECTION: instance.revokeConnection,
  SET_RUNTIME_BINDING: instance.setRuntimeBinding,
  SET_MODEL_POLICY: instance.setModelPolicy,
  LINK_DOCUMENT: instance.linkDocument,
  UNLINK_DOCUMENT: instance.unlinkDocument,
  BIND_SCHEDULE: instance.bindSchedule,
  UNBIND_SCHEDULE: instance.unbindSchedule,
  PIN_DEFINITION_VERSION: instance.pinDefinitionVersion,
  REQUEST_PAUSE: instance.requestPause,
  REQUEST_RESUME: instance.requestResume,
  RETIRE_INSTANCE: instance.retireInstance,
  CREATE_REVIEW: review.createReview,
  RECORD_DECISION: review.recordDecision,
  INVALIDATE_REVIEW: review.invalidateReview,
  RESERVE_EFFECT: review.reserveEffect,
  RECORD_DELIVERY: review.recordDelivery,
} as const;
export function requestIdentity(
  raw: unknown,
  ctx: Pick<TrustedContext, "principalId" | "ownerId" | "scopeRef">,
) {
  const c = commandSchema.parse(raw);
  opaque(c.operationId);
  opaque(c.documentId);
  opaque(ctx.principalId);
  assert(
    c.documentType === "kapelle/dispatch" || ctx.principalId === ctx.ownerId,
    "Authenticated owner required",
  );
  assert(
    !["actorId", "occurredAt", "expectedRevision"].some((k) => k in c.input),
    "Actor, timestamp and revision are authority-owned",
  );
  assert(Buffer.byteLength(canonical(c)) <= 262144, "Command too large");
  return {
    command: c,
    requestHash: digest({
      ownerId: ctx.ownerId,
      scopeRef: ctx.scopeRef,
      command: c,
      ...(c.documentType === "kapelle/dispatch" ? { principalId: ctx.principalId } : {}),
    }),
  };
}
function qualified(ref: instance.VersionedRefInput, ctx: TrustedContext) {
  const proof = ctx.definitions.find(
    (x) =>
      x.release.definitionId === ref.id &&
      x.release.packageVersion === ref.version &&
      x.release.contentHash === ref.contentHash,
  );
  assert(
    proof?.qualified && releaseHash(proof.release) === ref.contentHash,
    "Definition release is not qualified or hash does not match",
  );
  return proof.release;
}
function ownedInstance(ctx: TrustedContext, id?: string) {
  const s = ctx.instance;
  assert(
    s && s.ownerId === ctx.ownerId && s.scopeRef === ctx.scopeRef && (!id || s.instanceId === id),
    "Wrong owner, instance or scope",
  );
  return s;
}
function resourcesCurrent(p: review.Proposal | reviewV1.Proposal, ctx: TrustedContext) {
  if ("expiresAt" in p && p.expiresAt) {
    timestamp(p.expiresAt);
    assert(p.expiresAt > ctx.occurredAt, "Proposal expired");
  }
  assert(
    ctx.artifacts.some(
      (a) =>
        a.id === p.contentRef && a.version === p.contentVersion && a.contentHash === p.artifactHash,
    ),
    "Proposal artifact unavailable or changed",
  );
  for (const t of p.targets) {
    const fact = ctx.resources.find((f) => f.id === t.documentRef);
    assert(fact && fact.allowedActions.includes("read"), "Target not authorized");
    assert(
      fact.revision === t.revision && fact.contentHash === t.contentHash,
      "Stale target revision",
    );
  }
}
export function prepareCommand(
  raw: unknown,
  document: NativeDocument,
  ctx: TrustedContext,
): Prepared {
  const { command: c, requestHash } = requestIdentity(raw, ctx);
  recoveryCommand(c.type,c.documentId);controlCommand(c.type,c.documentId);savedReadCommand();
  timestamp(ctx.occurredAt);
  assert(
    document.header.id === c.documentId && document.header.documentType === c.documentType,
    "Wrong document identity",
  );
  const state = document.state.global;
  assert(state.revision === c.expectedRevision, "Stale document revision");
  assert(!state.ownerId || state.ownerId === ctx.ownerId, "Wrong document owner");
  const modelVersion = document.state.document.version;
  const model = nativeModel(c.documentType, modelVersion);
  const operation = model.documentModel.global.specifications
    .find((s) => s.version === modelVersion)!
    .modules.flatMap((m) => m.operations)
    .find((o) => o.name === c.type);
  assert(operation, "Operation does not belong to document model");
  const reviewNamespace = modelVersion === 3 ? taskReview : modelVersion === 1 ? reviewV1 : review;
  const creator = (
    c.documentType === "kapelle/review-intent"
      ? (modelVersion === 3 ? taskReview.actions[c.type as keyof typeof taskReview.actions] : {
          CREATE_REVIEW: (reviewNamespace as typeof review).createReview,
          RECORD_DECISION: (reviewNamespace as typeof review).recordDecision,
          INVALIDATE_REVIEW: (reviewNamespace as typeof review).invalidateReview,
          RESERVE_EFFECT: (reviewNamespace as typeof review).reserveEffect,
          RECORD_DELIVERY: (reviewNamespace as typeof review).recordDelivery,
          CLAIM_EXECUTION: review.claimExecution,
        }[c.type])
      : creators[c.type as keyof typeof creators]
  ) as (input: never) => Action;
  const rawInput = {
    ...c.input,
    actorId: ctx.principalId,
    occurredAt: ctx.occurredAt,
    expectedRevision: c.expectedRevision,
  };
  const namespace =
    c.documentType === "kapelle/agent-definition"
      ? definition
      : c.documentType === "kapelle/agent-instance"
        ? instance
        : c.documentType === "kapelle/dispatch"
          ? dispatch
          : reviewNamespace;
  const schemaName =
    c.type
      .toLowerCase()
      .split("_")
      .map((v) => v[0].toUpperCase() + v.slice(1))
      .join("") + "InputSchema";
  const schemaFactory = (namespace as unknown as Record<string, () => z.ZodType>)[schemaName];
  assert(schemaFactory, "Missing native input schema");
  const parsed = schemaFactory().parse(rawInput);
  assert(canonical(parsed) === canonical(rawInput), "Unknown or unsupported input field");
  const action = creator(parsed as never);
  // Generated parsers must not silently discard caller fields.
  assert(canonical(action.input) === canonical(rawInput), "Unknown or unsupported input field");
  if (c.documentType === "kapelle/agent-definition") {
    const input = action.input as definition.PublishDefinitionInput;
    assert(releaseHash(input.release) === input.release.contentHash, "Definition hash mismatch");
    assert(
      !ctx.definitions.some(
        (d) =>
          d.release.definitionId === input.release.definitionId &&
          d.release.packageVersion === input.release.packageVersion &&
          d.release.contentHash !== input.release.contentHash,
      ),
      "Release identity already has different content",
    );
    if (input.release.previousVersionRef) qualified(input.release.previousVersionRef, ctx);
  }
  if (c.documentType === "kapelle/agent-instance") {
    const s = document.state.global as instance.AgentInstanceState;
    const ref=c.type==='CREATE_INSTANCE'?(action.input as instance.CreateInstanceInput).definitionRef:s.definitionRef;
    const proof=ctx.definitions.find(d=>d.release.contentHash===ref?.contentHash&&d.release.definitionId===ref?.id&&d.release.packageVersion===ref?.version);
    const pilot=proof&&!proof.qualified&&proof.pilot?(pilotConservativeControl(c.type)?pilotIdentity(proof.pilot,ctx,c.documentId):currentPilot(proof.pilot,ctx,c.documentId)):undefined;
    if(pilot){
      assert(pilot.definitionHash===ref!.contentHash&&releaseHash(proof!.release)===ref!.contentHash,'pilot_definition_changed');
      pilotLifecycle(pilot,c.type,action.input);
      if(c.type==='REQUEST_RESUME')assert(s.runtimeBindingRef===pilot.runtimeBindingRef&&digest(s.modelPolicy)===pilot.modelPolicyHash,'pilot_instance_changed');
    }
    const eligible=(r:instance.VersionedRefInput)=>pilot&&canonical(r)===canonical(ref)?proof!.release:qualified(r,ctx);
    if (c.type === "CREATE_INSTANCE") {
      const i = action.input as instance.CreateInstanceInput;
      assert(i.instanceId === c.documentId, "Instance identity must match native document");
      assert(i.scopeRef === ctx.scopeRef, "Wrong creation scope");
      eligible(i.definitionRef);
      assert(!i.modelPolicy.paidFallback, "Initial paid fallback must be disabled");
    } else {
      const current = ownedInstance(ctx, s.instanceId ?? undefined);
      assert(canonical(current) === canonical(s), "Stale instance projection");
    }
    // Admitted Task/read facts apply only to the bound instance's own grant/readiness checks.
    const grantResources = [...ctx.resources, ...(ctx.admittedTaskReads ?? [])
      .filter((a) => a.instanceId === c.documentId && a.resource.resourceType === "task" &&
        canonical(a.resource.allowedActions) === canonical(["read"]) && !ctx.resources.some((r) => r.id === a.resource.id))
      .map((a) => a.resource)];
    if (c.type === "GRANT_CAPABILITY") {
      const g = (action.input as instance.GrantCapabilityInput).grant;
      const r = eligible(s.definitionRef!),
        fact = grantResources.find((f) => f.id === g.resourceRef);
      assert(
        g.principalId === s.instanceId &&
          fact &&
          g.actions.every((a) => fact.allowedActions.includes(a)),
        "Grant exceeds instance or document scope",
      );
      assert(
        r.capabilities.some(
          (cap) =>
            cap.resourceType === fact.resourceType &&
            g.actions.every((a) => cap.actions.includes(a)),
        ),
        "Capability not declared by pinned definition",
      );
    }
    if (c.type === "CREATE_INSTANCE" || c.type === "SET_MODEL_POLICY") {
      const p = (action.input as instance.SetModelPolicyInput).modelPolicy;
      const releaseRef =
        c.type === "CREATE_INSTANCE"
          ? (action.input as instance.CreateInstanceInput).definitionRef
          : s.definitionRef!;
      assert(
        eligible(releaseRef).modelProfiles.includes(p.preferredProfile),
        "Model profile is not qualified by the definition",
      );
      assert(ctx.budgetPolicyRefs.includes(p.budgetPolicyRef), "Budget policy not authorized");
      if (p.paidFallback)
        assert(
          p.fallbackScopeRef === ctx.scopeRef &&
            p.fallbackBudgetRef &&
            ctx.budgetPolicyRefs.includes(p.fallbackBudgetRef),
          "Fallback scope or budget not authorized",
        );
    }
    if (c.type === "PIN_DEFINITION_VERSION") {
      const i = action.input as instance.PinDefinitionVersionInput;
      const r = eligible(i.definitionRef);
      const migration = r.migrations.find((m) => m.fromVersion === s.definitionRef?.version);
      assert(
        migration &&
          canonical(migration.migrationRef) === canonical(i.migrationRef) &&
          canonical(migration.compatibilityFixtureRef) === canonical(i.compatibilityFixtureRef),
        "Qualified migration does not match",
      );
    }
    if (c.type === "SET_RUNTIME_BINDING")
      assert(
        ctx.runtimeBindingRefs.includes(
          (action.input as instance.SetRuntimeBindingInput).runtimeBindingRef,
        ) &&
          eligible(s.definitionRef!).runtimeContracts.includes(
            ctx.runtimeBindingContracts[
              (action.input as instance.SetRuntimeBindingInput).runtimeBindingRef
            ],
          ),
        "Runtime binding not authorized",
      );
    if (c.type === "BIND_CONNECTION")
      assert(
        ctx.connectionRefs.includes(
          (action.input as instance.BindConnectionInput).binding.connectionRef,
        ),
        "Connection not authorized",
      );
    if (c.type === "BIND_SCHEDULE")
      assert(
        ctx.scheduleRefs.includes(
          (action.input as instance.BindScheduleInput).schedule.schedulerRef,
        ),
        "Scheduler binding not authorized",
      );
    if (c.type === "LINK_DOCUMENT")
      assert(
        ctx.resources.some(
          (f) =>
            f.id === (action.input as instance.LinkDocumentInput).documentRef &&
            f.allowedActions.includes("read"),
        ),
        "Document link not authorized",
      );
    if (c.type === "REQUEST_RESUME") {
      const r = eligible(s.definitionRef!);
      assert(
        s.runtimeBindingRef &&
          ctx.runtimeBindingRefs.includes(s.runtimeBindingRef) &&
          r.runtimeContracts.includes(ctx.runtimeBindingContracts[s.runtimeBindingRef]),
        "Runtime binding unavailable",
      );
      for (const capability of r.capabilities.filter((x) => x.requirement === "REQUIRED"))
        assert(
          s.grants.some(
            (g) =>
              !g.revokedAt &&
              g.expiresAt > ctx.occurredAt &&
              g.principalId === s.instanceId &&
              grantResources.some(
                (f) =>
                  f.id === g.resourceRef &&
                  f.resourceType === capability.resourceType &&
                  capability.actions.every(
                    (a) => f.allowedActions.includes(a) && g.actions.includes(a),
                  ),
              ),
          ),
          "Required capability not granted",
        );
    }
  }
  if (c.documentType === "kapelle/review-intent" && modelVersion === 3) {
    assert(ctx.taskProposalVerified, "Task proposal source and capability not verified");
    assert(ctx.principalId === ctx.ownerId, "Task proposal owner required");
    if(c.type === "CREATE_TASK_PROPOSAL") assert(c.input.reviewId === c.documentId && c.input.scopeRef === ctx.scopeRef, "Task proposal identity differs");
    else assert((state as taskReview.ReviewIntentPHState["global"]).scopeRef === ctx.scopeRef, "Task proposal scope differs");
  }
  if (c.documentType === "kapelle/review-intent" && modelVersion !== 3) {
    const s = document.state.global as review.ReviewIntentState;
    const i = action.input as review.CreateReviewInput;
    const inst = ownedInstance(ctx, c.type === "CREATE_REVIEW" ? i.instanceId : s.instanceId!);
    assert(!pilotFor(ctx.definitions,inst.instanceId!),"pilot_generic_effect_forbidden");
    assert(
      (c.type === "CREATE_REVIEW" ? i.scopeRef : s.scopeRef) === ctx.scopeRef,
      "Wrong review scope",
    );
    if (c.type === "CREATE_REVIEW") {
      assert(i.reviewId === c.documentId, "Review identity must match native document");
      assert(proposalHash(i.proposal) === i.proposal.contentHash, "Proposal hash mismatch");
      resourcesCurrent(i.proposal as review.Proposal, ctx);
    }
    if (c.type === "RECORD_DECISION") resourcesCurrent(s.proposal!, ctx);
    if (c.type === "RECORD_DELIVERY") {
      const e = action.input as review.RecordDeliveryInput;
      assert(
        ctx.deliveryReceipts.some(
          (r) =>
            r.id === e.evidenceId &&
            r.operationId === e.operationId &&
            r.status === e.status &&
            r.providerRef === e.providerRef &&
            r.receiptRef === e.receiptRef,
        ),
        "Delivery evidence is not verified",
      );
    }
    if (c.type === "RESERVE_EFFECT" || c.type === "CLAIM_EXECUTION") {
      if (c.type === "CLAIM_EXECUTION")
        assert(
          (action.input as review.ClaimExecutionInput).executorId === inst.instanceId,
          "Wrong invocation executor",
        );
      assert(inst.desiredState === "READY", "Instance does not admit effects");
      resourcesCurrent(s.proposal!, ctx);
      const p = s.proposal!;
      if (p.effectKind === "WEBSITE_PUBLICATION") {
        const release = qualified(inst.definitionRef!, ctx);
        assert(
          inst.runtimeBindingRef &&
            ctx.runtimeBindingRefs.includes(inst.runtimeBindingRef) &&
            release.runtimeContracts.includes(ctx.runtimeBindingContracts[inst.runtimeBindingRef]),
          "Runtime binding unavailable",
        );
        assert(
          release.documentModels.some(
            (m) => m.documentType === "kapelle/review-intent" && m.version === 2,
          ) &&
            release.capabilities.some(
              (c) => c.resourceType === "website" && c.actions.includes("publish"),
            ),
          "Definition does not admit website publication",
        );
      }
      const reservation = action.input as review.ReserveEffectInput;
      assert(
        ctx.effects.some(
          (e) =>
            e.operationId === reservation.operationId &&
            e.instanceId === inst.instanceId &&
            e.scopeRef === ctx.scopeRef &&
            e.dispatchRef === reservation.dispatchRef &&
            e.outboxRef === reservation.outboxRef &&
            e.proposalHash === p.contentHash,
        ),
        "Existing Dispatch/outbox intent does not match proposal",
      );
      for (const target of p.targets) {
        const fact = ctx.resources.find((f) => f.id === target.documentRef)!;
        assert(fact.allowedActions.includes(p.action), "Document policy denies effect");
        assert(
          inst.grants.some(
            (g) =>
              !g.revokedAt &&
              g.expiresAt > ctx.occurredAt &&
              g.principalId === inst.instanceId &&
              g.resourceRef === target.documentRef &&
              g.actions.includes(p.action),
          ),
          "Instance capability missing, expired or revoked",
        );
      }
      if (p.senderConnectionRef) {
        const direction = p.effectKind === "SEND_MESSAGE" ? "SEND" : "PREPARE";
        assert(
          inst.connections.some(
            (b) =>
              !b.revokedAt &&
              b.connectionRef === p.senderConnectionRef &&
              b.directions.includes(direction),
          ) && ctx.connectionRefs.includes(p.senderConnectionRef),
          "Sender connection unavailable or direction denied",
        );
      }
    }
  }
  if (c.documentType === "kapelle/dispatch") {
    const s = document.state.global as dispatch.DispatchState;
    assert(ctx.dispatch, "Dispatch authority facts unavailable");
    const proof = { ...ctx, dispatch: ctx.dispatch };
    if (c.type === "CREATE_DISPATCH") {
      const i = action.input as dispatch.CreateDispatchInput;
      assert(
        i.dispatchId === c.documentId &&
          i.ownerId === ctx.ownerId &&
          i.offer.senderId === ctx.principalId,
        "Dispatch identity or authenticated sender differs",
      );
      authorizeDispatchLineage(i.dispatchId, i.offer as dispatch.DispatchOffer, proof);
    } else {
      assert(
        s.scopeRef === ctx.scopeRef && s.ownerId === ctx.ownerId && s.offer,
        "Dispatch ownership or scope differs",
      );
      if (c.type === "ACCEPT_DISPATCH") {
        assert(s.offer.recipient.instanceId === ctx.principalId, "Dispatch recipient differs");
        authorizeDispatchLineage(s.dispatchId!, s.offer, proof);
      }
      if (c.type === "REQUEST_DISPATCH_CANCEL")
        assert(
          [s.ownerId, s.offer.senderId].includes(ctx.principalId),
          "Dispatch cancellation actor differs",
        );
      if (c.type === "RECORD_DISPATCH_RESULT") {
        if (s.offer.task.authorityRef === "task-authority") authorizeDispatchLineage(s.dispatchId!, s.offer, proof);
        const i = action.input as dispatch.RecordDispatchResultInput;
        assert(
          s.offer.recipient.instanceId === ctx.principalId &&
            ctx.dispatch.results.some(
              (r) =>
                r.dispatchId === c.documentId &&
                r.inputHash === i.inputHash &&
                r.reportId === i.reportId &&
                r.contentVersion === i.contentVersion &&
                r.contentHash === i.contentHash &&
                r.verificationRef === i.verificationRef,
            ),
          "Dispatch original result evidence is not verified",
        );
      }
    }
  }
  // Action ID and timestamp are generated once by the factory, then retained by the authority.
  return { command: c, requestHash, action };
}
export function applyNative(document: NativeDocument, action: Action): NativeDocument {
  const model = nativeModel(document.header.documentType, document.state.document.version);
  const next = (model.reducer as (d: PHDocument, a: Action) => NativeDocument)(document, action);
  const error = next.operations.global.at(-1)?.error;
  assert(!error, error ?? "Native reducer rejected command");
  return next;
}
