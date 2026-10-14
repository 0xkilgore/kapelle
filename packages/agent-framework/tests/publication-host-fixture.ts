import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonical, digest, releaseHash, type ModelType } from "../src/command-boundary.js";
import { assert } from "../src/validation.js";
import { openFrameworkRuntime } from "../src/service/runtime.js";
import { publicationManifest, bytesHash, type PublicationManifest } from "../src/publication/manifest.js";
import { PublicationFactsAdapter } from "../src/publication/facts.js";
import { publicationEffectFacts, websiteEffectPolicy, type PublicationDispatch, type PublicationProvider, type DispatchBinding } from "../src/publication/effects.js";
import { publicationReviewPlan } from "../src/publication/provision.js";
import { dispatchOfferHash, instructionsHash } from "../src/dispatch/contracts.js";
import type { DispatchOffer } from "../document-models/dispatch/v1/index.js";
import type { PublicationSettlement } from "../src/publication/project-hold.js";
import { publicationFixture } from "./publication-fixtures.js";
import { vercelProviderFixture } from "./vercel-provider-fixture.js";
import { policy } from "./fixtures.js";

/** Retained synthetic Task/Report/source/build facts. Native definitions, agents,
 * independent grants, two-level Dispatch lineage and ReviewIntent are real scoped
 * Reactor documents. Never reads live authorities or credentials. */
