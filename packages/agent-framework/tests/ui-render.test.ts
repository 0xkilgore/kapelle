// Review UI renders (build item b) on the REAL launcher stack with fake data: one org runtime + hub, the deterministic
// fake model, a full meeting cycle, shadow replies, then Playwright screenshots at 390 and 1440. Opt-in: UI_RENDER=1
// (writes PNGs to UI_RENDER_DIR). Also asserts the served pages' CSP and that no page renders HTML from content.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { openOrgRuntime } from "../src/org/org-runtime.js";
import { openHub } from "../src/hub/hub-launcher.js";
import { signWebhook } from "../src/org/intake.js";
import { notesDigest } from "../src/org/notes.js";
import { policyHash } from "../src/org/member-reply.js";
import { ACCESS_TABLE_HASH } from "../src/access/org-access.js";
import { READER_POLICY_HASH } from "../src/agent-kit/scope-assembler.js";
import { runtimeCatalogSchema, claudeProfileFromBinding, profileHash } from "../src/agent-kit/runtime-catalog.js";
import { catalogSha256 } from "../src/agent-kit/kit-host.js";
import { hosted } from "./org-meeting-kit.js";
import { script } from "./org-meeting-script.js";
import { RP, ORIGIN } from "./soft-authenticator.js";
import { policyFor, ATTESTATION } from "./transcription-world.js";
import { TRANSCRIPTION_PROFILES, transcriptionProfileHash } from "../src/org/transcription/profile.js";
import * as F from "./media-fixtures.js";

const enabled = !!process.env.UI_RENDER && !!process.env.KAPELLE_SCOPED_REACTOR_ROOT;
const OUT = process.env.UI_RENDER_DIR ?? "/tmp/kapelle-ui-renders";
const W4 = { model: "claude-opus-5-5", credentialTeamId: "00000000-0000-4000-8000-000000000001", credentialKind: "claude-code-oauth" as const, runtime: "claude-agent-sdk" as const,
  sdkVersion: "0.2.90", cliVersion: "2.1.295", maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: "isolated" as const, thinking: "adaptive" as const, effort: "high" as const };
const dir = (p: string) => { const d = realpathSync(mkdtempSync(join("/tmp", p))); chmodSync(d, 0o700); return d; };
const sub = (r: string, n: string) => { const d = join(r, n); mkdirSync(d, { mode: 0o700 }); return d; };
const file = (p: string, c: string) => { writeFileSync(p, c, { mode: 0o600 }); return p; };
const ops = (socket: string, route: string, body: unknown = {}): Promise<any> => new Promise((res, rej) => {
  const data = Buffer.from(JSON.stringify(body));
  const r = request({ socketPath: socket, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (x) => {
    const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => res(JSON.parse(Buffer.concat(c).toString()))); });
  r.on("error", rej); r.end(data);
});
const MEETING = "# EXNA Demo — October meeting (synthetic)\nConfirmed: neighborhood cleanup on Saturday Oct 31.\nFlyer says 10am; Robin's note says 9am. Needs confirmation.\nSam might be able to help with supplies (tentative offer).\nIdea: spend $200 on supplies (not approved).";
const NOTES = "# October meeting — member notes\nThe neighborhood cleanup is on Saturday Oct 31.\nThe start time is being confirmed (flyer and notes differ).\nVolunteers welcome.\n";

