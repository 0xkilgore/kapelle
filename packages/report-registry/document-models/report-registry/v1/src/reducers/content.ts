import type { ReportRegistryContentOperations } from "document-models/report-registry/v1";
import { normalizePublication } from "../publication.js";
import {
  assertMutable,
  assertRevision,
  mutationMetadata,
  normalizeContent,
  optionalText,
  requireText,
  touch,
} from "../utils.js";

export const reportRegistryContentOperations: ReportRegistryContentOperations =
  {
    registerReportOperation(state, action) {
      if (state.id)
        throw new Error("REGISTER_REPORT: report already registered");
      const input = action.input;
      const metadata = mutationMetadata(input.actorId, input.occurredAt);
      const lifecycle = input.lifecycle ?? "DRAFT";
      if (lifecycle !== "DRAFT" && lifecycle !== "FINAL") {
        throw new Error(
          "REGISTER_REPORT: initial lifecycle must be DRAFT or FINAL",
        );
      }
      const producerId = requireText(input.producer.id, "producer.id", 500);

      const publication =
        input.publication == null
          ? undefined
          : normalizePublication(input.publication, {
              contentHash: input.content.contentHash,
              sourceRef: input.sourceRef,
              occurredAt: metadata.occurredAt,
              lifecycle,
              producerId,
              producerKind: input.producer.kind,
            });
      Object.assign(state, {
        id: requireText(input.id, "id", 500),
        schemaVersion: 1,
        reportRef: requireText(input.reportRef, "reportRef", 1_000),
        revision: 1,
        title: requireText(input.title, "title", 500),
        projectRef: optionalText(input.projectRef, "projectRef", 1_000),
        familyRef: optionalText(input.familyRef, "familyRef", 1_000),
        sourceRef: optionalText(input.sourceRef, "sourceRef", 4_000),
        producer: {
          kind: input.producer.kind,
          id: producerId,
          label: optionalText(input.producer.label, "producer.label", 500),
        },
        content: normalizeContent(input.content),
        ...(publication ? { publication } : {}),
        lifecycle,
        attention: {
          request: "NONE" as const,
          reasonCode: null,
          reason: null,
          reviewBy: null,
          expiresAt: null,
          requestedBy: null,
          requestedAt: null,
          resolvedAt: null,
          resolution: null,
        },
        review: { openedAt: null, readAt: null, feedback: [] },
        supersedesRef: null,
        supersededByRef: null,
        createdAt: metadata.occurredAt,
        updatedAt: metadata.occurredAt,
        createdBy: metadata.actorId,
        updatedBy: metadata.actorId,
      });
    },
    publishReportOperation(state, action) {
      assertMutable(state);
      assertRevision(state, action.input.expectedRevision);
      if (state.lifecycle !== "DRAFT") {
        throw new Error("PUBLISH_REPORT: only DRAFT reports can be published");
      }
      state.lifecycle = "FINAL";
      touch(state, action.input.actorId, action.input.occurredAt);
    },
  };
