// Build item (d): per-org backup sets and restore-into-a-new-root.
//
// A set is one directory `<backupRoot>/<orgId>-<stamp>/`:
//   authority-*.sqlite (+ .manifest.json)  the verified SQLite authority copy (backupSqliteAuthority, between commands)
//   files/state/<BACKED_UP_STATE_DIRS>/... the runtime's file state (B1: every state dir is decided below, backed up or excluded)
//   files/folder/...                       the org folder (members/, reviewers-private/)
//   set.json                               written LAST: the set is complete only when it exists; every file with its sha256
// The SQLite copy is taken first, then the files; a file newer than the database (an intake written after the copy) is an
// orphan the start-up sweep already handles. `workers/` (in-flight run journals) is deliberately not copied: a restored org
// starts with no running work. Restore verifies every hash, restores the authority under a NEW installation id (sent effects
// are held, never replayed) and writes a new org config pointing at the new root. Never overwrites: targets must not exist.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { backupSqliteAuthority, restoreSqliteAuthority } from "../service/sqlite-backup.js";
import type { SqliteAuthority } from "../service/sqlite-authority.js";
import type { FrameworkAuthority } from "../service/authority.js";
import { assert } from "../validation.js";

export const ORG_BACKUP_CONTRACT = "kapelle.org-backup/v1";
const SET_NAME = /^[a-z0-9][a-z0-9-]{1,62}-\d{8}T\d{9}Z$/;
/** B1 (Ops BACKUP-COVERAGE-FINDING 9e9ba859): every directory the runtime writes under stateRoot is EITHER backed up OR excluded
 *  with its reason. tests/backup-coverage.test.ts fails when the source writes a state dir that is in neither list. */
export const BACKED_UP_STATE_DIRS = [
  "reports",      // draft Reports
  "kit",          // kit snapshots and chats
  "chat",         // draft artifact versions (R-5)
  "teamtasks",    // task source files, attempt sources/manifests/results (rows point at them by hash)
  "website",      // pending website requests: flyer sources and after-files
  "media/images", // sanitized chat images (chat_images rows point at them)
  "newsletter",   // sent.json: a projection of the DB, backed up rather than derived (Fable B1 note (b)): restored with its DB snapshot
  "library",      // LIBRARY L1: the shared drive's normalized images (library_images rows point at them by hash)
] as const;
export const EXCLUDED_STATE_DIRS: Record<string, string> = {
  authority: "the database: copied and verified separately (backupSqliteAuthority)",
  workers: "in-flight run journals: a restored org starts with no running work",
  media: "transcription audio: transient, deleted when its job ends; its product (the transcript) is in the folder, which is backed up",
  "media/images/quarantine": "decoder in-flight inputs: reaped hourly",
};
const SKIP_UNDER = ["media/images/quarantine"];
const MAX_FILES = 50_000, MAX_FILE_BYTES = 64 * 1024 * 1024;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export type OrgBackupSet = { contract: typeof ORG_BACKUP_CONTRACT; orgId: string; at: string; sqlite: { file: string; sha256: string; installationId: string; binding: string };
  /** The consistency window (Fable C-D N-2): the database is as of `sqliteAt`; files were copied until `filesFinishedAt`. A file
   *  written in between (an intake landing during the walk) has no record in the copy: the restored runtime's start-up sweep moves
   *  it to reviewers-private/.orphans (audited, never deleted). */
  window: { sqliteAt: string; filesFinishedAt: string };
  files: { path: string; sha256: string; bytes: number }[]; skipped: { path: string; reason: string }[] };

function privateDir(p: string) { mkdirSync(p, { recursive: true, mode: 0o700 }); chmodSync(p, 0o700); }

