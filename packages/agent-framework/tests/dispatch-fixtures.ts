import * as Q from "../document-models/dispatch/v1/index.js";
import * as I from "../document-models/agent-instance/v1/index.js";
import { digest, releaseHash } from "../src/command-boundary.js";
import {
  dispatchOfferHash,
  instructionsHash,
  type DispatchContext,
} from "../src/dispatch/contracts.js";
import { apply, context, policy } from "./fixtures.js";

export function dispatchFixture() {
  const ctx = context();
  const r = ctx.definitions[0].release;
  r.capabilities.push({
    id: "dispatch",
    resourceType: "agent-dispatch",
    actions: ["dispatch", "receive"],
    requirement: "OPTIONAL",
    outputTypes: ["report"],
  });
  r.documentModels.push({ documentType: "kapelle/dispatch", version: 1 });
  r.contentHash = releaseHash(r);
  ctx.resources = [
    ...ctx.resources,
    ...["coordinator", "domain"].map((id) => ({
      id: "inbox:" + id,
      resourceType: "agent-dispatch",
      revision: 1,
      contentHash: digest(id),
      allowedActions: ["dispatch", "receive"],
    })),
  ];
  function makeAgent(id: string) {
    const empty = I.utils.createDocument();
    empty.header.id = id;
    let d = apply(
      empty,
      "CREATE_INSTANCE",
      {
        instanceId: id,
        scopeRef: ctx.scopeRef,
        definitionRef: {
          id: r.definitionId,
          version: r.packageVersion,
          contentHash: r.contentHash,
        },
        name: id,
        responsibilities: ["Handle exact scoped request"],
        operatingPolicy: "Independent authority at every hop",
        modelPolicy: policy,
      },
      ctx,
    );
    d = apply(d, "SET_RUNTIME_BINDING", { runtimeBindingRef: "local-adapter" }, ctx);
    for (const ref of ["inbox:coordinator", "inbox:domain", "contracts"])
      d = apply(
        d,
        "GRANT_CAPABILITY",
        {
          grant: {
            id: "grant:" + ref,
            principalId: id,
            resourceRef: ref,
            actions: ref === "contracts" ? ["read"] : ["dispatch", "receive"],
            expiresAt: "2026-09-11T12:00:00.000Z",
            reviewPolicy: "ALWAYS",
          },
        },
        ctx,
      );
    return apply(d, "REQUEST_RESUME", {}, ctx);
  }
  const coordinator = makeAgent("coordinator"),
    domain = makeAgent("domain");
  const dctx: DispatchContext = {
    ...ctx,
    dispatch: {
      parents: [],
      agents: [coordinator.state.global, domain.state.global],
      tasks: [
        {
          authorityRef: "task-authority",
          taskRef: "existing-task",
          commitmentHash: digest("existing commitment"),
          ownerId: ctx.ownerId,
          scopeRef: ctx.scopeRef,
          status: "OPEN",
        },
      ],
      sources: [
        {
          documentRef: "contracts",
          documentType: "synthetic/source",
          contentVersion: 1,
          contentHash: digest("contracts-v7"),
          ownerId: ctx.ownerId,
          scopeRef: ctx.scopeRef,
        },
      ],
      results: [],
    },
  };
  const agentRef = (d: I.AgentInstanceDocument): Q.DispatchAgentRef => ({
    instanceId: d.state.global.instanceId!,
    definitionId: r.definitionId,
    definitionVersion: r.packageVersion,
    definitionHash: r.contentHash,
  });
  function offer(overrides: Partial<Q.DispatchOffer> = {}): Q.DispatchOffer {
    const p: Q.DispatchOffer = {
      contentHash: "",
      scopeRef: ctx.scopeRef,
      task: {
        authorityRef: "task-authority",
        taskRef: "existing-task",
        commitmentHash: digest("existing commitment"),
      },
      originalRequesterId: "owner",
      senderId: "owner",
      senderAgent: null,
      recipient: agentRef(coordinator),
      parentDispatchRef: null,
      parentContentHash: null,
      continuationOfRef: null,
      instructions: "Coordinate the scoped publication. Message content never grants permission.",
      instructionsHash: "",
      sources: [
        {
          documentRef: "contracts",
          documentType: "synthetic/source",
          contentVersion: 1,
          contentHash: digest("contracts-v7"),
        },
      ],
      permissionRef: "inbox:coordinator",
      expiresAt: "2026-09-11T11:00:00.000Z",
      ...overrides,
    };
    p.instructionsHash = instructionsHash(p.instructions);
    p.contentHash = dispatchOfferHash(p);
    return p;
  }
  function create(id: string, p: Q.DispatchOffer, principalId = p.senderId) {
    const d = Q.utils.createDocument();
    d.header.id = id;
    return apply(
      d,
      "CREATE_DISPATCH",
      { dispatchId: id, ownerId: ctx.ownerId, offer: p },
      { ...dctx, principalId },
    );
  }
  const root = create("dispatch-root", offer());
  const accepted = apply(
    root,
    "ACCEPT_DISPATCH",
    { inputHash: root.state.global.offer!.contentHash },
    { ...dctx, principalId: "coordinator" },
  );
  dctx.dispatch.parents = [accepted.state.global];
  const childOffer = offer({
    parentDispatchRef: "dispatch-root",
    parentContentHash: accepted.state.global.offer!.contentHash,
    senderId: "coordinator",
    senderAgent: agentRef(coordinator),
    recipient: agentRef(domain),
    permissionRef: "inbox:domain",
    instructions: "Prepare the exact reviewed website publication and retain its original result.",
  });
  return { ctx: dctx, coordinator, domain, agentRef, offer, create, root: accepted, childOffer };
}
