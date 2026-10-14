import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { openPublicationHost } from "../src/publication/host.js";
import { publicationArtifact, publicationProposal } from "../src/publication/manifest.js";
import { openSyntheticPublicationNative, openSyntheticPublicationTarget } from "../tests/publication-host-fixture.js";
import { managerPublicationFixture } from "../tests/manager-publication-fixture.js";
import { assert } from "../src/validation.js";

const [command, rootArg, ...extra] = process.argv.slice(2);
assert(["serve", "status", "approve", "request-changes"].includes(command) && rootArg,
  "Usage: publication-host-demo.ts serve|status|approve|request-changes PRIVATE_STATE_ROOT [comment]");
const root = resolve(rootArg), marker = join(root, "synthetic-demo.json");
const read = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"));
const save = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
if (command !== "serve") {
  assert(read("synthetic-demo.json").contract === "kapelle/synthetic-publication-demo/v1", "Not a synthetic demo");
  const descriptor = read("endpoints.json"), secrets = read("synthetic-credentials.json");
  const origin = new URL(descriptor.ownerOrigin); assert(origin.hostname === "127.0.0.1" && origin.protocol === "http:", "Only isolated loopback demo permitted");
  const get = async (path: string) => {
    const response = await fetch(new URL(path, origin), { redirect: "error", signal: AbortSignal.timeout(20000), headers: { authorization: "Bearer " + secrets.owner } });
    assert(response.ok, "Demo read unavailable"); return response.json();
  };
  if (command === "status") console.log(JSON.stringify(await get("/publication-status"), null, 2));
  else {
    const binding = read("binding.json"), doc = await get(`/documents/${binding.reviewDocumentId}?type=kapelle%2Freview-intent`);
    const pendingPath = join(root, "owner-decision.json");
    const requested = { approved: command === "approve", reason: command === "approve" ? null : extra.join(" ").trim() };
    assert(requested.approved || requested.reason, "Request changes requires a comment");
    const request = existsSync(pendingPath) ? JSON.parse(readFileSync(pendingPath, "utf8")) : { operationId: randomUUID(), documentId: binding.reviewDocumentId, documentType: "kapelle/review-intent", expectedRevision: doc.document.state.global.revision, type: "RECORD_DECISION", input: { proposalHash: binding.proposal.contentHash, proposalVersion: binding.proposal.version, ...requested } };
    assert(request.input.approved === requested.approved && request.input.reason === requested.reason, "Saved decision differs; use a fresh proposal/demo, never replace an uncertain operation");
    if (!existsSync(pendingPath)) save("owner-decision.json", request);
    const response = await fetch(new URL("/commands", origin), { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000), headers: { authorization: "Bearer " + secrets.owner, "content-type": "application/json" }, body: JSON.stringify(request) });
    const receipt = await response.json(); assert(response.ok, "Demo decision rejected: " + JSON.stringify(receipt));
    save("owner-receipt.json", receipt); console.log(JSON.stringify(receipt, null, 2));
  }
} else {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root); assert(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, "Private dedicated state directory required");
  if (!existsSync(marker)) { assert(readdirSync(root).length === 0, "Refuse unmarked existing state"); save("synthetic-demo.json", { contract: "kapelle/synthetic-publication-demo/v1", hostId: "synthetic-host-" + randomUUID() }); }
  assert(read("synthetic-demo.json").contract === "kapelle/synthetic-publication-demo/v1", "Not a synthetic demo");
  if (!existsSync(join(root, "synthetic-credentials.json"))) save("synthetic-credentials.json", Object.fromEntries(["owner", "manager", "executor", "provider"].map(key => [key, randomBytes(36).toString("base64url")])));
  const secret = (key: string) => () => read("synthetic-credentials.json")[key] as string;
  const reactorRoot = process.env.KAPELLE_SCOPED_REACTOR_ROOT, managerRoot = process.env.KAPELLE_PUBLICATION_MANAGER_ROOT;
  assert(reactorRoot && managerRoot, "Explicit qualified Reactor and Manager source roots required");
  const reportMarkdown = process.env.KAPELLE_SYNTHETIC_REPORT_FILE ? readFileSync(process.env.KAPELLE_SYNTHETIC_REPORT_FILE, "utf8") : undefined;
  const native = await openSyntheticPublicationNative(root, reactorRoot, reportMarkdown, () => new Date().toISOString());
  const manager = await managerPublicationFixture(managerRoot, native.manifest, native.ids.reviewId, native.ids.instanceId, async () => { }, join(root, "manager"));
  const target = openSyntheticPublicationTarget(join(root, "synthetic-target.sqlite"), () => {
    const row = native.authority.journal.db.prepare("SELECT binding_json FROM publication_provider_contacts LIMIT 1").get();
    return row ? JSON.parse(String(row.binding_json)) : null;
  });
  const fault = process.env.KAPELLE_SYNTHETIC_PUBLICATION_FAULT ?? "";
  assert(["", "pending", "lost-response"].includes(fault), "Unknown synthetic fault"); target.setFault(fault);
  const host = await openPublicationHost(native.authority, {
    manifest: native.manifest, reviewId: native.ids.reviewId, instanceId: native.ids.instanceId,
    brokerHostId: read("synthetic-demo.json").hostId, managerTeamId: "synthetic-team", managerAuthorityId: "synthetic-manager-stable", executorAgent: "publication-executor", managerDatabase: manager.database, managerQueue: manager.queue,
    managerToken: secret("manager"), executorToken: secret("executor"), ownerDecisionToken: secret("owner"), providerToken: secret("provider"), providerRequest: target.request, stagingReceipt: async () => target.stagingReceipt,
    assertExclusiveProjectWriter: async () => { }, readRequestSettlement: target.settlement, bindEffects: native.bindEffects, wakeOnDecision: true
  });
  save("binding.json", { schemaVersion: "kapelle.publication-review-binding.v1", reviewDocumentId: native.ids.reviewId, instanceId: native.ids.instanceId, ownerId: native.manifest.ownerId, scopeRef: native.manifest.scopeRef, artifact: publicationArtifact(native.manifest), proposal: publicationProposal(native.manifest) });
  save("report.json", { id: native.manifest.report.id, reportRef: native.manifest.report.reportRef, sourceRef: native.manifest.report.sourceRef, markdown: native.state.reportBytes.toString(), target: "Synthetic isolated website; no real publication", completedCleanupTaskReused: false });
  const report = native.manifest.report, at = new Date().toISOString();
  save("report-document.json", {
    header: { id: report.id, documentType: "kilgore/report" }, state: {
      global: {
        reportRef: report.reportRef, title: "Synthetic website approval demonstration", projectRef: "synthetic", sourceRef: report.sourceRef, revision: 1,
        producer: { kind: "AGENT", id: "synthetic", label: "Isolated approval qualification" }, lifecycle: "FINAL",
        attention: { request: "APPROVE", reason: "Review the isolated synthetic target", reviewBy: null, requestedAt: at, resolvedAt: null, resolution: null },
        review: { openedAt: at, readAt: at, feedback: [] }, content: { storage: "INLINE_MARKDOWN", mimeType: "text/markdown", filename: "synthetic-report.md", contentHash: report.contentHash.slice(7), byteSize: report.bytes, markdown: native.state.reportBytes.toString(), blobRef: null }, createdAt: at, updatedAt: at
      }
    }
  });
  save("endpoints.json", { synthetic: true, ownerOrigin: host.ownerOrigin, managerOrigin: host.managerOrigin, executorOrigin: host.executorOrigin, credentialFile: join(root, "synthetic-credentials.json"), bindingFile: join(root, "binding.json"), pid: process.pid });
  console.log(JSON.stringify({ ready: true, synthetic: true, ownerOrigin: host.ownerOrigin, bindingFile: join(root, "binding.json"), stateRoot: root, pid: process.pid }));
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await host.close(); save("last-status.json", await host.readStatus()); target.close(); manager.close(); await native.close(); process.exit(0); };
  process.on("SIGTERM", () => void close()); process.on("SIGINT", () => void close());
}