/** Copy a tree of regular files (symlinks and specials skipped and recorded), hashing exactly the bytes written. */
function copyTree(from: string, to: string, label: string, out: OrgBackupSet) {
  if (!existsSync(from)) return;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const src = join(dir, name), rel = `${label}/${relative(from, src).split(sep).join("/")}`, st = lstatSync(src);
      if (st.isDirectory()) { if (!SKIP_UNDER.some((d) => rel === `state/${d}`)) walk(src); continue; }
      if (!st.isFile()) { out.skipped.push({ path: rel, reason: "not_a_regular_file" }); continue; }
      if (st.size > MAX_FILE_BYTES) { out.skipped.push({ path: rel, reason: "file_too_large" }); continue; }
      assert(out.files.length < MAX_FILES, "org_backup_too_many_files");
      let bytes: Buffer; try { bytes = readFileSync(src); } catch { out.skipped.push({ path: rel, reason: "vanished" }); continue; } // removed mid-walk
      const dest = join(to, relative(from, src)); privateDir(dirname(dest));
      writeFileSync(dest, bytes, { mode: 0o600, flag: "wx" });
      out.files.push({ path: rel, sha256: sha(bytes), bytes: bytes.length });
    }
  };
  walk(from);
}

/** Take one complete backup set. Returns the set manifest (also written as set.json). */
export async function backupOrg(o: { orgId: string; authority: FrameworkAuthority; sqlite: SqliteAuthority; stateRoot: string; folder: string; backupRoot: string; now?: () => string }) {
  privateDir(o.backupRoot);
  const at = (o.now ?? (() => new Date().toISOString()))(), name = `${o.orgId}-${at.replace(/[-:.]/g, "")}`;
  assert(SET_NAME.test(name), "org_backup_name_invalid");
  const dir = join(o.backupRoot, name);
  assert(!existsSync(dir), "org_backup_exists");
  privateDir(dir);
  const m = await backupSqliteAuthority(o.authority, o.sqlite, dir, () => at);
  const set: OrgBackupSet = { contract: ORG_BACKUP_CONTRACT, orgId: o.orgId, at, sqlite: { file: m.file, sha256: m.sha256, installationId: m.installationId, binding: m.binding },
    window: { sqliteAt: m.at, filesFinishedAt: "" }, files: [], skipped: [] };
  for (const d of BACKED_UP_STATE_DIRS) copyTree(join(o.stateRoot, d), join(dir, "files", "state", d), `state/${d}`, set);
  copyTree(o.folder, join(dir, "files", "folder"), "folder", set);
  set.window.filesFinishedAt = new Date().toISOString();
  writeFileSync(join(dir, "set.json"), JSON.stringify(set), { mode: 0o600, flag: "wx" });
  return { dir, set };
}

/** Complete sets, newest first. */
export function listOrgBackups(backupRoot: string, orgId: string) {
  if (!existsSync(backupRoot)) return [];
  return readdirSync(backupRoot).filter((n) => SET_NAME.test(n) && n.startsWith(orgId + "-") && existsSync(join(backupRoot, n, "set.json"))).sort().reverse();
}

/** Keep the newest `keep` complete sets; remove older complete sets and any incomplete set that is not the newest entry. */
export function pruneOrgBackups(backupRoot: string, orgId: string, keep: number) {
  assert(Number.isInteger(keep) && keep >= 1, "org_backup_keep_invalid");
  const all = readdirSync(backupRoot).filter((n) => SET_NAME.test(n) && n.startsWith(orgId + "-")).sort().reverse();
  const complete = all.filter((n) => existsSync(join(backupRoot, n, "set.json")));
  const keepSet = new Set(complete.slice(0, keep));
  const removed: string[] = [];
  for (const n of all) {
    if (keepSet.has(n)) continue;
    const p = resolve(backupRoot, n);
    assert(dirname(p) === resolve(backupRoot) && SET_NAME.test(n), "org_backup_prune_path"); // only direct children named like a set
    rmSync(p, { recursive: true, force: true }); removed.push(n);
  }
  return removed;
}

