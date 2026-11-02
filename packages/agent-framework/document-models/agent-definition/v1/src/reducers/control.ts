import type { AgentDefinitionControlOperations } from "document-models/agent-definition/v1";
import {
  assert,
  before,
  hash,
  newer,
  opaque,
  ref,
  text,
  touch,
  unique,
  version,
} from "../../../../../src/validation.js";

export const agentDefinitionControlOperations: AgentDefinitionControlOperations = {
  publishDefinitionOperation(state, { input: i }) {
    before(state, i, true);
    const r = i.release;
    opaque(r.definitionId);
    opaque(r.publisherRef);
    assert(r.publisherRef === i.actorId, "Publisher must match authenticated owner");
    version(r.packageVersion);
    assert(r.schemaVersion === 1, "Unsupported schema version");
    hash(r.contentHash);
    text(r.licenseRef);
    text(r.title);
    text(r.description);
    text(r.purpose);
    if (r.avatarRef) opaque(r.avatarRef);
    unique(r.examples, "example");
    if (r.instructionTokenCount != null)
      assert(
        Number.isInteger(r.instructionTokenCount) && r.instructionTokenCount >= 0 && r.tokenizerRef,
        "Token count requires tokenizer identity",
      );
    if (r.tokenizerRef) text(r.tokenizerRef);
    ref(r.instructions);
    unique(r.tags, "tag");
    unique(r.responsibilities, "responsibility");
    unique(
      r.skills.map((x) => x.id),
      "skill",
    );
    r.skills.forEach(ref);
    unique(
      r.capabilities.map((x) => x.id),
      "capability",
    );
    r.capabilities.forEach((c) => {
      opaque(c.id);
      text(c.resourceType);
      unique(c.actions, "action");
      assert(c.actions.length, "Capability requires actions");
      unique(c.outputTypes, "output");
    });
    unique(r.runtimeContracts, "runtime contract");
    unique(r.modelProfiles, "model profile");
    assert(
      r.runtimeContracts.length > 0 && r.modelProfiles.length > 0,
      "Runtime and model capability contracts required",
    );
    unique(
      r.documentModels.map((x) => x.documentType),
      "model dependency",
    );
    r.documentModels.forEach((x) => {
      text(x.documentType);
      assert(Number.isInteger(x.version) && x.version > 0, "Invalid model dependency version");
    });
    unique(
      r.views.map((x) => x.id),
      "view",
    );
    r.views.forEach((v) => ref(v.codeRef));
    unique(
      r.migrations.map((x) => x.fromVersion),
      "migration",
    );
    r.migrations.forEach((m) => {
      version(m.fromVersion);
      ref(m.migrationRef);
      ref(m.compatibilityFixtureRef);
    });
    if (r.previousVersionRef) {
      ref(r.previousVersionRef);
      assert(r.previousVersionRef.id === r.definitionId, "Previous release identity mismatch");
      newer(r.packageVersion, r.previousVersionRef.version);
    }
    unique(r.exportRequirements, "export requirement");
    assert(r.exportRequirements.length, "Export requirements required");
    unique(
      r.qualificationFixtures.map((x) => x.id),
      "fixture",
    );
    assert(r.qualificationFixtures.length, "Qualification fixture required");
    r.qualificationFixtures.forEach(ref);
    state.release = {
      ...r,
      previousVersionRef: r.previousVersionRef ?? null,
      avatarRef: r.avatarRef ?? null,
      instructionTokenCount: r.instructionTokenCount ?? null,
      tokenizerRef: r.tokenizerRef ?? null,
    };
    touch(state, i);
  },
};
