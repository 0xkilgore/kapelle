// Build item (c): Resend inbound against the documented contract with recorded fixtures — no account, no calls.
// Svix known-answer vector; then through the real launchers: hub Svix check, runtime re-verification of the raw bytes,
// content fetched via the port (text attachment only), replay without refetch, payload conflict, HTML-only extraction.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { request } from "node:http";
import { verifySvix, htmlToText, type ResendContentPort } from "../src/org/resend-inbound.js";
import { openOrgRuntime } from "../src/org/org-runtime.js";
import { openHub } from "../src/hub/hub-launcher.js";
import { runtimeCatalogSchema, claudeProfileFromBinding } from "../src/agent-kit/runtime-catalog.js";
import { catalogSha256 } from "../src/agent-kit/kit-host.js";
import { hosted } from "./org-meeting-kit.js";
import { RP, ORIGIN } from "./soft-authenticator.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const fixture = (n: string) => readFileSync(fileURLToPath(new URL(`./fixtures/resend/${n}`, import.meta.url)), "utf8");
const svixSign = (secret: string, id: string, ts: string, body: string) =>
  "v1," + createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64");

it("Svix verification matches the published known-answer vector (the signature Resend's docs show) and refuses variants", () => {
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", h = { id: "msg_p5jXN8AQM9LWM0D4loKWxJek", timestamp: "1614265330", signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=" };
  const body = '{"test": 2432232314}', now = 1614265330 * 1000;
  expect(() => verifySvix(secret, h, body, now)).not.toThrow();
  expect(() => verifySvix(secret, { ...h, signature: "v1,bogus v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=" }, body, now)).not.toThrow(); // any listed signature
  expect(() => verifySvix(secret, h, body.replace("2432", "2433"), now)).toThrow("intake_signature_invalid");
  expect(() => verifySvix(secret, { ...h, signature: "v2,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=" }, body, now)).toThrow("intake_signature_invalid");
  expect(() => verifySvix(secret, h, body, now + 301_000)).toThrow("intake_signature_stale");
  expect(() => verifySvix("not-a-whsec", h, body, now)).toThrow("intake_secret_invalid");
  expect(htmlToText("<p>Hi <b>there</b></p><script>steal()</script><style>x{}</style>&amp; bye")).toBe("Hi there\n& bye");
});

