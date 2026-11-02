// Build item (d): scheduled per-org backup sets, the Ops route, retention, the CLI, and restore into a new root that a runtime
// then serves from (new installation id, same members, intakes and files). Backup taken while intake is landing. Fake data.
import { describe, it, expect } from "vitest";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openOrgRuntime } from "../src/org/org-runtime.js";
import { restoreOrgBackup, listOrgBackups } from "../src/org/org-backup.js";
import { signWebhook } from "../src/org/intake.js";
import { runtimeCatalogSchema, claudeProfileFromBinding } from "../src/agent-kit/runtime-catalog.js";
import { catalogSha256 } from "../src/agent-kit/kit-host.js";
import { hosted } from "./org-meeting-kit.js";
import { RP, ORIGIN } from "./soft-authenticator.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const tmp = (p: string) => { const d = realpathSync(mkdtempSync(join("/tmp", p))); chmodSync(d, 0o700); return d; };
const sub = (r: string, n: string) => { const d = join(r, n); mkdirSync(d, { mode: 0o700 }); return d; };
const file = (p: string, c: string) => { writeFileSync(p, c, { mode: 0o600 }); return p; };
const W4 = { model: "claude-opus-5-5", credentialTeamId: "00000000-0000-4000-8000-000000000001", credentialKind: "claude-code-oauth" as const, runtime: "claude-agent-sdk" as const,
  sdkVersion: "0.2.90", cliVersion: "2.1.295", maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: "isolated" as const, thinking: "adaptive" as const, effort: "high" as const };
const ops = (socket: string, route: string): Promise<any> => new Promise((res, rej) => {
  const r = request({ socketPath: socket, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": 2 } }, (x) => {
    const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => res(JSON.parse(Buffer.concat(c).toString()))); });
  r.on("error", rej); r.end("{}");
});
const until = async (f: () => Promise<boolean>) => { for (let i = 0; i < 400; i++) { if (await f()) return; await new Promise((r) => setTimeout(r, 25)); } throw Error("timeout"); };

