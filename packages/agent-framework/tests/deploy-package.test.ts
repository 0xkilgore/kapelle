// Deployment package (prepared, not run): the rendered configs pass the real schemas, carry no secret values, and agree with the
// systemd units and the runbook on every path; then the org runtime and the hub BOOT from exactly the rendered configs (in a
// scratch root, directories made as the runbook says) and the admin CLI reads Ops status. No systemd, Caddy or network here.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { request } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { render, layout } from "../deploy/kapelle-admin.js";
import { orgRuntimeConfigSchema, openOrgRuntime } from "../src/org/org-runtime.js";
import { hubConfigSchema, openHub } from "../src/hub/hub-launcher.js";
import { catalogSha256 } from "../src/agent-kit/kit-host.js";
import { signWebhook } from "../src/org/intake.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const repo = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const unit = (n: string) => readFileSync(repo(`deploy/systemd/${n}`), "utf8");
const ops = (socket: string, route: string, body: unknown = {}): Promise<any> => new Promise((res, rej) => { const data = Buffer.from(JSON.stringify(body));
  const r = request({ socketPath: socket, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (x) => {
    const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => res(JSON.parse(Buffer.concat(c).toString()))); }); r.on("error", rej); r.end(data); });

it("units, Caddyfile, runbook and the admin tool agree on the server layout", () => {
  const L = layout({ org: "exna" }), org = unit("kapelle-org@.service"), hub = unit("kapelle-hub.service"), bk = unit("kapelle-backup@.service");
  const readme = readFileSync(repo("deploy/README.md"), "utf8"), caddy = readFileSync(repo("deploy/caddy/Caddyfile.template"), "utf8");
  // IMAGES-V1 live bug (Oct 23): two matched request_body directives: the image upload route (the hub's own route shape) up to
  // 4 MiB (= the hub's image cap), everything else 1 MB; a 413 is answered as the app's JSON refusal.
  const RX = "path_regexp ^/o/[a-z0-9][a-z0-9-]{1,62}/upload/im_[a-f0-9]{32}$";
  expect(caddy).toContain("@imageUpload {\n\t\tmethod PUT\n\t\t" + RX + "\n\t}");
  expect(caddy).toContain("@notImageUpload {\n\t\tnot {\n\t\t\tmethod PUT\n\t\t\t" + RX + "\n\t\t}\n\t}");
  expect(caddy).toContain("request_body @imageUpload {\n\t\tmax_size 4MiB\n\t}");
  expect(caddy).toContain("request_body @notImageUpload {\n\t\tmax_size 1MB\n\t}");
  // The main site (the optional FILES-HOST block, the files host's own site, has its own 1 KB cap; caddy-template.test.ts covers it).
  const main = caddy.replace(/^# FILES-HOST-BEGIN[\s\S]*^# FILES-HOST-END\n/m, ""), files = caddy.slice(main.length);
  expect(main.match(/max_size/g)).toHaveLength(2);
  expect(main.match(/request_body \{/g)).toBeNull(); // no unmatched (site-wide) limit left on the main site
  expect([files.match(/max_size/g), files.match(/request_body \{/g)?.length]).toEqual([["max_size"], 1]);
  expect(caddy).toContain('respond @imageTooLarge `{"ok":false,"error":"image_too_large"}` 413');
  expect(caddy).toContain('respond @tooLarge `{"ok":false,"error":"hub_body_too_large"}` 413');
  // Paths: the unit's writable/runtime dirs are exactly the layout's.
  expect(L.accessSocket).toBe("/run/kapelle-access/exna/access.sock");
  expect(org).toContain("RuntimeDirectory=kapelle-access/%i\nRuntimeDirectoryMode=0710");
  expect(L.opsSocket.startsWith("/var/lib/kapelle/exna/")).toBe(true);
  expect(org).toContain("ReadWritePaths=/var/lib/kapelle/%i /var/backups/kapelle/%i");
  expect(L.backupDir).toBe("/var/backups/kapelle/exna");
  expect(org).toContain("ExecStart=/opt/node/bin/node /opt/kapelle/current/bin/org-serve.mjs /etc/kapelle/orgs/%i.json");
  expect(hub).toContain("ExecStart=/opt/node/bin/node /opt/kapelle/current/bin/hub-serve.mjs /etc/kapelle/hub-config.json");
  expect(bk).toContain("/opt/kapelle/current/bin/backup-cli.mjs backup /etc/kapelle/orgs/%i.json");
  expect(L.hubSpool).toBe("/var/lib/kapelle-hub/spool"); expect(hub).toContain("ReadWritePaths=/var/lib/kapelle-hub");
  // Never root, always confined.
  for (const u of [org, hub, bk]) {
    expect(u).toMatch(/^User=kapelle-/m); expect(u).not.toMatch(/^User=root/m);
    for (const d of ["NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "UMask=0077"]) expect(u, d).toContain(d);
  }
  expect(org).toMatch(/^MemoryMax=512M$/m); expect(hub).toMatch(/^MemoryMax=256M$/m);
  for (const u of [org, hub]) for (const d of ["CapabilityBoundingSet=\n", "SystemCallFilter=@system-service", "ProtectHostname=yes", "ProtectClock=yes"]) expect(u, d).toContain(d);
  // The hub reaches the org only via the org group; Caddy proxies to the hub's loopback port.
  expect(hub).toContain("SupplementaryGroups=kapelle-exna");
  expect(caddy).toContain("reverse_proxy 127.0.0.1:8700"); expect(caddy).toContain("{{DOMAIN}}");
  // Every blocker is stated, and every path in the layout table is a layout path.
  for (const b of ["B1", "B2", "B3", "B4", "B5", "B6", "PREPARED, NOT RUN"]) expect(readme).toContain(b);
  for (const p of ["/run/kapelle-access/exna/access.sock", "/var/backups/kapelle/exna", "/var/lib/kapelle-hub/spool", "/etc/kapelle/secrets/hub/"]) expect(readme).toContain(p);
});

describe.skipIf(!enabled)("the rendered configs boot", () => {
  it("render -> the org runtime and hub start from exactly those files; the admin CLI reads Ops status; no secret values in configs", async () => {
    const root = realpathSync(mkdtempSync("/tmp/kdp-")); chmodSync(root, 0o700);
    const L = layout({ org: "exna", root });
    // Directories and secrets exactly as the runbook makes them (one Unix user here, so the hub shares the org's uid).
    for (const d of [L.stateRoot, L.folder, dirname(L.opsSocket), L.backupDir, L.hubSpool, dirname(L.webhookSecret), dirname(L.envelopeKey)]) mkdirSync(d, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(L.accessSocket), { recursive: true, mode: 0o710 }); chmodSync(dirname(L.accessSocket), 0o710);
    const whsec = randomBytes(24).toString("base64url");
    for (const [p, v] of [[L.webhookSecret, whsec], [L.openrouterKey, "sk-or-v1-SYNTHETIC-NOT-A-REAL-KEY"]] as const) writeFileSync(p, v + "\n", { mode: 0o600 });
    const first = render({ org: "exna", label: "EXNA", domain: "exna.example.org", monthlyUsd: 15, root, intake: "fake" });
    expect(first.hubConfig).toBeNull();
    expect(first).toMatchObject({ monthlyUsd: 15, mail: "spool" });
    expect(() => render({ org: "exna", label: "EXNA", domain: "exna.example.org", monthlyUsd: undefined as never, root })).toThrow("render_monthly_usd_required");
    // Transcription (Fable R-1/R-4): off unless asked; the monthly cap is the owner's (D-1), never a default; deepgram expects a key file.
    expect(orgRuntimeConfigSchema.parse(JSON.parse(readFileSync(L.orgConfig, "utf8"))).transcription).toBeUndefined();
    for (const bad of [{ transcription: "deepgram" as const }, { transcription: "deepgram" as const, transcriptionUsd: 0 }, { transcription: "whisper" as never, transcriptionUsd: 3 }])
      expect(() => render({ org: "exna", label: "EXNA", domain: "exna.example.org", monthlyUsd: 15, root, intake: "fake", ...bad })).toThrow("render_transcription_invalid");
    const withT = render({ org: "exna", label: "EXNA", domain: "exna.example.org", monthlyUsd: 15, root, intake: "fake", transcription: "deepgram", transcriptionUsd: 4 });
    expect(withT.secretsExpected).toContain(L.transcriptionKey);
    expect(orgRuntimeConfigSchema.parse(JSON.parse(readFileSync(L.orgConfig, "utf8"))).transcription).toEqual({ backend: "deepgram", monthlyUsd: 4, secretFile: L.transcriptionKey, qualificationRef: "pending:" });
    render({ org: "exna", label: "EXNA", domain: "exna.example.org", monthlyUsd: 15, root, intake: "fake" }); // back to the rest of this test's config
    const cfg = orgRuntimeConfigSchema.parse(JSON.parse(readFileSync(L.orgConfig, "utf8")));
    expect(cfg.hosted.monthlyUsd).toBe(15);
    expect(cfg).toMatchObject({ orgId: "exna", rpId: "exna.example.org", origins: ["https://exna.example.org"], groupAccess: true, hostedProfileId: "or-sonnet-4-6-us",
      backup: { dir: L.backupDir, everyMinutes: 360, keep: 8 }, catalogSha256: catalogSha256(L.catalog) });
    const fakeFetch = async () => new Response("{}", { status: 503 });
    const org = await openOrgRuntime(cfg, { fetchImpl: fakeFetch as never });
    let hub: Awaited<ReturnType<typeof openHub>> | undefined;
    try {
      const st = await ops(L.opsSocket, "/ops/status");
      expect(st).toMatchObject({ ok: true, orgId: "exna" });
      const kp = generateKeyPairSync("ed25519");
      writeFileSync(L.envelopeKey, kp.privateKey.export({ format: "pem", type: "pkcs8" }) as string, { mode: 0o600 });
      expect((await ops(L.opsSocket, "/ops/envelope-key/add", { kid: "k1", publicJwk: kp.publicKey.export({ format: "jwk" }) })).ok).toBe(true);
      writeFileSync(L.hubMailKey, "re_SYNTHETIC_NOT_A_REAL_KEY_12345\n", { mode: 0o600 });
      const second = render({ org: "exna", label: "EXNA", domain: "exna.example.org", monthlyUsd: 15, root, intake: "fake", installationId: st.installationId, mailFrom: "EXNA <noreply@exna.example.org>" });
      const hubCfg = hubConfigSchema.parse(JSON.parse(readFileSync(second.hubConfig!, "utf8")));
      expect(hubCfg.ingress[0]).toEqual({ installationId: "fake-exna", orgId: "exna", provider: "fake" }); // Fable deploy R-1: no webhook secret on the hub
      expect(readdirSync(dirname(L.envelopeKey)).sort()).toEqual(["exna-envelope.pem", "resend-send.key"]); // the hub's secrets: envelope + mail keys only
      expect(hubCfg).toMatchObject({ labels: { exna: "EXNA" }, mail: { provider: "resend", from: "EXNA <noreply@exna.example.org>", apiKeyFile: L.hubMailKey } });
      expect(hubCfg.labels!.exna).toBe(JSON.parse(readFileSync(L.orgConfig, "utf8")).label); // Fable B2 note: the mail's org name IS the org config's label
      hub = await openHub({ ...hubCfg, listen: { host: "127.0.0.1", port: 0 } }); // 8700 in production; any free port here
      expect(hub.mail).toEqual({ sent: 0, failed: 0, lastError: null }); // the Resend mailer is wired (key file checked at start); nothing sent
      // R-1: the hub forwards; the runtime alone verifies. A signed webhook is accepted (quarantined: unknown recipient), a
      // forged one is refused BY THE RUNTIME, a structurally empty one by the hub.
      const hook = (sig: string, headers = true) => { const id = "msg_" + randomBytes(6).toString("hex"), ts = String(Math.floor(Date.now() / 1000));
        const raw = JSON.stringify({ type: "email.received", data: { email_id: id, message_id: `<${id}@m.test>`, from: "a@b.test", to: ["intake+UNKNOWNTOKEN000000@in.exna.example.org"], subject: "S", text: "T" } });
        return fetch(`http://127.0.0.1:${hub!.port}/ingress/email/fake-exna`, { method: "POST", body: raw,
          headers: headers ? { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig === "good" ? signWebhook(whsec, "fake-exna", id, ts, raw) : sig } : {} }).then(async (r) => [r.status, (await r.json() as any).error ?? null]); };
      expect(await hook("good")).toEqual([200, null]);
      expect(await hook("v1,forged-by-a-compromised-hub")).toEqual([401, "intake_signature_invalid"]);
      expect(await hook("", false)).toEqual([401, "hub_signature_missing"]);
      const page = await fetch(`http://127.0.0.1:${hub.port}/o/exna/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
      // Secrets appear in configs only as paths.
      for (const f of [L.catalog, L.orgConfig, second.hubConfig!]) { const t = readFileSync(f, "utf8"); expect(t).not.toContain(whsec); expect(t).not.toMatch(/sk-or-|re_SYNTHETIC|BEGIN PRIVATE KEY/); }
      // The admin CLI's ops subcommand against the rendered config.
      // Async (never spawnSync): the runtime answering the CLI lives in THIS process's event loop.
      const tsx = process.env.KAPELLE_TEST_TSX_CLI;
      const admin = (...args: string[]) => new Promise<any>((res) => execFile(process.execPath, [tsx!, repo("deploy/kapelle-admin.ts"), ...args], { timeout: 60_000 }, (_e, out) => res(JSON.parse(String(out)))));
      if (tsx) {
        expect(await admin("ops", L.orgConfig, "/ops/status")).toMatchObject({ ok: true, orgId: "exna", installationId: st.installationId });
        expect(await admin("ops", L.orgConfig, "/etc/passwd")).toEqual({ ok: false, error: "ops_route_invalid" });
      }
      // While it runs, a second runtime on the same state is refused by the single-writer lock.
      await expect(openOrgRuntime(cfg, { fetchImpl: fakeFetch as never })).rejects.toThrow("worker_lock_held");
    } finally { await hub?.close(); await org.close(); }
    // The runbook's restore drill, exactly: backup-cli restore of the newest set into a NEW root, then a runtime starts on it
    // (with the production config's groupAccess socket mode) and answers Ops status.
    if (process.env.KAPELLE_TEST_TSX_CLI) {
      const sets = readdirSync(L.backupDir).filter((n) => /^exna-/.test(n)).sort();
      expect(sets.length).toBeGreaterThanOrEqual(1);
      const drillRoot = join(root, "drill-root");
      const restored = await new Promise<any>((res) => execFile(process.execPath, [process.env.KAPELLE_TEST_TSX_CLI!, repo("src/org/backup-cli.ts"), "restore", L.orgConfig, join(L.backupDir, sets.at(-1)!), drillRoot], { timeout: 60_000 },
        (_e, out) => res(JSON.parse(String(out)))));
      expect(restored).toMatchObject({ ok: true, held: false });
      const drillCfg = JSON.parse(readFileSync(join(drillRoot, "org-config.json"), "utf8"));
      expect(drillCfg).toMatchObject({ groupAccess: true }); expect(drillCfg.backup).toBeUndefined();
      const drill = await openOrgRuntime(drillCfg, { fetchImpl: fakeFetch as never });
      try { expect(await ops(drillCfg.opsSocket, "/ops/status")).toMatchObject({ ok: true, orgId: "exna", installationId: restored.installationId }); }
      finally { await drill.close(); }
    }
    // The production intake (resend): refused without the org's Resend key file; starts with it (B3 builds the client).
    render({ org: "exna", label: "EXNA", domain: "exna.example.org", monthlyUsd: 15, root });
    const resendCfg = JSON.parse(readFileSync(L.orgConfig, "utf8"));
    expect(resendCfg.installations[0]).toMatchObject({ provider: "resend", apiKeyFile: L.resendApiKey });
    await expect(openOrgRuntime(resendCfg, { fetchImpl: fakeFetch as never })).rejects.toThrow("org_resend_key_missing");
    writeFileSync(L.resendApiKey, "re_SYNTHETIC_NOT_A_REAL_KEY_12345\n", { mode: 0o600 });
    const live = await openOrgRuntime(resendCfg, { fetchImpl: fakeFetch as never, resendFetch: (async () => { throw new Error("no network in tests"); }) as never });
    await live.close();
  }, 120_000);
});

it("the production UI copy (cp src/hub/ui/* bin/ui/, NOT recursive) carries every served UI file, the font and its license", async () => {
  // Owner UI feedback (Oct 23) + Ops: a missing font falls back silently to the system font, so no browser test would notice.
  // Ops' build copies ui/* without -R (a directory would stop it under set -e): every served file must be FLAT and present.
  const { Hub } = await import("../src/hub/hub.js");
  const ui = repo("src/hub/ui"), entries = readdirSync(ui, { withFileTypes: true });
  expect(entries.filter((e) => !e.isFile()).map((e) => e.name)).toEqual([]); // no subfolder for the copy to trip on
  const copied = new Set(entries.map((e) => e.name));
  const served = Object.keys((Hub as any).UI_TYPES as Record<string, string>);
  expect(served).toContain("InterVariable.woff2");
  for (const name of served) { expect(name).not.toContain("/"); expect(copied.has(name)).toBe(true); }
  expect(copied.has("Inter-LICENSE.txt")).toBe(true); expect(copied.has("Inter-SOURCE.txt")).toBe(true);
  expect(readFileSync(join(ui, "Inter-LICENSE.txt"), "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
  const font = readFileSync(join(ui, "InterVariable.woff2"));
  expect(font.subarray(0, 4).toString("latin1")).toBe("wOF2");
  // The stylesheet points at the flat file, the hub's own route serves it.
  expect(readFileSync(join(ui, "app.css"), "utf8")).toContain('url("InterVariable.woff2")');
  let head: Record<string, string> = {}, body: Buffer = Buffer.alloc(0);
  (Hub.prototype as any).static.call({}, { writeHead: (_: number, h: Record<string, string>) => { head = h; }, end: (b: Buffer) => { body = b; } }, "InterVariable.woff2");
  expect(head["content-type"]).toBe("font/woff2"); expect(head["cache-control"]).toBe("private, max-age=86400"); // Fable N-2
  // Fable N-3: the upstream asset is recorded next to the license, and its recorded sha is this file's.
  expect(readFileSync(join(ui, "Inter-SOURCE.txt"), "utf8")).toContain("sha256 " + createHash("sha256").update(font).digest("hex"));
  let other: Record<string, string> = {};
  (Hub.prototype as any).static.call({}, { writeHead: (_: number, h: Record<string, string>) => { other = h; }, end: () => {} }, "app.css");
  expect(other["cache-control"]).toBe("no-store"); expect(head["content-security-policy"]).toContain("font-src 'self'"); expect(body.equals(font)).toBe(true);
});
