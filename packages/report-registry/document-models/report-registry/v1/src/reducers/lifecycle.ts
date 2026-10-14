import type { ReportRegistryLifecycleOperations } from "document-models/report-registry/v1";
import {
  assertMutable,
  assertRevision,
  clearAttention,
  mutationMetadata,
  optionalText,
  requireText,
  touch,
} from "../utils.js";

export const reportRegistryLifecycleOperations: ReportRegistryLifecycleOperations =
  {
    supersedeReportOperation(state, action) {
      assertMutable(state);
      assertRevision(state, action.input.expectedRevision);
      if (state.lifecycle !== "FINAL") {
        throw new Error("SUPERSEDE_REPORT: report must be FINAL");
      }
      const metadata = mutationMetadata(
        action.input.actorId,
        action.input.occurredAt,
      );
      const supersededByRef = requireText(
        action.input.supersededByRef,
        "supersededByRef",
        1_000,
      );
      if (supersededByRef === state.reportRef) {
        throw new Error("SUPERSEDE_REPORT: report cannot supersede itself");
      }
      state.lifecycle = "SUPERSEDED";
      state.supersededByRef = supersededByRef;
      if (
        state.attention.request !== "NONE" &&
        state.attention.resolvedAt == null
      ) {
        clearAttention(state, metadata.occurredAt, "RESOLVED");
      }
      touch(state, metadata.actorId, metadata.occurredAt);
    },
    withdrawReportOperation(state, action) {
      assertMutable(state);
      assertRevision(state, action.input.expectedRevision);
      const metadata = mutationMetadata(
        action.input.actorId,
        action.input.occurredAt,
      );
      optionalText(action.input.reason, "reason", 4_000);
      state.lifecycle = "WITHDRAWN";
      if (
        state.attention.request !== "NONE" &&
        state.attention.resolvedAt == null
      ) {
        clearAttention(state, metadata.occurredAt, "RESOLVED");
      }
      touch(state, metadata.actorId, metadata.occurredAt);
    },
  };

