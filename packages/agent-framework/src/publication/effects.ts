import { canonical, digest, type TrustedContext } from "../command-boundary.js";
import type { Facts, FrameworkAuthority, ServiceOptions } from "../service/authority.js";
import type { PublicationFactsAdapter } from "./facts.js";
import { verifyNativeDispatch, type DispatchNativeReader } from "../dispatch/native-proof.js";
import { assert, opaque } from "../validation.js";
import {
  publicationProposal,
  canonicalTarget,
  type PublicationManifest,
  type WebsiteTarget,
} from "./manifest.js";
import { verifyPublishedSite, verifyPromotedTarget, type RedirectObservation } from "./routing.js";

export interface DispatchIntent {
  key: string;
  reviewId: string;
  instanceId: string;
  ownerId: string;
  scopeRef: string;
  proposalHash: string;
  artifactHash: string;
  task: PublicationManifest["task"];
}
export interface DispatchBinding {
  intent: DispatchIntent;
  dispatchRef: string;
  outboxRef: string;
  operationId: string;
}
export function dispatchIntent(
  reviewId: string,
  instanceId: string,
  m: PublicationManifest,
): DispatchIntent {
  const p = publicationProposal(m);
  return {
    key: "website:" + digest({ reviewId, proposalHash: p.contentHash }).slice(7),
    reviewId,
    instanceId,
    ownerId: m.ownerId,
    scopeRef: m.scopeRef,
    proposalHash: p.contentHash,
    artifactHash: p.artifactHash,
    task: m.task,
  };
}
export function verifyDispatch(binding: DispatchBinding, expected: DispatchIntent) {
  assert(canonical(binding.intent) === canonical(expected), "Existing Dispatch intent differs");
  [binding.dispatchRef, binding.outboxRef, binding.operationId].forEach(opaque);
  assert(
    binding.dispatchRef !== expected.task.managerTaskRef,
    "Task reference is not a Dispatch reference",
  );
  return binding;
}
/** Implement inside existing Manager Dispatch storage. ensure must atomically
 * enforce key+exact payload. This queue port never grants invocation rights: those
 * come only from the native ReviewIntent CLAIM_EXECUTION operation. Its retryable
 * outbox lease is not an execution claim or a publication receipt.
 */
export interface PublicationDispatch {
  ensure(intent: DispatchIntent): Promise<DispatchBinding>;
  read(key: string): Promise<DispatchBinding | null>;
}
export function websiteEffectPolicy(
  m: PublicationManifest,
  instanceId: string,
  nativeDispatch?: DispatchNativeReader,
): NonNullable<ServiceOptions["effectPolicy"]> {
  const p = publicationProposal(m);
  return async (command, document, context) => {
    assert(m.contract !== "kapelle/website-publication/v3" || command.type === "RECORD_DELIVERY",
      "Proposed managed writer policy is not executable");
    const s = document.state.global;
    assert(
      command.documentType === "kapelle/review-intent" &&
        document.state.document.version === 2 &&
        ["RESERVE_EFFECT", "CLAIM_EXECUTION", "RECORD_DELIVERY"].includes(command.type) &&
        "proposal" in s &&
        s.instanceId === instanceId &&
        s.ownerId === m.ownerId &&
        s.scopeRef === m.scopeRef &&
        context.ownerId === m.ownerId &&
        context.scopeRef === m.scopeRef &&
        canonical(s.proposal) === canonical(p),
      "External effect is outside the qualified website binding",
    );
    if (m.originDispatch && command.type !== "RECORD_DELIVERY") {
      assert(nativeDispatch, "Native originating Dispatch reader unavailable");
      const origin = await verifyNativeDispatch(
        nativeDispatch,
        m.originDispatch.documentId,
        context,
      );
      assert(
        origin.offer!.contentHash === m.originDispatch.contentHash &&
          origin.offer!.recipient.instanceId === instanceId &&
          origin.offer!.task.authorityRef === m.task.authorityRef &&
          origin.offer!.task.taskRef === m.task.authorityTaskRef &&
          origin.offer!.task.commitmentHash === m.task.commitmentHash,
        "Native originating Dispatch differs from publication",
      );
    }
  };
}
export function dispatchFact(
  binding: DispatchBinding,
  expected: DispatchIntent,
): TrustedContext["effects"][number] {
  verifyDispatch(binding, expected);
  return {
    operationId: binding.operationId,
    dispatchRef: binding.dispatchRef,
    outboxRef: binding.outboxRef,
    instanceId: expected.instanceId,
    scopeRef: expected.scopeRef,
    proposalHash: expected.proposalHash,
  };
}

