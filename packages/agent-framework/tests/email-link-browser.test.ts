// Option A (was B1 passkeys): the email-link flow in a REAL browser (headless Chromium), over HTTPS on a real hostname
// (self-signed cert trusted by SPKI, hostname mapped to loopback; the session cookie is Secure), through the served UI and hub:
//   Ops mints the first admin's one-time link -> the admin joins in the browser (signed in) -> the Members page says member
//   changes are Ops' -> Ops mints a reviewer's link -> the reviewer joins -> adopts a submission and approves its plan by
//   clicking -> receipts are mailed. Replayed links and a second bootstrap are refused; no passkey exists anywhere.
//   Opt-in: BROWSER_E2E=1 (needs openssl + the Playwright install).
import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import https from "node:https";
import { request } from "node:http";
import { openOrgRuntime } from "../src/org/org-runtime.js";
import { openHub } from "../src/hub/hub-launcher.js";
import { signWebhook } from "../src/org/intake.js";
import { policyFor } from "./transcription-world.js";
import * as F from "./media-fixtures.js";
import { runtimeCatalogSchema, claudeProfileFromBinding } from "../src/agent-kit/runtime-catalog.js";
import { catalogSha256 } from "../src/agent-kit/kit-host.js";
import { hosted } from "./org-meeting-kit.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.BROWSER_E2E && !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && existsSync(PLAYWRIGHT);
const W4 = { model: "claude-opus-5-5", credentialTeamId: "00000000-0000-4000-8000-000000000001", credentialKind: "claude-code-oauth" as const, runtime: "claude-agent-sdk" as const,
  sdkVersion: "0.2.90", cliVersion: "2.1.295", maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: "isolated" as const, thinking: "adaptive" as const, effort: "high" as const };
const sub = (r: string, n: string) => { const d = join(r, n); mkdirSync(d, { mode: 0o700 }); return d; };
const file = (p: string, c: string) => { writeFileSync(p, c, { mode: 0o600 }); return p; };
const ops = (socket: string, route: string, body: unknown = {}): Promise<any> => new Promise((res, rej) => { const data = Buffer.from(JSON.stringify(body));
  const r = request({ socketPath: socket, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (x) => {
    const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => res(JSON.parse(Buffer.concat(c).toString()))); }); r.on("error", rej); r.end(data); });

