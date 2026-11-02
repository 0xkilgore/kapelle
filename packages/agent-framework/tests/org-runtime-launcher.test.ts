// Lean runtime build item (a): org runtime + hub as services from config files. Two orgs, the hub with a mail spool,
// Ops-socket bootstrap (never via the hub), login through the spooled link, signed email ingress, restart sweeps, and
// config refusals. Fake provider (injected fetch), fake mail; no network beyond loopback and Unix sockets.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { request } from "node:http";
import { openOrgRuntime } from "../src/org/org-runtime.js";
import { backupOrg, restoreOrgBackup } from "../src/org/org-backup.js";
import { requestIdentity, applyNative } from "../src/command-boundary.js";
import * as ReviewV3 from "../document-models/review-intent/v3/index.js";
import { openHub } from "../src/hub/hub-launcher.js";
import { signWebhook } from "../src/org/intake.js";
import { runtimeCatalogSchema, claudeProfileFromBinding } from "../src/agent-kit/runtime-catalog.js";
import { catalogSha256 } from "../src/agent-kit/kit-host.js";
import { hosted } from "./org-meeting-kit.js";
import { RP, ORIGIN } from "./soft-authenticator.js";
import { policyHash, type ReplyPolicy } from "../src/org/member-reply.js";
import { ACCESS_TABLE_HASH, bodyHash, envelopeBytes } from "../src/access/org-access.js";
import { READER_POLICY_HASH } from "../src/agent-kit/scope-assembler.js";
import { profileHash } from "../src/agent-kit/runtime-catalog.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const dir = (p: string, parent = "/tmp") => { const d = realpathSync(mkdtempSync(join(parent, p))); chmodSync(d, 0o700); return d; };
const sub = (root: string, name: string) => { const d = join(root, name); mkdirSync(d, { mode: 0o700 }); return d; };
const file = (path: string, content: string) => { writeFileSync(path, content, { mode: 0o600 }); return path; };
const W4 = { model: "claude-opus-5-5", credentialTeamId: "00000000-0000-4000-8000-000000000001", credentialKind: "claude-code-oauth" as const, runtime: "claude-agent-sdk" as const,
  sdkVersion: "0.2.90", cliVersion: "2.1.295", maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: "isolated" as const, thinking: "adaptive" as const, effort: "high" as const };
const ops = (socket: string, route: string, body: unknown = {}): Promise<any> => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(body));
  const r = request({ socketPath: socket, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
    const c: Buffer[] = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve(JSON.parse(Buffer.concat(c).toString())));
  });
  r.on("error", reject); r.end(data);
});
let providerDown = false; // N-4: flipped to make the provider refuse (HTTP 503) for one run
const fakeFetch = async () => providerDown ? new Response(JSON.stringify({ error: { code: 503, message: "unavailable" } }), { status: 503, headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ id: "gen-1", model: "anthropic/claude-sonnet-4.6", provider: "Anthropic",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: "The member notes do not say." } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001 } }),
  { status: 200, headers: { "content-type": "application/json" } });

function orgConfig(base: string, orgId: string) {
  const root = sub(base, orgId), state = sub(root, "state"), folder = sub(root, "folder"), run = sub(root, "run"), opsDir = sub(root, "ops"), secrets = sub(root, "secrets");
  const catalog = runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [claudeProfileFromBinding("claude-current", W4, "x"), hosted] });
  const catalogPath = file(join(root, "catalog.json"), JSON.stringify(catalog));
  const secret = randomBytes(24).toString("base64url");
  return { secret, config: { contract: "kapelle.org-runtime/v1", orgId, label: `${orgId} demo`, stateRoot: state, folder, accessSocket: join(run, "access.sock"), opsSocket: join(opsDir, "ops.sock"),
    rpId: RP, origins: [ORIGIN], installations: [{ installationId: `inst-${orgId}`, domain: `${orgId}.in.kapelle.test`, secretFile: file(join(secrets, "webhook"), secret) }],
    catalogPath, catalogSha256: catalogSha256(catalogPath), hostedProfileId: "hosted-sonnet",
    hosted: { secretFile: file(join(secrets, "provider.key"), "sk-or-v1-SYNTHETIC-NOT-A-REAL-KEY"), monthlyUsd: 20 }, replyDomain: `reply.${orgId}.kapelle.test` } };
}