export type ProviderReceipt = {
  operationId: string;
  intentHash: string;
  providerRef: string;
  receiptRef: string;
  status: "PUBLISHED" | "FAILED" | "UNKNOWN";
  teamId: string;
  projectId: string;
  deploymentId: string | null;
  commit: string;
  tree: string;
  buildHash: string;
  environment: "production";
};
export interface PublicationProvider {
  holdStatus?(binding: DispatchBinding): {held: boolean; requestSettlement: string; observations: string[]; proofRef?: string};
  /** Qualified provider guards reserve/claim/write AND reconciliation as one operation.
   * Optional only for other independently qualified/synthetic providers. */
  withOperation?<T>(binding: DispatchBinding, fn: () => Promise<T>): Promise<T>;
  /** Read-only eligibility check before consuming an invocation claim. */
  preflight?(binding: DispatchBinding, manifest: PublicationManifest): Promise<void>;
  /** Retain delivery observation after native commit; this does not settle a request. */
  confirmDelivery?(binding: DispatchBinding, evidenceId: string): Promise<void>;
  /** Qualified adapter must serialize provider writes, recheck preconditions,
   * and bind the deployed bytes to this manifest. An unqualified Vercel CLI
   * invocation is not an implementation of this interface. */
  publish(binding: DispatchBinding, manifest: PublicationManifest): Promise<void>;
  /** Evidence bound to the SAME operation; never performs another publish.
   * A matching observed result alone does not prove provider request settlement. */
  receipt(binding: DispatchBinding): Promise<ProviderReceipt>;
  target(): Promise<WebsiteTarget>;
  /** Exact HTTPS domain/path; no redirects, bounded raw bytes from the live site. */
  site(domain: string, path: string): Promise<Uint8Array>;
  /** Exact bound redirect evidence; never follow Location or send credentials. */
  redirect?(domain: string, path: string): Promise<RedirectObservation>;
}
export async function publicationDelivery(
  binding: DispatchBinding,
  m: PublicationManifest,
  provider: Omit<PublicationProvider, "publish">,
): Promise<TrustedContext["deliveryReceipts"][number]> {
  const receipt = await provider.receipt(binding);
  assert(
    receipt.operationId === binding.operationId &&
      receipt.intentHash === digest(binding.intent) &&
      receipt.teamId === m.target.teamId &&
      receipt.projectId === m.target.projectId &&
      receipt.commit === m.source.commit &&
      receipt.tree === m.source.tree &&
      receipt.buildHash === m.build.outputHash &&
      receipt.environment === "production",
    "Delivery receipt identity differs",
  );
  opaque(receipt.providerRef);
  opaque(receipt.receiptRef);
  assert(["PUBLISHED", "FAILED", "UNKNOWN"].includes(receipt.status), "Invalid provider result");
  const proofs: unknown[] = [];
  if (receipt.status === "PUBLISHED") {
    assert(receipt.deploymentId, "Delivery deployment identity missing");
    const target = canonicalTarget(await provider.target());
    verifyPromotedTarget(m.target, target, receipt.deploymentId);
    proofs.push(...(await verifyPublishedSite(target, m.build.siteFiles, provider)));
    assert(
      canonical(target) === canonical(canonicalTarget(await provider.target())),
      "Delivery target changed during verification",
    );
    proofs.push(target);
  }
  const evidenceHash = digest({ receipt, proofs });
  return {
    id: "publication-evidence:" + evidenceHash.slice(7),
    operationId: binding.operationId,
    status:
      receipt.status === "PUBLISHED"
        ? "DELIVERED"
        : receipt.status === "FAILED"
          ? "FAILED"
          : "UNCERTAIN",
    providerRef: receipt.providerRef,
    receiptRef: receipt.receiptRef,
  };
}