describe.skipIf(!enabled)("review UI renders (build item b)", () => {
  it("renders Notes / Review / Activity / Sign in at 390 and 1440 on the real launcher stack", async () => {
    mkdirSync(OUT, { recursive: true });
    const base = dir("kui-"), root = sub(base, "org-a"), state = sub(root, "state"), folder = sub(root, "folder"), run = sub(root, "run"), opsDir = sub(root, "ops"), secrets = sub(root, "secrets");
    const catalog = runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [claudeProfileFromBinding("claude-current", W4, "x"), hosted] });
    const catalogPath = file(join(root, "catalog.json"), JSON.stringify(catalog)), whSecret = randomBytes(24).toString("base64url");
    const fakeFetch = async (_u: string, init: any) => {
      const b = JSON.parse(init.body), system = String(b.messages[0].content), user = String(b.messages[1].content);
      const kind = system.includes("frozen copy of the agent") ? "chat" : "draft";
      return new Response(JSON.stringify({ id: "gen", model: "anthropic/claude-sonnet-4.6", provider: "Anthropic", choices: [{ finish_reason: "stop", message: { role: "assistant", content: script({ user, kind }) } }],
        usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020, cost: 0.0045 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const cfg = { contract: "kapelle.org-runtime/v1", orgId: "org-a", label: "EXNA Demo", stateRoot: state, folder, accessSocket: join(run, "a.sock"), opsSocket: join(opsDir, "o.sock"),
      rpId: RP, origins: [ORIGIN], installations: [{ installationId: "inst-org-a", domain: "org-a.in.kapelle.test", secretFile: file(join(secrets, "wh"), whSecret) }],
      catalogPath, catalogSha256: catalogSha256(catalogPath), hostedProfileId: "hosted-sonnet", hosted: { secretFile: file(join(secrets, "k"), "sk-or-v1-SYNTHETIC"), monthlyUsd: 20 }, replyDomain: "reply.org-a.kapelle.test",
      transcription: { backend: "fake", monthlyUsd: 3 } };
    const org = await openOrgRuntime(cfg, { fetchImpl: fakeFetch as never });
    const kp = generateKeyPairSync("ed25519"); await ops(cfg.opsSocket, "/ops/envelope-key/add", { kid: "k1", publicJwk: kp.publicKey.export({ format: "jwk" }) });
    const mail: any[] = [];
    const hub = await openHub({ contract: "kapelle.hub/v1", listen: { host: "127.0.0.1", port: 0 }, mailSpool: sub(base, "spool"),
      orgs: [{ orgId: "org-a", installationId: org.sqlite.identity.installationId, accessSocket: cfg.accessSocket, kid: "k1", keyFile: file(join(base, "k.pem"), kp.privateKey.export({ format: "pem", type: "pkcs8" }) as string), origin: ORIGIN }],
      ingress: [{ installationId: "inst-org-a", orgId: "org-a", secretFile: cfg.installations[0].secretFile }] }, { mailer: (m) => mail.push(m) });
    const url = `http://127.0.0.1:${hub.port}`;
    const http = async (path: string, body: unknown, cookie = "") => (await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) })).json() as Promise<any>;
    const login = async (email: string) => { mail.length = 0; await http("/o/org-a/login", { email }); await new Promise((r) => setTimeout(r, 20));
      const t = new URL(mail.find((m) => m.to === email).link).searchParams.get("token"); const r = await fetch(`${url}/o/org-a/magic?token=${t}`); return (r.headers.get("set-cookie") ?? "").split(";")[0]; };
    const act = async (cookie: string, action: string, body: unknown, digest: string | null = null) => {
      const operationId = randomUUID(), ch = await http("/o/org-a/challenge", { action, body, artifactDigest: digest, operationId }, cookie);
      return http("/o/org-a/act", { challengeId: ch.challengeId, action, body, artifactDigest: digest, operationId }, cookie);
    };
    // Option A: people join from an Ops one-time link (the first admin too); the join opens their session.
    const join_ = async (link: string) => { const r = await fetch(`${url}/o/org-a/invite/accept`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: new URL(link).hash.replace(/^#token=/, "") }) }); expect(((await r.json()) as any).ok).toBe(true); return (r.headers.get("set-cookie") ?? "").split(";")[0]; };
    let browser: any;
    try {
      await join_((await ops(cfg.opsSocket, "/ops/bootstrap/invite", { email: "admin@exna.test" })).link);
      const admin = await login("admin@exna.test");
      const member = async (email: string, role: string) => { await join_((await ops(cfg.opsSocket, "/ops/member/invite", { email, role })).link);
        return { email, cookie: await login(email) }; };
      const robin = await member("robin@exna.test", "reviewer"), alex = await member("alex@exna.test", "contributor");
      const addr = (await ops(cfg.opsSocket, "/ops/intake/token/issue", { email: alex.email })).address;
      const deliver = async (subject: string, text: string) => { const id = "msg_" + randomBytes(6).toString("hex"), ts = String(Math.floor(Date.now() / 1000));
        const raw = JSON.stringify({ type: "email.received", data: { email_id: id, message_id: `<${id}@mail.test>`, from: "alex@exna.test", to: [addr], subject, text } });
        await fetch(`${url}/ingress/email/inst-org-a`, { method: "POST", headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": signWebhook(whSecret, "inst-org-a", id, ts, raw) }, body: raw }); };
      await deliver("October meeting notes", MEETING);
      const intake = (await http("/o/org-a/api/intake/list", {}, robin.cookie)).result.intakes[0];
      const adopted = await act(robin.cookie, "task.adopt", { intakeId: intake.intakeId, title: "October meeting notes" });
      const plan = (await http("/o/org-a/api/plan/prepare", { taskId: adopted.result.taskId }, robin.cookie)).result;
      await act(robin.cookie, "proposal.approve", { proposalId: plan.proposalId, expectedRevision: plan.expectedRevision, version: plan.version, planHash: plan.planHash }, plan.planHash);
      let drafts: any[] = []; for (let i = 0; i < 200 && !drafts.length; i++) { drafts = (await http("/o/org-a/api/draft/list", {}, robin.cookie)).result.drafts; await new Promise((r) => setTimeout(r, 25)); }
      await act(robin.cookie, "notes.approve", { meeting: "2026-10-08", reportId: drafts[0].documentId, markdown: NOTES }, notesDigest(NOTES));
      await deliver("November meeting agenda", "Agenda items for November (synthetic).");
      const policy = { contract: "kapelle.member-reply-policy/v1", version: 1, mode: "shadow", senderName: "EXNA Demo notes", members: [{ memberId: (await http("/o/org-a/api/member/me", {}, alex.cookie)).result.memberId }],
        sourceAudience: "members", catalogProfileHash: profileHash(hosted), readerPolicyHash: READER_POLICY_HASH, actionTableHash: ACCESS_TABLE_HASH,
        caps: { perMemberPerDay: 10, perOrgPerDay: 100, followUps: 1, maxChars: 2000 }, retentionDays: 90 };
      expect((await ops(cfg.opsSocket, "/ops/policy/approve", { policy })).ok).toBe(true);
      for (const q of ["When is the cleanup?", "What time does the cleanup start?", "Did we approve the $200 for supplies?"]) await deliver("Question", q);
      await new Promise((r) => setTimeout(r, 600));
      // Transcription data for the Recordings frames: a policy (Ops), one recording transcribed on FAKE with parts 1-1
      // adopted, and a fresh upload waiting for its notice attestation.
      expect((await ops(cfg.opsSocket, "/ops/transcription/policy/approve", { policy: policyFor() })).ok).toBe(true);
      const putAudio = async (b: Buffer, name: string) => { const m = await http("/o/org-a/api/media/upload", { fileName: name, size: b.length, contentType: "audio/wav" }, robin.cookie);
        return (await fetch(`${url}/o/org-a/upload/${m.result.uploadId}`, { method: "PUT", headers: { "content-type": "audio/wav", cookie: robin.cookie }, body: new Uint8Array(b) })).json() as Promise<any>; };
      const oct = await putAudio(F.wav(30), "October meeting.wav");
      expect((await act(robin.cookie, "transcript.start", { jobId: oct.jobId, profileHash: transcriptionProfileHash(TRANSCRIPTION_PROFILES.fake), attestation: ATTESTATION }, oct.audioSha256)).ok).toBe(true);
      await org.transcription.jobs!.idle();
      expect((await act(robin.cookie, "task.adopt", { transcriptJobId: oct.jobId, parts: [1, 1], title: "October meeting (transcript)" })).ok).toBe(true);
      expect((await putAudio(F.wav(45), "November board call.wav")).ok).toBe(true);
      // Served UI: strict CSP, no inline script.
      const page = await fetch(`${url}/o/org-a/`);
      expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(await page.text()).not.toMatch(/<script>|onclick=/);

      const { chromium } = await import("/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs" as string);
      browser = await chromium.launch();
      const shots: string[] = [];
      const shoot = async (who: string | null, hash: string, name: string, width: number, ...clicks: string[]) => {
        const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: width < 600 ? 2 : 1 });
        if (who) { const [k, v] = who.split("="); await ctx.addCookies([{ name: k, value: v, url, httpOnly: true, sameSite: "Lax" }]); }
        const p = await ctx.newPage(); await p.goto(`${url}/o/org-a/${hash}`); await p.waitForTimeout(400);
        for (const click of clicks) { await p.getByRole("button", { name: click }).first().click(); await p.waitForTimeout(500); }
        await p.evaluate(() => window.scrollTo(0, 0));
        const out = join(OUT, `${name}-${width}.png`); await p.screenshot({ path: out, fullPage: true }); shots.push(out); await ctx.close();
      };
      for (const w of [390, 1440]) {
        await shoot(null, "", "signin", w);
        await shoot(alex.cookie, "#notes", "notes-member", w);
        await shoot(robin.cookie, "#review", "review-reviewer", w);
        await shoot(robin.cookie, "#review", "review-draft-open", w, "Open draft");
        await shoot(robin.cookie, "#review", "review-draft-copied", w, "Open draft", "Start from the private draft");
        await shoot(robin.cookie, "#activity", "activity-reviewer", w);
        // Transcription T-6: the Recordings page (a transcribed meeting with an adoption, and a fresh upload), the notice
        // attestation dialog, an open transcript and the part-range adoption.
        await shoot(robin.cookie, "#recordings", "recordings", w);
        await shoot(robin.cookie, "#recordings", "recordings-transcribe", w, "Transcribe…");
        await shoot(robin.cookie, "#recordings", "recordings-transcript", w, "Open transcript");
        await shoot(robin.cookie, "#recordings", "recordings-adopt", w, "Adopt parts…");
        // Option A: the email-link invitation page (nothing consumed until "Join"), and the admins' Members page.
        await shoot(null, `invite#token=${new URL((await ops(cfg.opsSocket, "/ops/member/invite", { email: `sam${w}@exna.test`, role: "contributor" })).link).hash.slice(7)}`, "invite", w);
        await shoot(admin, "#members", "members-admin", w);
        // An approval with a sign-in older than an hour: refused, with the fresh-link offer.
        const stale = await login("robin@exna.test");
        (hub.hub as any).sessions.get(createHash("sha256").update(stale.split("=")[1]).digest("hex")).authAt -= 61 * 60_000;
        await shoot(stale, "#review", "approve-stale-signin", w, "Prepare plan", "Approve plan");
      }
      await shoot(null, `invite#token=${new URL((await ops(cfg.opsSocket, "/ops/member/invite", { email: "kim@exna.test", role: "contributor" })).link).hash.slice(7)}`, "invite-joined", 1440, "Join");
      writeFileSync(join(OUT, "index.json"), JSON.stringify(shots, null, 2));
      expect(shots).toHaveLength(27);
    } finally { await browser?.close(); await hub.close(); await org.close(); }
  }, 300_000);
});
