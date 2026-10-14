import { z } from "zod";
import { digest } from "../content.js";
import { assert } from "../validation.js";

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const proposedWriterPolicySchema = z.object({
  contract: z.literal("kapelle/website-writer-policy/v1"),
  status: z.literal("PROPOSED"),
  mode: z.literal("brokered-automation-owner-override"),
  teamId: id,
  projectId: id,
  brokerId: id,
  generation: z.number().int().positive(),
  managedAutomation: z.literal("one-broker-all-automated-production-writes"),
  managedWrites: z.literal("deploy-promote-rollback-alias-domain-routing"),
  ownerRace: z.literal("manual-write-can-race-and-be-overwritten"),
  providerGuarantee: z.literal("no-atomic-cas-no-exactly-once-no-continuous-currentness"),
  recoveryRelease: z.literal("requires-qualified-no-remaining-effect-evidence"),
  ownerException: z.literal("owner-manual-writes-remain-possible"),
  gitPromotion: z.literal("disconnect-before-activation"),
  credentials: z.literal("isolate-broker-from-other-automation"),
  serialization: z.literal("single-host-durable-project-hold-before-native-claim"),
  ambiguousRequest: z.literal("retain-hold-no-retry-no-timeout-release"),
  delivery: z.literal("observed-result-is-not-request-settlement-or-continuous-currentness"),
  drift: z.literal("pause-and-require-new-exact-review"),
}).strict();
export const writerPolicyArtifactSchema = z.object({
  id, version: z.literal(1), contentHash: hash, policy: proposedWriterPolicySchema,
}).strict();
export function proposedWriterPolicy(raw: unknown) {
  const policy = proposedWriterPolicySchema.parse(raw), contentHash = digest(policy);
  return Object.freeze({ id: "writer-policy:" + contentHash.slice(7), version: 1 as const,
    contentHash, policy: Object.freeze(policy) });
}
export function verifyWriterPolicy(raw: unknown) {
  const artifact = writerPolicyArtifactSchema.parse(raw), expected = proposedWriterPolicy(artifact.policy);
  assert(artifact.id === expected.id && artifact.contentHash === expected.contentHash,
    "Writer policy artifact identity differs");
  return expected;
}