describe.skipIf(!enabled)("per-org backups (build item d)", () => {
  it("overdue backup at start, Ops route, one at a time, retention, backup under intake load, verified restore, runtime on the restored root", async () => {
    const base = tmp("kbk-"), root = sub(base, "exna"), secrets = sub(root, "secrets"), backupDir = join(base, "backups");
    const catalogPath = file(join(root, "catalog.json"), JSON.stringify(runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [claudeProfileFromBinding("claude-current", W4, "x"), hosted] })));
    const secret = randomBytes(24).toString("base64url");
    const config = { contract: "kapelle.org-runtime/v1", orgId: "exna", label: "EXNA", stateRoot: sub(root, "state"), folder: sub(root, "folder"),
      accessSocket: join(sub(root, "run"), "a.sock"), opsSocket: join(sub(root, "ops"), "o.sock"), rpId: RP, origins: [ORIGIN],
      installations: [{ installationId: "inst-exna", domain: "exna.in.kapelle.test", secretFile: file(join(secrets, "webhook"), secret) }],
      catalogPath, catalogSha256: catalogSha256(catalogPath), hostedProfileId: "hosted-sonnet", hosted: { secretFile: file(join(secrets, "k"), "sk-or-v1-SYNTHETIC"), monthlyUsd: 5 },
      replyDomain: "reply.exna.kapelle.test", backup: { dir: backupDir, everyMinutes: 60, keep: 2 } };
    // A backup directory inside the org's own state or folder is refused (a set would copy itself).
    await expect(openOrgRuntime({ ...config, backup: { ...config.backup, dir: join(config.folder, "bk") } })).rejects.toThrow("org_backup_dir_overlaps");
    const org = await openOrgRuntime(config);
    let restored: Awaited<ReturnType<typeof openOrgRuntime>> | null = null;
    try {
      // None existed, so one is taken right after start.
      await until(async () => (await ops(config.opsSocket, "/ops/status")).backup.ok === 1);
      const admin = org.access.acceptInvite(org.access.bootstrapInvite("alex@exna.test").token); // option A: the Ops one-time link
      const { address } = org.intake.issueToken(admin.memberId, "inst-exna");
      const ingest = (n: number) => { const id = `msg_bk_${n}`, ts = String(Math.floor(Date.now() / 1000));
        const raw = JSON.stringify({ type: "email.received", data: { email_id: id, message_id: `<${n}@x.test>`, from: "a@x.test", to: [address], subject: `Note ${n}`, text: `Body ${n}` } });
        return org.intake.receive("inst-exna", { id, timestamp: ts, signature: signWebhook(secret, "inst-exna", id, ts, raw) }, raw, () => true); };
      for (let i = 1; i <= 5; i++) expect(ingest(i).state).toBe("accepted");
      // Under load: intake keeps landing while a set is taken; a second request while one runs is refused, not queued.
      let n = 5; const load = (async () => { for (let i = 0; i < 20; i++) { ingest(++n); await new Promise((r) => setImmediate(r)); } })();
      const first = org.backupNow(), overlapping = org.backupNow();
      await expect(overlapping).rejects.toThrow("org_backup_in_progress");
      expect(await first).toMatchObject({ files: expect.any(Number), pruned: 0 });
      await load;
      const third = await ops(config.opsSocket, "/ops/backup/now");
      expect(third).toMatchObject({ ok: true, pruned: 1 }); // keep 2: the start-up set is pruned
      const sets = listOrgBackups(backupDir, "exna");
      expect(sets).toHaveLength(2);
      expect(sets[0]).toBe(third.set);
      expect((await ops(config.opsSocket, "/ops/status")).backup).toMatchObject({ ok: 3, failed: 0, sets: 2, lastError: null, last: { set: third.set } });
      const setDir = join(backupDir, third.set), set = JSON.parse(readFileSync(join(setDir, "set.json"), "utf8"));
      expect(set.files.filter((f: any) => f.path.startsWith("folder/reviewers-private/intake/")).length).toBeGreaterThanOrEqual(25);
      expect(readdirSync(setDir).sort()).toEqual(expect.arrayContaining(["files", "set.json"]));
      expect(set.window.sqliteAt <= set.window.filesFinishedAt).toBe(true); // the consistency window is explicit

      // Restore refuses a changed file and an existing target; never writes into the live org.
      const tampered = join(base, "tampered"); cpSync(setDir, tampered, { recursive: true });
      appendFileSync(join(tampered, "files", set.files.find((f: any) => f.path.startsWith("folder/")).path), "x");
      expect(() => restoreOrgBackup(tampered, join(base, "r0"), "exna")).toThrow("org_restore_file_changed");
      expect(() => restoreOrgBackup(setDir, root, "exna")).toThrow("org_restore_target_exists");
      expect(() => restoreOrgBackup(setDir, join(base, "r1"), "other-org")).toThrow("org_restore_set_invalid");

      // The CLI restores into a new root and writes a config a runtime starts from (new installation id, same org content).
      const tsx = process.env.KAPELLE_TEST_TSX_CLI;
      let restoredConfig: any;
      const newRoot = join(base, "restored");
      if (tsx) {
        const cli = fileURLToPath(new URL("../src/org/backup-cli.ts", import.meta.url)), cfgPath = file(join(base, "org-config.json"), JSON.stringify(config));
        const list = JSON.parse(spawnSync(process.execPath, [tsx, cli, "list", cfgPath], { encoding: "utf8" }).stdout);
        expect(list).toEqual({ ok: true, sets });
        // B1 (Fable B-4): verify re-hashes the newest set in place and prints files per directory.
        const v = JSON.parse(spawnSync(process.execPath, [tsx, cli, "verify", cfgPath], { encoding: "utf8" }).stdout);
        expect(v).toMatchObject({ ok: true, set: sets[0], skipped: 0, perDir: { folder: expect.any(Number), kit: expect.any(Number) } });
        expect(v.perDir.folder).toBeGreaterThan(0);
        const r = JSON.parse(spawnSync(process.execPath, [tsx, cli, "restore", cfgPath, setDir, newRoot], { encoding: "utf8" }).stdout);
        expect(r).toMatchObject({ ok: true, restoredFrom: org.sqlite.identity.installationId, held: false });
        restoredConfig = JSON.parse(readFileSync(r.config, "utf8"));
      } else {
        const r = restoreOrgBackup(setDir, newRoot, "exna"); const { backup: _b, ...rest } = config;
        restoredConfig = { ...rest, stateRoot: r.stateRoot, folder: r.folder, accessSocket: r.accessSocket, opsSocket: r.opsSocket };
      }
      expect(restoredConfig.backup).toBeUndefined();
      restored = await openOrgRuntime(restoredConfig);
      expect(restored.sqlite.identity.installationId).not.toBe(org.sqlite.identity.installationId);
      const count = (o: any) => (o.sqlite.db.prepare("SELECT COUNT(*) AS n FROM intake_records WHERE state='accepted'").get() as { n: number }).n;
      expect(count(restored)).toBeGreaterThanOrEqual(5);
      expect(count(restored)).toBeLessThanOrEqual(count(org));
      // Every restored intake record has its files (newer files without a record are swept as orphans at start).
      for (const r of restored.sqlite.db.prepare("SELECT intake_id FROM intake_records WHERE state='accepted'").all() as { intake_id: string }[])
        expect(existsSync(join(restoredConfig.folder, "reviewers-private", "intake", r.intake_id, "message.md"))).toBe(true);
      expect(restored.access.membershipVersion()).toBe(org.access.membershipVersion());
      const st = await ops(restoredConfig.opsSocket, "/ops/status");
      expect(st).toMatchObject({ ok: true, orgId: "exna", preparer: (await ops(config.opsSocket, "/ops/status")).preparer, backup: null });
    } finally { await restored?.close(); await org.close(); }
  }, 180_000);
});
