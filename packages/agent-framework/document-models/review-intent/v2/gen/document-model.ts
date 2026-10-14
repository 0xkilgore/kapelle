import type { DocumentModelGlobalState } from "document-model";

export const documentModel: DocumentModelGlobalState = {
  id: "kapelle/review-intent",
  name: "Review Intent",
  author: {
    name: "Chris Powers",
    website: "https://kapelle.ai",
  },
  extension: "phreview",
  description: "Portable agent framework: review-intent",
  specifications: [
    {
      state: {
        local: {
          schema: "",
          examples: [],
          initialValue: "",
        },
        global: {
          schema:
            "\nenum ReviewState { PROPOSED APPROVED REJECTED INVALIDATED }\nenum EffectKind { DOCUMENT_CHANGE PREPARE_MESSAGE SEND_MESSAGE }\nenum DeliveryStatus { ACCEPTED DELIVERED FAILED UNCERTAIN }\ntype TargetRevision { documentRef: ID! revision: Int! contentHash: String! }\ntype Proposal { version: Int! contentHash: String! contentRef: ID! contentVersion: Int! artifactHash: String! effectKind: EffectKind! action: String! targets: [TargetRevision!]! senderConnectionRef: ID recipients: [String!]! }\ntype Decision { actorId: ID! occurredAt: DateTime! proposalHash: String! proposalVersion: Int! approved: Boolean! reason: String }\ntype EffectReservation { operationId: ID! dispatchRef: ID! outboxRef: ID! occurredAt: DateTime! }\ntype DeliveryEvidence { id: ID! status: DeliveryStatus! providerRef: ID! receiptRef: ID! occurredAt: DateTime! }\n\ntype ReviewIntentState {\nrevision: Int!\nownerId: ID\ncreatedAt: DateTime\nupdatedAt: DateTime\n\nreviewId: ID\ninstanceId: ID\nscopeRef: ID\nproposal: Proposal\nstatus: ReviewState!\ndecision: Decision\ninvalidatedReason: String\neffect: EffectReservation\ndelivery: [DeliveryEvidence!]!\n\n}",
          examples: [],
          initialValue:
            '{"revision": 0, "ownerId": null, "createdAt": null, "updatedAt": null, "reviewId": null, "instanceId": null, "scopeRef": null, "proposal": null, "status": "PROPOSED", "decision": null, "invalidatedReason": null, "effect": null, "delivery": []}',
        },
      },
      modules: [
        {
          id: "review-intent-control",
          name: "control",
          description:
            "Deterministic document operations; authenticated commands are enforced by the service boundary.",
          operations: [
            {
              id: "review-intent-create-review",
              name: "CREATE_REVIEW",
              description: "Create review",
              schema:
                "input CreateReviewInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nreviewId: ID!\n instanceId: ID!\n scopeRef: ID!\n proposal: ProposalInput!\n}\ninput TargetRevisionInput { documentRef: ID! revision: Int! contentHash: String! }\ninput ProposalInput { version: Int! contentHash: String! contentRef: ID! contentVersion: Int! artifactHash: String! effectKind: EffectKind! action: String! targets: [TargetRevisionInput!]! senderConnectionRef: ID recipients: [String!]! }\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "review-intent-record-decision",
              name: "RECORD_DECISION",
              description: "Record decision",
              schema:
                "input RecordDecisionInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nproposalHash: String!\n proposalVersion: Int!\n approved: Boolean!\n reason: String\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "review-intent-invalidate-review",
              name: "INVALIDATE_REVIEW",
              description: "Invalidate review",
              schema:
                "input InvalidateReviewInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nreason: String!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "review-intent-reserve-effect",
              name: "RESERVE_EFFECT",
              description: "Reserve effect",
              schema:
                "input ReserveEffectInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\noperationId: ID!\n dispatchRef: ID!\n outboxRef: ID!\n proposalHash: String!\n proposalVersion: Int!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "review-intent-record-delivery",
              name: "RECORD_DELIVERY",
              description: "Record delivery",
              schema:
                "input RecordDeliveryInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nevidenceId: ID!\n operationId: ID!\n status: DeliveryStatus!\n providerRef: ID!\n receiptRef: ID!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
          ],
        },
      ],
      version: 1,
      changeLog: [],
    },
    {
      state: {
        local: {
          schema: "",
          examples: [],
          initialValue: "",
        },
        global: {
          schema:
            "\nenum ReviewState { PROPOSED APPROVED REJECTED INVALIDATED }\nenum EffectKind { DOCUMENT_CHANGE PREPARE_MESSAGE SEND_MESSAGE WEBSITE_PUBLICATION }\nenum DeliveryStatus { ACCEPTED DELIVERED FAILED UNCERTAIN }\ntype TargetRevision { documentRef: ID! revision: Int! contentHash: String! }\ntype Proposal { version: Int! contentHash: String! contentRef: ID! contentVersion: Int! artifactHash: String! expiresAt: DateTime effectKind: EffectKind! action: String! targets: [TargetRevision!]! senderConnectionRef: ID recipients: [String!]! }\ntype Decision { actorId: ID! occurredAt: DateTime! proposalHash: String! proposalVersion: Int! approved: Boolean! reason: String }\ntype EffectReservation { operationId: ID! dispatchRef: ID! outboxRef: ID! occurredAt: DateTime! }\ntype DeliveryEvidence { id: ID! status: DeliveryStatus! providerRef: ID! receiptRef: ID! occurredAt: DateTime! }\n\ntype ExecutionClaim { operationId: ID! attemptId: ID! executorId: ID! occurredAt: DateTime! }\n\ntype ReviewIntentState {\nrevision: Int!\nownerId: ID\ncreatedAt: DateTime\nupdatedAt: DateTime\n\nreviewId: ID\ninstanceId: ID\nscopeRef: ID\nproposal: Proposal\nstatus: ReviewState!\ndecision: Decision\ninvalidatedReason: String\neffect: EffectReservation\nexecution: ExecutionClaim\ndelivery: [DeliveryEvidence!]!\n\n}",
          examples: [],
          initialValue:
            '{"revision": 0, "ownerId": null, "createdAt": null, "updatedAt": null, "reviewId": null, "instanceId": null, "scopeRef": null, "proposal": null, "status": "PROPOSED", "decision": null, "invalidatedReason": null, "effect": null, "delivery": [], "execution": null}',
        },
      },
      modules: [
        {
          id: "review-intent-control",
          name: "control",
          description:
            "Deterministic document operations; authenticated commands are enforced by the service boundary.",
          operations: [
            {
              id: "review-intent-create-review",
              name: "CREATE_REVIEW",
              description: "Create review",
              schema:
                "input CreateReviewInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nreviewId: ID!\n instanceId: ID!\n scopeRef: ID!\n proposal: ProposalInput!\n}\ninput TargetRevisionInput { documentRef: ID! revision: Int! contentHash: String! }\ninput ProposalInput { version: Int! contentHash: String! contentRef: ID! contentVersion: Int! artifactHash: String! expiresAt: DateTime effectKind: EffectKind! action: String! targets: [TargetRevisionInput!]! senderConnectionRef: ID recipients: [String!]! }\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "review-intent-record-decision",
              name: "RECORD_DECISION",
              description: "Record decision",
              schema:
                "input RecordDecisionInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nproposalHash: String!\n proposalVersion: Int!\n approved: Boolean!\n reason: String\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "review-intent-invalidate-review",
              name: "INVALIDATE_REVIEW",
              description: "Invalidate review",
              schema:
                "input InvalidateReviewInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nreason: String!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "review-intent-reserve-effect",
              name: "RESERVE_EFFECT",
              description: "Reserve effect",
              schema:
                "input ReserveEffectInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\noperationId: ID!\n dispatchRef: ID!\n outboxRef: ID!\n proposalHash: String!\n proposalVersion: Int!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "review-intent-record-delivery",
              name: "RECORD_DELIVERY",
              description: "Record delivery",
              schema:
                "input RecordDeliveryInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nevidenceId: ID!\n operationId: ID!\n status: DeliveryStatus!\n providerRef: ID!\n receiptRef: ID!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "review-intent-claim-execution",
              name: "CLAIM_EXECUTION",
              description:
                "Permanently claim one native invocation; uncertain recovery never resets it.",
              schema:
                "input ClaimExecutionInput { actorId: ID! occurredAt: DateTime! expectedRevision: Int! operationId: ID! dispatchRef: ID! outboxRef: ID! proposalHash: String! proposalVersion: Int! attemptId: ID! executorId: ID! }",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
          ],
        },
      ],
      version: 2,
      changeLog: [],
    },
  ],
};
