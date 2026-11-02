import type {
  ReportContentDescriptor,
  ReportContentDescriptorInput,
  ReportRegistryGlobalState,
} from "document-models/report-registry/v1";

const UTC_INSTANT = /(Z|[+-]00:00)$/;

export function requireText(
  value: string,
  field: string,
  maxLength: number,
): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field}: non-empty value required`);
  if (normalized.length > maxLength) {
    throw new Error(`${field}: maximum length is ${maxLength}`);
  }
  return normalized;
}

export function optionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new Error(`${field}: maximum length is ${maxLength}`);
  }
  return normalized;
}

export function boundedText(
  value: string,
  field: string,
  maxLength: number,
): string {
  if (value.length > maxLength) {
    throw new Error(`${field}: maximum length is ${maxLength}`);
  }
  return value;
}

export function assertUtc(value: string, field: string): string {
  if (!UTC_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field}: valid UTC ISO-8601 instant required`);
  }
  return new Date(value).toISOString();
}

export function mutationMetadata(
  actorId: string,
  occurredAt: string,
): { actorId: string; occurredAt: string } {
  return {
    actorId: requireText(actorId, "actorId", 500),
    occurredAt: assertUtc(occurredAt, "occurredAt"),
  };
}

export function assertInitialized(state: ReportRegistryGlobalState): void {
  if (!state.id) throw new Error("report has not been registered");
}

export function assertMutable(state: ReportRegistryGlobalState): void {
  assertInitialized(state);
  if (state.lifecycle === "SUPERSEDED" || state.lifecycle === "WITHDRAWN") {
    throw new Error(
      `report is ${state.lifecycle.toLowerCase()} and cannot be changed`,
    );
  }
}

export function assertRevision(
  state: ReportRegistryGlobalState,
  expectedRevision: number,
): void {
  if (expectedRevision !== state.revision) {
    throw new Error(
      `revision conflict (expected ${expectedRevision}, actual ${state.revision})`,
    );
  }
}

export function touch(
  state: ReportRegistryGlobalState,
  actorId: string,
  occurredAt: string,
): void {
  const metadata = mutationMetadata(actorId, occurredAt);
  state.revision += 1;
  state.updatedBy = metadata.actorId;
  state.updatedAt = metadata.occurredAt;
}

export function normalizeContent(
  input: ReportContentDescriptorInput,
): ReportContentDescriptor {
  const storage = input.storage;
  const mimeType = requireText(input.mimeType, "content.mimeType", 500);
  const contentHash = requireText(
    input.contentHash,
    "content.contentHash",
    500,
  );
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0) {
    throw new Error("content.byteSize: non-negative safe integer required");
  }
  const filename = optionalText(input.filename, "content.filename", 1_000);
  const blobRef = optionalText(input.blobRef, "content.blobRef", 4_000);
  const markdown =
    input.markdown == null
      ? null
      : boundedText(input.markdown, "content.markdown", 1_000_000);

  if (storage === "INLINE_MARKDOWN") {
    if (markdown == null) {
      throw new Error("content: INLINE_MARKDOWN requires markdown");
    }
    if (blobRef != null) {
      throw new Error("content: INLINE_MARKDOWN cannot include blobRef");
    }
  } else {
    if (blobRef == null) throw new Error("content: BLOB requires blobRef");
    if (markdown != null) {
      throw new Error("content: BLOB cannot include inline markdown");
    }
  }

  return {
    storage,
    mimeType,
    filename,
    contentHash,
    byteSize: input.byteSize,
    markdown,
    blobRef,
  };
}

export function clearAttention(
  state: ReportRegistryGlobalState,
  occurredAt: string,
  resolution: "DISMISSED" | "READ" | "RESOLVED",
): void {
  state.attention.resolvedAt = occurredAt;
  state.attention.resolution = resolution;
}

