// Lean runtime step 4 test wiring: per-org kit (KitHost with the two audience roots, hosted fake provider, per-org SQLite
// spend ledger, registry double), member-scoped routines and passkey-gated actions. Fake data only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { KitHost, catalogSha256 } from "../src/agent-kit/kit-host.js";
import { openKitExecution } from "../src/agent-kit/kit-execution.js";
import { openKitChat } from "../src/agent-kit/chat.js";
import { runtimeCatalogSchema, claudeProfileFromBinding } from "../src/agent-kit/runtime-catalog.js";
import { hostedProfileSchema } from "../src/agent-kit/hosted/profile.js";
import { openHostedAdapter } from "../src/agent-kit/hosted/adapter.js";
import type { HostedProfile } from "../src/agent-kit/hosted/profile.js";
import type { HostedFetch } from "../src/agent-kit/hosted/transport.js";
import { TaskProposals } from "../src/task-delegation/proposals.js";
import { type TaskReportRequest } from "../src/task-delegation/worker-contract.js";
import { SqliteSpendLedger } from "../src/service/sqlite-effects.js";
import { orgReadTask } from "../src/org/org-tasks.js";
import { writeApprovedNotes } from "../src/org/notes.js";
import { AccessError } from "../src/access/org-access.js";
import { MemberReplies } from "../src/org/member-reply.js";
import { profileHash } from "../src/agent-kit/runtime-catalog.js";
import type { OrgCore } from "./org-fixture.js";
import type { ClaudeAdapter } from "../src/worker/execution.js";

const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const TOKEN = "synthetic-owner-credential-for-the-agent-kit-0001";
const W4 = { model: "claude-opus-5-5", credentialTeamId: "00000000-0000-4000-8000-000000000001", credentialKind: "claude-code-oauth" as const, runtime: "claude-agent-sdk" as const,
  sdkVersion: "0.2.90", cliVersion: "2.1.295", maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: "isolated" as const, thinking: "adaptive" as const, effort: "high" as const };
export const hosted = hostedProfileSchema.parse({ id: "hosted-sonnet", contract: "kapelle.restricted-execution/v3", qualificationRef: "synthetic:hosted",
  runtime: { kind: "hosted-api", locality: "remote-provider", model: "anthropic/claude-sonnet-4.6", origin: "https://openrouter.ai/api/v1", providers: ["Anthropic"],
    dataPolicy: { dataCollection: "deny", zdr: true }, contextTokens: 200000, reasoning: "off", tools: [], concurrencyLimit: 1, usage: "required" },
  harness: { kind: "hosted-openai-compatible", adapterContract: "kapelle.hosted-api-adapter/v1" },
  pricing: { version: "synthetic-2026-10", inputUsdPerMTok: 3, outputUsdPerMTok: 15, reservationMargin: 1.5 }, limits: { maxOutputTokens: 5000, maxBudgetUsd: 1, timeoutMs: 120000 } });

function registryDouble() {
  const pubs = new Map<string, any>();
  const evidence = (r: TaskReportRequest) => {
    const driveId = "synthetic-drive", documentId = randomUUID(), planDigest = hex("plan:" + r.publicationId);
    const author = { id: r.instanceId, label: "Org agent", instanceId: r.instanceId, definitionId: "org-preparer", definitionVersion: "1.0.0", definitionHash: hex("def") };
    return { documentId, driveId, reportRef: "report:task:" + r.publicationId.slice(12), sourceRef: "dispatch:" + r.dispatchId, producerId: r.instanceId, revision: 1,
      publication: { publicationId: r.publicationId, author, publisher: { id: "service:pub", label: "Publisher", instanceId: null, definitionId: null, definitionVersion: null, definitionHash: null },
        runRef: `kapelle-task://dispatch/${r.dispatchId}?input=${r.inputHash.slice(7)}`, sourceRef: "dispatch:" + r.dispatchId,
        provenanceRef: `kapelle-task://execution/${r.executionHash.slice(7)}?packet=${r.packetHash.slice(7)}`, contentHash: hex(r.markdown), contentVersion: 1,
        authorizationRef: "auth:synthetic", publishedAt: new Date().toISOString() },
      markdown: r.markdown, planDigest, verificationRef: "private-report:" + hex(JSON.stringify({ driveId, documentId, planDigest })),
      scope: { ownerId: r.ownerId, scopeRef: r.scopeRef, driveId, admissionRef: "kit-binding" } };
  };
  const port = { bindingRef: "kit-binding", admitted: async () => true,
    async publish(r: TaskReportRequest) { let e = pubs.get(r.publicationId); if (!e) { e = evidence(r); pubs.set(r.publicationId, e); } return structuredClone(e); },
    async lookup(r: TaskReportRequest) { return pubs.has(r.publicationId) ? structuredClone(pubs.get(r.publicationId)) : null; },
    async read(id: string) { return structuredClone(pubs.get(id)); } };
  return { port, pubs };
}

