// G-1 Product driver against a world shaped exactly like Ops' g1-tools output (world.json, <root>/org-config.json, hub spool),
// with in-process runtimes and the fake provider: Q&A, passkey adopt/plan/approve -> drafts, the quota org's refusal shape,
// and backup-under-load + restore + start. Also pins the G-1 rpId/origin requirement for the synthetic authenticator.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { request } from "node:http";
import { openOrgRuntime } from "../src/org/org-runtime.js";
import { openHub } from "../src/hub/hub-launcher.js";
import { signWebhook } from "../src/org/intake.js";
import { runtimeCatalogSchema, claudeProfileFromBinding } from "../src/agent-kit/runtime-catalog.js";
import { catalogSha256 } from "../src/agent-kit/kit-host.js";
import { hosted } from "./org-meeting-kit.js";
import { runLoad } from "../g1/g1-load.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const RP = "g1.kapelle.test", ORIGIN = "https://g1.kapelle.test";
const sub = (r: string, n: string) => { const d = join(r, n); mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700); return d; };
const file = (p: string, c: string) => { writeFileSync(p, c, { mode: 0o600 }); return p; };
const W4 = { model: "claude-opus-5-5", credentialTeamId: "00000000-0000-4000-8000-000000000001", credentialKind: "claude-code-oauth" as const, runtime: "claude-agent-sdk" as const,
  sdkVersion: "0.2.90", cliVersion: "2.1.295", maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: "isolated" as const, thinking: "adaptive" as const, effort: "high" as const };
// Per-org fake model: a short latency (the server's fake had 300 ms) and a per-call cost (the quota org pays more, so it reaches
// its cap after real drafts and answers, as on G-1).
const fakeFetchAt = (cost: number) => async () => { await new Promise((r) => setTimeout(r, 50)); return new Response(JSON.stringify({ id: "gen-1", model: "anthropic/claude-sonnet-4.6", provider: "Anthropic",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: "The member notes do not say." } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost } }),
  { status: 200, headers: { "content-type": "application/json" } }); };
const fakeFetch = fakeFetchAt(0.004);
const ops = (socket: string, route: string, body: unknown = {}): Promise<any> => new Promise((res, rej) => { const data = Buffer.from(JSON.stringify(body));
  const r = request({ socketPath: socket, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (x) => {
    const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => res(JSON.parse(Buffer.concat(c).toString()))); }); r.on("error", rej); r.end(data); });

