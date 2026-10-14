import type { ReportPublication, ReportPublicationInput, ReportAgentSnapshotInput, ReportAgentSnapshot } from "../gen/schema/types.js";
import { requireText, optionalText } from "./utils.js";

function hash(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field}: expected lowercase SHA256`);
  return value;
}
function agent(input: ReportAgentSnapshotInput): ReportAgentSnapshot {
  return {
    id: requireText(input.id, "agent.id", 500),
    label: requireText(input.label, "agent.label", 500),
    instanceId: optionalText(input.instanceId, "agent.instanceId", 500),
    definitionId: optionalText(input.definitionId, "agent.definitionId", 500),
    definitionVersion: optionalText(input.definitionVersion, "agent.definitionVersion", 100),
    definitionHash: input.definitionHash == null ? null : hash(input.definitionHash, "agent.definitionHash"),
  };
}
/** Host authorization is enforced before native admission; references are evidence, not grants. */
export function normalizePublication(input: ReportPublicationInput, binding: {
  contentHash: string; sourceRef?: string | null; occurredAt: string; lifecycle: string;
  producerId: string; producerKind: string;
}): ReportPublication {
  if (binding.lifecycle !== "FINAL") throw new Error("publication: requires FINAL registration");
  if (input.contentHash !== binding.contentHash || input.sourceRef !== binding.sourceRef || input.publishedAt !== binding.occurredAt)
    throw new Error("publication: content, source or timestamp binding mismatch");
  if (binding.producerKind !== "AGENT" || input.author.id !== binding.producerId)
    throw new Error("publication: author must match Agent producer");
  if (!Number.isSafeInteger(input.contentVersion) || input.contentVersion < 1)
    throw new Error("publication: contentVersion must be positive");
  return {
    publicationId: requireText(input.publicationId, "publicationId", 500),
    author: agent(input.author), publisher: agent(input.publisher),
    runRef: requireText(input.runRef, "runRef", 2000),
    sourceRef: requireText(input.sourceRef, "sourceRef", 4000),
    provenanceRef: requireText(input.provenanceRef, "provenanceRef", 2000),
    contentHash: hash(input.contentHash, "contentHash"), contentVersion: input.contentVersion,
    authorizationRef: requireText(input.authorizationRef, "authorizationRef", 2000),
    publishedAt: input.publishedAt,
  };
}
