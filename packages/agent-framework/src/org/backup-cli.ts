// Ops entrypoint for build item (d): `node backup-cli.mjs <command> <org-config.json> ...` (one JSON line out; fixed labels on failure).
//   backup  <config>                    take a set now through the org's Ops socket (the runtime must be running)
//   list    <config>                    complete sets, newest first
//   verify  <config> [setDir]           B1 (Fable B-4): re-hash the newest (or the named) set in place; files per directory
//   restore <config> <setDir> <newRoot> verify + restore into a NEW root (new installation id); writes <newRoot>/org-config.json
//                                       with the same org, catalog and secrets, new state/folder/sockets, and no backup schedule
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { request } from "node:http";
import { orgRuntimeConfigSchema } from "./org-runtime.js";
import { listOrgBackups, restoreOrgBackup, verifyOrgBackup } from "./org-backup.js";

const ops = (socket: string, route: string): Promise<any> => new Promise((res, rej) => {
  const r = request({ socketPath: socket, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": 2 } }, (x) => {
    const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch (e) { rej(e); } }); });
  r.on("error", rej); r.end("{}");
});
const out = (v: unknown, code = 0) => { console.log(JSON.stringify(v)); process.exit(code); };
const label = (e: unknown) => (e instanceof Error && /^[a-z][a-z0-9_]{2,63}$/.test(e.message) ? e.message : "backup_cli_error");

const [, , cmd, configPath, a1, a2] = process.argv;
try {
  if (!cmd || !configPath) out({ ok: false, error: "usage: backup|list|verify|restore <org-config.json> [setDir newRoot]" }, 2);
  const c = orgRuntimeConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  if (cmd === "backup") { const r = await ops(c.opsSocket, "/ops/backup/now"); out(r, r.ok ? 0 : 1); }
  else if (cmd === "list") out({ ok: true, sets: c.backup ? listOrgBackups(c.backup.dir, c.orgId) : [] });
  else if (cmd === "verify") {
    const name = a1 ? null : c.backup ? listOrgBackups(c.backup.dir, c.orgId)[0] : undefined;
    if (!a1 && !name) out({ ok: false, error: "backup_cli_no_set" }, 1);
    const setDir = a1 ?? join(c.backup!.dir, name!), v = verifyOrgBackup(setDir, c.orgId);
    out({ ok: true, set: setDir.split("/").at(-1), at: v.set.at, files: v.set.files.length, skipped: v.skipped, perDir: v.perDir });
  }
  else if (cmd === "restore") {
    if (!a1 || !a2) out({ ok: false, error: "usage: restore <org-config.json> <setDir> <newRoot>" }, 2);
    const r = restoreOrgBackup(a1, a2, c.orgId);
    // The access-socket directory takes the mode the runtime demands for this config (0710 with groupAccess, the hub's group
    // traverses it; 0700 otherwise): a production config's restored root must start (it refused before).
    chmodSync(dirname(r.accessSocket), c.groupAccess ? 0o710 : 0o700);
    const { backup: _drop, ...rest } = c;
    const next = orgRuntimeConfigSchema.parse({ ...rest, stateRoot: r.stateRoot, folder: r.folder, accessSocket: r.accessSocket, opsSocket: r.opsSocket });
    writeFileSync(join(a2, "org-config.json"), JSON.stringify(next, null, 1), { mode: 0o600, flag: "wx" });
    out({ ok: true, config: join(a2, "org-config.json"), installationId: r.installationId, restoredFrom: r.restoredFrom, held: r.held, files: r.files, at: r.at });
  } else out({ ok: false, error: "backup_cli_unknown_command" }, 2);
} catch (e) { out({ ok: false, error: label(e) }, 1); }