export async function openSyntheticPublicationNative(root: string, reactorRoot: string, reportMarkdown?: string, clock?: () => string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const metaPath = join(root, "synthetic-binding.json"), f = publicationFixture("dpl_new", true);
  const reportPath = join(root, "synthetic-report.md");
  if (!existsSync(reportPath)) writeFileSync(reportPath, reportMarkdown ?? "# Synthetic website publication\n\nThis decision controls only an isolated synthetic website.\n\nTarget: https://www.synthetic.test\n\nApprove publishing the retained synthetic page, or request changes with a comment. No real website or completed cleanup Task is involved.\n", { mode: 0o600, flag: "wx" });
  f.state.reportBytes = readFileSync(reportPath);
  assert(f.state.reportBytes.length > 0 && f.state.reportBytes.length < 1000000, "Bounded synthetic report required");
  let ids: any = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
  let manifest: PublicationManifest = ids?.manifest ?? publicationManifest({ ...f.m, report: { ...f.m.report, id: "85c99552-7b30-4e62-9d71-93b4bdc68f03", contentHash: bytesHash(f.state.reportBytes), bytes: f.state.reportBytes.length } });
  if (!ids && clock) manifest = publicationManifest({ ...manifest, expiresAt: new Date(Date.parse(clock()) + 24 * 60 * 60 * 1000).toISOString() });
  assert(manifest.report.contentHash === bytesHash(f.state.reportBytes), "Retained synthetic report changed");
  let ports: { dispatch: PublicationDispatch; provider: PublicationProvider } | undefined;
  let adapter: PublicationFactsAdapter | undefined;
  let runtime: Awaited<ReturnType<typeof openFrameworkRuntime>>;
  const release = f.ctx.definitions[0].release;
  release.capabilities.push({ id: "dispatch", resourceType: "agent-dispatch", actions: ["dispatch", "receive"], requirement: "OPTIONAL", outputTypes: ["report"] },
    { id: "task", resourceType: "task", actions: ["read"], requirement: "OPTIONAL", outputTypes: ["report"] });
  release.documentModels.push({ documentType: "kapelle/dispatch", version: 1 }); release.contentHash = releaseHash(release);
  const task = {
    authorityRef: f.m.task.authorityRef, taskRef: f.m.task.authorityTaskRef, ownerId: f.m.ownerId,
    scopeRef: f.m.scopeRef, commitmentHash: f.m.task.commitmentHash, status: "OPEN" as const
  };
  const source = { documentRef: task.taskRef, documentType: "kilgore/task", ownerId: task.ownerId, scopeRef: task.scopeRef, contentVersion: 1, contentHash: task.commitmentHash };
  const base = () => ({
    ...f.ctx, artifacts: [], effects: [], deliveryReceipts: [], resources: [
      { id: "inbox:coordinator", resourceType: "agent-dispatch", revision: 1, contentHash: digest("coordinator"), allowedActions: ["dispatch", "receive"] },
      { id: "inbox:publisher", resourceType: "agent-dispatch", revision: 1, contentHash: digest("publisher"), allowedActions: ["dispatch", "receive"] },
      { id: task.taskRef, resourceType: "task", revision: 1, contentHash: task.commitmentHash, allowedActions: ["read"] },
      ...(!adapter ? [{ id: f.m.target.bindingRef, resourceType: "website", revision: 1, contentHash: digest(f.m.target), allowedActions: ["read", "publish"] }] : [])],
    dispatch: { tasks: [task], sources: [source], agents: [], parents: [], results: [] }
  });
  const emptyDispatch: PublicationDispatch = { read: async () => null, ensure: async () => { throw Error("Host not bound"); } };
  const emptyProvider = {} as PublicationProvider;
  const now = () => clock?.() ?? f.state.now;
  const options = {
    stateRoot: join(root, "native"), reactorRoot, ownerId: f.m.ownerId, scopeRef: f.m.scopeRef, now,
    effectPolicy: async (...args: Parameters<ReturnType<typeof websiteEffectPolicy>>) => {
      assert(ids && runtime, "Host binding unavailable"); await websiteEffectPolicy(manifest, ids.instanceId, runtime.authority.backend)(...args);
    }, facts: async () => adapter ? publicationEffectFacts(base(), adapter, ids.reviewId, ids.instanceId, ports?.dispatch ?? emptyDispatch, ports?.provider ?? emptyProvider) : base()
  };
  const makeAdapter = () => new PublicationFactsAdapter(manifest, {
    report: async (id) => ({ id, ownerId: manifest.ownerId, scopeRef: manifest.scopeRef, reportRef: manifest.report.reportRef, sourceRef: manifest.report.sourceRef, bytes: f.state.reportBytes, revision: 2 }),
    source: async (expected) => assert(!f.state.sourceError && canonical(expected) === canonical(f.m.source), "Synthetic source changed"),
    build: async () => f.state.build, staging: async () => f.state.staging, target: async () => f.state.target,
    task: async () => ({ ...manifest.task, ownerId: manifest.ownerId, scopeRef: manifest.scopeRef })
  }, now);
  if (ids) adapter = makeAdapter();
  runtime = await openFrameworkRuntime(options);
  let n = 0;
  const command = async (id: string, type: ModelType, name: string, input: Record<string, unknown>, actor = "owner") => {
    const d = await runtime.authority.read(id, type), c = { operationId: `synthetic-host-${name}-${Date.now()}-${n++}`, documentId: id, documentType: type, expectedRevision: d.state.global.revision, type: name, input };
    const receipt = actor === "owner" ? await runtime.authority.command(c) : await runtime.authority.dispatchCommand(c, actor);
    assert(receipt.result.disposition === "ACCEPTED", "Synthetic provisioning rejected: " + JSON.stringify(receipt.result)); return c;
  };
  const allocate = async (type: ModelType, version = 1) => (await runtime.authority.allocate(`synthetic-host-allocation-${n++}`, type, "Isolated approval qualification", version)).documentId;
  if (!ids) {
    const definition = await allocate("kapelle/agent-definition"); await command(definition, "kapelle/agent-definition", "PUBLISH_DEFINITION", { release });
    const install = async () => {
      const id = await allocate("kapelle/agent-instance"); await command(id, "kapelle/agent-instance", "CREATE_INSTANCE", { instanceId: id, scopeRef: f.m.scopeRef, definitionRef: { id: release.definitionId, version: release.packageVersion, contentHash: release.contentHash }, name: "Synthetic publication worker", responsibilities: ["Exact reviewed synthetic publication"], operatingPolicy: "No inherited approval", modelPolicy: policy });
      await command(id, "kapelle/agent-instance", "SET_RUNTIME_BINDING", { runtimeBindingRef: "local-adapter" });
      for (const ref of ["inbox:coordinator", "inbox:publisher", task.taskRef, f.m.target.bindingRef]) await command(id, "kapelle/agent-instance", "GRANT_CAPABILITY", { grant: { id: "grant:" + ref, principalId: id, resourceRef: ref, actions: ref === task.taskRef ? ["read"] : ref === f.m.target.bindingRef ? ["read", "publish"] : ["dispatch", "receive"], expiresAt: manifest.expiresAt, reviewPolicy: "ALWAYS" } });
      await command(id, "kapelle/agent-instance", "REQUEST_RESUME", {});
      return { instanceId: id, definitionId: release.definitionId, definitionVersion: release.packageVersion, definitionHash: release.contentHash };
    };
    const coordinator = await install(), publisher = await install();
    const offer = (overrides: Partial<DispatchOffer>): DispatchOffer => {
      const input: DispatchOffer = { scopeRef: f.m.scopeRef, contentHash: "", task: { authorityRef: task.authorityRef, taskRef: task.taskRef, commitmentHash: task.commitmentHash }, originalRequesterId: "owner", senderId: "owner", senderAgent: null, recipient: coordinator, parentDispatchRef: null, parentContentHash: null, continuationOfRef: null, instructions: "Prepare a synthetic website publication; separate owner approval required.", instructionsHash: "", sources: [{ documentRef: source.documentRef, documentType: source.documentType, contentVersion: source.contentVersion, contentHash: source.contentHash }], permissionRef: "inbox:coordinator", expiresAt: manifest.expiresAt, ...overrides };
      input.instructionsHash = instructionsHash(input.instructions); input.contentHash = dispatchOfferHash(input); return input;
    };
    const parentId = await allocate("kapelle/dispatch"), parent = offer({});
    await command(parentId, "kapelle/dispatch", "CREATE_DISPATCH", { dispatchId: parentId, ownerId: "owner", offer: parent });
    await command(parentId, "kapelle/dispatch", "ACCEPT_DISPATCH", { inputHash: parent.contentHash }, coordinator.instanceId);
    const childId = await allocate("kapelle/dispatch"), child = offer({ senderId: coordinator.instanceId, senderAgent: coordinator, recipient: publisher, parentDispatchRef: parentId, parentContentHash: parent.contentHash, permissionRef: "inbox:publisher" });
    await command(childId, "kapelle/dispatch", "CREATE_DISPATCH", { dispatchId: childId, ownerId: "owner", offer: child }, coordinator.instanceId);
    await command(childId, "kapelle/dispatch", "ACCEPT_DISPATCH", { inputHash: child.contentHash }, publisher.instanceId);
    manifest = publicationManifest({ ...manifest, originDispatch: { documentId: childId, contentHash: child.contentHash } });
    const plan = publicationReviewPlan(manifest), reviewId = (await runtime.authority.allocate(plan.allocation.operationId, plan.allocation.documentType, plan.allocation.name, 2)).documentId;
    ids = { manifest, reviewId, instanceId: publisher.instanceId, parentId, childId, coordinatorId: coordinator.instanceId };
    adapter = makeAdapter(); assert((await runtime.authority.command(plan.createReview(reviewId, publisher.instanceId))).result.disposition === "ACCEPTED", "Review rejected");
    writeFileSync(metaPath, JSON.stringify(ids, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
  return {
    manifest, ids, state: f.state, command, get authority() { return runtime.authority; },
    bindEffects: (value: NonNullable<typeof ports>) => { ports = value; },
    async restart() { ports = undefined; await runtime.close(); runtime = await openFrameworkRuntime(options); },
    close: () => runtime.close()
  };
}

/** A SYNTHETIC counterexample provider with immutable per-request terminal
 * receipts committed atomically with its target change. Vercel does not supply
 * this oracle. No network request leaves this function. */
export function openSyntheticPublicationTarget(path: string, binding: () => DispatchBinding | null) {
  const fake = vercelProviderFixture(true), db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS requests(operation_id TEXT PRIMARY KEY,binding_json TEXT NOT NULL,proof_json TEXT,state TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS target(singleton INTEGER PRIMARY KEY CHECK(singleton=1),published INTEGER NOT NULL);
 INSERT OR IGNORE INTO target VALUES(1,0);`);
  let fault = "";
  const refresh = () => { fake.state.published = Boolean(db.prepare("SELECT published FROM target WHERE singleton=1").get()!.published); };
  const request: typeof fetch = async (input, init) => {
    refresh(); if (init?.method !== "POST") return fake.request(input, init);
    const b = binding(); assert(b, "Synthetic provider requires exact retained operation");
    const prior = db.prepare("SELECT * FROM requests WHERE operation_id=?").get(b.operationId);
    assert(!prior, "Synthetic provider duplicate contact");
    const proof: PublicationSettlement = { contract: "kapelle/publication-settlement/v1", operationId: b.operationId, bindingHash: digest(b), teamId: fake.m.target.teamId, projectId: fake.m.target.projectId, deploymentId: "dpl_new", outcome: "COMPLETED", proofRef: "synthetic-terminal:" + digest(b).slice(7), proofHash: digest({ b, terminal: true, target: "dpl_new" }) };
    db.exec("BEGIN IMMEDIATE"); try {
      db.prepare("INSERT INTO requests VALUES(?,?,?,?)").run(b.operationId, canonical(b), fault === "pending" ? null : canonical(proof), fault === "pending" ? "PENDING" : "COMPLETED");
      if (fault !== "pending") db.prepare("UPDATE target SET published=1 WHERE singleton=1").run();
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    fake.state.posts++;
    if (fault === "pending" || fault === "lost-response") throw Error("Synthetic lost provider acknowledgement");
    return new Response(null, { status: 202 });
  };
  return {
    request, stagingReceipt: fake.stagingReceipt, setFault: (value: string) => { fault = value; },
    posts: () => Number(db.prepare("SELECT COUNT(*) AS n FROM requests").get()!.n),
    async settlement(b: DispatchBinding) {
      const row = db.prepare("SELECT * FROM requests WHERE operation_id=?").get(b.operationId);
      if (!row) return null; assert(row.binding_json === canonical(b), "Synthetic receipt binding differs"); return row.proof_json ? JSON.parse(String(row.proof_json)) as PublicationSettlement : null;
    },
    /** Models an independent Owner publishing identical bytes while our request is pending. */
    observeSameCandidate: () => db.prepare("UPDATE target SET published=1 WHERE singleton=1").run(),
    close: () => db.close()
  };
}
