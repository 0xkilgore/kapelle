import { z } from "zod";
import { canonical } from "../content.js";
import { assert } from "../validation.js";
import type { FrameworkAuthority } from "../service/authority.js";
import {
  PublicationCoordinator,
  dispatchIntent,
  verifyDispatch,
  type DispatchBinding,
  type PublicationDispatch,
  type PublicationProvider,
} from "./effects.js";
import { publicationArtifact, publicationProposal, type PublicationManifest } from "./manifest.js";
import { jsonRequest, machineHandler, privateEndpoint } from "./transport-http.js";

export async function approvedPublication(
  authority: FrameworkAuthority,
  manifest: PublicationManifest,
  reviewId: string,
  instanceId: string,
) {
  const d = await authority.read(reviewId, "kapelle/review-intent"),
    s = d.state.global;
  assert(
    d.state.document.version === 2 &&
      "proposal" in s &&
      s.ownerId === manifest.ownerId &&
      s.scopeRef === manifest.scopeRef &&
      s.instanceId === instanceId &&
      s.status === "APPROVED" &&
      s.decision?.approved &&
      canonical(s.proposal) === canonical(publicationProposal(manifest)),
    "Exact native owner approval required",
  );
  return s;
}
/** A separate, single-review machine surface. No caller commands, actor, target,
 * manifest, credential, shell argument, or decision endpoint is accepted. */
export function publicationExecutorHandler(config: {
  authority: FrameworkAuthority;
  manifest: PublicationManifest;
  reviewId: string;
  instanceId: string;
  dispatch: PublicationDispatch;
  provider: PublicationProvider;
  token: () => string;
}) {
  const manifest = publicationArtifact(config.manifest).manifest;
  const intent = dispatchIntent(config.reviewId, config.instanceId, manifest);
  const coordinator = new PublicationCoordinator(
    config.authority,
    manifest,
    config.instanceId,
    config.dispatch,
    config.provider,
  );
  return machineHandler(config.token, async (method, url, body) => {
    assert(
      !url.search && method === "POST" && ["/run", "/reconcile"].includes(url.pathname),
      "Unknown executor route",
    );
    const request = z
      .object({ operationId: z.string(), dispatchRef: z.string(), outboxRef: z.string() })
      .strict()
      .parse(body);
    const binding = await config.dispatch.read(intent.key);
    assert(binding, "Saved Manager binding unavailable");
    verifyDispatch(binding, intent);
    assert(
      request.operationId === binding.operationId &&
        request.dispatchRef === binding.dispatchRef &&
        request.outboxRef === binding.outboxRef,
      "Executor operation differs",
    );
    await approvedPublication(config.authority, manifest, config.reviewId, config.instanceId);
    const result =
      url.pathname === "/run"
        ? await coordinator.run(config.reviewId)
        : await coordinator.reconcile(config.reviewId, binding);
    const state = await approvedPublication(
      config.authority,
      manifest,
      config.reviewId,
      config.instanceId,
    );
    const evidence = state.delivery.at(-1);
    assert(
      state.effect?.operationId === binding.operationId && evidence?.status === result.status,
      "Native executor receipt unavailable",
    );
    return {
      reviewId: config.reviewId,
      operationId: binding.operationId,
      dispatchRef: binding.dispatchRef,
      status: evidence.status,
      evidenceId: evidence.id,
      occurredAt: evidence.occurredAt,
    };
  });
}

export async function nativePublicationDelivery(
  authority: FrameworkAuthority,
  manifest: PublicationManifest,
  reviewId: string,
  instanceId: string,
  binding: DispatchBinding,
  evidenceId: string,
) {
  const s = await approvedPublication(authority, manifest, reviewId, instanceId);
  verifyDispatch(binding, dispatchIntent(reviewId, instanceId, manifest));
  assert(
    s.effect?.operationId === binding.operationId &&
      s.delivery.some((e) => e.id === evidenceId && (e.status === "DELIVERED" || e.status === "FAILED")),
    "Native delivery confirmation required",
  );
}
export class PublicationExecutorClient {
  private readonly origin: string;
  constructor(
    origin: string,
    private readonly token: () => string,
    private readonly request: typeof fetch = fetch,
  ) {
    this.origin = privateEndpoint(origin);
  }
  async deliver(binding: DispatchBinding, mode: "run" | "reconcile" = "run") {
    const r = z
      .object({
        reviewId: z.string(),
        operationId: z.string(),
        dispatchRef: z.string(),
        status: z.enum(["DELIVERED", "FAILED", "UNCERTAIN"]),
        evidenceId: z.string().min(1),
        occurredAt: z.iso.datetime(),
      })
      .strict()
      .parse(
        await jsonRequest(this.origin, "/" + mode, this.token, this.request, {
          operationId: binding.operationId,
          dispatchRef: binding.dispatchRef,
          outboxRef: binding.outboxRef,
        }),
      );
    assert(
      r.reviewId === binding.intent.reviewId &&
        r.operationId === binding.operationId &&
        r.dispatchRef === binding.dispatchRef,
      "Executor receipt identity differs",
    );
    return r;
  }
}
