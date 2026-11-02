// SF demo renders: the volunteer flow, step by step, on the REAL launcher stack with synthetic EXNA data (fake model, fake mail,
// nothing sent). Each step is photographed at 1440 AFTER it happens, in order: email in -> adopt -> plan -> draft -> reviewer
// writes member notes -> notes published -> member asks -> Activity shows the prepared (never sent) reply. Approval steps
// go through the API (same session-bound challenges as the buttons; option A: no passkeys); everything else is clicked in the UI. Opt-in: DEMO_RENDER=1
// (PNGs to DEMO_RENDER_DIR). See .workspace/.../SF-DEMO-SCRIPT.md for the narration.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
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

const enabled = !!process.env.DEMO_RENDER && !!process.env.KAPELLE_SCOPED_REACTOR_ROOT;
const OUT = process.env.DEMO_RENDER_DIR ?? "/tmp/kapelle-demo-renders";
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

describe.skipIf(!enabled)("SF demo renders (volunteer flow, synthetic EXNA)", () => {
  it("photographs each step of the volunteer flow at 1440", async () => {
    mkdirSync(OUT, { recursive: true });
    const base = dir("kui-"), root = sub(base, "exna"), state = sub(root, "state"), folder = sub(root, "folder"), run = sub(root, "run"), opsDir = sub(root, "ops"), secrets = sub(root, "secrets");
    const catalog = runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [claudeProfileFromBinding("claude-current", W4, "x"), hosted] });
    const catalogPath = file(join(root, "catalog.json"), JSON.stringify(catalog)), whSecret = randomBytes(24).toString("base64url");
    const fakeFetch = async (_u: string, init: any) => {
      const b = JSON.parse(init.body), system = String(b.messages[0].content), user = String(b.messages[1].content);
      const kind = system.includes("frozen copy of the agent") ? "chat" : "draft";
      return new Response(JSON.stringify({ id: "gen", model: "anthropic/claude-sonnet-4.6", provider: "Anthropic", choices: [{ finish_reason: "stop", message: { role: "assistant", content: script({ user, kind }) } }],
        usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020, cost: 0.0045 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const cfg = { contract: "kapelle.org-runtime/v1", orgId: "exna", label: "EXNA Demo", stateRoot: state, folder, accessSocket: join(run, "a.sock"), opsSocket: join(opsDir, "o.sock"),
      rpId: RP, origins: [ORIGIN], installations: [{ installationId: "inst-exna", domain: "exna.in.kapelle.test", secretFile: file(join(secrets, "wh"), whSecret) }],
      catalogPath, catalogSha256: catalogSha256(catalogPath), hostedProfileId: "hosted-sonnet", hosted: { secretFile: file(join(secrets, "k"), "sk-or-v1-SYNTHETIC"), monthlyUsd: 20 }, replyDomain: "reply.exna.kapelle.test" };
    const org = await openOrgRuntime(cfg, { fetchImpl: fakeFetch as never });
    const kp = generateKeyPairSync("ed25519"); await ops(cfg.opsSocket, "/ops/envelope-key/add", { kid: "k1", publicJwk: kp.publicKey.export({ format: "jwk" }) });
    const mail: any[] = [];
    const hub = await openHub({ contract: "kapelle.hub/v1", listen: { host: "127.0.0.1", port: 0 }, mailSpool: sub(base, "spool"),
      orgs: [{ orgId: "exna", installationId: org.sqlite.identity.installationId, accessSocket: cfg.accessSocket, kid: "k1", keyFile: file(join(base, "k.pem"), kp.privateKey.export({ format: "pem", type: "pkcs8" }) as string), origin: ORIGIN }],
      ingress: [{ installationId: "inst-exna", orgId: "exna", secretFile: cfg.installations[0].secretFile }] }, { mailer: (m) => mail.push(m) });
    const url = `http://127.0.0.1:${hub.port}`;
    const http = async (path: string, body: unknown, cookie = "") => (await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) })).json() as Promise<any>;
    const login = async (email: string) => { mail.length = 0; await http("/o/exna/login", { email }); await new Promise((r) => setTimeout(r, 20));
      const t = new URL(mail.find((m) => m.to === email).link).searchParams.get("token"); const r = await fetch(`${url}/o/exna/magic?token=${t}`); return (r.headers.get("set-cookie") ?? "").split(";")[0]; };
    const act = async (cookie: string, action: string, body: unknown, digest: string | null = null) => {
      const operationId = randomUUID(), ch = await http("/o/exna/challenge", { action, body, artifactDigest: digest, operationId }, cookie);
      return http("/o/exna/act", { challengeId: ch.challengeId, action, body, artifactDigest: digest, operationId }, cookie);
    };
    // Option A: people join from an Ops one-time link (the first admin too); the join opens their session.
    const join_ = async (link: string) => { const r = await fetch(`${url}/o/exna/invite/accept`, { method: "POST", headers: { "content-type": "application/json" },
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
        await fetch(`${url}/ingress/email/inst-exna`, { method: "POST", headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": signWebhook(whSecret, "inst-exna", id, ts, raw) }, body: raw }); };
      const { chromium } = await import("/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs" as string);
      browser = await chromium.launch();
      const shots: string[] = [];
      type Step = { click?: string; fill?: [string, string]; text?: string };
      const shoot = async (who: string, hash: string, name: string, ...steps: Step[]) => {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
        const [k, v] = who.split("="); await ctx.addCookies([{ name: k, value: v, url, httpOnly: true, sameSite: "Lax" }]);
        const p = await ctx.newPage(); await p.goto(`${url}/o/exna/${hash}`); await p.waitForTimeout(400);
        for (const s of steps) {
          if (s.click) await p.getByRole("button", { name: s.click }).first().click();
          if (s.fill) await p.locator(s.fill[0]).fill(s.fill[1]);
          if (s.text) await p.getByText(s.text).first().click();
          await p.waitForTimeout(600);
        }
        await p.evaluate(() => window.scrollTo(0, 0));
        const out = join(OUT, `${name}-1440.png`); await p.screenshot({ path: out, fullPage: true }); shots.push(out); await ctx.close();
      };
      const waitFor = async (f: () => Promise<boolean>) => { for (let i = 0; i < 200; i++) { if (await f()) return; await new Promise((r) => setTimeout(r, 25)); } throw Error("timeout"); };

      // 1. A volunteer emails the meeting notes to the org's private address.
      await deliver("October meeting notes", MEETING);
      await shoot(robin.cookie, "#review", "01-email-in");
      // 2. A reviewer adopts it as a Task.
      const intake = (await http("/o/exna/api/intake/list", {}, robin.cookie)).result.intakes[0];
      const adopted = await act(robin.cookie, "task.adopt", { intakeId: intake.intakeId, title: "October meeting notes" });
      expect(adopted.ok).toBe(true);
      await shoot(robin.cookie, "#review", "02-adopted");
      // 3. The system prepares the exact plan; the reviewer sees it before approving.
      await shoot(robin.cookie, "#review", "03-plan", { click: "Prepare plan" });
      const plan = (await http("/o/exna/api/plan/prepare", { taskId: adopted.result.taskId }, robin.cookie)).result; // the same open plan (N-3)
      // 4. The reviewer approves the plan (bound to the plan hash); the agent drafts privately.
      expect((await act(robin.cookie, "proposal.approve", { proposalId: plan.proposalId, expectedRevision: plan.expectedRevision, version: plan.version, planHash: plan.planHash }, plan.planHash)).ok).toBe(true);
      let drafts: any[] = [];
      await waitFor(async () => (drafts = (await http("/o/exna/api/draft/list", {}, robin.cookie)).result.drafts).length > 0);
      await shoot(robin.cookie, "#review", "04-draft-ready");
      // 5. The reviewer writes what members should see (the private draft never becomes visible by itself).
      await shoot(robin.cookie, "#review", "05-member-notes", { click: "Open draft" }, { fill: ["#member-notes", NOTES] });
      // 6. Approved over the exact text (bound to its digest): members can now read the notes.
      expect((await act(robin.cookie, "notes.approve", { meeting: "2026-10-08", reportId: drafts[0].documentId, markdown: NOTES }, notesDigest(NOTES))).ok).toBe(true);
      await shoot(alex.cookie, "#notes", "06-notes-published");
      // 7. A member asks a question; the answer cites the approved notes.
      await shoot(alex.cookie, "#notes", "07-member-asks", { fill: ["#q", "When is the cleanup?"] }, { click: "Ask" });
      // 8. A member emails a question; the reply is prepared and recorded (shadow mode), never sent. Activity shows it.
      const policy = { contract: "kapelle.member-reply-policy/v1", version: 1, mode: "shadow", senderName: "EXNA Demo notes", members: [{ memberId: (await http("/o/exna/api/member/me", {}, alex.cookie)).result.memberId }],
        sourceAudience: "members", catalogProfileHash: profileHash(hosted), readerPolicyHash: READER_POLICY_HASH, actionTableHash: ACCESS_TABLE_HASH,
        caps: { perMemberPerDay: 10, perOrgPerDay: 100, followUps: 1, maxChars: 2000 }, retentionDays: 90 };
      expect((await ops(cfg.opsSocket, "/ops/policy/approve", { policy })).ok).toBe(true);
      await deliver("Question", "When is the cleanup?");
      await waitFor(async () => ((await http("/o/exna/api/audit/read", {}, robin.cookie)).result ?? []).some((r: any) => r.decision === "shadowed"));
      await shoot(robin.cookie, "#activity", "08-activity-prepared-reply", { text: "Exact reply and sources" });
      writeFileSync(join(OUT, "index.json"), JSON.stringify(shots, null, 2));
      expect(shots).toHaveLength(8);
    } finally { await browser?.close(); await hub.close(); await org.close(); }
  }, 300_000);
});
