import * as D from "../document-models/agent-definition/v1/index.js";
import * as I from "../document-models/agent-instance/v1/index.js";
import * as R from "../document-models/review-intent/v1/index.js";
import {
  applyNative,
  digest,
  prepareCommand,
  proposalHash,
  releaseHash,
  type Command,
  type NativeDocument,
  type TrustedContext,
} from "../src/command-boundary.js";
export { D, I, R };
export const at = "2026-09-10T12:00:00.000Z";
export const vref = (id: string, version = "1.0.0") => ({
  id,
  version,
  contentHash: digest({ id, version }),
});
export const policy = {
  preferredProfile: "local-structured-proposal",
  concurrencyLimit: 1,
  budgetPolicyRef: "budget-local",
  paidFallback: false,
  fallbackProvider: null,
  fallbackScopeRef: null,
  fallbackBudgetRef: null,
};
export function release(
  version = "1.0.0",
  previous: D.DefinitionRelease | null = null,
): D.DefinitionRelease {
  const r: D.DefinitionRelease = {
    definitionId: "synthetic-commissioner",
    packageVersion: version,
    schemaVersion: 1,
    publisherRef: "owner",
    licenseRef: "license:private",
    contentHash: "",
    previousVersionRef: previous
      ? {
          id: previous.definitionId,
          version: previous.packageVersion,
          contentHash: previous.contentHash,
        }
      : null,
    title: "Synthetic Commissioner",
    description: "Fabricated model qualification, no real league or recipients.",
    tags: ["synthetic"],
    avatarRef: null,
    examples: ["Reconcile synthetic week"],
    instructionTokenCount: 12,
    tokenizerRef: "synthetic-tokenizer-v1",
    purpose: "Reconcile synthetic contracts",
    responsibilities: ["reconcile"],
    instructions: vref("instructions"),
    skills: [vref("rules")],
    capabilities: [
      {
        id: "contracts",
        requirement: "OPTIONAL",
        resourceType: "contracts",
        actions: ["read", "update", "send"],
        outputTypes: ["report"],
      },
    ],
    runtimeContracts: ["deterministic-v1"],
    modelProfiles: ["local-structured-proposal"],
    documentModels: [{ documentType: "kapelle/review-intent", version: 1 }],
    migrations: previous
      ? [
          {
            fromVersion: previous.packageVersion,
            migrationRef: vref("migration"),
            compatibilityFixtureRef: vref("compatibility"),
          },
        ]
      : [],
    views: [{ id: "overview", codeRef: vref("view-overview") }],
    exportRequirements: ["native-operations", "referenced-artifacts"],
    qualificationFixtures: [vref("synthetic-week")],
  };
  r.contentHash = releaseHash(r);
  return r;
}
export function context(): TrustedContext {
  return {
    principalId: "owner",
    ownerId: "owner",
    scopeRef: "synthetic-league",
    occurredAt: at,
    definitions: [{ release: release(), qualified: true }],
    resources: [
      {
        id: "contracts",
        resourceType: "contracts",
        revision: 7,
        contentHash: digest("contracts-v7"),
        allowedActions: ["read", "update", "send"],
      },
    ],
    connectionRefs: ["synthetic-chat"],
    runtimeBindingRefs: ["local-adapter"],
    runtimeBindingContracts: { "local-adapter": "deterministic-v1" },
    scheduleRefs: ["existing-scheduler"],
    budgetPolicyRefs: ["budget-local", "budget-explicit"],
    artifacts: [
      { id: "proposal-artifact-v1", version: 1, contentHash: digest("synthetic-proposal-bytes") },
    ],
    effects: [
      {
        operationId: "effect-1",
        instanceId: "commissioner-1",
        scopeRef: "synthetic-league",
        dispatchRef: "dispatch-existing-1",
        outboxRef: "outbox-existing-1",
        proposalHash: proposal().contentHash,
      },
    ],
    deliveryReceipts: [],
  };
}
export function command(
  d: NativeDocument,
  type: string,
  input: Record<string, unknown>,
  op = `op-${d.state.global.revision}`,
): Command {
  return {
    operationId: op,
    documentId: d.header.id,
    documentType: d.header.documentType as Command["documentType"],
    expectedRevision: d.state.global.revision,
    type,
    input,
  };
}
export function apply<T extends NativeDocument>(
  d: T,
  type: string,
  input: Record<string, unknown>,
  ctx: TrustedContext = context(),
): T {
  if (d.header.documentType === "kapelle/agent-instance" && d.state.global.revision > 0)
    ctx = { ...ctx, instance: d.state.global as I.AgentInstanceState };
  return applyNative(d, prepareCommand(command(d, type, input), d, ctx).action) as T;
}
export function installed(ctx = context()): I.AgentInstanceDocument {
  const empty = I.utils.createDocument();
  empty.header.id = "commissioner-1";
  return apply(
    empty,
    "CREATE_INSTANCE",
    {
      instanceId: "commissioner-1",
      scopeRef: ctx.scopeRef,
      definitionRef: {
        id: ctx.definitions[0].release.definitionId,
        version: "1.0.0",
        contentHash: ctx.definitions[0].release.contentHash,
      },
      name: "Synthetic commissioner",
      responsibilities: ["reconcile"],
      operatingPolicy: "Propose for review",
      modelPolicy: policy,
    },
    ctx,
  );
}
export function ready(ctx = context()): I.AgentInstanceDocument {
  let d = installed(ctx);
  d = apply(d, "SET_RUNTIME_BINDING", { runtimeBindingRef: "local-adapter" }, ctx);
  d = apply(
    d,
    "GRANT_CAPABILITY",
    {
      grant: {
        id: "grant-1",
        principalId: "commissioner-1",
        resourceRef: "contracts",
        actions: ["read", "update", "send"],
        expiresAt: "2026-09-11T12:00:00.000Z",
        reviewPolicy: "ALWAYS",
      },
    },
    ctx,
  );
  d = apply(
    d,
    "BIND_CONNECTION",
    {
      binding: {
        id: "chat-binding",
        connectionRef: "synthetic-chat",
        label: "Synthetic league test chat",
        accountRef: "synthetic-account",
        directions: ["PREPARE", "SEND"],
      },
    },
    ctx,
  );
  return apply(d, "REQUEST_RESUME", {}, ctx);
}
export function proposal(kind: R.EffectKind = "DOCUMENT_CHANGE"): R.Proposal {
  const p: R.Proposal = {
    version: 1,
    contentHash: "",
    contentRef: "proposal-artifact-v1",
    contentVersion: 1,
    artifactHash: digest("synthetic-proposal-bytes"),
    effectKind: kind,
    action: kind === "SEND_MESSAGE" ? "send" : "update",
    targets: [{ documentRef: "contracts", revision: 7, contentHash: digest("contracts-v7") }],
    senderConnectionRef: kind === "DOCUMENT_CHANGE" ? null : "synthetic-chat",
    recipients: kind === "DOCUMENT_CHANGE" ? [] : ["synthetic-recipient"],
  };
  p.contentHash = proposalHash(p);
  return p;
}
export function proposed(ctx: TrustedContext): R.ReviewIntentDocument {
  const empty = R.utils.createDocument();
  empty.header.id = "review-1";
  return apply(
    empty,
    "CREATE_REVIEW",
    {
      reviewId: "review-1",
      instanceId: "commissioner-1",
      scopeRef: ctx.scopeRef,
      proposal: proposal(),
    },
    ctx,
  );
}
export function approved(ctx: TrustedContext): R.ReviewIntentDocument {
  const d = proposed(ctx);
  return apply(
    d,
    "RECORD_DECISION",
    {
      proposalHash: d.state.global.proposal!.contentHash,
      proposalVersion: 1,
      approved: true,
      reason: null,
    },
    ctx,
  );
}
export function reserve(d: R.ReviewIntentDocument, ctx: TrustedContext) {
  return apply(
    d,
    "RESERVE_EFFECT",
    {
      operationId: "effect-1",
      dispatchRef: "dispatch-existing-1",
      outboxRef: "outbox-existing-1",
      proposalHash: d.state.global.proposal!.contentHash,
      proposalVersion: 1,
    },
    ctx,
  );
}