/** The hosted fake: a meeting draft for Task runs, a cited (or abstaining) answer for chat/reply prompts. */
export type ModelScript = (prompt: { system: string; user: string; kind: "draft" | "chat" }) => string;
export const requestsLog: { orgId: string; kind: string; user: string }[] = [];

/** Options (qualification runner): a different hosted profile; the fake answering AS that profile's provider (canonical model,
 *  first display name); a request observer; or a full fetch replacement + key file (live mode). */
/** observe may return a callback that receives the fake's response (the qualification report records status + routed provider). */
export type KitOptions = { profile?: HostedProfile; observe?: (orgId: string, url: string, init: any) => void | ((res: Response) => void); fetch?: (orgId: string) => HostedFetch; keyFile?: string; monthlyUsd?: number };
export function meetingKit(script: ModelScript, ko: KitOptions = {}) {
  const prof = ko.profile ?? hosted;
  return async (o: OrgCore) => {
    const catalog = runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [claudeProfileFromBinding("claude-current", W4, "x"), prof] });
    const catalogPath = join(o.root, "catalog.json"); writeFileSync(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
    const secret = ko.keyFile ?? join(o.root, "provider.key"); if (!ko.keyFile) writeFileSync(secret, "sk-or-v1-SYNTHETIC-NOT-A-REAL-KEY\n", { mode: 0o600 });
    const ledger = new SqliteSpendLedger(o.sqlite, { monthlyUsd: ko.monthlyUsd ?? 30 });
    const fakeFetch = async (url: string, init: any) => {
      const seen = ko.observe?.(o.orgId, url, init);
      const b = JSON.parse(init.body), system = String(b.messages[0].content), user = String(b.messages[1].content);
      const kind = system.includes("frozen copy of the agent") ? "chat" as const : "draft" as const;
      requestsLog.push({ orgId: o.orgId, kind, user });
      const res = new Response(JSON.stringify({ id: "gen-" + requestsLog.length, model: prof.runtime.responseModels?.at(-1) ?? prof.runtime.model,
        provider: (prof.runtime.providerNames ?? prof.runtime.providers)[0],
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: script({ system, user, kind }) } }], usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020, cost: 0.0045 } }),
        { status: 200, headers: { "content-type": "application/json" } });
      if (typeof seen === "function") seen(res);
      return res;
    };
    const loadHostedProvider = async () => openHostedAdapter({ profile: prof, secretFile: secret, ledger, fetch: (ko.fetch ? ko.fetch(o.orgId) : fakeFetch) as HostedFetch });
    const noClaude: ClaudeAdapter = { sdkVersion: "0.2.90", cliVersion: "2.1.295", async run() { throw Error("claude must not be used"); } };
    const reg = registryDouble(), a = o.rt.authority;
    mkdirSync(join(o.folder, "members", "notes"), { recursive: true, mode: 0o700 });
    const kit = KitHost.open({ contract: "kapelle.kit-host/v1", catalogPath, catalogSha256: catalogSha256(catalogPath), stateDir: join(o.root, "kit"), permissionRef: "task-delegation:owner",
      workspaceRoot: o.folder, scopeRoots: [
        { id: "rp", path: join(o.folder, "reviewers-private"), label: "Reviewers (private)", projects: [`${o.orgId}-reviewers`] },
        { id: "mem", path: join(o.folder, "members"), label: "Members", projects: [o.orgId] }] }, a);
    const exec = openKitExecution({ root: join(o.root, "workers"), authority: a, kit, token: () => TOKEN, loadProvider: async () => noClaude, loadHostedProvider,
      publisher: reg.port as never, checkHostPins: async () => {}, readTask: (id: string) => orgReadTask(a, id) });
    const chat = openKitChat({ kit, authority: a, root: join(o.root, "kit", "chats"), token: () => TOKEN, loadProvider: async () => noClaude, loadHostedProvider, checkHostPins: async () => {} });
    o.setKit(kit, exec);
    const mk = async (name: string, purpose: string, scope: { rootId: string; relativeDirectory: string }) => {
      const req = { kind: "generic", operationId: randomUUID(), name, purpose, instructions: "", defaultScopes: [{ kind: "folder", ...scope }], runtime: prof.id };
      return (await kit.create({ ...req, manifestHash: kit.preview(req).manifestHash })).instanceId;
    };
    const preparer = await mk("Meeting preparer", "Draft meeting notes from submitted material for reviewers.", { rootId: "rp", relativeDirectory: "intake" });
    const membersQa = await mk("Members Q&A", "Answer members' questions from approved member notes only.", { rootId: "mem", relativeDirectory: "notes" });
    const api = new TaskProposals(a);
    const reviewer = (m: { role: string }) => { if (!["admin", "reviewer"].includes(m.role)) throw new AccessError("access_role_not_permitted"); };
    // The member's conversation id is derived server-side from the member, never chosen by the client (no history crossing).
    const conversationOf = (memberId: string) => { const h = hex(`${o.orgId}:${memberId}`); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
    const principal = (memberId: string) => `member:${o.orgId}:${memberId}:v${o.access.membershipVersion()}`;
    // Shadow member replies (step 4 stage D): members audience only, no transport anywhere.
    const hostPins = { catalogProfileHash: profileHash(prof) };
    const replies = new MemberReplies(o.sqlite, { orgId: o.orgId, folder: o.folder, replyDomain: `reply.${o.orgId}.kapelle.test`,
      catalogProfileHash: () => hostPins.catalogProfileHash,
      memberActive: (id) => !!o.sqlite.db.prepare("SELECT 1 FROM access_members WHERE member_id=? AND status='active'").get(id),
      ask: async (memberId, question) => { const t = await chat.ask(membersQa, { operationId: randomUUID(), conversationId: conversationOf(memberId), question }); return t as never; },
      ledgerSessions: () => (o.sqlite.db.prepare("SELECT key FROM effects WHERE kind='hosted-inference' ORDER BY rowid").all() as { key: string }[]).map((r) => r.key) });
    return {
      routines: {
        "agent.ask": async (b: any, m: any) => chat.ask(membersQa, { operationId: randomUUID(), conversationId: conversationOf(m.memberId), question: String(b.question).slice(0, 2000) }),
        "notes.read": async () => ({ files: (await import("node:fs")).readdirSync(join(o.folder, "members", "notes")).sort() }),
        "draft.read": async (b: any, m: any) => { reviewer(m); return { markdown: reg.pubs.get(String(b.publicationId))?.markdown ?? null }; },
        "audit.read": async (_b: any, m: any) => replies.audit(m),
      },
      actions: {
        "task.adopt": async (b: any, z: any) => {
          const { documentId } = await a.allocate(z.operationId, "kilgore/task", String(b.title));
          return a.orgTaskCommand({ operationId: z.operationId, documentId, documentType: "kilgore/task", expectedRevision: 0, type: "CREATE_TASK",
            input: { id: documentId, title: String(b.title), ownerId: "owner", source: "HUMAN", sourceRef: `intake:${b.intakeId}` } }, principal(z.memberId),
            { memberId: z.memberId, action: z.action, bodyHash: z.bodyHash, operationId: z.operationId });
        },
        "proposal.approve": async (b: any, z: any) => (await api.approveAndSend(String(b.proposalId), { operationId: z.operationId, expectedRevision: b.expectedRevision, version: b.version, planHash: b.planHash })).item,
        "notes.approve": async (b: any, z: any) => writeApprovedNotes(o.folder, z, b),
        "policy.approve": async (b: any, z: any) => replies.approvePolicy(z, b),
      },
      onAccepted: (intakeId: string) => { void replies.onIntake(intakeId).catch(() => {}); },
      extra: { kit, exec, chat, api, reg, ledger, preparer, membersQa, conversationOf, replies, hostPins },
    };
  };
}

