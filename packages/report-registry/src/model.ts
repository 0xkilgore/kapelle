import { createHash, randomUUID } from "node:crypto";

export const REPORT_DOCUMENT_TYPE = "kilgore/report" as const;

export type ReportLifecycle = "draft" | "final" | "superseded" | "withdrawn";
export type AttentionRequest =
  | "none"
  | "read"
  | "answer"
  | "decide"
  | "approve"
  | "request_change";

export type Producer = {
  kind: "human" | "agent" | "service" | "import";
  id: string;
  label?: string;
};

export type ContentDescriptor = {
  storage: "inline_markdown" | "blob";
  mime_type: string;
  filename: string | null;
  content_hash: string;
  byte_size: number;
  markdown: string | null;
  blob_ref: string | null;
};

export type Feedback = {
  feedback_id: string;
  actor: string;
  body: string;
  created_at: string;
  route: {
    status: "unrouted" | "routed" | "failed";
    destination: string | null;
    routed_at: string | null;
    error: string | null;
  };
};

export type ReportState = {
  schema_version: "report.v1";
  report_ref: string;
  revision: number;
  title: string;
  project_ref: string | null;
  family_ref: string | null;
  source_ref: string | null;
  producer: Producer;
  content: ContentDescriptor;
  lifecycle: ReportLifecycle;
  attention: {
    request: AttentionRequest;
    reason_code: string | null;
    reason: string | null;
    review_by: string | null;
    expires_at: string | null;
    requested_by: string | null;
    requested_at: string | null;
    resolved_at: string | null;
    resolution: "read" | "dismissed" | "resolved" | null;
  };
  review: {
    opened_at: string | null;
    read_at: string | null;
    feedback: Feedback[];
  };
  supersedes_ref: string | null;
  superseded_by_ref: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  applied_operation_ids: string[];
};

export type ReportDocument = {
  header: {
    id: string;
    slug: string;
    documentType: typeof REPORT_DOCUMENT_TYPE;
    createdAtUtcIso: string;
    name: string;
  };
  state: { global: ReportState };
  operations: { global: ReportOperation[] };
};

type OperationBase<T extends string, I> = {
  operation_id: string;
  type: T;
  input: I;
  actor: string;
  ts: string;
  expected_revision: number | null;
};

export type ReportOperation =
  | OperationBase<"REGISTER_REPORT", {
      report_ref: string;
      title: string;
      project_ref?: string | null;
      family_ref?: string | null;
      source_ref?: string | null;
      producer: Producer;
      content: ContentDescriptor;
      lifecycle?: "draft" | "final";
    }>
  | OperationBase<"PUBLISH_REPORT", Record<string, never>>
  | OperationBase<"REQUEST_REVIEW", {
      request: Exclude<AttentionRequest, "none">;
      reason_code?: string | null;
      reason?: string | null;
      review_by?: string | null;
      expires_at?: string | null;
    }>
  | OperationBase<"MARK_OPENED", Record<string, never>>
  | OperationBase<"MARK_READ", Record<string, never>>
  | OperationBase<"MARK_UNREAD", Record<string, never>>
  | OperationBase<"ADD_FEEDBACK", { feedback_id?: string; body: string }>
  | OperationBase<"MARK_FEEDBACK_ROUTED", { feedback_id: string; destination: string }>
  | OperationBase<"MARK_FEEDBACK_ROUTE_FAILED", { feedback_id: string; error: string }>
  | OperationBase<"DISMISS_ATTENTION", Record<string, never>>
  | OperationBase<"RESOLVE_ATTENTION", Record<string, never>>
  | OperationBase<"SUPERSEDE_REPORT", { superseded_by_ref: string }>
  | OperationBase<"WITHDRAW_REPORT", { reason?: string | null }>;

type OperationInput<T extends ReportOperation["type"]> = Extract<ReportOperation, { type: T }>["input"];