describe.skipIf(!enabled)("option A: email-link join and approvals in a real browser", () => {
  it("first admin from an Ops link, reviewer from an Ops link, adopt and approve by clicking, receipts mailed", async () => {
    const base = realpathSync(mkdtempSync("/tmp/kpb-")); chmodSync(base, 0o700);
    // TLS for a real hostname (WebAuthn needs a secure origin and a domain RP id).
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(base, "key.pem"), "-out", join(base, "cert.pem"),
      "-days", "2", "-subj", "/CN=exna.test", "-addext", "subjectAltName=DNS:exna.test"], { stdio: "ignore" });
    const der = execFileSync("openssl", ["x509", "-in", join(base, "cert.pem"), "-pubkey", "-noout"]);
    const spki = execFileSync("openssl", ["pkey", "-pubin", "-outform", "der"], { input: der });
    const spkiHash = (await import("node:crypto")).createHash("sha256").update(spki).digest("base64");
    let hubPort = 0;
    const proxy = https.createServer({ key: readFileSync(join(base, "key.pem")), cert: readFileSync(join(base, "cert.pem")) }, (req, res) => {
      const up = request({ host: "127.0.0.1", port: hubPort, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
      up.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(up);
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const ORIGIN = `https://exna.test:${(proxy.address() as { port: number }).port}`;

    const root = sub(base, "exna"), secrets = sub(root, "secrets");
    const catalogPath = file(join(root, "catalog.json"), JSON.stringify(runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [claudeProfileFromBinding("claude-current", W4, "x"), hosted] })));
    const whsec = randomBytes(24).toString("base64url");
    const cfg = { contract: "kapelle.org-runtime/v1", orgId: "exna", label: "EXNA", stateRoot: sub(root, "state"), folder: sub(root, "folder"),
      accessSocket: join(sub(root, "run"), "a.sock"), opsSocket: join(sub(root, "ops"), "o.sock"), rpId: "exna.test", origins: [ORIGIN],
      installations: [{ installationId: "inst-exna", domain: "in.exna.test", secretFile: file(join(secrets, "wh"), whsec) }],
      catalogPath, catalogSha256: catalogSha256(catalogPath), hostedProfileId: "hosted-sonnet", hosted: { secretFile: file(join(secrets, "k"), "sk-or-v1-SYNTHETIC"), monthlyUsd: 5 },
      replyDomain: "reply.exna.test", transcription: { backend: "fake", monthlyUsd: 3 } };
    const org = await openOrgRuntime(cfg, { fetchImpl: (async () => new Response("{}", { status: 503 })) as never });
    const kp = generateKeyPairSync("ed25519"); await ops(cfg.opsSocket, "/ops/envelope-key/add", { kid: "k1", publicJwk: kp.publicKey.export({ format: "jwk" }) });
    const mail: { to: string; kind: string; link: string; receipt?: any }[] = [];
    const hub = await openHub({ contract: "kapelle.hub/v1", listen: { host: "127.0.0.1", port: 0 }, mailSpool: sub(base, "spool"),
      orgs: [{ orgId: "exna", installationId: org.sqlite.identity.installationId, accessSocket: cfg.accessSocket, kid: "k1", keyFile: file(join(base, "k.pem"), kp.privateKey.export({ format: "pem", type: "pkcs8" }) as string), origin: ORIGIN }],
      ingress: [{ installationId: "inst-exna", orgId: "exna", secretFile: cfg.installations[0].secretFile }] }, { mailer: (m) => mail.push(m) });
    hubPort = hub.port;
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP exna.test 127.0.0.1", `--ignore-certificate-errors-spki-list=${spkiHash}`] });
    const SHOTS = process.env.B1_SHOTS_DIR; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    const shot = async (page: any, name: string) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-1440.png`), fullPage: true }); };
    const person = async () => (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); // no authenticator
    const receipts = async (n: number) => { for (let i = 0; i < 100; i++) { const r = mail.filter((x) => x.kind === "receipt"); if (r.length >= n) return r; await new Promise((x) => setTimeout(x, 25)); } throw Error("no receipt"); };
    try {
      // 1. Ops mints the first admin's one-time link (owner-only socket); a second bootstrap is refused once someone exists.
      const boot = await ops(cfg.opsSocket, "/ops/bootstrap/invite", { email: "admin@exna.test" });
      expect(boot).toMatchObject({ ok: true, email: "admin@exna.test", link: expect.stringMatching(new RegExp(`^${ORIGIN.replace(/\./g, "\\.")}/o/exna/invite#token=[A-Za-z0-9_-]{43}$`)) });
      const admin = await person();
      await admin.goto(boot.link);
      expect(new URL(admin.url()).hash).toBe(""); expect(admin.url()).toBe(`${ORIGIN}/o/exna/`); // the token left the address bar at once
      // Server-provided facts before joining: which org, which role, what to do if unexpected.
      await admin.getByRole("heading", { name: "Set up EXNA" }).waitFor();
      await admin.getByText("You are the first administrator of EXNA (admin@exna.test).").waitFor();
      await admin.getByText("Didn't expect this? Close this page.", { exact: false }).waitFor();
      await shot(admin, "a-invite-page");
      await admin.getByRole("button", { name: "Join EXNA" }).click();
      await admin.waitForSelector("#nav a");
      expect(await admin.locator("#who").textContent()).toBe("admin@exna.test"); // CP cleanup: no internal role word in the top bar
      expect((await admin.context().cookies()).find((c: any) => c.name === "kh_exna")).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/o/exna" });
      expect(await ops(cfg.opsSocket, "/ops/bootstrap/invite", { email: "someone@exna.test" })).toEqual({ ok: false, error: "access_bootstrap_not_empty" });
      // The link is single use.
      const replay = await person(); await replay.goto(boot.link);
      await replay.getByRole("heading", { name: "This invitation can't be used" }).waitFor();
      await replay.getByText("That invite was already used.").waitFor();
      expect(await replay.getByRole("button", { name: /^Join/ }).count()).toBe(0);
      // 2. Members: member changes are Ops' (the `totp` tier) until an authenticator-app step exists.
      await admin.goto(`${ORIGIN}/o/exna/#members`);
      await admin.getByText("is done on the server for now", { exact: false }).waitFor();
      expect(await admin.locator("#invite-email").count()).toBe(0);
      await shot(admin, "a-members");
      // 3. Ops mints Robin's link; Robin joins on their own device and sees Review (and not Members).
      const robinLink = await ops(cfg.opsSocket, "/ops/member/invite", { email: "robin@exna.test", role: "reviewer" });
      const robin = await person();
      await robin.goto(robinLink.link);
      await robin.getByRole("heading", { name: "An administrator invited you to EXNA" }).waitFor();
      await robin.getByText("You'll join as a reviewer (robin@exna.test).").waitFor();
      await robin.getByRole("button", { name: "Join EXNA" }).click();
      await robin.waitForSelector("#nav a");
      // CP cleanup (Oct 18): the top bar is the member tabs; reviewer/admin tools open from Manage. Without chat, Notes stays first;
      // Chat, Website and Newsletter appear only when configured.
      expect(await robin.locator("#nav a").allTextContents()).toEqual(["Notes", "Files", "Manage", "Help"]); // USABILITY v1: Help for everyone
      // 4. A submission arrives (address issued by Ops); Robin adopts it and approves its plan by clicking.
      const { address } = await ops(cfg.opsSocket, "/ops/intake/token/issue", { email: "robin@exna.test" });
      const id = "msg_" + randomUUID().slice(0, 8), ts = String(Math.floor(Date.now() / 1000));
      const raw = JSON.stringify({ type: "email.received", data: { email_id: id, message_id: `<${id}@m.test>`, from: "robin@exna.test", to: [address], subject: "October meeting notes", text: "Synthetic notes." } });
      expect((await fetch(`http://127.0.0.1:${hub.port}/ingress/email/inst-exna`, { method: "POST", headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": signWebhook(whsec, "inst-exna", id, ts, raw) }, body: raw })).status).toBe(200);
      await robin.goto(`${ORIGIN}/o/exna/#review`); await robin.getByRole("button", { name: "Adopt as Task" }).click();
      await robin.getByRole("button", { name: "Prepare plan" }).click();
      await robin.getByRole("button", { name: "Approve plan" }).click();
      await robin.getByText("Plan approved.", { exact: false }).waitFor();
      await shot(robin, "a-plan-approved");
      expect((org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM intake_adoptions").get() as { n: number }).n).toBe(1);
      expect(org.sqlite.db.prepare("SELECT action, authn, step_up FROM access_authorizations ORDER BY at").all()).toEqual([
        { action: "task.adopt", authn: "email-session", step_up: "session" }, { action: "proposal.approve", authn: "email-session", step_up: "session-fresh" }]);
      // Receipts: Robin for the adopt; Robin and the admin for the plan approval.
      expect((await receipts(3)).map((m) => [m.to, m.receipt.action]).sort()).toEqual([["admin@exna.test", "proposal.approve"], ["robin@exna.test", "proposal.approve"], ["robin@exna.test", "task.adopt"]]);
      // Transcription T-6 in the browser (FAKE backend): Robin uploads a recording through the real streamed PUT (Secure
      // cookie, HTTPS), attests the recording notice, transcribes, reads the transcript with unverified speakers, adopts
      // part 1 and approves its plan, all by clicking.
      expect((await ops(cfg.opsSocket, "/ops/transcription/policy/approve", { policy: policyFor() })).ok).toBe(true);
      await robin.goto(`${ORIGIN}/o/exna/#recordings`);
      await robin.getByRole("heading", { name: "Recordings", exact: true }).first().waitFor();
      await robin.locator("#recording").setInputFiles({ name: "October meeting.wav", mimeType: "audio/wav", buffer: F.wav(30) });
      await robin.getByRole("button", { name: "Upload recording" }).click();
      await robin.getByText("Uploaded (0:30). Next: Transcribe.").waitFor();
      await robin.getByRole("button", { name: "Transcribe…" }).waitFor({ timeout: 5000 });
      await robin.getByRole("button", { name: "Transcribe…" }).click();
      const go = robin.getByRole("button", { name: "Transcribe", exact: true });
      expect(await go.isDisabled()).toBe(true); // the notice attestation is a precondition (R-8)
      await robin.getByLabel("Who authorised the recording").fill("Chair, per the EXNA bylaws");
      await robin.getByLabel("Who was present (audience)").fill("Members at the October meeting (synthetic)");
      await robin.getByLabel("What people who declined could do instead").fill("Written comments to the secretary");
      await robin.getByLabel("The notice above was given before recording started.").check();
      expect(await go.isDisabled()).toBe(false);
      await go.click();
      await robin.getByText("Transcript ready · 1 part").waitFor({ timeout: 15000 });
      await robin.getByRole("button", { name: "Open transcript" }).click();
      await robin.getByText("Speaker 1 · unverified").first().waitFor();
      await shot(robin, "t6-transcript");
      await robin.getByRole("button", { name: "Adopt parts…" }).click();
      await robin.getByRole("button", { name: "Adopt as Task" }).click();
      await robin.getByText("Adopted. Prepare its plan next.").waitFor();
      await robin.getByRole("button", { name: "Prepare plan (parts 1–1)" }).waitFor({ timeout: 5000 });
      await robin.getByRole("button", { name: "Prepare plan (parts 1–1)" }).click();
      await robin.getByText("Reads the adopted transcript parts only.", { exact: false }).waitFor();
      await robin.getByRole("button", { name: "Approve plan" }).click();
      await robin.getByText("Plan approved.", { exact: false }).waitFor();
      expect(org.sqlite.db.prepare("SELECT state, parts FROM transcription_jobs").all()).toEqual([{ state: "done", parts: 1 }]);
      expect(org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM transcript_adoptions").get()).toEqual({ n: 1 });
      expect((org.sqlite.db.prepare("SELECT action, authn FROM access_authorizations WHERE action IN ('transcript.start','proposal.approve') ORDER BY at").all() as any[]).map((r) => r.action))
        .toEqual(["proposal.approve", "transcript.start", "proposal.approve"]);
      // No passkey anywhere: two members, no credentials.
      expect(org.sqlite.db.prepare("SELECT email, role FROM access_members ORDER BY email").all()).toEqual([{ email: "admin@exna.test", role: "admin" }, { email: "robin@exna.test", role: "reviewer" }]);
      expect(org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM access_credentials").get()).toEqual({ n: 0 });
    } finally { await browser.close(); await hub.close(); await org.close(); await new Promise<void>((r) => proxy.close(() => r())); }
  }, 180_000);
});