/** Verify a complete set in place (every path admitted, every file's bytes match set.json). Content-free counts per directory. */
export function verifyOrgBackup(setDir: string, expectedOrgId: string) {
  const set = JSON.parse(readFileSync(join(setDir, "set.json"), "utf8")) as OrgBackupSet;
  assert(set.contract === ORG_BACKUP_CONTRACT && set.orgId === expectedOrgId, "org_restore_set_invalid");
  for (const f of set.files) {
    assert((f.path.startsWith("folder/") || BACKED_UP_STATE_DIRS.some((d) => f.path.startsWith(`state/${d}/`))) && !f.path.includes("\0") && !f.path.split("/").includes(".."), "org_restore_path_invalid");
    assert(sha(readFileSync(join(setDir, "files", f.path))) === f.sha256, "org_restore_file_changed");
  }
  return { set, perDir: perDir(set.files.map((f) => f.path)), skipped: set.skipped.length };
}

/** The directory a backed-up path counts under: "folder" or its state dir. */
const dirOf = (path: string) => path.startsWith("folder/") ? "folder" : BACKED_UP_STATE_DIRS.find((d) => path.startsWith(`state/${d}/`)) ?? "other";
function perDir(paths: string[]) {
  const n: Record<string, number> = Object.fromEntries([...BACKED_UP_STATE_DIRS, "folder"].map((d) => [d, 0]));
  for (const p of paths) n[dirOf(p)] = (n[dirOf(p)] ?? 0) + 1;
  return n;
}
function liveFiles(root: string, label: string, skip: (rel: string) => boolean = () => false): string[] {
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[]).filter((e) => e.isFile())
    .map((e) => `${label}/${relative(root, join(e.parentPath, e.name)).split(sep).join("/")}`).filter((r) => !skip(r));
}

/** B-5: the content-free coverage line for Ops status. Per directory: files live now vs in the newest complete set; and every
 *  directory present under stateRoot that is neither backed up nor excluded (must be empty). */
export function backupCoverage(o: { orgId: string; stateRoot: string; folder: string; backupRoot?: string }) {
  const present = existsSync(o.stateRoot) ? readdirSync(o.stateRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  const decided = (d: string) => (BACKED_UP_STATE_DIRS as readonly string[]).includes(d) || d in EXCLUDED_STATE_DIRS;
  const unclassified = present.filter((d) => !decided(d)).sort();
  const live = perDir([...BACKED_UP_STATE_DIRS.flatMap((d) => liveFiles(join(o.stateRoot, d), `state/${d}`, (r) => SKIP_UNDER.some((x) => r.startsWith(`state/${x}/`)))),
    ...liveFiles(o.folder, "folder")]);
  const newest = o.backupRoot ? listOrgBackups(o.backupRoot, o.orgId)[0] : undefined;
  const set = newest ? JSON.parse(readFileSync(join(o.backupRoot!, newest, "set.json"), "utf8")) as OrgBackupSet : null;
  const inSet = set ? perDir(set.files.map((f) => f.path)) : null;
  return { latestSet: newest ?? null, latestAt: set?.at ?? null, unclassified,
    dirs: Object.keys(live).map((d) => ({ dir: d, live: live[d], inSet: inSet ? inSet[d] ?? 0 : null })) };
}

/** Restore a complete set into `newRoot` (must not exist). Returns the new paths and identity; the caller writes the config. */
export function restoreOrgBackup(setDir: string, newRoot: string, expectedOrgId: string) {
  const { set } = verifyOrgBackup(setDir, expectedOrgId);
  assert(!existsSync(newRoot), "org_restore_target_exists");
  privateDir(newRoot);
  const stateRoot = join(newRoot, "state"), folder = join(newRoot, "folder"), run = join(newRoot, "run"), ops = join(newRoot, "ops");
  for (const d of [stateRoot, folder, run, ops]) privateDir(d);
  const id = restoreSqliteAuthority(join(setDir, set.sqlite.file), join(stateRoot, "authority"), set.sqlite.binding);
  for (const f of set.files) {
    const dest = join(newRoot, f.path); // state/... and folder/... map 1:1 under newRoot
    privateDir(dirname(dest));
    writeFileSync(dest, readFileSync(join(setDir, "files", f.path)), { mode: 0o600, flag: "wx" });
  }
  return { stateRoot, folder, accessSocket: join(run, "access.sock"), opsSocket: join(ops, "ops.sock"), ...id, files: set.files.length, at: set.at };
}
