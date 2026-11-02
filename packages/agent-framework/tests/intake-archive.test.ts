// Intake archiving (the last open bound from G-1): past ~500 stored submissions the intake folder exceeds the snapshot walk's
// 1000 entries and every plan is refused. Archiving moves processed submissions out of the preparer's scope (oldest first,
// over budget or old), keeps the newest adopted ones and anything not yet processed, and is crash-safe (DB is the truth).
import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { openOrgRuntime } from "../src/org/org-runtime.js";
import { openHub } from "../src/hub/hub-launcher.js";
import { signWebhook } from "../src/org/intake.js";
import { runtimeCatalogSchema, claudeProfileFromBinding } from "../src/agent-kit/runtime-catalog.js";
import { catalogSha256 } from "../src/agent-kit/kit-host.js";
import { hosted } from "./org-meeting-kit.js";
import { RP, ORIGIN } from "./soft-authenticator.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const W4 = { model: "claude-opus-5-5", credentialTeamId: "00000000-0000-4000-8000-000000000001", credentialKind: "claude-code-oauth" as const, runtime: "claude-agent-sdk" as const,
  sdkVersion: "0.2.90", cliVersion: "2.1.295", maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: "isolated" as const, thinking: "adaptive" as const, effort: "high" as const };

describe.skipIf(!enabled)("intake archiving keeps plans possible", () => {
  it("over the walk bound -> plan refused; archive -> under budget, plan works; kept, hidden, refused, restored, reconciled", async () => {
    const base = realpathSync(mkdtempSync("/tmp/kia-")); chmodSync(base, 0o700);
    const sub = (r: string, n: string) => { const d = join(r, n); mkdirSync(d, { mode: 0o700 }); return d; };
    const file = (p: string, c: string) => { writeFileSync(p, c, { mode: 0o600 }); return p; };
    const root = sub(base, "exna"), secrets = sub(root, "secrets");
    const catalogPath = file(join(root, "catalog.json"), JSON.stringify(runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [claudeProfileFromBinding("claude-current", W4, "x"), hosted] })));
    const secret = randomBytes(24).toString("base64url");
    const cfg = { contract: "kapelle.org-runtime/v1", orgId: "exna", label: "EXNA", stateRoot: sub(root, "state"), folder: sub(root, "folder"), accessSocket: join(sub(root, "run"), "a.sock"),
      opsSocket: join(sub(root, "ops"), "o.sock"), rpId: RP, origins: [ORIGIN], installations: [{ installationId: "inst-exna", domain: "in.exna.test", secretFile: file(join(secrets, "wh"), secret) }],
      catalogPath, catalogSha256: catalogSha256(catalogPath), hostedProfileId: "hosted-sonnet", hosted: { secretFile: file(join(secrets, "k"), "sk-or-v1-SYNTHETIC"), monthlyUsd: 5 },
      replyDomain: "reply.exna.test", intakeArchive: { afterDays: 3650, budgetEntries: 100 } };
    const org = await openOrgRuntime(cfg, { fetchImpl: (async () => new Response("{}", { status: 503 })) as never });
    const ops = (route: string, body: unknown = {}): Promise<any> => new Promise((res, rej) => { const data = Buffer.from(JSON.stringify(body));
      const r = request({ socketPath: cfg.opsSocket, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (x) => {
        const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => res(JSON.parse(Buffer.concat(c).toString()))); }); r.on("error", rej); r.end(data); });
    const kp = generateKeyPairSync("ed25519"); await ops("/ops/envelope-key/add", { kid: "k1", publicJwk: kp.publicKey.export({ format: "jwk" }) });
    const mail: any[] = [];
    const hub = await openHub({ contract: "kapelle.hub/v1", listen: { host: "127.0.0.1", port: 0 }, mailSpool: sub(base, "spool"),
      orgs: [{ orgId: "exna", installationId: org.sqlite.identity.installationId, accessSocket: cfg.accessSocket, kid: "k1", keyFile: file(join(base, "k.pem"), kp.privateKey.export({ format: "pem", type: "pkcs8" }) as string), origin: ORIGIN }],
      ingress: [] }, { mailer: (m) => mail.push(m) });
    const url = `http://127.0.0.1:${hub.port}`;
    const post = async (path: string, body: unknown, cookie = "") => (await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) })).json() as Promise<any>;
    try {
      const b = await ops("/ops/bootstrap/invite", { email: "robin@exna.test" });
      expect((await post("/o/exna/invite/accept", { token: new URL(b.link).hash.replace(/^#token=/, "") })).ok).toBe(true);
      await post("/o/exna/login", { email: "robin@exna.test" }); await new Promise((r) => setTimeout(r, 30));
      const cookie = ((await fetch(`${url}/o/exna/magic?token=${new URL(mail.at(-1).link).searchParams.get("token")}`)).headers.get("set-cookie") ?? "").split(";")[0];
      const act = async (action: string, body: unknown, digest: string | null = null) => { const operationId = randomUUID(), ch = await post("/o/exna/challenge", { action, body, artifactDigest: digest, operationId }, cookie);
        return post("/o/exna/act", { challengeId: ch.challengeId, action, body, artifactDigest: digest, operationId }, cookie); };
      const { address } = org.intake.issueToken((org.sqlite.db.prepare("SELECT member_id FROM access_members").get() as { member_id: string }).member_id, "inst-exna");
      let n = 0;
      const ingest = async (processed = true) => { const id = `msg_${String(++n).padStart(10, "0")}`, ts = String(Math.floor(Date.now() / 1000));
        const raw = JSON.stringify({ type: "email.received", data: { email_id: id, message_id: `<${id}@m.test>`, from: "robin@exna.test", to: [address], subject: `Note ${n}`, text: `Synthetic note ${n}.` } });
        const r = org.intake.receive("inst-exna", { id, timestamp: ts, signature: signWebhook(secret, "inst-exna", id, ts, raw) }, raw, () => true);
        if (processed) await org.replies.onIntake(r.intakeId); // the reply decision is journalled (no policy: trigger_no_policy)
        return r.intakeId; };
      const first = await ingest();
      for (let i = 0; i < 519; i++) await ingest();
      const unprocessed = [await ingest(false), await ingest(false)];        // no reply decision yet: never archived
      const latest = await ingest();
      const adoptOf = async (intakeId: string, title: string) => (await act("task.adopt", { intakeId, title })).result.taskId as string;
      const taskOld = await adoptOf(first, "Oldest"), taskNew = await adoptOf(latest, "Newest");
      // Over the walk bound: the plan is refused with a plain label (G-1 follow-up).
      expect((await ops("/ops/status")).intakeArchive.intakeEntries).toBeGreaterThan(1000);
      expect(await post("/o/exna/api/plan/prepare", { taskId: taskNew }, cookie)).toMatchObject({ ok: false, error: "plan_intake_folder_full" });
      // Fable archiving F-1: an Ops override outside the config bounds (or an unknown field) is refused, not clamped; nothing moves.
      for (const bad of [{ budgetEntries: 10 }, { budgetEntries: 5000 }, { afterDays: 0 }, { afterDays: 1.5 }, { afterDays: "7" }, { everything: true }])
        expect(await ops("/ops/intake/archive", bad), JSON.stringify(bad)).toEqual({ ok: false, error: "intake_archive_params_invalid" });
      expect((await ops("/ops/status")).intakeArchive.archivedTotal).toBe(0);
      // Archive: oldest first until under budget; the adopted ones (newest 4 adopted) and the unprocessed ones stay.
      const run = await ops("/ops/intake/archive");
      expect(run.ok).toBe(true);
      expect(run.intakeEntries).toBeLessThanOrEqual(100);
      const inDir = join(cfg.folder, "reviewers-private", "intake"), archDir = join(cfg.folder, "reviewers-private", "archive", "intake");
      for (const id of [first, latest, ...unprocessed]) expect(existsSync(join(inDir, id)), id).toBe(true);
      expect(readdirSync(archDir).length).toBe(run.moved);
      expect((await post("/o/exna/api/plan/prepare", { taskId: taskNew }, cookie)).ok).toBe(true);   // plans possible again
      expect((await post("/o/exna/api/plan/prepare", { taskId: taskOld }, cookie)).ok).toBe(true);   // the kept adopted one too
      // Archived submissions leave the Review list and cannot be adopted.
      const listed = new Set((await post("/o/exna/api/intake/list", {}, cookie)).result.intakes.map((i: any) => i.intakeId));
      const someArchived = readdirSync(archDir)[0];
      expect(listed.has(someArchived)).toBe(false);
      expect((await act("task.adopt", { intakeId: someArchived, title: "Late" })).error).toBe("adopt_intake_archived");
      // Restore (Ops) brings one back.
      expect(await ops("/ops/intake/restore", { intakeId: someArchived })).toMatchObject({ ok: true, restored: someArchived });
      expect(existsSync(join(inDir, someArchived))).toBe(true);
      expect((await post("/o/exna/api/intake/list", {}, cookie)).result.intakes.some((i: any) => i.intakeId === someArchived)).toBe(true);
      expect(await ops("/ops/intake/restore", { intakeId: someArchived })).toEqual({ ok: false, error: "intake_not_archived" });
      // Crash reconciliation, both ways: a directory on the wrong side of its record is put back where the DB says.
      const other = readdirSync(archDir)[0];
      renameSync(join(archDir, other), join(inDir, other));               // as if a crash came between record and rename
      org.sqlite.db.prepare("INSERT INTO intake_archive(intake_id, archived_at) VALUES (?, ?)").run(someArchived, new Date().toISOString()); // and the reverse
      await ops("/ops/intake/archive");
      expect(existsSync(join(archDir, other)) && !existsSync(join(inDir, other))).toBe(true);
      expect(existsSync(join(archDir, someArchived)) && !existsSync(join(inDir, someArchived))).toBe(true);
      const st = (await ops("/ops/status")).intakeArchive;
      expect(st).toMatchObject({ afterDays: 3650, budgetEntries: 100 });
      expect(st.archivedTotal).toBe(readdirSync(archDir).length);
      expect((org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM intake_audit WHERE event='intake_archived'").get() as { n: number }).n).toBeGreaterThanOrEqual(run.moved);
    } finally { await hub.close(); await org.close(); }
  }, 300_000);
});
