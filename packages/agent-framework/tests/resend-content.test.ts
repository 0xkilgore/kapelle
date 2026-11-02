// B3: the real Resend Receiving API client (no account, no network: a fixture fetch answers exactly as the documented API).
// The key goes only to api.resend.com; downloads go only to the pinned CDN host and without the key; fixed failure labels.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resendContentPort, RESEND_API } from "../src/org/resend-content.js";
import { IntakeError } from "../src/org/intake.js";
import { openOrgRuntime } from "../src/org/org-runtime.js";
import { runtimeCatalogSchema, claudeProfileFromBinding } from "../src/agent-kit/runtime-catalog.js";
import { catalogSha256 } from "../src/agent-kit/kit-host.js";
import { hosted } from "./org-meeting-kit.js";
import { RP, ORIGIN } from "./soft-authenticator.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const fixture = (n: string) => readFileSync(fileURLToPath(new URL(`./fixtures/resend/${n}`, import.meta.url)), "utf8");
const KEY = "re_SYNTHETIC_NOT_A_REAL_KEY_12345";
const EMAIL_ID = "56761188-7520-42d8-8898-ff6fc54ce618";
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const keyFile = () => { const d = realpathSync(mkdtempSync("/tmp/krc-")); chmodSync(d, 0o700); const f = join(d, "resend-api.key"); writeFileSync(f, KEY + "\n", { mode: 0o600 }); return f; };
/** The documented API, from the recorded fixtures; records every call (url + whether a key was sent). */
function fixtureApi() {
  const calls: { url: string; auth: boolean }[] = [], state = { down: false };
  const f = async (url: string, init: any) => {
    calls.push({ url, auth: "authorization" in init.headers });
    if (state.down && url.startsWith(RESEND_API)) return json({ name: "service_unavailable", message: "try later" }, 503);
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    if (url === `${RESEND_API}/emails/receiving/${EMAIL_ID}`) return json({ ...JSON.parse(fixture("receiving-get.json")), id: EMAIL_ID });
    if (url === `${RESEND_API}/emails/receiving/${EMAIL_ID}/attachments`) return json(JSON.parse(fixture("attachments.json")));
    if (url.startsWith("https://inbound-cdn.resend.com/")) return new Response("# Agenda\n1. Cleanup date\n", { status: 200 });
    return json({ name: "not_found", message: "nope" }, 404);
  };
  return { calls, state, fetch: f };
}
const label = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof IntakeError ? e.reason : "other:" + String(e)));

it("Receiving API client: the documented requests, the key only to api.resend.com, the pinned download host, fixed labels", async () => {
  const api = fixtureApi(), port = resendContentPort({ apiKeyFile: keyFile(), fetch: api.fetch as never });
  const email = await port.getReceived(EMAIL_ID);
  expect(email).toMatchObject({ id: EMAIL_ID, subject: "October meeting notes" });
  expect(Object.keys(email.headers).every((k) => k === k.toLowerCase())).toBe(true);
  const att = await port.listAttachments(EMAIL_ID);
  expect(att.map((a) => [a.filename, a.content_type])).toEqual([["agenda.md", "text/markdown"], ["flyer.pdf", "application/pdf"]]);
  expect((await port.download(att[0].download_url, 1024)).toString()).toContain("Agenda");
  expect(api.calls).toEqual([
    { url: `${RESEND_API}/emails/receiving/${EMAIL_ID}`, auth: true },
    { url: `${RESEND_API}/emails/receiving/${EMAIL_ID}/attachments`, auth: true },
    { url: att[0].download_url, auth: false }, // the signed URL is fetched WITHOUT the API key
  ]);
  // Download host pinning: another host, plain http, embedded credentials, an odd port: refused, nothing fetched.
  const before = api.calls.length;
  for (const u of ["https://evil.example/a/1", "http://inbound-cdn.resend.com/a/1", "https://user:pw@inbound-cdn.resend.com/a/1", "https://inbound-cdn.resend.com:8443/a/1", "not a url"])
    expect(await label(port.download(u, 1024)), u).toMatch(/^resend_download_(host_not_admitted|url_invalid)$/);
  expect(api.calls.length).toBe(before);
  expect(await label(port.download(att[0].download_url, 4))).toBe("resend_response_too_large");
  expect(await label(port.getReceived("../../etc"))).toBe("resend_id_invalid");
  // Failures: by status, malformed body, transport; never the provider's message.
  const with404 = resendContentPort({ apiKeyFile: keyFile(), fetch: (async () => json({ name: "not_found", message: "Email not found" }, 404)) as never });
  expect(await label(with404.getReceived(EMAIL_ID))).toBe("resend_http_404");
  const garbled = resendContentPort({ apiKeyFile: keyFile(), fetch: (async () => new Response("<html>oops</html>", { status: 200 })) as never });
  expect(await label(garbled.getReceived(EMAIL_ID))).toBe("resend_response_malformed");
  const down = resendContentPort({ apiKeyFile: keyFile(), fetch: (async () => { throw new TypeError("ECONNRESET"); }) as never });
  expect(await label(down.listAttachments(EMAIL_ID))).toBe("resend_transport_failed");
  const k = keyFile(); chmodSync(k, 0o644);
  expect(await label(resendContentPort({ apiKeyFile: k, fetch: api.fetch as never }).getReceived(EMAIL_ID))).toBe("resend_key_not_private");
});

