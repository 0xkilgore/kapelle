// B2: the hub's only outbound mail (fixed sign-in / invite templates) through the Resend send port, plus the invite page's
// read-only facts. Fake fetch / fake port only: no Resend account, no key, no network.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { authMailText, authMailMessage, resendSendPort, fakeMailPort, MailError, RESEND_SEND_URL } from "../src/hub/auth-mail.js";
import { openOrgRuntime } from "../src/org/org-runtime.js";
import { openHub, portMailer } from "../src/hub/hub-launcher.js";
import { runtimeCatalogSchema, claudeProfileFromBinding } from "../src/agent-kit/runtime-catalog.js";
import { catalogSha256 } from "../src/agent-kit/kit-host.js";
import { hosted } from "./org-meeting-kit.js";
import { RP, ORIGIN } from "./soft-authenticator.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const tmp = () => { const d = realpathSync(mkdtempSync("/tmp/kam-")); chmodSync(d, 0o700); return d; };
const LINK = "https://exna.example.org/o/exna/magic?token=" + "x".repeat(43);

it("fixed templates: server facts only, one-line header fields, the link once, no model content", () => {
  const login = authMailText({ orgId: "exna", orgLabel: "EXNA", to: "a@b.test", kind: "login", link: LINK });
  expect(login.subject).toBe("Your sign-in link for EXNA");
  expect(login.text.split(LINK)).toHaveLength(2);
  const inv = authMailText({ orgId: "exna", orgLabel: "EXNA\r\nBcc: victim@evil.test", to: "r@b.test", kind: "invite", link: LINK, inviter: "robin@exna.test", role: "contributor" });
  expect(inv.subject).toBe("robin@exna.test invited you to EXNA Bcc: victim@evil.test"); // flattened to one line: no header injection
  expect(inv.text).toContain("as a contributor");
  expect(inv.text).toMatch(/Open this link to join\. It signs you in/);
  expect(inv.text).not.toMatch(/passkey/i);
  expect(authMailText({ orgId: "exna", orgLabel: "EXNA", to: "x@y.test", kind: "invite", link: LINK, inviter: null, role: "admin" }).subject).toBe("An administrator invited you to EXNA");
  // The idempotency key is stable per link and does not contain it.
  const a = authMailMessage({ orgId: "exna", orgLabel: "EXNA", to: "a@b.test", kind: "login", link: LINK }), b = authMailMessage({ orgId: "exna", orgLabel: "EXNA", to: "a@b.test", kind: "login", link: LINK });
  expect(a.idempotencyKey).toBe(b.idempotencyKey); expect(a.idempotencyKey).not.toContain("x".repeat(10));
});

it("option A receipt template (Fable control 4): fixed text, server facts only, one receipt per operation and recipient", () => {
  const D = "sha256:" + "ab".repeat(32), APP = "https://exna.example.org/o/exna/";
  const receipt = { actor: "robin@exna.test", action: "proposal.approve", artifactDigest: D, operationId: "op-1", at: "2026-10-16T12:00:00.000Z", authn: "email-session" };
  const self = authMailText({ orgId: "exna", orgLabel: "EXNA", to: "robin@exna.test", kind: "receipt", link: APP, receipt });
  expect(self.subject).toBe("EXNA: you approved a plan");
  expect(self.text.split("\n")).toEqual(["You approved a plan in EXNA.", "", `Plan: ${D}`, "Reference: op-1", "When: 2026-10-16T12:00:00.000Z (UTC)", "How: signed in with an email link", "",
    `Open EXNA: ${APP}`, "", "If this wasn't you, someone may be able to read this mailbox. Tell your administrator now so they can remove access."]);
  const owner = authMailText({ orgId: "exna", orgLabel: "EXNA", to: "admin@exna.test", kind: "receipt", link: APP, receipt });
  expect(owner.subject).toBe("EXNA: robin@exna.test approved a plan");
  expect(owner.text).toMatch(/^robin@exna\.test approved a plan in EXNA\./);
  // Header-injection-safe and digest-checked: an actor with a newline is one line; a malformed digest is omitted.
  const odd = authMailText({ orgId: "exna", orgLabel: "EXNA", to: "x@y.test", kind: "receipt", link: APP, receipt: { ...receipt, actor: "a@b.test\r\nBcc: v@evil.test", artifactDigest: "<b>x</b>", action: "task.adopt" } });
  expect(odd.subject).toBe("EXNA: a@b.test Bcc: v@evil.test adopted a submission as a Task");
  expect(odd.text).not.toMatch(/<b>|Item:/);
  const k = (op: string, to = "robin@exna.test") => authMailMessage({ orgId: "exna", orgLabel: "EXNA", to, kind: "receipt", link: APP, receipt: { ...receipt, operationId: op } }).idempotencyKey;
  expect(k("op-1")).toBe(k("op-1")); expect(k("op-1")).not.toBe(k("op-2")); expect(k("op-1")).not.toBe(k("op-1", "admin@exna.test"));
});