/** Admission and completion use different evidence. Once the alias advances,
 * old-target facts disappear; that must not prevent recording verified delivery.
 * Supply the exact native review IDs from retained provisioning, not request JSON.
 */
export async function publicationEffectFacts(
  base: Facts,
  adapter: PublicationFactsAdapter,
  reviewId: string,
  instanceId: string,
  dispatch: Pick<PublicationDispatch, "read">,
  provider: Omit<PublicationProvider, "publish">,
): Promise<Facts> {
  const expected = dispatchIntent(reviewId, instanceId, adapter.manifest);
  const facts = await adapter.facts(base, true).catch(() => base);
  const binding = await dispatch.read(expected.key);
  if (!binding) return facts;
  const effect = dispatchFact(binding, expected);
  assert(
    !facts.effects.some((e) => e.operationId === effect.operationId),
    "Duplicate publication effect fact",
  );
  let evidence: TrustedContext["deliveryReceipts"] = [];
  try {
    evidence = [await publicationDelivery(binding, adapter.manifest, provider)];
  } catch {
    /* Unavailable evidence never becomes a success/failure receipt. */
  }
  return {
    ...facts,
    effects: [...facts.effects, effect],
    deliveryReceipts: [...facts.deliveryReceipts, ...evidence],
  };
}

/** In-process execution coordinator, also used by the separately mounted scoped
 * executor HTTP adapter. Injects the existing Dispatch adapter and a qualified
 * provider; this module neither deploys with CLI nor completes the parent task.
 */