function make<T extends ReportOperation["type"]>(
  type: T,
  input: OperationInput<T>,
  actor: string,
  expectedRevision: number | null = null,
  ts = new Date().toISOString(),
): Extract<ReportOperation, { type: T }> {
  return {
    operation_id: randomUUID(),
    type,
    input,
    actor,
    ts,
    expected_revision: expectedRevision,
  } as Extract<ReportOperation, { type: T }>;
}

export const actions = {
  registerReport: (input: OperationInput<"REGISTER_REPORT">, actor: string, ts?: string) =>
    make("REGISTER_REPORT", input, actor, 0, ts),
  publishReport: (actor: string, expectedRevision: number, ts?: string) =>
    make("PUBLISH_REPORT", {}, actor, expectedRevision, ts),
  requestReview: (input: OperationInput<"REQUEST_REVIEW">, actor: string, expectedRevision: number, ts?: string) =>
    make("REQUEST_REVIEW", input, actor, expectedRevision, ts),
  markOpened: (actor: string, expectedRevision: number, ts?: string) =>
    make("MARK_OPENED", {}, actor, expectedRevision, ts),
  markRead: (actor: string, expectedRevision: number, ts?: string) =>
    make("MARK_READ", {}, actor, expectedRevision, ts),
  markUnread: (actor: string, expectedRevision: number, ts?: string) =>
    make("MARK_UNREAD", {}, actor, expectedRevision, ts),
  addFeedback: (input: OperationInput<"ADD_FEEDBACK">, actor: string, expectedRevision: number, ts?: string) =>
    make("ADD_FEEDBACK", { ...input, feedback_id: input.feedback_id ?? randomUUID() }, actor, expectedRevision, ts),
  markFeedbackRouted: (input: OperationInput<"MARK_FEEDBACK_ROUTED">, actor: string, expectedRevision: number, ts?: string) =>
    make("MARK_FEEDBACK_ROUTED", input, actor, expectedRevision, ts),
  markFeedbackRouteFailed: (input: OperationInput<"MARK_FEEDBACK_ROUTE_FAILED">, actor: string, expectedRevision: number, ts?: string) =>
    make("MARK_FEEDBACK_ROUTE_FAILED", input, actor, expectedRevision, ts),
  dismissAttention: (actor: string, expectedRevision: number, ts?: string) =>
    make("DISMISS_ATTENTION", {}, actor, expectedRevision, ts),
  resolveAttention: (actor: string, expectedRevision: number, ts?: string) =>
    make("RESOLVE_ATTENTION", {}, actor, expectedRevision, ts),
  supersedeReport: (input: OperationInput<"SUPERSEDE_REPORT">, actor: string, expectedRevision: number, ts?: string) =>
    make("SUPERSEDE_REPORT", input, actor, expectedRevision, ts),
  withdrawReport: (input: OperationInput<"WITHDRAW_REPORT">, actor: string, expectedRevision: number, ts?: string) =>
    make("WITHDRAW_REPORT", input, actor, expectedRevision, ts),
};

export function blankReportDocument(reportRef: string, ts: string): ReportDocument {
  const deterministicId = createHash("sha256").update(reportRef).digest("hex").slice(0, 32);
  return {
    header: {
      id: `phid:${deterministicId}`,
      slug: reportRef.replace(/[^a-zA-Z0-9-]+/g, "-").slice(0, 64),
      documentType: REPORT_DOCUMENT_TYPE,
      createdAtUtcIso: ts,
      name: reportRef,
    },
    state: { global: {} as ReportState },
    operations: { global: [] },
  };
}

function requireText(value: string, field: string): string {
  if (!value || !value.trim()) throw new Error(`${field} required`);
  return value.trim();
}