it("N-3: the port mailer reports each send's outcome (null or the fixed label) to the hub, never the link", async () => {
  const outcomes: (string | null)[] = [];
  const ok = portMailer(fakeMailPort()), bad = portMailer({ async send() { throw new MailError("mail_http_500:type=internal_server_error"); } }), odd = portMailer({ async send() { throw new Error("boom " + LINK); } });
  const m = { orgId: "exna", to: "a@b.test", kind: "login" as const, link: LINK };
  for (const p of [ok, bad, odd]) { await new Promise<void>((res) => p.mailer(m, (e) => { outcomes.push(e); res(); })); }
  expect(outcomes).toEqual([null, "mail_http_500:type=internal_server_error", "mail_error"]);
  expect([ok.stats, bad.stats, odd.stats].map((x) => [x.sent, x.failed])).toEqual([[1, 0], [0, 1], [0, 1]]);
});

it("Resend send client: one pinned request, key from an owner-only file, typed failure labels, never the provider's message", async () => {
  const dir = tmp(), keyFile = join(dir, "resend.key"); writeFileSync(keyFile, "re_SYNTHETIC_NOT_A_REAL_KEY_12345\n", { mode: 0o600 });
  const seen: any[] = []; let reply: () => Response = () => new Response(JSON.stringify({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }), { status: 200 });
  const port = resendSendPort({ from: "EXNA <noreply@exna.example.org>", apiKeyFile: keyFile, fetch: async (url, init) => { seen.push({ url, init }); return reply(); } });
  const m = authMailMessage({ orgId: "exna", orgLabel: "EXNA", to: "alex@exna.test", kind: "login", link: LINK });
  await port.send(m);
  expect(seen[0].url).toBe(RESEND_SEND_URL);
  expect(seen[0].init).toMatchObject({ method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: "Bearer re_SYNTHETIC_NOT_A_REAL_KEY_12345", "idempotency-key": m.idempotencyKey } });
  expect(JSON.parse(seen[0].init.body)).toEqual({ from: "EXNA <noreply@exna.example.org>", to: ["alex@exna.test"], subject: m.subject, text: m.text });
  const fails = async (r: () => Response) => { reply = r; return port.send(m).then(() => null, (e) => (e instanceof MailError ? e.label : "other")); };
  expect(await fails(() => new Response(JSON.stringify({ name: "validation_error", message: "API key is invalid", statusCode: 401 }), { status: 401 }))).toBe("mail_http_401:type=validation_error");
  expect(await fails(() => new Response(JSON.stringify({ name: "rate_limit_exceeded", message: "Too many requests" }), { status: 429 }))).toBe("mail_http_429:type=rate_limit_exceeded");
  expect(await fails(() => new Response("<html>bad gateway</html>", { status: 502 }))).toBe("mail_http_502");
  expect(await fails(() => new Response("{}", { status: 200 }))).toBe("mail_http_unexpected"); // 200 without an id is not a send
  const broken = resendSendPort({ from: "noreply@exna.example.org", apiKeyFile: keyFile, fetch: async () => { throw new TypeError("socket hang up"); } });
  await expect(broken.send(m)).rejects.toThrow("mail_transport_failed");
  chmodSync(keyFile, 0o644); await expect(port.send(m)).rejects.toThrow("mail_key_not_private"); chmodSync(keyFile, 0o600);
  writeFileSync(keyFile, "sk-not-a-resend-key\n", { mode: 0o600 }); await expect(port.send(m)).rejects.toThrow("mail_key_invalid");
  expect(() => resendSendPort({ from: "EXNA <noreply@exna.example.org>\r\nBcc: x@y.test", apiKeyFile: keyFile })).toThrow("mail_from_invalid");
});