describe.skipIf(!enabled)("G-1 Product driver (g1/g1-load.ts)", () => {
  it("drives Q&A, passkey plan/approve to drafts, the quota refusal and backup-under-load on an Ops-shaped world", async () => {
    const base = realpathSync(mkdtempSync(join("/tmp", "kg1-"))); chmodSync(base, 0o700);
    const hubDir = sub(base, "hub"), spool = sub(hubDir, "spool"), keys = sub(hubDir, "keys");
    const catalog = runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [claudeProfileFromBinding("claude-current", W4, "x"), hosted] });
    const orgs: any[] = [], runtimes: any[] = [];
    let hub: Awaited<ReturnType<typeof openHub>> | undefined;
    try {
      for (const [i, monthlyUsd] of [[1, 20], [2, 0.2]] as const) {
        const orgId = `org-${i}`, root = sub(base, orgId), secrets = sub(root, "secrets"), catalogPath = file(join(root, "catalog.json"), JSON.stringify(catalog));
        const secret = randomBytes(24).toString("base64url");
        const config = { contract: "kapelle.org-runtime/v1", orgId, label: orgId, stateRoot: sub(root, "state"), folder: sub(root, "folder"),
          accessSocket: join(sub(root, "run"), "access.sock"), opsSocket: join(sub(root, "ops"), "ops.sock"), rpId: RP, origins: [ORIGIN],
          installations: [{ installationId: `inst-${orgId}`, domain: `${orgId}.in.g1.kapelle.test`, secretFile: file(join(secrets, "webhook"), secret) }],
          catalogPath, catalogSha256: catalogSha256(catalogPath), hostedProfileId: "hosted-sonnet", hosted: { secretFile: file(join(secrets, "provider.key"), "sk-g1-SYNTHETIC"), monthlyUsd },
          replyDomain: `reply.${orgId}.g1.kapelle.test`, ...(i === 1 ? { backup: { dir: join(root, "backups"), everyMinutes: 60, keep: 3 } } : {}) };
        file(join(root, "org-config.json"), JSON.stringify(config));
        const rt = await openOrgRuntime(config, { fetchImpl: (i === 2 ? fakeFetchAt(0.05) : fakeFetch) as never }); runtimes.push(rt);
        const kp = generateKeyPairSync("ed25519"); await ops(config.opsSocket, "/ops/envelope-key/add", { kid: "k1", publicJwk: kp.publicKey.export({ format: "jwk" }) });
        // Option A: the first admin joins from the Ops one-time link (accepted here at the runtime; the hub is not open yet).
        const email = `admin@${orgId}.g1.test`;
        expect(rt.access.acceptInvite(new URL((await ops(config.opsSocket, "/ops/bootstrap/invite", { email })).link).hash.slice(7))).toMatchObject({ role: "admin" });
        orgs.push({ orgId, root, config, secret, monthlyUsd, kp, admin: { email } });
      }
      hub = await openHub({ contract: "kapelle.hub/v1", listen: { host: "127.0.0.1", port: 0 }, mailSpool: spool,
        orgs: orgs.map((o) => ({ orgId: o.orgId, installationId: runtimes[orgs.indexOf(o)].sqlite.identity.installationId, accessSocket: o.config.accessSocket, kid: "k1",
          keyFile: file(join(keys, `${o.orgId}.pem`), o.kp.privateKey.export({ format: "pem", type: "pkcs8" }) as string), origin: ORIGIN })),
        ingress: orgs.map((o) => ({ installationId: `inst-${o.orgId}`, orgId: o.orgId, secretFile: o.config.installations[0].secretFile })) });
      const url = `http://127.0.0.1:${hub.port}`;
      // Ten submissions per org (G-1 finding: a whole-folder snapshot overflowed the packet past seven files).
      for (const [n, rt] of runtimes.entries()) {
        const o = orgs[n], { address } = rt.intake.issueToken((rt.sqlite.db.prepare("SELECT member_id FROM access_members").get() as { member_id: string }).member_id, `inst-${o.orgId}`);
        for (let k = 1; k <= 10; k++) { const id = `msg_${o.orgId}_${k}`, ts = String(Math.floor(Date.now() / 1000));
          const raw = JSON.stringify({ type: "email.received", data: { email_id: id, message_id: `<${k}@s.test>`, from: "m@s.test", to: [address], subject: `Note ${k}`, text: `Synthetic note ${k}.` } });
          expect((await fetch(`${url}/ingress/email/inst-${o.orgId}`, { method: "POST", headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": signWebhook(o.secret, `inst-${o.orgId}`, id, ts, raw) }, body: raw })).status).toBe(200); }
      }
      file(join(base, "world.json"), JSON.stringify({ n: 2, hubDir, spool, keys, orgs: orgs.map((o) => ({ orgId: o.orgId, root: o.root, secret: o.secret, monthlyUsd: o.monthlyUsd,
        accessSocket: o.config.accessSocket, opsSocket: o.config.opsSocket, webhookFile: o.config.installations[0].secretFile, admin: o.admin })) }));

      const load = runLoad(base, 8, 60, { hub: url, startDelayMs: 0, openRuntime: (c) => openOrgRuntime(c, { fetchImpl: fakeFetch as never }) });
      // Option A: make every hub session's sign-in 61 minutes old mid-run (as in a run longer than an hour): the driver must
      // sign in again and keep approving, never report access_session_not_fresh.
      await new Promise((x) => setTimeout(x, 2500));
      for (const sess of (hub.hub as any).sessions.values()) sess.authAt -= 61 * 60_000;
      const r = await load;
      const text = JSON.stringify(r);
      expect(text).not.toContain("The member notes do not say."); // never model text
      expect(r.orgs["org-1"]).toMatchObject({ login: 202, plan: { skipped: null, errors: {} } });
      expect(r.orgs["org-1"].ask).toMatchObject({ refused: {}, errors: {} });
      expect(r.orgs["org-1"].ask.ok).toBeGreaterThan(0); // members can ask before the first notes exist
      expect(r.orgs["org-1"].plan.approved).toBeGreaterThanOrEqual(2);
      expect(r.orgs["org-1"].plan.sessionRefreshes).toBeGreaterThanOrEqual(1);
      for (const id of ["org-1", "org-2"]) expect(r.orgs[id].plan.prepared, id).toBe(r.orgs[id].plan.adopted); // every adopted submission prepares
      expect(r.orgs["org-1"].plan.drafts).toBe(r.orgs["org-1"].plan.approved);
      expect(r.orgs["org-1"].quota).toBeNull();
      // G-1 finding: on the capped org a question is a definite REFUSED with the cap label (was FAILED kit_chat_inference_failed).
      expect(r.orgs["org-2"].quota).toMatchObject({ monthlyUsd: 0.2, refusal: { path: "ask", status: "REFUSED", reason: "hosted_monthly_cap_exceeded" } });
      expect(r.orgs["org-2"].ask.ok).toBeGreaterThanOrEqual(1);
      expect(r.orgs["org-2"].ask.refused).not.toHaveProperty("kit_chat_inference_failed");
      // held is true when a model call was in flight at backup time: the restored org holds that sent effect, never replays it.
      expect(r.backup).toMatchObject({ org: "org-1", status: "ok", restoredStatusOk: true, held: expect.any(Boolean) });
    } finally { await hub?.close(); for (const rt of runtimes) await rt.close(); }
  }, 180_000);
});