/** One full meeting cycle on one org (stage C flow), returning the people and ids for stage D. */
export async function meetingCycle(w: any, org: any, c: { meeting: string; notes: string; date: string; title: string },
  people?: { robin: any; alex: any; addr: string }) {
  const { notesDigest } = await import("../src/org/notes.js");
  if (!people) await w.bootstrap(org);
  const robin = people?.robin ?? await w.invite(org, `robin@${org.orgId}.test`, "reviewer"), alex = people?.alex ?? await w.invite(org, `alex@${org.orgId}.test`, "contributor");
  const addr = people?.addr ?? w.issueAddress(org, alex) as string;
  const d = await w.deliver(org, { to: [addr], subject: c.title, text: c.meeting });
  if (d.status !== 200) throw new Error("meeting delivery failed");
  const intakeId = (org.sqlite.db.prepare("SELECT intake_id FROM intake_records WHERE provider_event_id=?").get(d.id) as { intake_id: string }).intake_id;
  const adopted = await w.act(org, robin, "task.adopt", { intakeId, title: c.title });
  const taskId = adopted.body.result.documentId as string;
  const snap = await org.kit.snapshot({ instanceId: org.preparer, scope: { kind: "folder", rootId: "rp", relativeDirectory: "intake" } });
  const op = randomUUID(), expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const roster = await org.rt.authority.taskDelegationAgents(taskId, { operationId: op, expiresAt, instanceId: org.preparer, source: snap.source });
  const ag = roster.agents.find((x: any) => x.id === org.preparer);
  const p = (await org.api.create({ operationId: op, draft: { operationId: op, taskId, revision: roster.task.revision, agentId: org.preparer, recipient: ag.recipient, grantPlan: ag.grantPlan,
    sourceHash: roster.task.sourceHash, includeNotes: true, includeComments: false, includeReferences: false, instructions: "Draft meeting notes from the submitted material only." } }))!;
  const last = p.versions.at(-1)!;
  const approve = await w.act(org, robin, "proposal.approve", { proposalId: p.proposalId, expectedRevision: p.revision, version: last.version, planHash: last.planHash }, last.planHash, randomUUID());
  const before = org.reg.pubs.size;
  await org.exec.run(approve.body.result.dispatchId); await org.exec.drain();
  // Fail loudly with the draft run's own status and reason (a live qualification once died here on 'undefined.documentId').
  if (org.reg.pubs.size === before) {
    const st: any = await org.exec.status(approve.body.result.dispatchId).catch(() => null);
    const spend = (org.sqlite.db.prepare("SELECT state, reason FROM effects WHERE kind='hosted-inference' ORDER BY rowid DESC LIMIT 1").get() ?? null) as { state: string; reason: string | null } | null;
    throw new Error(`meeting_draft_not_published: ${st?.status ?? "no_status"}:${st?.reason ?? "no_reason"} ledger:${spend ? spend.state + ":" + (spend.reason ?? "none") : "none"}`);
  }
  const reportId = [...org.reg.pubs.values()].at(-1).documentId;
  // A reviewer must explicitly confirm notes that carry private-looking terms (e.g. the injection fixture's text).
  const { privateMarkersIn } = await import("../src/org/notes.js");
  const body = { meeting: c.date, reportId, markdown: c.notes, ...(privateMarkersIn(c.notes).length ? { acknowledgedPrivateTerms: true } : {}) };
  const notes = await w.act(org, robin, "notes.approve", body, notesDigest(c.notes));
  if (!notes.body.ok) throw new Error("notes approval failed: " + JSON.stringify(notes.body));
  return { robin, alex, addr, intakeId, taskId, dispatchId: approve.body.result.dispatchId as string };
}