describe.skipIf(!enabled)("auth mail through the hub + the invite page's facts", () => {
  it("members get a sign-in mail, strangers none; the invite mail names the inviter and role; invite/info is read-only", async () => {
    const base = tmp(), sub = (r: string, n: string) => { const d = join(r, n); mkdirSync(d, { mode: 0o700 }); return d; };
    const root = sub(base, "exna"), secrets = sub(root, "secrets"), file = (p: string, c: string) => { writeFileSync(p, c, { mode: 0o600 }); return p; };
    const W4 = { model: "claude-opus-5-5", credentialTeamId: "00000000-0000-4000-8000-000000000001", credentialKind: "claude-code-oauth" as const, runtime: "claude-agent-sdk" as const,
      sdkVersion: "0.2.90", cliVersion: "2.1.295", maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: "isolated" as const, thinking: "adaptive" as const, effort: "high" as const };
    const catalogPath = file(join(root, "catalog.json"), JSON.stringify(runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [claudeProfileFromBinding("claude-current", W4, "x"), hosted] })));
    const cfg = { contract: "kapelle.org-runtime/v1", orgId: "exna", label: "EXNA", stateRoot: sub(root, "state"), folder: sub(root, "folder"), accessSocket: join(sub(root, "run"), "a.sock"),
      opsSocket: join(sub(root, "ops"), "o.sock"), rpId: RP, origins: [ORIGIN], installations: [{ installationId: "inst-exna", domain: "in.exna.test", secretFile: file(join(secrets, "wh"), randomBytes(24).toString("base64url")) }],
      catalogPath, catalogSha256: catalogSha256(catalogPath), hostedProfileId: "hosted-sonnet", hosted: { secretFile: file(join(secrets, "k"), "sk-or-v1-SYNTHETIC"), monthlyUsd: 5 }, replyDomain: "reply.exna.test" };
    const org = await openOrgRuntime(cfg, { fetchImpl: (async () => new Response("{}", { status: 503 })) as never });
    const ops = (route: string, body: unknown = {}): Promise<any> => new Promise((res, rej) => { const data = Buffer.from(JSON.stringify(body));
      const r = request({ socketPath: cfg.opsSocket, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (x) => {
        const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => res(JSON.parse(Buffer.concat(c).toString()))); }); r.on("error", rej); r.end(data); });
    const kp = generateKeyPairSync("ed25519"); await ops("/ops/envelope-key/add", { kid: "k1", publicJwk: kp.publicKey.export({ format: "jwk" }) });
    const port = fakeMailPort();
    const hub = await openHub({ contract: "kapelle.hub/v1", listen: { host: "127.0.0.1", port: 0 }, mailSpool: sub(base, "spool"), labels: { exna: "EXNA" },
      orgs: [{ orgId: "exna", installationId: org.sqlite.identity.installationId, accessSocket: cfg.accessSocket, kid: "k1", keyFile: file(join(base, "k.pem"), kp.privateKey.export({ format: "pem", type: "pkcs8" }) as string), origin: ORIGIN }],
      ingress: [] }, { mailPort: port });
    const url = `http://127.0.0.1:${hub.port}`, settle = () => new Promise((r) => setTimeout(r, 30));
    const post = async (path: string, body: unknown, cookie = "") => (await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) })).json() as Promise<any>;
    const linkIn = (text: string) => /https:\/\/\S+/.exec(text)![0];
    try {
      // The first admin's Ops link: invite/info says "first admin", names the org; nothing is consumed by reading. Joining
      // (option A: no passkey) admits them and opens their session; the link is then used up.
      const boot = await ops("/ops/bootstrap/invite", { email: "admin@exna.test" }), bootToken = new URL(boot.link).hash.replace(/^#token=/, "");
      expect(await post("/o/exna/invite/info", { token: bootToken })).toEqual({ ok: true, orgLabel: "EXNA", role: "admin", email: "admin@exna.test", invitedBy: null, firstAdmin: true });
      expect(await post("/o/exna/invite/info", { token: bootToken })).toMatchObject({ ok: true }); // still usable
      const joined = await fetch(url + "/o/exna/invite/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: bootToken }) });
      expect(await joined.json()).toMatchObject({ ok: true, role: "admin" });
      expect(joined.headers.get("set-cookie")).toMatch(/^kh_exna=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/o\/exna$/);
      expect(await post("/o/exna/invite/info", { token: bootToken })).toEqual({ ok: false, error: "access_invite_consumed" });
      expect(await post("/o/exna/invite/accept", { token: bootToken })).toEqual({ ok: false, error: "access_invite_consumed" });
      // Sign-in mail: the member gets one fixed-template mail; a stranger gets the same answer and no mail.
      expect(await post("/o/exna/login", { email: "nobody@exna.test" })).toMatchObject({ ok: true }); await settle();
      expect(port.sink).toHaveLength(0);
      await post("/o/exna/login", { email: "admin@exna.test" }); await settle();
      expect(port.sink).toHaveLength(1);
      expect(port.sink[0]).toMatchObject({ to: "admin@exna.test", subject: "Your sign-in link for EXNA" });
      const magic = await fetch(linkIn(port.sink[0].text).replace(ORIGIN, url)), cookie = (magic.headers.get("set-cookie") ?? "").split(";")[0];
      expect(cookie).toMatch(/^kh_exna=/);
      expect(hub.mail).toEqual({ sent: 1, failed: 0, lastError: null });
      // Option A: an in-app invite is `totp` tier and refused (no mail); Ops issues the link instead; invite/info agrees.
      const op = randomUUID(), body = { email: "robin@exna.test", role: "reviewer" };
      expect(await post("/o/exna/challenge", { action: "member.invite", body, artifactDigest: null, operationId: op }, cookie)).toEqual({ ok: false, error: "access_step_up_required" });
      const inv = await ops("/ops/member/invite", { email: "robin@exna.test", role: "reviewer" });
      expect(inv).toMatchObject({ ok: true, email: "robin@exna.test", role: "reviewer", link: expect.stringMatching(/\/o\/exna\/invite#token=[A-Za-z0-9_-]{43}$/) });
      const invToken = new URL(inv.link).hash.replace(/^#token=/, "");
      expect(await post("/o/exna/invite/info", { token: invToken })).toEqual({ ok: true, orgLabel: "EXNA", role: "reviewer", email: "robin@exna.test", invitedBy: null, firstAdmin: false });
      expect(await post("/o/exna/invite/info", { token: "y".repeat(43) })).toEqual({ ok: false, error: "access_invite_unknown" });
      expect(hub.mail).toEqual({ sent: 1, failed: 0, lastError: null });
      // Fable B1 N-1: the page is served at /invite (the token rides in the #fragment); a query-string token is not served.
      expect((await fetch(`${url}/o/exna/invite`)).status).toBe(200);
      const legacy = await fetch(`${url}/o/exna/invite?token=${"z".repeat(43)}`);
      expect(legacy.status).not.toBe(200); expect(legacy.headers.get("content-type")).not.toMatch(/text\/html/);
      expect(boot.link).toMatch(/\/o\/exna\/invite#token=[A-Za-z0-9_-]{43}$/);
      // Fable B1 N-2: hammering one token is refused at the hub after 10 tries in 10 minutes.
      const bogus = "q".repeat(43), statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await fetch(`${url}/o/exna/invite/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: bogus }) })).status);
      expect(statuses.slice(0, 10).every((x) => x === 403)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally { await hub.close(); await org.close(); }
  }, 120_000);
});
