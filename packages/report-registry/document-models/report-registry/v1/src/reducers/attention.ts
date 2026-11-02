import type {
  ReportRegistryAttentionOperations,
  ReportRegistryGlobalState,
  ReportReviewState,
} from "document-models/report-registry/v1";
import {
  assertMutable,
  assertRevision,
  assertUtc,
  clearAttention,
  mutationMetadata,
  optionalText,
  requireText,
  touch,
} from "../utils.js";

function ensureReviewState(state: ReportRegistryGlobalState): ReportReviewState {
  const legacyState = state as ReportRegistryGlobalState & {
    review?: ReportReviewState;
  };
  legacyState.review ??= { openedAt: null, readAt: null, feedback: [] };
  return legacyState.review;
}

function assertFinalReview(state: ReportRegistryGlobalState): void {
  assertMutable(state);
  if (state.lifecycle !== "FINAL") {
    throw new Error("review: report must be FINAL");
  }
}

export const reportRegistryAttentionOperations: ReportRegistryAttentionOperations =
  {
    requestReviewOperation(state, action) {
      assertMutable(state);
      assertRevision(state, action.input.expectedRevision);
      if (state.lifecycle !== "FINAL") {
        throw new Error("REQUEST_REVIEW: report must be FINAL");
      }
      if (action.input.request === "NONE") {
        throw new Error("REQUEST_REVIEW: active request required");
      }
      const metadata = mutationMetadata(
        action.input.actorId,
        action.input.occurredAt,
      );
      const nextAttention = {
        request: action.input.request,
        reasonCode: optionalText(action.input.reasonCode, "reasonCode", 500),
        reason: optionalText(action.input.reason, "reason", 4_000),
        reviewBy:
          action.input.reviewBy == null
            ? null
            : assertUtc(action.input.reviewBy, "reviewBy"),
        expiresAt:
          action.input.expiresAt == null
            ? null
            : assertUtc(action.input.expiresAt, "expiresAt"),
        requestedBy: metadata.actorId,
        requestedAt: metadata.occurredAt,
        resolvedAt: null,
        resolution: null,
      } as const;
      ensureReviewState(state);
      state.attention = nextAttention;
      touch(state, metadata.actorId, metadata.occurredAt);
    },
    markOpenedOperation(state, action) {
      assertFinalReview(state);
      assertRevision(state, action.input.expectedRevision);
      const metadata = mutationMetadata(
        action.input.actorId,
        action.input.occurredAt,
      );
      const review = ensureReviewState(state);
      review.openedAt ??= metadata.occurredAt;
      touch(state, metadata.actorId, metadata.occurredAt);
    },
    markReadOperation(state, action) {
      assertFinalReview(state);
      assertRevision(state, action.input.expectedRevision);
      const metadata = mutationMetadata(
        action.input.actorId,
        action.input.occurredAt,
      );
      const review = ensureReviewState(state);
      review.openedAt ??= metadata.occurredAt;
      review.readAt ??= metadata.occurredAt;
      if (
        state.attention.request === "READ" &&
        state.attention.resolvedAt == null
      ) {
        clearAttention(state, metadata.occurredAt, "READ");
      }
      touch(state, metadata.actorId, metadata.occurredAt);
    },
    markUnreadOperation(state, action) {
      assertFinalReview(state);
      assertRevision(state, action.input.expectedRevision);
      const metadata = mutationMetadata(
        action.input.actorId,
        action.input.occurredAt,
      );
      const review = ensureReviewState(state);
      review.readAt = null;
      // Reading attention can return without reversing a dismissal, approval,
      // or other explicit decision. Opening history remains intact.
      if (
        state.attention.request === "READ" &&
        state.attention.resolvedAt !== null &&
        state.attention.resolution === "READ"
      ) {
        state.attention.resolvedAt = null;
        state.attention.resolution = null;
      }
      touch(state, metadata.actorId, metadata.occurredAt);
    },
    addFeedbackOperation(state, action) {
      assertFinalReview(state);
      assertRevision(state, action.input.expectedRevision);
      const metadata = mutationMetadata(
        action.input.actorId,
        action.input.occurredAt,
      );
      const feedbackId = requireText(
        action.input.feedbackId,
        "feedbackId",
        500,
      );
      const bodyMarkdown = requireText(
        action.input.bodyMarkdown,
        "bodyMarkdown",
        100_000,
      );
      const review = ensureReviewState(state);
      if (
        review.feedback.some((feedback) => feedback.id === feedbackId)
      ) {
        return;
      }
      if (review.feedback.length >= 10_000) {
        throw new Error("feedback: maximum count is 10000");
      }
      review.feedback = [
        ...review.feedback,
        {
          id: feedbackId,
          actorId: metadata.actorId,
          bodyMarkdown,
          createdAt: metadata.occurredAt,
          route: {
            status: "UNROUTED",
            destination: null,
            routedAt: null,
            error: null,
          },
        },
      ];
      touch(state, metadata.actorId, metadata.occurredAt);
    },
    markFeedbackRoutedOperation(state, action) {
      assertMutable(state);
      assertRevision(state, action.input.expectedRevision);
      const metadata = mutationMetadata(
        action.input.actorId,
        action.input.occurredAt,
      );
      const destination = requireText(
        action.input.destination,
        "destination",
        4_000,
      );
      const review = (state as ReportRegistryGlobalState & {
        review?: ReportReviewState;
      }).review;
      if (!review) throw new Error("MARK_FEEDBACK_ROUTED: feedback not found");
      const feedback = review.feedback.find(
        (candidate) => candidate.id === action.input.feedbackId,
      );
      if (!feedback)
        throw new Error("MARK_FEEDBACK_ROUTED: feedback not found");
      feedback.route = {
        status: "ROUTED",
        destination,
        routedAt: metadata.occurredAt,
        error: null,
      };
      touch(state, metadata.actorId, metadata.occurredAt);
    },
    markFeedbackRouteFailedOperation(state, action) {
      assertMutable(state);
      assertRevision(state, action.input.expectedRevision);
      const metadata = mutationMetadata(
        action.input.actorId,
        action.input.occurredAt,
      );
      const routeError = requireText(action.input.error, "error", 4_000);
      const review = (state as ReportRegistryGlobalState & {
        review?: ReportReviewState;
      }).review;
      if (!review) {
        throw new Error("MARK_FEEDBACK_ROUTE_FAILED: feedback not found");
      }
      const feedback = review.feedback.find(
        (candidate) => candidate.id === action.input.feedbackId,
      );
      if (!feedback)
        throw new Error("MARK_FEEDBACK_ROUTE_FAILED: feedback not found");
      feedback.route = {
        status: "FAILED",
        destination: feedback.route.destination,
        routedAt: null,
        error: routeError,
      };
      touch(state, metadata.actorId, metadata.occurredAt);
    },
    dismissAttentionOperation(state, action) {
      assertFinalReview(state);
      assertRevision(state, action.input.expectedRevision);
      if (
        state.attention.request === "NONE" ||
        state.attention.resolvedAt != null
      ) {
        throw new Error("DISMISS_ATTENTION: no active request");
      }
      const metadata = mutationMetadata(
        action.input.actorId,
        action.input.occurredAt,
      );
      ensureReviewState(state);
      clearAttention(state, metadata.occurredAt, "DISMISSED");
      touch(state, metadata.actorId, metadata.occurredAt);
    },
    resolveAttentionOperation(state, action) {
      assertFinalReview(state);
      assertRevision(state, action.input.expectedRevision);
      if (
        state.attention.request === "NONE" ||
        state.attention.resolvedAt != null
      ) {
        throw new Error("RESOLVE_ATTENTION: no active request");
      }
      const metadata = mutationMetadata(
        action.input.actorId,
        action.input.occurredAt,
      );
      ensureReviewState(state);
      clearAttention(state, metadata.occurredAt, "RESOLVED");
      touch(state, metadata.actorId, metadata.occurredAt);
    },
  };