describe.skipIf(!enabled)("a Resend installation runs on the real client (no injected port)", () => {
  it("a signed webhook -> the runtime's own client fetches the email + text attachment -> accepted", async () => {
    const base = realpathSync(mkdtempSync("/tmp/krc2-")); chmodSync(base, 0o700);
    const sub = (r: string, n: string) => { const d = join(r, n); mkdirSync(d, { mode: 0o700 }); return d; };
    const file = (p: string, c: string) => { writeFileSync(p, c, { mode: 0o600 }); return p; };
    const root = sub(base, "exna"), secrets = sub(root, "secrets");
    const W4 = { model: "claude-opus-5-5", credentialTeamId: "00000000-0000-4000-8000-000000000001", credentialKind: "claude-code-oauth" as const, runtime: "claude-agent-sdk" as const,
      sdkVersion: "0.2.90", cliVersion: "2.1.295", maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: "isolated" as const, thinking: "adaptive" as const, effort: "high" as const };
    const catalogPath = file(join(root, "catalog.json"), JSON.stringify(runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [claudeProfileFromBinding("claude-current", W4, "x"), hosted] })));
    const whsec = "whsec_" + randomBytes(24).toString("base64");
    const cfg = { contract: "kapelle.org-runtime/v1", orgId: "exna", label: "EXNA", stateRoot: sub(root, "state"), folder: sub(root, "folder"), accessSocket: join(sub(root, "run"), "a.sock"),
      opsSocket: join(sub(root, "ops"), "o.sock"), rpId: RP, origins: [ORIGIN],
      installations: [{ installationId: "resend-exna", domain: "exna.in.kapelle.test", secretFile: file(join(secrets, "whsec"), whsec), provider: "resend", apiKeyFile: file(join(secrets, "resend-api.key"), KEY) }],
      catalogPath, catalogSha256: catalogSha256(catalogPath), hostedProfileId: "hosted-sonnet", hosted: { secretFile: file(join(secrets, "k"), "sk-or-v1-SYNTHETIC"), monthlyUsd: 5 }, replyDomain: "reply.exna.kapelle.test" };
    const api = fixtureApi();
    const org = await openOrgRuntime(cfg, { fetchImpl: (async () => new Response("{}", { status: 503 })) as never, resendFetch: api.fetch as never });
    try {
      const admin = org.access.acceptInvite(org.access.bootstrapInvite("alex@exna.test").token);
      const { address } = org.intake.issueToken(admin.memberId, "resend-exna");
      const raw = fixture("email-received.json").replace("__INTAKE_ADDRESS__", address);
      const id = "msg_" + randomBytes(6).toString("hex"), ts = String(Math.floor(Date.now() / 1000));
      const signature = "v1," + createHmac("sha256", Buffer.from(whsec.slice(6), "base64")).update(`${id}.${ts}.${raw}`).digest("base64");
      const r = await org.intake.receiveResend("resend-exna", { id, timestamp: ts, signature }, raw, () => true);
      expect(r).toMatchObject({ state: "accepted", replayed: false });
      const dir = join(cfg.folder, "reviewers-private", "intake", r.intakeId);
      expect(readdirSync(dir).sort()).toEqual(["attachment-1-agenda.md", "message.md"]);
      expect(readFileSync(join(dir, "message.md"), "utf8")).toContain("Subject: October meeting notes");
      expect(api.calls.map((c) => [c.url.replace(/[?].*/, ""), c.auth])).toEqual([
        [`${RESEND_API}/emails/receiving/${EMAIL_ID}`, true], [`${RESEND_API}/emails/receiving/${EMAIL_ID}/attachments`, true],
        ["https://inbound-cdn.resend.com/a/2a0c9ce0", false]]); // the PDF is never downloaded
    } finally { await org.close(); }
  }, 120_000);

  it("F-1: a transient content-fetch failure is 503 at the hub (no record); the redelivery creates exactly one record", async () => {
    const base = realpathSync(mkdtempSync("/tmp/krc3-")); chmodSync(base, 0o700);
    const sub = (r: string, n: string) => { const d = join(r, n); mkdirSync(d, { mode: 0o700 }); return d; };
    const file = (p: string, c: string) => { writeFileSync(p, c, { mode: 0o600 }); return p; };
    const root = sub(base, "exna"), secrets = sub(root, "secrets");
    const W4 = { model: "claude-opus-5-5", credentialTeamId: "00000000-0000-4000-8000-000000000001", credentialKind: "claude-code-oauth" as const, runtime: "claude-agent-sdk" as const,
      sdkVersion: "0.2.90", cliVersion: "2.1.295", maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: "isolated" as const, thinking: "adaptive" as const, effort: "high" as const };
    const catalogPath = file(join(root, "catalog.json"), JSON.stringify(runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [claudeProfileFromBinding("claude-current", W4, "x"), hosted] })));
    const whsec = "whsec_" + randomBytes(24).toString("base64");
    const cfg = { contract: "kapelle.org-runtime/v1", orgId: "exna", label: "EXNA", stateRoot: sub(root, "state"), folder: sub(root, "folder"), accessSocket: join(sub(root, "run"), "a.sock"),
      opsSocket: join(sub(root, "ops"), "o.sock"), rpId: RP, origins: [ORIGIN],
      installations: [{ installationId: "resend-exna", domain: "exna.in.kapelle.test", secretFile: file(join(secrets, "whsec"), whsec), provider: "resend", apiKeyFile: file(join(secrets, "resend-api.key"), KEY) }],
      catalogPath, catalogSha256: catalogSha256(catalogPath), hostedProfileId: "hosted-sonnet", hosted: { secretFile: file(join(secrets, "k"), "sk-or-v1-SYNTHETIC"), monthlyUsd: 5 }, replyDomain: "reply.exna.kapelle.test" };
    const api = fixtureApi();
    const org = await openOrgRuntime(cfg, { fetchImpl: (async () => new Response("{}", { status: 503 })) as never, resendFetch: api.fetch as never });
    const { openHub } = await import("../src/hub/hub-launcher.js"), { generateKeyPairSync } = await import("node:crypto");
    const kp = generateKeyPairSync("ed25519");
    const hub = await openHub({ contract: "kapelle.hub/v1", listen: { host: "127.0.0.1", port: 0 }, mailSpool: sub(base, "spool"),
      orgs: [{ orgId: "exna", installationId: org.sqlite.identity.installationId, accessSocket: cfg.accessSocket, kid: "k1", keyFile: file(join(base, "k.pem"), kp.privateKey.export({ format: "pem", type: "pkcs8" }) as string), origin: ORIGIN }],
      ingress: [{ installationId: "resend-exna", orgId: "exna", provider: "resend" }] }); // no hub secret (deploy R-1)
    try {
      const admin = org.access.acceptInvite(org.access.bootstrapInvite("alex@exna.test").token);
      const { address } = org.intake.issueToken(admin.memberId, "resend-exna");
      const raw = fixture("email-received.json").replace("__INTAKE_ADDRESS__", address), svixId = "msg_" + randomBytes(6).toString("hex");
      // A Svix redelivery reuses the message id and body with a fresh timestamp and signature.
      const deliver = async (body = raw, id = svixId) => { const ts = String(Math.floor(Date.now() / 1000));
        const signature = "v1," + createHmac("sha256", Buffer.from(whsec.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
        const r = await fetch(`http://127.0.0.1:${hub.port}/ingress/email/resend-exna`, { method: "POST", headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": signature }, body });
        return [r.status, (await r.json() as any).error ?? null]; };
      const records = () => (org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM intake_records").get() as { n: number }).n;
      api.state.down = true;
      expect(await deliver()).toEqual([503, "resend_http_503"]); // retryable: Resend will redeliver
      expect(await deliver()).toEqual([503, "resend_http_503"]);
      expect(records()).toBe(0);                                  // nothing recorded, nothing lost
      api.state.down = false;
      expect(await deliver()).toEqual([200, null]);
      expect(records()).toBe(1);
      expect(await deliver()).toEqual([200, null]);               // a duplicate redelivery replays
      expect(records()).toBe(1);
      // A definite refusal (the email does not exist at Resend) stays 4xx: Resend stops.
      const other = raw.replace("56761188-7520-42d8-8898-ff6fc54ce618", "11111111-2222-4333-8444-555555555555");
      expect(await deliver(other, "msg_" + randomBytes(6).toString("hex"))).toEqual([422, "resend_http_404"]);
      expect(records()).toBe(1);
    } finally { await hub.close(); await org.close(); }
  }, 120_000);
});
