import type { FrameworkAuthority } from "../service/authority.js";
import { assert } from "../validation.js";
import { publicationArtifact, type PublicationManifest } from "./manifest.js";
import { dispatchIntent, websiteEffectPolicy } from "./effects.js";
import { ManagerPublicationClient } from "./manager-transport.js";
import { nativePublicationDelivery, publicationExecutorHandler } from "./executor-http.js";
import { VercelPublicationProvider } from "./vercel-provider.js";
import type { StagingReceiptReader } from "./staging.js";
import type { PublicationSettlement } from "./project-hold.js";

/** Explicit host wiring; creates no listener, credential, model, grant or provider
 * request. The host supplies retained provisioning and trusted facts ports. */
export function publicationExecutorAdapters(
  authority: FrameworkAuthority,
  config: {
    manifest: PublicationManifest;
    brokerHostId: string;
    reviewId: string;
    instanceId: string;
    managerOrigin: string;
    managerToken: () => string;
    executorToken: () => string;
    ownerDecisionToken: () => string;
    providerToken: () => string;
    stagingReceipt: StagingReceiptReader;
    stagedProtectionBypass?: () => string;
    assertExclusiveProjectWriter: () => Promise<void>;
    providerRequest?: typeof fetch;
    managerRequest?: typeof fetch;
    readRequestSettlement?: (binding: import("./effects.js").DispatchBinding) => Promise<PublicationSettlement | null>;
  },
) {
  const manifest = publicationArtifact(config.manifest).manifest;
  const machineToken = () => {
    const manager = config.managerToken(),
      executor = config.executorToken(),
      owner = config.ownerDecisionToken();
    assert(
      [manager, executor, owner].every((t) => t.length >= 32) &&
        new Set([manager, executor, owner]).size === 3,
      "Distinct Manager, executor and owner decision credentials required",
    );
    return executor;
  };
  machineToken();
  const dispatch = new ManagerPublicationClient(
    config.managerOrigin,
    config.managerToken,
    dispatchIntent(config.reviewId, config.instanceId, manifest),
    config.managerRequest,
  );
  const provider = new VercelPublicationProvider({
    manifest,
    reviewId: config.reviewId,
    instanceId: config.instanceId,
    journal: authority.journal.db,
    brokerHostId: config.brokerHostId,
    token: config.providerToken,
    request: config.providerRequest,
    stagingReceipt: config.stagingReceipt,
    stagedProtectionBypass: config.stagedProtectionBypass,
    admit: (binding) =>
      authority.effectAdmission(config.reviewId, binding.operationId).then(() => {}),
    confirmNativeDelivery: (binding, evidenceId) =>
      nativePublicationDelivery(
        authority,
        manifest,
        config.reviewId,
        config.instanceId,
        binding,
        evidenceId,
      ),
    assertExclusiveProjectWriter: config.assertExclusiveProjectWriter,
    readRequestSettlement: config.readRequestSettlement,
    confirmNativeInvocation: async (binding) => {
      const {approvedPublication} = await import("./executor-http.js");
      const state = await approvedPublication(authority, manifest, config.reviewId, config.instanceId);
      assert(state.effect?.operationId === binding.operationId && "execution" in state && state.execution?.operationId === binding.operationId,
        "Retained native invocation required for no-contact settlement");
    },
  });
  return {
    dispatch,
    provider,
    effectPolicy: websiteEffectPolicy(manifest, config.instanceId, authority.backend),
    handler: publicationExecutorHandler({
      authority,
      manifest,
      reviewId: config.reviewId,
      instanceId: config.instanceId,
      dispatch,
      provider,
      token: machineToken,
    }),
  };
}