function assertIsoOrNull(value: string | null | undefined, field: string): void {
  if (value != null && Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`);
}

function assertMutable(state: ReportState, op: string): void {
  if (state.lifecycle === "superseded" || state.lifecycle === "withdrawn") {
    throw new Error(`${op}: report is ${state.lifecycle}`);
  }
}

export function reduceReport(document: ReportDocument | null, operation: ReportOperation): ReportDocument {
  if (!operation.operation_id || !operation.actor || !operation.ts) {
    throw new Error(`${operation.type}: operation_id, actor, and ts required`);
  }

  if (document?.state.global.applied_operation_ids.includes(operation.operation_id)) return document;
  const currentRevision = document?.state.global.revision ?? 0;
  if (operation.expected_revision != null && operation.expected_revision !== currentRevision) {
    throw new Error(`${operation.type}: revision conflict (expected ${operation.expected_revision}, actual ${currentRevision})`);
  }

  if (operation.type === "REGISTER_REPORT") {
    if (document) throw new Error("REGISTER_REPORT: report already exists");
    const i = operation.input;
    requireText(i.report_ref, "report_ref");
    requireText(i.title, "title");
    requireText(i.producer.id, "producer.id");
    requireText(i.content.content_hash, "content.content_hash");
    if (i.content.storage === "inline_markdown" && i.content.markdown == null) {
      throw new Error("REGISTER_REPORT: inline_markdown requires markdown");
    }
    if (i.content.storage === "blob" && !i.content.blob_ref) {
      throw new Error("REGISTER_REPORT: blob storage requires blob_ref");
    }
    const next = blankReportDocument(i.report_ref, operation.ts);
    next.header.name = i.title.trim();
    next.state.global = {
      schema_version: "report.v1",
      report_ref: i.report_ref.trim(),
      revision: 1,
      title: i.title.trim(),
      project_ref: i.project_ref ?? null,
      family_ref: i.family_ref ?? null,
      source_ref: i.source_ref ?? null,
      producer: structuredClone(i.producer),
      content: structuredClone(i.content),
      lifecycle: i.lifecycle ?? "draft",
      attention: {
        request: "none", reason_code: null, reason: null, review_by: null,
        expires_at: null, requested_by: null, requested_at: null,
        resolved_at: null, resolution: null,
      },
      review: { opened_at: null, read_at: null, feedback: [] },
      supersedes_ref: null,
      superseded_by_ref: null,
      created_at: operation.ts,
      updated_at: operation.ts,
      created_by: operation.actor,
      updated_by: operation.actor,
      applied_operation_ids: [operation.operation_id],
    };
    next.operations.global.push(structuredClone(operation));
    return next;
  }

  if (!document) throw new Error(`${operation.type}: report does not exist`);
  // Validate the additive unread contract without changing historical operations.
  if (operation.type === "MARK_UNREAD") {
    if (document.state.global.lifecycle !== "final") throw new Error("MARK_UNREAD: report must be final");
    if (!Number.isSafeInteger(operation.expected_revision) || operation.expected_revision !== currentRevision) {
      throw new Error("MARK_UNREAD: exact expected revision required");
    }
    requireText(operation.actor, "actor");
    assertIsoOrNull(operation.ts, "ts");
  }
  const next = structuredClone(document);
  const state = next.state.global;
  // Documents created before review.v1 legitimately omit this additive field.
  // Materialize its neutral state before any generated review reducer runs.
  state.review ??= { opened_at: null, read_at: null, feedback: [] };
  assertMutable(state, operation.type);

  switch (operation.type) {
    case "PUBLISH_REPORT":
      if (state.lifecycle !== "draft") throw new Error("PUBLISH_REPORT: only draft reports can publish");
      state.lifecycle = "final";
      break;
    case "REQUEST_REVIEW": {
      if (state.lifecycle !== "final") throw new Error("REQUEST_REVIEW: report must be final");
      const i = operation.input;
      if (i.request === "none") throw new Error("REQUEST_REVIEW: non-none request required");
      assertIsoOrNull(i.review_by, "review_by");
      assertIsoOrNull(i.expires_at, "expires_at");
      state.attention = {
        request: i.request,
        reason_code: i.reason_code ?? null,
        reason: i.reason?.trim() || null,
        review_by: i.review_by ?? null,
        expires_at: i.expires_at ?? null,
        requested_by: operation.actor,
        requested_at: operation.ts,
        resolved_at: null,
        resolution: null,
      };
      break;
    }
    case "MARK_OPENED":
      state.review.opened_at ??= operation.ts;
      break;
    case "MARK_READ":
      state.review.opened_at ??= operation.ts;
      state.review.read_at ??= operation.ts;
      if (state.attention.request === "read" && state.attention.resolved_at == null) {
        state.attention.resolved_at = operation.ts;
        state.attention.resolution = "read";
      }
      break;
    case "MARK_UNREAD":
      state.review.read_at = null;
      if (state.attention.request === "read" && state.attention.resolved_at != null && state.attention.resolution === "read") {
        state.attention.resolved_at = null;
        state.attention.resolution = null;
      }
      break;
    case "ADD_FEEDBACK": {
      const body = requireText(operation.input.body, "feedback.body");
      const feedbackId = requireText(operation.input.feedback_id ?? "", "feedback.feedback_id");
      if (!state.review.feedback.some((f) => f.feedback_id === feedbackId)) {
        state.review.feedback.push({
          feedback_id: feedbackId,
          actor: operation.actor,
          body,
          created_at: operation.ts,
          route: { status: "unrouted", destination: null, routed_at: null, error: null },
        });
      }
      break;
    }
    case "MARK_FEEDBACK_ROUTED": {
      const feedback = state.review.feedback.find((f) => f.feedback_id === operation.input.feedback_id);
      if (!feedback) throw new Error("MARK_FEEDBACK_ROUTED: feedback not found");
      feedback.route = {
        status: "routed",
        destination: requireText(operation.input.destination, "destination"),
        routed_at: operation.ts,
        error: null,
      };
      break;
    }
    case "MARK_FEEDBACK_ROUTE_FAILED": {
      const feedback = state.review.feedback.find((f) => f.feedback_id === operation.input.feedback_id);
      if (!feedback) throw new Error("MARK_FEEDBACK_ROUTE_FAILED: feedback not found");
      feedback.route = {
        status: "failed",
        destination: feedback.route.destination,
        routed_at: null,
        error: requireText(operation.input.error, "error"),
      };
      break;
    }
    case "DISMISS_ATTENTION":
      if (state.attention.request === "none") throw new Error("DISMISS_ATTENTION: no active request");
      state.attention.resolved_at = operation.ts;
      state.attention.resolution = "dismissed";
      break;
    case "RESOLVE_ATTENTION":
      if (state.attention.request === "none") throw new Error("RESOLVE_ATTENTION: no active request");
      state.attention.resolved_at = operation.ts;
      state.attention.resolution = "resolved";
      break;
    case "SUPERSEDE_REPORT":
      state.lifecycle = "superseded";
      state.superseded_by_ref = requireText(operation.input.superseded_by_ref, "superseded_by_ref");
      if (state.superseded_by_ref === state.report_ref) throw new Error("SUPERSEDE_REPORT: cannot supersede itself");
      state.attention.resolved_at ??= operation.ts;
      state.attention.resolution ??= "resolved";
      break;
    case "WITHDRAW_REPORT":
      state.lifecycle = "withdrawn";
      state.attention.resolved_at ??= operation.ts;
      state.attention.resolution ??= "resolved";
      break;
    default: {
      const unreachable: never = operation;
      throw new Error(`unknown operation ${(unreachable as ReportOperation).type}`);
    }
  }

  state.revision += 1;
  state.updated_at = operation.ts;
  state.updated_by = operation.actor;
  state.applied_operation_ids.push(operation.operation_id);
  next.operations.global.push(structuredClone(operation));
  return next;
}