describe.skipIf(!enabled)("org runtime + hub launchers (build item a)", () => {
  it("start from config, bootstrap over Ops only, login via spool, ingest, restart with sweeps, refuse bad configs", async () => {
    const base = dir("k5-"), hubDir = sub(base, "hub"), spool = sub(hubDir, "spool"), keys = sub(hubDir, "keys");
    const A = orgConfig(base, "org-a"), B = orgConfig(base, "org-b");
    // Config refusals first: ops socket beside the access socket; a catalog whose pin does not match; a Dropbox path.
    await expect(openOrgRuntime({ ...A.config, opsSocket: join(A.config.accessSocket, "..", "ops.sock") }, { fetchImpl: fakeFetch as never })).rejects.toThrow("org_ops_socket_must_be_separate");
    await expect(openOrgRuntime({ ...A.config, catalogSha256: "0".repeat(64) }, { fetchImpl: fakeFetch as never })).rejects.toThrow("org_catalog_pin_mismatch");
    await expect(openOrgRuntime({ ...A.config, folder: "/Users/x/Dropbox/org" }, { fetchImpl: fakeFetch as never })).rejects.toThrow();

    let orgA = await openOrgRuntime(A.config, { fetchImpl: fakeFetch as never });
    const orgB = await openOrgRuntime(B.config, { fetchImpl: fakeFetch as never });
    let hub: Awaited<ReturnType<typeof openHub>> | null = null;
    try {
      expect(orgA.swept).toEqual({ orphans: [], replies: [] });
      expect(readdirSync(A.config.folder).sort()).toEqual(["members", "reviewers-private"]);
      // Per-org envelope keys are installed at the runtime over the Ops socket; the hub gets only the private key file.
      const hubOrgs = [];
      for (const [o, cfg] of [[orgA, A.config], [orgB, B.config]] as const) {
        const kp = generateKeyPairSync("ed25519");
        expect(await ops(cfg.opsSocket, "/ops/envelope-key/add", { kid: "k1", publicJwk: kp.publicKey.export({ format: "jwk" }) })).toMatchObject({ ok: true });
        hubOrgs.push({ orgId: cfg.orgId, installationId: o.sqlite.identity.installationId, accessSocket: cfg.accessSocket, kid: "k1",
          keyFile: file(join(keys, `${cfg.orgId}.pem`), kp.privateKey.export({ format: "pem", type: "pkcs8" }) as string), origin: ORIGIN });
      }
      hub = await openHub({ contract: "kapelle.hub/v1", listen: { host: "127.0.0.1", port: 0 }, mailSpool: spool, orgs: hubOrgs,
        ingress: [{ installationId: "inst-org-a", orgId: "org-a", secretFile: A.config.installations[0].secretFile }, { installationId: "inst-org-b", orgId: "org-b", secretFile: B.config.installations[0].secretFile }] });
      const url = `http://127.0.0.1:${hub.port}`;
      // R-5 / option A: the first admin's one-time link comes from the Ops socket (the passkey enrolment routes are gone); the
      // hub has no route to any Ops action. Joining through the hub admits them.
      for (const r of ["/ops/bootstrap/begin", "/ops/bootstrap/complete"]) expect(await ops(A.config.opsSocket, r, { email: "admin@org-a.test" }), r).toEqual({ ok: false, error: "ops_route" });
      const boot = await ops(A.config.opsSocket, "/ops/bootstrap/invite", { email: "admin@org-a.test" });
      const joinAt = async (link: string) => (await fetch(`${url}/o/org-a/invite/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(link).hash.replace(/^#token=/, "") }) })).json() as Promise<any>;
      expect(await joinAt(boot.link)).toMatchObject({ ok: true, role: "admin" });
      expect([401, 404]).toContain((await fetch(`${url}/o/org-a/ops/bootstrap/invite`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
      expect(JSON.stringify(hubOrgs)).not.toContain("ops.sock");
      // Login through the spooled magic link.
      expect((await fetch(`${url}/o/org-a/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@org-a.test" }) })).status).toBe(202);
      await new Promise((r) => setTimeout(r, 20));
      const mails = readdirSync(spool).map((f) => JSON.parse(readFileSync(join(spool, f), "utf8")));
      expect(mails).toHaveLength(1);
      for (const f of readdirSync(spool)) expect(statMode(join(spool, f))).toBe(0o600);
      const magic = await fetch(`${url}/o/org-a/magic?token=${new URL(mails[0].link).searchParams.get("token")}`);
      const cookie = (magic.headers.get("set-cookie") ?? "").split(";")[0];
      // Option A: a submission address is `totp` tier: refused in the app, issued by Ops.
      expect(await (await fetch(`${url}/o/org-a/api/intake/token/issue`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" })).json()).toEqual({ ok: false, error: "access_step_up_required" });
      const issue = { result: await ops(A.config.opsSocket, "/ops/intake/token/issue", { email: "admin@org-a.test" }) };
      expect(issue.result).toMatchObject({ ok: true, email: "admin@org-a.test", address: expect.stringMatching(/@org-a\.in\.kapelle\.test$/) });
      expect(await ops(A.config.opsSocket, "/ops/intake/token/issue", { email: "nobody@org-a.test" })).toEqual({ ok: false, error: "access_member_unknown" });
      // Even a logged-in admin has no hub route to any Ops action.
      for (const r of ["ops/bootstrap/invite", "ops/member/invite", "ops/policy/approve", "ops/envelope-key/add", "ops/status"])
        expect((await fetch(`${url}/o/org-a/${r}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" })).status, r).toBe(404);
      // Signed email through the hub's ingress into org A only.
      const id = "msg_launcher_0001", ts = String(Math.floor(Date.now() / 1000));
      const raw = JSON.stringify({ type: "email.received", data: { email_id: id, message_id: "<x@sender.test>", from: "a@sender.test", to: [issue.result.address], subject: "Notes", text: "hello" } });
      const ing = await fetch(`${url}/ingress/email/inst-org-a`, { method: "POST", headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": signWebhook(A.secret, "inst-org-a", id, ts, raw) }, body: raw });
      expect(ing.status).toBe(200);
      expect(orgA.sqlite.db.prepare("SELECT state FROM intake_records WHERE provider_event_id=?").get(id)).toEqual({ state: "accepted" });
      expect(orgB.sqlite.db.prepare("SELECT COUNT(*) AS n FROM intake_records").get()).toEqual({ n: 0 });
      // The full cycle through the service: intake list -> passkey adopt (twice: one Task) -> plan.prepare -> passkey
      // approve -> background run publishes to the ORG report store -> draft list/read -> passkey notes -> notes read.
      const api = async (path: string, body: unknown = {}) => (await fetch(`${url}/o/org-a/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) })).json() as Promise<any>;
      let opn = 0;
      const act = async (action: string, body: unknown, artifactDigest: string | null = null, operationId = `op-${action}-${String(++opn).padStart(8, "0")}`) => {
        const ch = await api("challenge", { action, body, artifactDigest, operationId });
        return api("act", { challengeId: ch.challengeId, action, body, artifactDigest, operationId });
      };
      const intakes = (await api("api/intake/list")).result.intakes;
      expect(intakes).toEqual([expect.objectContaining({ intakeId: expect.stringMatching(/^intake_/), subject: "Notes", from: "admin@org-a.test", adoptedTaskId: null })]);
      const adopt = await act("task.adopt", { intakeId: intakes[0].intakeId, title: "Notes" });
      expect(adopt.ok, JSON.stringify(adopt)).toBe(true);
      expect(adopt.result.result.disposition).toBe("ACCEPTED");
      expect((await act("task.adopt", { intakeId: intakes[0].intakeId, title: "Notes" })).error).toBe("adopt_already_adopted");
      expect(await orgA.rt.authority.backend.list("kilgore/task")).toHaveLength(1);
      expect((await api("api/intake/list")).result.intakes[0].adoptedTaskId).toBe(adopt.result.taskId);
      const plan = (await api("api/plan/prepare", { taskId: adopt.result.taskId })).result;
      expect(plan.planHash).toMatch(/^sha256:/);
      // A-1: the passkey's artifact digest must BE the plan hash being approved (no digest, or another, is refused).
      const planBody = { proposalId: plan.proposalId, expectedRevision: plan.expectedRevision, version: plan.version, planHash: plan.planHash };
      expect((await act("proposal.approve", planBody, null)).error).toBe("approve_plan_digest_mismatch");
      expect((await act("proposal.approve", planBody, "sha256:" + "0".repeat(64))).error).toBe("approve_plan_digest_mismatch");
      // N-3: preparing again over the same material returns the same unapproved plan (no duplicate proposal).
      expect((await api("api/plan/prepare", { taskId: adopt.result.taskId })).result).toEqual(plan);
      const approved = await act("proposal.approve", { proposalId: plan.proposalId, expectedRevision: plan.expectedRevision, version: plan.version, planHash: plan.planHash }, plan.planHash, crypto.randomUUID());
      expect(approved.ok, JSON.stringify(approved)).toBe(true);
      let drafts: any[] = [];
      for (let i = 0; i < 200 && !drafts.length; i++) { drafts = (await api("api/draft/list")).result.drafts; if (!drafts.length) await new Promise((r) => setTimeout(r, 25)); }
      expect(drafts).toEqual([expect.objectContaining({ taskId: adopt.result.taskId })]);
      expect((await api("api/draft/read", { documentId: drafts[0].documentId })).result.document.markdown).toBe("The member notes do not say.");
      // B1 (attribution, shadow trial): the draft and the approvals view name the approving member from the recorded
      // Authorization, joined on the approval operationId and checked against the native approval's plan hash; option A
      // control 5: and how it was made (authn).
      const memberVersion = (await ops(A.config.opsSocket, "/ops/status")).membershipVersion;
      expect(drafts[0].approvedBy).toEqual({ email: "admin@org-a.test", membershipVersion: memberVersion, planHash: plan.planHash, approvedAt: expect.any(String), authn: "email-session" });
      const approvalsNow = (await api("api/approval/list")).result.approvals;
      expect(approvalsNow.filter((x: any) => x.matched)).toEqual([expect.objectContaining({ proposalId: plan.proposalId, taskId: adopt.result.taskId, title: "Notes", dispatchId: approved.result.dispatchId,
        planHash: plan.planHash, artifactDigest: plan.planHash, authn: "email-session", approvedBy: { memberId: expect.stringMatching(/^m-/), email: "admin@org-a.test", membershipVersion: memberVersion } })]);
      const { notesDigest } = await import("../src/org/notes.js");
      const md = "# Notes\nThe cleanup is on Saturday Oct 31.\n";
      // N-2: notes must link to a real private draft.
      expect((await act("notes.approve", { meeting: "2026-10-08", reportId: crypto.randomUUID(), markdown: md }, notesDigest(md))).error).toBe("notes_report_unknown");
      expect((await act("notes.approve", { meeting: "2026-10-08", reportId: drafts[0].documentId, markdown: md }, notesDigest(md))).result).toMatchObject({ version: 1 });
      expect((await api("api/notes/read")).result.files).toEqual(["2026-10-08.v1.md"]);
      expect((await api("api/notes/get", { file: "2026-10-08.v1.md" })).result.markdown).toBe(md);
      expect((await api("api/notes/get", { file: "../../state/authority/authority.sqlite" })).error).toBe("notes_file_invalid");
      // N-4: a background run that ends without a published draft is audited and counted (here: the provider is down).
      const id2 = "msg_launcher_0002", ts2 = String(Math.floor(Date.now() / 1000));
      const raw2 = JSON.stringify({ type: "email.received", data: { email_id: id2, message_id: "<y@sender.test>", from: "a@sender.test", to: [issue.result.address], subject: "Second", text: "more" } });
      expect((await fetch(`${url}/ingress/email/inst-org-a`, { method: "POST", headers: { "webhook-id": id2, "webhook-timestamp": ts2, "webhook-signature": signWebhook(A.secret, "inst-org-a", id2, ts2, raw2) }, body: raw2 })).status).toBe(200);
      const second = (await api("api/intake/list")).result.intakes.find((i: any) => i.subject === "Second");
      const adopt2 = await act("task.adopt", { intakeId: second.intakeId, title: "Second" });
      const plan2 = (await api("api/plan/prepare", { taskId: adopt2.result.taskId })).result;
      providerDown = true;
      expect((await act("proposal.approve", { proposalId: plan2.proposalId, expectedRevision: plan2.expectedRevision, version: plan2.version, planHash: plan2.planHash }, plan2.planHash, crypto.randomUUID()))).toMatchObject({ ok: true });
      let failures = 0;
      for (let i = 0; i < 200 && !failures; i++) { failures = (await ops(A.config.opsSocket, "/ops/status")).draftRunFailures; if (!failures) await new Promise((r) => setTimeout(r, 25)); }
      expect(failures).toBe(1);
      expect(orgA.sqlite.db.prepare("SELECT detail FROM intake_audit WHERE event='draft_run_failed'").get()).toEqual({ detail: expect.stringMatching(/^EXECUTION_(REJECTED|UNCERTAIN)(:[a-z0-9_]+)?$/) });
      providerDown = false;
      // The pinned catalog changed under the running runtime: a fixed refusal (UI words), never an internal error.
      const id3 = "msg_launcher_0003", ts3 = String(Math.floor(Date.now() / 1000));
      const raw3 = JSON.stringify({ type: "email.received", data: { email_id: id3, message_id: "<z@sender.test>", from: "a@sender.test", to: [issue.result.address], subject: "Third", text: "again" } });
      expect((await fetch(`${url}/ingress/email/inst-org-a`, { method: "POST", headers: { "webhook-id": id3, "webhook-timestamp": ts3, "webhook-signature": signWebhook(A.secret, "inst-org-a", id3, ts3, raw3) }, body: raw3 })).status).toBe(200);
      const adopt3 = await act("task.adopt", { intakeId: (await api("api/intake/list")).result.intakes.find((i: any) => i.subject === "Third").intakeId, title: "Third" });
      const plan3 = (await api("api/plan/prepare", { taskId: adopt3.result.taskId })).result;
      const catalogBytes = readFileSync(A.config.catalogPath);
      writeFileSync(A.config.catalogPath, Buffer.concat([catalogBytes, Buffer.from("\n")]));
      expect(await act("proposal.approve", { proposalId: plan3.proposalId, expectedRevision: plan3.expectedRevision, version: plan3.version, planHash: plan3.planHash }, plan3.planHash, crypto.randomUUID()))
        .toEqual({ ok: false, error: "setup_changed" });
      expect(await api("api/agent/ask", { question: "When is the cleanup?" })).toMatchObject({ ok: true, result: { answer: null, reason: expect.any(String) } }); // chat records a refused turn
      writeFileSync(A.config.catalogPath, catalogBytes);
      // B4: a member principal cannot approve under review-intent v3, at every layer: the command boundary admits only the
      // owner for review-intent, the org entry point is Task-only, and the v3 reducer itself binds owner == actor.
      const memberId = approvalsNow.find((x: any) => x.matched).approvedBy.memberId, member = `member:org-a:${memberId}:v${memberVersion}`;
      const approveCmd = { operationId: crypto.randomUUID(), documentId: plan3.proposalId, documentType: "kapelle/review-intent", expectedRevision: plan3.expectedRevision,
        type: "APPROVE_TASK_PROPOSAL", input: { version: plan3.version, planHash: plan3.planHash, operationId: crypto.randomUUID(), dispatchId: crypto.randomUUID() } };
      expect(() => requestIdentity(approveCmd, { principalId: member, ownerId: "owner", scopeRef: "org-a" })).toThrow("Authenticated owner required");
      expect(() => orgA.rt.authority.orgTaskCommand(approveCmd, member)).toThrow("org_task_command_only");
      const proposalDoc = (await orgA.rt.authority.backend.read(plan3.proposalId, "kapelle/review-intent")).document as any;
      const approveAs = (actorId: string) => ReviewV3.actions.APPROVE_TASK_PROPOSAL({ actorId, occurredAt: new Date().toISOString(), expectedRevision: plan3.expectedRevision,
        version: plan3.version, planHash: plan3.planHash, operationId: crypto.randomUUID(), dispatchId: crypto.randomUUID() });
      expect(() => applyNative(proposalDoc, approveAs(member) as never)).toThrow("Task proposal owner differs");
      expect(() => applyNative(proposalDoc, approveAs("owner") as never)).not.toThrow(); // control: only the actor differs (pure; nothing persisted)
      // B2: attribution lives in the org authority database, so it travels with every backup: after restore into a new root
      // the joined rows are identical and each matched approval still resolves to its native approval with the same plan hash.
      const attributionRows = (db: any) => db.prepare(`SELECT a.operation_id, a.member_id, a.artifact_digest, a.at, c.membership_version, m.email FROM access_authorizations a
        JOIN access_challenges c ON c.id = a.challenge_id LEFT JOIN access_members m ON m.member_id = a.member_id WHERE a.action = 'proposal.approve' ORDER BY a.operation_id`).all();
      const set = await backupOrg({ orgId: "org-a", authority: orgA.rt.authority, sqlite: orgA.sqlite, stateRoot: A.config.stateRoot, folder: A.config.folder, backupRoot: join(base, "bk-a") });
      const rr = restoreOrgBackup(set.dir, join(base, "restored-a"), "org-a");
      const restoredA = await openOrgRuntime({ ...A.config, stateRoot: rr.stateRoot, folder: rr.folder, accessSocket: rr.accessSocket, opsSocket: rr.opsSocket }, { fetchImpl: fakeFetch as never });
      try {
        expect(attributionRows(restoredA.sqlite.db)).toEqual(attributionRows(orgA.sqlite.db));
        expect(attributionRows(restoredA.sqlite.db).length).toBeGreaterThanOrEqual(1);
        for (const x of approvalsNow.filter((y: any) => y.matched))
          expect(((await restoredA.api.lookup(x.operationId)) as any).approval).toMatchObject({ operationId: x.operationId, planHash: x.artifactDigest });
      } finally { await restoredA.close(); }
      // Option A: the `totp`-tier actions through the Ops socket (and the admin CLI, which posts to it): invite link -> join,
      // list, role change, removal guard, reply policy approval (refused in the app), address revoke.
      const robinLink = await ops(A.config.opsSocket, "/ops/member/invite", { email: "Robin@org-a.test", role: "reviewer" });
      expect(robinLink).toMatchObject({ ok: true, email: "robin@org-a.test", role: "reviewer", link: expect.stringMatching(/\/o\/org-a\/invite#token=/) });
      const robin = await joinAt(robinLink.link);
      expect(robin).toMatchObject({ ok: true, role: "reviewer" });
      expect(await ops(A.config.opsSocket, "/ops/member/invite", { email: "x@org-a.test", role: "owner" })).toEqual({ ok: false, error: "access_invite_invalid" });
      expect((await ops(A.config.opsSocket, "/ops/member/list")).members.map((m: any) => [m.email, m.role, m.status])).toEqual([["admin@org-a.test", "admin", "active"], ["robin@org-a.test", "reviewer", "active"]]);
      expect(await ops(A.config.opsSocket, "/ops/member/role", { email: "robin@org-a.test", role: "contributor" })).toMatchObject({ ok: true, role: "contributor" });
      expect(await ops(A.config.opsSocket, "/ops/member/remove", { email: "admin@org-a.test" })).toEqual({ ok: false, error: "access_last_admin" });
      const policy: ReplyPolicy = { contract: "kapelle.member-reply-policy/v1", version: 1, mode: "shadow", senderName: "Org A notes", members: [{ memberId: robin.memberId }], sourceAudience: "members",
        catalogProfileHash: profileHash(hosted), readerPolicyHash: READER_POLICY_HASH, actionTableHash: ACCESS_TABLE_HASH, caps: { perMemberPerDay: 6, perOrgPerDay: 100, followUps: 1, maxChars: 2000 }, retentionDays: 90 };
      expect((await act("policy.approve", policy, policyHash(policy))).error).toBe("access_step_up_required");
      expect(await ops(A.config.opsSocket, "/ops/policy/approve", { policy: { ...policy, extra: 1 } })).toEqual({ ok: false, error: "reply_policy_invalid" });
      expect(await ops(A.config.opsSocket, "/ops/policy/approve", { policy })).toEqual({ ok: true, policyHash: policyHash(policy), version: 1 });
      expect(orgA.sqlite.db.prepare("SELECT member_id, authn, step_up, artifact_digest FROM access_authorizations WHERE action='policy.approve'").all())
        .toEqual([{ member_id: "ops", authn: "ops-socket", step_up: "ops", artifact_digest: policyHash(policy) }]);
      expect(await ops(A.config.opsSocket, "/ops/intake/token/revoke", { email: "admin@org-a.test" })).toEqual({ ok: true, email: "admin@org-a.test", revoked: true });
      expect(await ops(A.config.opsSocket, "/ops/member/remove", { email: "robin@org-a.test" })).toMatchObject({ ok: true, memberId: robin.memberId });
      expect((await ops(A.config.opsSocket, "/ops/status")).receiptFailures).toEqual({}); // N-3: the spool never fails a receipt
      // N-3: receipts the hub reports as unsent (its signed service envelope) are counted by label in Ops status.
      const hubKey = createPrivateKey(readFileSync(hubOrgs[0].keyFile)), approvedOp = (orgA.sqlite.db.prepare("SELECT operation_id FROM access_authorizations WHERE action='proposal.approve' LIMIT 1").get() as { operation_id: string }).operation_id;
      for (const to of ["admin@org-a.test", "robin@org-a.test"]) {
        const body = { operationId: approvedOp, to, label: "mail_http_500:type=internal_server_error" };
        const env = { v: 1 as const, orgId: "org-a", installationId: orgA.sqlite.identity.installationId, kid: "k1", memberId: "hub", membershipVersion: 0, action: "receipt.failed",
          bodyHash: bodyHash(body), requestId: randomBytes(18).toString("base64url"), expiry: new Date(Date.now() + 60_000).toISOString(), session: null };
        expect(orgA.access.receiptFailed(env, sign(null, envelopeBytes(env), hubKey).toString("base64url"), body)).toEqual({ recorded: true });
      }
      expect((await ops(A.config.opsSocket, "/ops/status")).receiptFailures).toEqual({ "mail_http_500:type=internal_server_error": 2 });
      // N-1: the Ops socket caps request bodies.
      expect(await ops(A.config.opsSocket, "/ops/status", { pad: "x".repeat(70_000) })).toEqual({ ok: false, error: "ops_body_too_large" });
      // Restart org A: the same agents, the same installation; an orphan intake dir is swept at start-up.
      const status1 = await ops(A.config.opsSocket, "/ops/status");
      mkdirSync(join(A.config.folder, "reviewers-private", "intake", "intake_" + "e".repeat(32)), { mode: 0o700 });
      await orgA.close();
      orgA = await openOrgRuntime(A.config, { fetchImpl: fakeFetch as never });
      expect(orgA.swept.orphans).toEqual(["intake_" + "e".repeat(32)]);
      const status2 = await ops(A.config.opsSocket, "/ops/status");
      expect([status2.preparer, status2.membersQa, status2.installationId]).toEqual([status1.preparer, status1.membersQa, status1.installationId]);
      expect(existsSync(A.config.accessSocket)).toBe(true);
      // The hub keeps working across an org runtime restart (no stale keep-alive connection to the old socket).
      const again = await (await fetch(`${url}/o/org-a/api/member/me`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" })).json() as any;
      expect(again).toMatchObject({ ok: true, result: { email: "admin@org-a.test", role: "admin" } });
    } finally { await hub?.close(); await orgA.close(); await orgB.close(); }
  }, 180_000);
});
function statMode(p: string) { return statSync(p).mode & 0o777; }
