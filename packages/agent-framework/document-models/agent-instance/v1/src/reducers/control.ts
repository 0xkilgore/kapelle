import type { AgentInstanceControlOperations } from "document-models/agent-instance/v1";
import {
  assert,
  before,
  modelPolicy,
  newer,
  opaque,
  ref,
  text,
  timestamp,
  touch,
  unique,
  type Mutation,
} from "../../../../../src/validation.js";
import type { AgentInstanceState } from "../../gen/schema/types.js";

function editable(s: AgentInstanceState, i: Mutation) {
  before(s, i);
  assert(s.desiredState !== "RETIRED", "Instance is retired");
}
export const agentInstanceControlOperations: AgentInstanceControlOperations = {
  createInstanceOperation(s, { input: i }) {
    before(s, i, true);
    opaque(i.instanceId);
    opaque(i.scopeRef);
    ref(i.definitionRef);
    text(i.name);
    text(i.operatingPolicy);
    unique(i.responsibilities, "responsibility");
    modelPolicy(i.modelPolicy);
    Object.assign(s, {
      instanceId: i.instanceId,
      scopeRef: i.scopeRef,
      definitionRef: i.definitionRef,
      name: i.name,
      responsibilities: i.responsibilities,
      operatingPolicy: i.operatingPolicy,
      modelPolicy: {
        ...i.modelPolicy,
        fallbackProvider: i.modelPolicy.fallbackProvider ?? null,
        fallbackScopeRef: i.modelPolicy.fallbackScopeRef ?? null,
        fallbackBudgetRef: i.modelPolicy.fallbackBudgetRef ?? null,
      },
      desiredState: "PAUSED",
    });
    touch(s, i);
  },
  setResponsibilitiesOperation(s, { input: i }) {
    editable(s, i);
    unique(i.responsibilities, "responsibility");
    s.responsibilities = i.responsibilities;
    touch(s, i);
  },
  setOperatingPolicyOperation(s, { input: i }) {
    editable(s, i);
    text(i.operatingPolicy);
    s.operatingPolicy = i.operatingPolicy;
    touch(s, i);
  },
  enableSkillOperation(s, { input: i }) {
    editable(s, i);
    ref(i.ref);
    assert(
      !s.skills.some((x) => x.ref.id === i.ref.id),
      "Skill already enabled; disable before replacing",
    );
    assert(s.skills.length < 100, "Skill limit");
    s.skills.push({ ref: i.ref, source: i.source });
    touch(s, i);
  },
  disableSkillOperation(s, { input: i }) {
    editable(s, i);
    assert(
      s.skills.some((x) => x.ref.id === i.skillId),
      "Unknown skill",
    );
    s.skills = s.skills.filter((x) => x.ref.id !== i.skillId);
    touch(s, i);
  },
  grantCapabilityOperation(s, { input: i }) {
    editable(s, i);
    const g = i.grant;
    opaque(g.id);
    opaque(g.principalId);
    opaque(g.resourceRef);
    timestamp(g.expiresAt);
    assert(g.expiresAt > i.occurredAt, "Grant already expired");
    unique(g.actions, "action");
    assert(g.actions.length > 0, "Grant requires actions");
    assert(!s.grants.some((x) => x.id === g.id), "Grant ID cannot be reused");
    assert(s.grants.length < 500, "Grant limit");
    s.grants.push({ ...g, revokedAt: null });
    touch(s, i);
  },
  revokeCapabilityOperation(s, { input: i }) {
    editable(s, i);
    const g = s.grants.find((x) => x.id === i.grantId);
    assert(g && !g.revokedAt, "Grant unavailable");
    g.revokedAt = i.occurredAt;
    touch(s, i);
  },
  bindConnectionOperation(s, { input: i }) {
    editable(s, i);
    const b = i.binding;
    [b.id, b.connectionRef, b.accountRef].forEach(opaque);
    text(b.label);
    unique(b.directions, "direction");
    assert(b.directions.length, "Connection requires direction");
    assert(!s.connections.some((x) => x.id === b.id), "Connection ID cannot be reused");
    assert(s.connections.length < 100, "Connection limit");
    s.connections.push({ ...b, revokedAt: null });
    touch(s, i);
  },
  revokeConnectionOperation(s, { input: i }) {
    editable(s, i);
    const b = s.connections.find((x) => x.id === i.connectionId);
    assert(b && !b.revokedAt, "Connection unavailable");
    b.revokedAt = i.occurredAt;
    touch(s, i);
  },
  setRuntimeBindingOperation(s, { input: i }) {
    editable(s, i);
    assert(s.desiredState === "PAUSED", "Pause before changing runtime");
    opaque(i.runtimeBindingRef);
    s.runtimeBindingRef = i.runtimeBindingRef;
    touch(s, i);
  },
  setModelPolicyOperation(s, { input: i }) {
    editable(s, i);
    modelPolicy(i.modelPolicy);
    s.modelPolicy = {
      ...i.modelPolicy,
      fallbackProvider: i.modelPolicy.fallbackProvider ?? null,
      fallbackScopeRef: i.modelPolicy.fallbackScopeRef ?? null,
      fallbackBudgetRef: i.modelPolicy.fallbackBudgetRef ?? null,
    };
    touch(s, i);
  },
  linkDocumentOperation(s, { input: i }) {
    editable(s, i);
    opaque(i.documentRef);
    assert(
      !s.documentLinks.some((x) => x.documentRef === i.documentRef),
      "Document already linked",
    );
    assert(s.documentLinks.length < 500, "Link limit");
    s.documentLinks.push({ documentRef: i.documentRef, access: i.access });
    touch(s, i);
  },
  unlinkDocumentOperation(s, { input: i }) {
    editable(s, i);
    assert(
      s.documentLinks.some((x) => x.documentRef === i.documentRef),
      "Unknown document link",
    );
    s.documentLinks = s.documentLinks.filter((x) => x.documentRef !== i.documentRef);
    touch(s, i);
  },
  bindScheduleOperation(s, { input: i }) {
    editable(s, i);
    const b = i.schedule;
    [b.id, b.schedulerRef, b.conditionRef, b.watermarkRef].forEach(opaque);
    text(b.timezone);
    assert(/^[A-Za-z_]+(?:\/[A-Za-z_+-]+)+$|^UTC$/.test(b.timezone), "Use IANA timezone");
    assert(Number.isInteger(b.maxExecutions) && b.maxExecutions > 0, "Invalid execution bound");
    if (b.lastRunRef) opaque(b.lastRunRef);
    assert(!s.schedules.some((x) => x.id === b.id), "Schedule already bound");
    assert(s.schedules.length < 100, "Schedule limit");
    s.schedules.push({ ...b, lastRunRef: b.lastRunRef ?? null });
    touch(s, i);
  },
  unbindScheduleOperation(s, { input: i }) {
    editable(s, i);
    assert(
      s.schedules.some((x) => x.id === i.scheduleId),
      "Unknown schedule",
    );
    s.schedules = s.schedules.filter((x) => x.id !== i.scheduleId);
    touch(s, i);
  },
  pinDefinitionVersionOperation(s, { input: i }) {
    editable(s, i);
    assert(s.desiredState === "PAUSED", "Pause before upgrading");
    assert(s.definitionRef, "Missing definition");
    ref(i.definitionRef);
    ref(i.migrationRef);
    ref(i.compatibilityFixtureRef);
    assert(s.definitionRef.id === i.definitionRef.id, "Cannot replace definition identity");
    newer(i.definitionRef.version, s.definitionRef.version);
    s.definitionRef = i.definitionRef;
    touch(s, i);
  },
  requestPauseOperation(s, { input: i }) {
    editable(s, i);
    assert(s.desiredState === "READY", "Instance is not ready");
    s.desiredState = "PAUSED";
    touch(s, i);
  },
  requestResumeOperation(s, { input: i }) {
    editable(s, i);
    assert(s.desiredState === "PAUSED", "Instance is not paused");
    assert(s.runtimeBindingRef, "Runtime binding required");
    s.desiredState = "READY";
    touch(s, i);
  },
  retireInstanceOperation(s, { input: i }) {
    editable(s, i);
    s.desiredState = "RETIRED";
    touch(s, i);
  },
};
