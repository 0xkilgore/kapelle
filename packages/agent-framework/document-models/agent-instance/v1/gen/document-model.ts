import type { DocumentModelGlobalState } from "document-model";

export const documentModel: DocumentModelGlobalState = {
  id: "kapelle/agent-instance",
  name: "Agent Instance",
  author: {
    name: "Chris Powers",
    website: "https://kapelle.ai",
  },
  extension: "phagent",
  description: "Portable agent framework: agent-instance",
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
            "\ntype VersionedRef { id: ID! version: String! contentHash: String! }\n\nenum DesiredState { READY PAUSED RETIRED }\nenum SkillSource { BUILTIN MARKET USER }\nenum ConnectionDirection { RECEIVE PREPARE SEND }\nenum ReviewPolicy { ALWAYS WITHIN_GRANT }\nenum DocumentAccess { PRIVATE SHARED PUBLIC }\nenum CatchUpPolicy { SKIP COALESCE }\ntype EnabledSkill { ref: VersionedRef! source: SkillSource! }\ntype CapabilityGrant { id: ID! principalId: ID! resourceRef: ID! actions: [String!]! expiresAt: DateTime! reviewPolicy: ReviewPolicy! revokedAt: DateTime }\ntype ConnectionBinding { id: ID! connectionRef: ID! label: String! accountRef: ID! directions: [ConnectionDirection!]! revokedAt: DateTime }\ntype DocumentLink { documentRef: ID! access: DocumentAccess! }\ntype ScheduleBinding { id: ID! schedulerRef: ID! timezone: String! maxExecutions: Int! conditionRef: ID! catchUp: CatchUpPolicy! watermarkRef: ID! lastRunRef: ID }\ntype ModelPolicy { preferredProfile: String! concurrencyLimit: Int! budgetPolicyRef: ID! paidFallback: Boolean! fallbackProvider: String fallbackScopeRef: ID fallbackBudgetRef: ID }\n\ntype AgentInstanceState {\nrevision: Int!\nownerId: ID\ncreatedAt: DateTime\nupdatedAt: DateTime\n\ninstanceId: ID\nscopeRef: ID\ndefinitionRef: VersionedRef\nname: String\nresponsibilities: [String!]!\noperatingPolicy: String\ndesiredState: DesiredState!\nruntimeBindingRef: ID\nskills: [EnabledSkill!]!\ngrants: [CapabilityGrant!]!\nconnections: [ConnectionBinding!]!\ndocumentLinks: [DocumentLink!]!\nschedules: [ScheduleBinding!]!\nmodelPolicy: ModelPolicy\n\n}",
          examples: [],
          initialValue:
            '{"revision": 0, "ownerId": null, "createdAt": null, "updatedAt": null, "instanceId": null, "scopeRef": null, "definitionRef": null, "name": null, "responsibilities": [], "operatingPolicy": null, "desiredState": "PAUSED", "runtimeBindingRef": null, "skills": [], "grants": [], "connections": [], "documentLinks": [], "schedules": [], "modelPolicy": null}',
        },
      },
      modules: [
        {
          id: "agent-instance-control",
          name: "control",
          description:
            "Deterministic document operations; authenticated commands are enforced by the service boundary.",
          operations: [
            {
              id: "agent-instance-create-instance",
              name: "CREATE_INSTANCE",
              description: "Create instance",
              schema:
                "input CreateInstanceInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\ninstanceId: ID!\n scopeRef: ID!\n definitionRef: VersionedRefInput!\n name: String!\n responsibilities: [String!]!\n operatingPolicy: String!\n modelPolicy: ModelPolicyInput!\n}\ninput VersionedRefInput { id: ID! version: String! contentHash: String! }\ninput ModelPolicyInput { preferredProfile: String! concurrencyLimit: Int! budgetPolicyRef: ID! paidFallback: Boolean! fallbackProvider: String fallbackScopeRef: ID fallbackBudgetRef: ID }",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-set-responsibilities",
              name: "SET_RESPONSIBILITIES",
              description: "Set responsibilities",
              schema:
                "input SetResponsibilitiesInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nresponsibilities: [String!]!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-set-operating-policy",
              name: "SET_OPERATING_POLICY",
              description: "Set operating policy",
              schema:
                "input SetOperatingPolicyInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\noperatingPolicy: String!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-enable-skill",
              name: "ENABLE_SKILL",
              description: "Enable skill",
              schema:
                "input EnableSkillInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nref: VersionedRefInput!\n source: SkillSource!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-disable-skill",
              name: "DISABLE_SKILL",
              description: "Disable skill",
              schema:
                "input DisableSkillInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nskillId: ID!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-grant-capability",
              name: "GRANT_CAPABILITY",
              description: "Grant capability",
              schema:
                "input GrantCapabilityInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\ngrant: CapabilityGrantInput!\n}\ninput CapabilityGrantInput { id: ID! principalId: ID! resourceRef: ID! actions: [String!]! expiresAt: DateTime! reviewPolicy: ReviewPolicy! }",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-revoke-capability",
              name: "REVOKE_CAPABILITY",
              description: "Revoke capability",
              schema:
                "input RevokeCapabilityInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\ngrantId: ID!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-bind-connection",
              name: "BIND_CONNECTION",
              description: "Bind connection",
              schema:
                "input BindConnectionInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nbinding: ConnectionBindingInput!\n}\ninput ConnectionBindingInput { id: ID! connectionRef: ID! label: String! accountRef: ID! directions: [ConnectionDirection!]! }",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-revoke-connection",
              name: "REVOKE_CONNECTION",
              description: "Revoke connection",
              schema:
                "input RevokeConnectionInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nconnectionId: ID!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-set-runtime-binding",
              name: "SET_RUNTIME_BINDING",
              description: "Set runtime binding",
              schema:
                "input SetRuntimeBindingInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nruntimeBindingRef: ID!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-set-model-policy",
              name: "SET_MODEL_POLICY",
              description: "Set model policy",
              schema:
                "input SetModelPolicyInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nmodelPolicy: ModelPolicyInput!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-link-document",
              name: "LINK_DOCUMENT",
              description: "Link document",
              schema:
                "input LinkDocumentInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\ndocumentRef: ID!\n access: DocumentAccess!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-unlink-document",
              name: "UNLINK_DOCUMENT",
              description: "Unlink document",
              schema:
                "input UnlinkDocumentInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\ndocumentRef: ID!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-bind-schedule",
              name: "BIND_SCHEDULE",
              description: "Bind schedule",
              schema:
                "input BindScheduleInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nschedule: ScheduleBindingInput!\n}\ninput ScheduleBindingInput { id: ID! schedulerRef: ID! timezone: String! maxExecutions: Int! conditionRef: ID! catchUp: CatchUpPolicy! watermarkRef: ID! lastRunRef: ID }",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-unbind-schedule",
              name: "UNBIND_SCHEDULE",
              description: "Unbind schedule",
              schema:
                "input UnbindScheduleInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nscheduleId: ID!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-pin-definition-version",
              name: "PIN_DEFINITION_VERSION",
              description: "Pin definition version",
              schema:
                "input PinDefinitionVersionInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\ndefinitionRef: VersionedRefInput!\n migrationRef: VersionedRefInput!\n compatibilityFixtureRef: VersionedRefInput!\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-request-pause",
              name: "REQUEST_PAUSE",
              description: "Request pause",
              schema:
                "input RequestPauseInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\n\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-request-resume",
              name: "REQUEST_RESUME",
              description: "Request resume",
              schema:
                "input RequestResumeInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\n\n}\n",
              template: "",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "agent-instance-retire-instance",
              name: "RETIRE_INSTANCE",
              description: "Retire instance",
              schema:
                "input RetireInstanceInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\n\n}\n",
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
  ],
};
