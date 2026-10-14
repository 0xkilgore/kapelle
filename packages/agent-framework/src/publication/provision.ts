import { digest, type Command } from "../command-boundary.js";
import { assert, opaque } from "../validation.js";
import { publicationArtifact, publicationProposal } from "./manifest.js";

/** Allocation/provisioning plan only; does not allocate, grant, resume or decide.
 * Call with IDs returned by native allocation, never predicted native IDs.
 */
export function publicationReviewPlan(raw: unknown) {
  const artifact = publicationArtifact(raw);
  return {
    artifact,
    allocation: {
      operationId: `publication-review:${artifact.contentHash.slice(7)}`,
      documentType: "kapelle/review-intent" as const,
      modelVersion: 2,
      name: "Website publication review",
    },
    prerequisites: [
      "Qualified native website publisher definition and installed instance",
      "Owner/scope-bound Report Registry bytes and existing Task Authority mapping",
      "Exact clean source, production build receipt, current provider target snapshot",
      "Narrow website grant and Dispatch executor qualified before execution",
    ],
    createReview(reviewId: string, instanceId: string, expectedRevision = 0): Command {
      opaque(reviewId);
      opaque(instanceId);
      assert(expectedRevision === 0, "Review already initialized");
      return {
        operationId: `publication-create:${digest({ reviewId, artifact: artifact.contentHash }).slice(7)}`,
        documentId: reviewId,
        documentType: "kapelle/review-intent",
        expectedRevision,
        type: "CREATE_REVIEW",
        input: {
          reviewId,
          instanceId,
          scopeRef: artifact.manifest.scopeRef,
          proposal: publicationProposal(raw),
        },
      };
    },
  };
}