describe.skipIf(!enabled)("Resend inbound through the launchers (fixtures)", () => {
  it("hub + runtime verify Svix; content via port; text attachments only; replay without refetch; conflict refused", async () => {
    const dir = (p: string) => { const d = realpathSync(mkdtempSync(join("/tmp", p))); chmodSync(d, 0o700); return d; };
    const sub = (r: string, n: string) => { const d = join(r, n); mkdirSync(d, { mode: 0o700 }); return d; };
    const file = (p: string, c: string) => { writeFileSync(p, c, { mode: 0o600 }); return p; };
    const base = dir("kres-"), root = sub(base, "org"), state = sub(root, "state"), folder = sub(root, "folder"), run = sub(root, "run"), opsDir = sub(root, "ops"), secrets = sub(root, "secrets");
    const W4 = { model: "claude-opus-5-5", credentialTeamId: "00000000-0000-4000-8000-000000000001", credentialKind: "claude-code-oauth" as const, runtime: "claude-agent-sdk" as const,
      sdkVersion: "0.2.90", cliVersion: "2.1.295", maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: "isolated" as const, thinking: "adaptive" as const, effort: "high" as const };
    const catalogPath = file(join(root, "catalog.json"), JSON.stringify(runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [claudeProfileFromBinding("claude-current", W4, "x"), hosted] })));
    const whsec = "whsec_" + randomBytes(24).toString("base64");
    const cfg = { contract: "kapelle.org-runtime/v1", orgId: "exna", label: "EXNA", stateRoot: state, folder, accessSocket: join(run, "a.sock"), opsSocket: join(opsDir, "o.sock"), rpId: RP, origins: [ORIGIN],
      installations: [{ installationId: "resend-exna", domain: "exna.in.kapelle.test", secretFile: file(join(secrets, "whsec"), whsec), provider: "resend" }],
      catalogPath, catalogSha256: catalogSha256(catalogPath), hostedProfileId: "hosted-sonnet", hosted: { secretFile: file(join(secrets, "k"), "sk-or-v1-SYNTHETIC"), monthlyUsd: 5 }, replyDomain: "reply.exna.kapelle.test" };
    // No port -> the runtime refuses to start a Resend installation (nothing can call Resend by accident).
    await expect(openOrgRuntime(cfg)).rejects.toThrow("org_resend_key_missing"); // no port injected and no key file
    let address = "";
    const calls = { get: 0, list: 0, download: [] as string[] };
    const attachments = JSON.parse(fixture("attachments.json")).data;
    let receiving = JSON.parse(fixture("receiving-get.json"));
    const port: ResendContentPort = {
      async getReceived(id) { calls.get++; return { ...receiving, id, to: [address] }; },
      async listAttachments() { calls.list++; return attachments; },
      async download(url) { calls.download.push(url); return Buffer.from("# Agenda\n1. Cleanup date\n"); },
    };
    const org = await openOrgRuntime(cfg, { resendPort: port });
    const ops = (route: string, body: unknown = {}): Promise<any> => new Promise((res, rej) => { const data = Buffer.from(JSON.stringify(body));
      const r = request({ socketPath: cfg.opsSocket, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (x) => {
        const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => res(JSON.parse(Buffer.concat(c).toString()))); }); r.on("error", rej); r.end(data); });
    const kp = generateKeyPairSync("ed25519"); await ops("/ops/envelope-key/add", { kid: "k1", publicJwk: kp.publicKey.export({ format: "jwk" }) });
    const mail: any[] = [];
    const hub = await openHub({ contract: "kapelle.hub/v1", listen: { host: "127.0.0.1", port: 0 }, mailSpool: sub(base, "spool"),
      orgs: [{ orgId: "exna", installationId: org.sqlite.identity.installationId, accessSocket: cfg.accessSocket, kid: "k1", keyFile: file(join(base, "k.pem"), kp.privateKey.export({ format: "pem", type: "pkcs8" }) as string), origin: ORIGIN }],
      ingress: [{ installationId: "resend-exna", orgId: "exna", secretFile: cfg.installations[0].secretFile, provider: "resend" }] }, { mailer: (m) => mail.push(m) });
    const url = `http://127.0.0.1:${hub.port}`;
    try {
      const b = await ops("/ops/bootstrap/invite", { email: "alex@exna.test" });
      expect((await (await fetch(`${url}/o/exna/invite/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(b.link).hash.replace(/^#token=/, "") }) })).json() as any).ok).toBe(true);
      await fetch(`${url}/o/exna/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "alex@exna.test" }) }); await new Promise((r) => setTimeout(r, 20));
      const cookie = ((await fetch(`${url}/o/exna/magic?token=${new URL(mail[0].link).searchParams.get("token")}`)).headers.get("set-cookie") ?? "").split(";")[0];
      expect(cookie).toMatch(/^kh_exna=/);
      address = (await ops("/ops/intake/token/issue", { email: "alex@exna.test" })).address; // option A: Ops issues submission addresses
      const event = fixture("email-received.json").replace("__INTAKE_ADDRESS__", address);
      const deliver = (body: string, o: { secret?: string; id?: string } = {}) => { const id = o.id ?? "msg_" + randomBytes(8).toString("hex"), ts = String(Math.floor(Date.now() / 1000));
        return fetch(`${url}/ingress/email/resend-exna`, { method: "POST", headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": svixSign(o.secret ?? whsec, id, ts, body) }, body }); };
      // Hub refuses a wrong secret and our fake-provider headers on a Resend installation.
      expect((await deliver(event, { secret: "whsec_" + randomBytes(24).toString("base64") })).status).toBe(401);
      expect((await fetch(`${url}/ingress/email/resend-exna`, { method: "POST", headers: { "webhook-id": "x".repeat(12), "webhook-timestamp": "1", "webhook-signature": "v1,x" }, body: event })).status).toBe(401);
      // Accepted: content from the Receiving API (text body), the text attachment downloaded, the PDF never downloaded.
      const ok = await deliver(event, { id: "msg_first_delivery" });
      expect(ok.status).toBe(200);
      const rec = org.sqlite.db.prepare("SELECT * FROM intake_records").get() as any;
      expect(rec).toMatchObject({ state: "accepted", provider_event_id: "56761188-7520-42d8-8898-ff6fc54ce618" });
      const dir = join(folder, "reviewers-private", "intake", rec.intake_id);
      expect(readFileSync(join(dir, "message.md"), "utf8")).toBe("Subject: October meeting notes\n\nConfirmed: neighborhood cleanup on Saturday Oct 31.\nFlyer says 10am; notes say 9am.");
      expect(readdirSync(dir).sort()).toEqual(["attachment-1-agenda.md", "message.md"]);
      expect(JSON.parse(rec.files).refused).toEqual([{ name: "attachment-2-flyer.pdf", reason: "intake_attachment_type_not_admitted" }]);
      expect(calls).toEqual({ get: 1, list: 1, download: ["https://inbound-cdn.resend.com/a/2a0c9ce0?signature=sig-1"] });
      // A Svix retry of the same delivery replays without refetching; a different body for the same email_id is refused.
      expect((await deliver(event, { id: "msg_first_delivery" })).status).toBe(200);
      expect(calls.get).toBe(1);
      expect((await deliver(event.replace("October meeting notes", "Changed subject"))).status).toBe(422);
      // The runtime re-verifies the raw bytes even if a hub forwards a bad signature straight to the socket.
      const forged: any = await new Promise((res, rej) => { const data = Buffer.from(JSON.stringify({ installationId: "resend-exna", headers: { id: "msg_forged", timestamp: String(Math.floor(Date.now() / 1000)), signature: "v1,AAAA" }, body: event }));
        const r = request({ socketPath: cfg.accessSocket, path: "/intake/email", method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (x) => {
          const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => res(JSON.parse(Buffer.concat(c).toString()))); }); r.on("error", rej); r.end(data); });
      expect(forged).toEqual({ ok: false, error: "intake_signature_invalid" });
      // HTML-only message: text extracted (scripts dropped), never rendered.
      receiving = { ...receiving, text: null };
      const second = event.replace("56761188-7520-42d8-8898-ff6fc54ce618", "11111111-2222-4333-8444-555555555555");
      expect((await deliver(second)).status).toBe(200);
      const rec2 = org.sqlite.db.prepare("SELECT intake_id FROM intake_records WHERE provider_event_id='11111111-2222-4333-8444-555555555555'").get() as any;
      expect(readFileSync(join(folder, "reviewers-private", "intake", rec2.intake_id, "message.md"), "utf8")).toBe("Subject: October meeting notes\n\nConfirmed: neighborhood cleanup on Saturday Oct 31.");
      // An unknown address is quarantined without any content fetch.
      const before = calls.get;
      expect((await deliver(event.replace(address, "intake+UNKNOWN0000000000000000@exna.in.kapelle.test").replace("56761188", "99999999"))).status).toBe(200);
      expect(calls.get).toBe(before); // classified from webhook metadata; content never fetched
      expect((org.sqlite.db.prepare("SELECT state, files FROM intake_records WHERE provider_event_id LIKE '99999999%'").get() as any)).toEqual({ state: "quarantined", files: null });
    } finally { await hub.close(); await org.close(); }
  }, 180_000);
});
