export type ReportAttentionRequest = "NONE" | "READ" | "ANSWER" | "DECIDE" | "APPROVE" | "REQUEST_CHANGE";
export type ReportAttentionResolution = "READ" | "DISMISSED" | "RESOLVED";

export type ReportFeedback = {
  feedbackId: string;
  actor: string;
  body: string;
  createdAt: string;
  route: {
    status: "UNROUTED" | "ROUTED" | "FAILED";
    destination: string | null;
    routedAt: string | null;
    error: string | null;
  };
};

export type ReportRegistryItem = {
  documentId: string;
  reportRef: string;
  title: string;
  projectRef: string | null;
  sourceRef: string | null;
  revision: number;
  producer: { kind: string; id: string; label: string | null };
  lifecycle: string;
  supersedesRef?: string | null;
  supersededByRef?: string | null;
  attention: {
    request: ReportAttentionRequest;
    reason: string | null;
    reviewBy: string | null;
    requestedAt: string | null;
    resolvedAt: string | null;
    resolution: ReportAttentionResolution | null;
  };
  review: {
    openedAt: string | null;
    readAt: string | null;
    feedback: ReportFeedback[];
  };
  content: {
    storage: "INLINE_MARKDOWN" | "BLOB";
    mimeType: string;
    filename: string | null;
    contentHash: string;
    byteSize: number;
    markdown: string | null;
    blobRef: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type ReportRegistrySnapshot = {
  schemaVersion: "kapelle.report-library.v1";
  generatedAt: string;
  source: "vetra-report-registry";
  driveId: string;
  reports: ReportRegistryItem[];
};

export type ReportRegistryReadResult =
  | { availability: "authoritative"; snapshot: ReportRegistrySnapshot; latencyMs: number }
  | { availability: "unavailable"; snapshot: null; error: string; latencyMs: number | null };

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function string(value: unknown, max = 2_000): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function nullableString(value: unknown, max = 2_000): string | null {
  return value === null || value === undefined ? null : string(value, max);
}

function iso(value: unknown): string | null {
  const candidate = string(value, 64);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

function optionalIso(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return iso(value) ?? undefined;
}

function normalizeFeedback(value: unknown): ReportFeedback | null {
  const feedback = record(value);
  const route = record(feedback?.route);
  if (!feedback || !route) return null;
  const feedbackId = string(feedback.id, 256);
  const actor = string(feedback.actorId, 256);
  const body = string(feedback.bodyMarkdown, 4_000);
  const createdAt = iso(feedback.createdAt);
  const status = string(route.status, 32) as ReportFeedback["route"]["status"] | null;
  const routedAt = optionalIso(route.routedAt);
  if (!feedbackId || !actor || !body || !createdAt || !status || !["UNROUTED", "ROUTED", "FAILED"].includes(status) || routedAt === undefined) return null;
  return {
    feedbackId,
    actor,
    body,
    createdAt,
    route: {
      status,
      destination: nullableString(route.destination, 2_000),
      routedAt,
      error: nullableString(route.error, 2_000),
    },
  };
}

export function normalizeReportDocument(value: unknown): ReportRegistryItem | null {
  const document = record(value);
  const header = record(document?.header);
  const state = record(document?.state);
  const global = record(state?.global);
  if (!header || header.documentType !== "kilgore/report" || !global) return null;

  const documentId = string(header.id, 256);
  const reportRef = string(global.reportRef, 512);
  const title = string(global.title, 500);
  const producer = record(global.producer);
  const attention = record(global.attention);
  const content = record(global.content);
  const review = global.review === undefined ? null : record(global.review);
  const createdAt = iso(global.createdAt);
  const updatedAt = iso(global.updatedAt);
  if (!documentId || !reportRef || !title || !producer || !attention || !content || !createdAt || !updatedAt) return null;

  const producerKind = string(producer.kind, 64);
  const producerId = string(producer.id, 256);
  const request = string(attention.request, 32) as ReportAttentionRequest | null;
  const storage = string(content.storage, 32) as "INLINE_MARKDOWN" | "BLOB" | null;
  const mimeType = string(content.mimeType, 128);
  const contentHash = string(content.contentHash, 256);
  const byteSize = typeof content.byteSize === "number" && Number.isSafeInteger(content.byteSize) && content.byteSize >= 0 ? content.byteSize : null;
  const lifecycle = string(global.lifecycle, 32);
  const revision = typeof global.revision === "number" && Number.isSafeInteger(global.revision) && global.revision >= 1
    ? global.revision
    : null;
  const resolution = nullableString(attention.resolution, 32) as ReportAttentionResolution | null;
  const openedAt = optionalIso(review?.openedAt);
  const readAt = optionalIso(review?.readAt);
  const rawFeedback = review === null ? [] : Array.isArray(review.feedback) ? review.feedback : null;
  const feedback = rawFeedback?.map(normalizeFeedback) ?? null;

  if (!producerKind || !producerId || !request || !["NONE", "READ", "ANSWER", "DECIDE", "APPROVE", "REQUEST_CHANGE"].includes(request)) return null;
  if (!storage || !["INLINE_MARKDOWN", "BLOB"].includes(storage) || !mimeType || !contentHash || byteSize === null || !lifecycle || revision === null) return null;
  if (resolution !== null && !["READ", "DISMISSED", "RESOLVED"].includes(resolution)) return null;
  if (openedAt === undefined || readAt === undefined || feedback === null || feedback.some((entry) => entry === null)) return null;
  if (storage === "INLINE_MARKDOWN" && typeof content.markdown !== "string") return null;
  if (storage === "BLOB" && !string(content.blobRef, 2_000)) return null;

  return {
    documentId,
    reportRef,
    title,
    projectRef: nullableString(global.projectRef, 256),
    sourceRef: nullableString(global.sourceRef, 2_000),
    revision,
    producer: { kind: producerKind, id: producerId, label: nullableString(producer.label, 256) },
    lifecycle,
    supersedesRef: nullableString(global.supersedesRef, 1_000),
    supersededByRef: nullableString(global.supersededByRef, 1_000),
    attention: {
      request,
      reason: nullableString(attention.reason, 2_000),
      reviewBy: attention.reviewBy == null ? null : iso(attention.reviewBy),
      requestedAt: attention.requestedAt == null ? null : iso(attention.requestedAt),
      resolvedAt: attention.resolvedAt == null ? null : iso(attention.resolvedAt),
      resolution,
    },
    review: {
      openedAt,
      readAt,
      feedback: feedback as ReportFeedback[],
    },
    content: {
      storage,
      mimeType,
      filename: nullableString(content.filename, 500),
      contentHash,
      byteSize,
      markdown: content.markdown == null ? null : typeof content.markdown === "string" ? content.markdown : null,
      blobRef: nullableString(content.blobRef, 2_000),
    },
    createdAt,
    updatedAt,
  };
}

type VisibleReport = Pick<ReportRegistryItem, "lifecycle" | "sourceRef" | "updatedAt" | "reportRef">;
export function visibleReportMetadata<T extends VisibleReport>(reports: T[]): T[] {
  return reports
    .filter((report) => report.lifecycle === "FINAL")
    .filter((report) => !report.sourceRef?.startsWith("fixture://"))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.reportRef.localeCompare(b.reportRef));
}

export function visibleReportById(reports: ReportRegistryItem[], documentId: string): ReportRegistryItem | null {
  return visibleReports(reports).find((report) => report.documentId === documentId) ?? null;
}

export function reportMetadataNeedingAttention<T extends VisibleReport & { attention: Pick<ReportRegistryItem["attention"], "request" | "resolvedAt" | "reviewBy"> }>(reports: T[]): T[] {
  return visibleReportMetadata(reports)
    .filter((report) => report.attention.request !== "NONE" && report.attention.resolvedAt === null)
    .sort((a, b) => (a.attention.reviewBy ?? "9999").localeCompare(b.attention.reviewBy ?? "9999") || b.updatedAt.localeCompare(a.updatedAt));
}

/** A known, unregistered publication intent is not a malformed published report. */
export function pendingPublicationDocument(value:unknown):boolean {
  const doc=record(value), header=record(doc?.header), state=record(doc?.state), global=record(state?.global);
  return !!header && header.documentType==="kilgore/report" && typeof header.name==="string" && /^kapelle-publication-[a-f0-9]{64}$/.test(header.name)
    && !!global && global.id===null && global.reportRef==="" && global.revision===0 && global.lifecycle==="DRAFT" && global.content===null && global.producer===null;
}

export function visibleReports(reports: ReportRegistryItem[]): ReportRegistryItem[] { return visibleReportMetadata(reports); }
export function reportsNeedingAttention(reports: ReportRegistryItem[]): ReportRegistryItem[] { return reportMetadataNeedingAttention(reports); }
