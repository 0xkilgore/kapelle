import type { DocumentModelGlobalState } from "document-model";

export const documentModel: DocumentModelGlobalState = {
  id: "kapelle/agent-definition",
  name: "Agent Definition",
  author: {
    name: "Chris Powers",
    website: "https://kapelle.ai",
  },
  extension: "phagentdef",
  description: "Portable agent framework: agent-definition",
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
            "\ntype VersionedRef { id: ID! version: String! contentHash: String! }\n\nenum Requirement { REQUIRED OPTIONAL }\ntype CapabilityDeclaration { id: ID! requirement: Requirement! resourceType: String! actions: [String!]! outputTypes: [String!]! }\ntype ModelDependency { documentType: String! version: Int! }\ntype MigrationDeclaration { fromVersion: String! migrationRef: VersionedRef! compatibilityFixtureRef: VersionedRef! }\ntype ViewDeclaration { id: ID! codeRef: VersionedRef! }\ntype DefinitionRelease {\n definitionId: ID! packageVersion: String! schemaVersion: Int! publisherRef: ID! licenseRef: String! contentHash: String!\n previousVersionRef: VersionedRef title: String! description: String! tags: [String!]! avatarRef: ID examples: [String!]! instructionTokenCount: Int tokenizerRef: String purpose: String! responsibilities: [String!]!\n instructions: VersionedRef! skills: [VersionedRef!]! capabilities: [CapabilityDeclaration!]!\n runtimeContracts: [String!]! modelProfiles: [String!]! documentModels: [ModelDependency!]!\n migrations: [MigrationDeclaration!]! views: [ViewDeclaration!]! exportRequirements: [String!]! qualificationFixtures: [VersionedRef!]!\n}\n\ntype AgentDefinitionState {\nrevision: Int!\nownerId: ID\ncreatedAt: DateTime\nupdatedAt: DateTime\nrelease: DefinitionRelease\n}",
          examples: [],
          initialValue:
            '{"revision": 0, "ownerId": null, "createdAt": null, "updatedAt": null, "release": null}',
        },
      },
      modules: [
        {
          id: "agent-definition-control",
          name: "control",
          description:
            "Deterministic document operations; authenticated commands are enforced by the service boundary.",
          operations: [
            {
              id: "agent-definition-publish-definition",
              name: "PUBLISH_DEFINITION",
              description: "Publish definition",
              schema:
                "input PublishDefinitionInput {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\nrelease: DefinitionReleaseInput!\n}\ninput VersionedRefInput { id: ID! version: String! contentHash: String! }\ninput CapabilityDeclarationInput { id: ID! requirement: Requirement! resourceType: String! actions: [String!]! outputTypes: [String!]! }\ninput ModelDependencyInput { documentType: String! version: Int! }\ninput MigrationDeclarationInput { fromVersion: String! migrationRef: VersionedRefInput! compatibilityFixtureRef: VersionedRefInput! }\ninput ViewDeclarationInput { id: ID! codeRef: VersionedRefInput! }\ninput DefinitionReleaseInput {\n definitionId: ID! packageVersion: String! schemaVersion: Int! publisherRef: ID! licenseRef: String! contentHash: String!\n previousVersionRef: VersionedRefInput title: String! description: String! tags: [String!]! avatarRef: ID examples: [String!]! instructionTokenCount: Int tokenizerRef: String purpose: String! responsibilities: [String!]!\n instructions: VersionedRefInput! skills: [VersionedRefInput!]! capabilities: [CapabilityDeclarationInput!]!\n runtimeContracts: [String!]! modelProfiles: [String!]! documentModels: [ModelDependencyInput!]!\n migrations: [MigrationDeclarationInput!]! views: [ViewDeclarationInput!]! exportRequirements: [String!]! qualificationFixtures: [VersionedRefInput!]!\n}\n",
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