export class PublicationCoordinator {
  constructor(
    private readonly authority: FrameworkAuthority,
    private readonly manifest: PublicationManifest,
    private readonly instanceId: string,
    private readonly dispatch: PublicationDispatch,
    private readonly provider: PublicationProvider,
  ) {}
  private async approved(reviewId: string) {
    const d = await this.authority.read(reviewId, "kapelle/review-intent"), s = d.state.global;
    assert(
      d.state.document.version === 2 && "proposal" in s &&
        s.instanceId === this.instanceId && s.ownerId === this.manifest.ownerId &&
        s.scopeRef === this.manifest.scopeRef &&
        canonical(s.proposal) === canonical(publicationProposal(this.manifest)) &&
        s.status === "APPROVED" && s.decision?.approved,
      "One exact native approval required",
    );
    return s;
  }
  private guarded<T>(binding: DispatchBinding, fn: () => Promise<T>): Promise<T> {
    return this.provider.withOperation ? this.provider.withOperation(binding, fn) : fn();
  }
  async run(reviewId: string) {
    assert(this.manifest.contract !== "kapelle/website-publication/v3",
      "Proposed managed writer policy is not executable");
    await this.approved(reviewId);
    const intent = dispatchIntent(reviewId, this.instanceId, this.manifest);
    const binding = verifyDispatch(await this.dispatch.ensure(intent), intent);
    const settled = await this.settledResult(reviewId, binding);
    if (settled) return settled;
    return this.guarded(binding, async () => {
      // Re-read after admission: no reservation, claim, write or reconciliation may
      // overlap another run of this project, even through another provider instance.
      const s = await this.approved(reviewId), p = publicationProposal(this.manifest);
      if (!s.effect) {
        const operationId = "publication-reserve:" + digest({ reviewId, binding }).slice(7);
        const saved = this.authority.journal.get(operationId)?.command;
        const result = await this.authority.command(saved ?? {
          operationId, documentId: reviewId, documentType: "kapelle/review-intent",
          expectedRevision: s.revision, type: "RESERVE_EFFECT",
          input: { operationId: binding.operationId, dispatchRef: binding.dispatchRef,
            outboxRef: binding.outboxRef, proposalHash: p.contentHash, proposalVersion: p.version },
        });
        assert(result.result.disposition === "ACCEPTED", "Native effect reservation was not accepted");
      } else assert(s.effect.operationId === binding.operationId &&
        s.effect.dispatchRef === binding.dispatchRef && s.effect.outboxRef === binding.outboxRef,
      "Existing effect differs from Dispatch");
      if (s.delivery.some((e) => e.status === "DELIVERED" || e.status === "FAILED"))
        return this.reconcileLocked(reviewId, binding);
      // Known eligibility failures do not consume a native invocation. The durable
      // project hold already exists, including the crash window before contact.
      if (!("execution" in s && s.execution)) await this.provider.preflight?.(binding, this.manifest);
      if (await this.authority.claimPublicationInvocation(reviewId, binding.operationId)) {
        await this.authority.effectAdmission(reviewId, binding.operationId);
        try { await this.provider.publish(binding, this.manifest); }
        catch { /* Possible contact: receipt lookup only; never repeat the claim. */ }
      }
      return this.reconcileLocked(reviewId, binding);
    });
  }
  async reconcile(reviewId: string, known?: DispatchBinding) {
    await this.approved(reviewId);
    const intent = dispatchIntent(reviewId, this.instanceId, this.manifest);
    const binding = known ?? (await this.dispatch.read(intent.key));
    assert(binding, "Existing publication Dispatch unavailable");
    verifyDispatch(binding, intent);
    const settled = await this.settledResult(reviewId, binding);
    if (settled) return settled;
    return this.guarded(binding, () => this.reconcileLocked(reviewId, binding));
  }
  private async settledResult(reviewId: string, binding: DispatchBinding) {
    const status = this.provider.holdStatus?.(binding);
    if (!status || !["COMPLETED", "NO_CONTACT"].includes(status.requestSettlement)) return null;
    const s = await this.approved(reviewId), previous = s.delivery.at(-1);
    assert(s.effect?.operationId === binding.operationId && previous &&
      (previous.status === "DELIVERED" || previous.status === "FAILED") &&
      status.observations.includes(previous.id), "Settled native receipt unavailable");
    return {status: previous.status};
  }
  private async reconcileLocked(reviewId: string, binding: DispatchBinding) {
    const s = await this.approved(reviewId);
    assert(s.effect?.operationId === binding.operationId &&
      s.effect.dispatchRef === binding.dispatchRef && s.effect.outboxRef === binding.outboxRef,
    "Unknown publication reservation");
    assert("execution" in s && s.execution, "Publication invocation has not been claimed");
    const previous = s.delivery.at(-1);
    // Historical native delivery remains readable when later public reads fail or
    // drift. Repeating the observation acknowledgement never releases the hold.
    if (previous && (previous.status === "DELIVERED" || previous.status === "FAILED")) {
      await this.provider.confirmDelivery?.(binding, previous.id);
      return { status: previous.status };
    }
    const evidence = await publicationDelivery(binding, this.manifest, this.provider);
    if (previous?.id === evidence.id ||
      (previous?.status === "UNCERTAIN" && evidence.status === "UNCERTAIN"))
      return { status: previous.status };
    const operationId = "publication-delivery:" + digest({ reviewId, evidence }).slice(7);
    const saved = this.authority.journal.get(operationId)?.command;
    const result = await this.authority.command(saved ?? {
      operationId, documentId: reviewId, documentType: "kapelle/review-intent",
      expectedRevision: s.revision, type: "RECORD_DELIVERY",
      input: { evidenceId: evidence.id, operationId: binding.operationId,
        status: evidence.status, providerRef: evidence.providerRef, receiptRef: evidence.receiptRef },
    });
    assert(result.result.disposition === "ACCEPTED", "Native delivery evidence was not accepted");
    if (evidence.status === "DELIVERED" || evidence.status === "FAILED")
      await this.provider.confirmDelivery?.(binding, evidence.id);
    return { status: evidence.status };
  }
}
