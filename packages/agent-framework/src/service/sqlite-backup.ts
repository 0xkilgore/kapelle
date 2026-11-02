// Lean runtime step 1 (C-2.3, R-5): consistent backup and identity-changing restore of the org's authority.sqlite.
// Backup uses the SQLite online backup API (node:sqlite `backup`), never a file copy of an open database, and runs between
// commands under the authority's own serialization (maintenance). Its manifest binds file hash, page count, schema,
// binding/authority/Drive and the source installation id, plus document/operation/receipt/effect counts.
// Restore copies a verified backup into a NEW empty private state root under a NEW installation id: a stale process still
// holding the old store can never write into it, and it can never be mistaken for the live store. Effects that were
// `sent` at backup time are unknown outcomes: they become `unsettled` and native writes stay refused until each is
// reconciled (consumed claims stay consumed; nothing is replayed from the old backup).
import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assert } from "../validation.js";
import { SQLITE_AUTHORITY_SCHEMA, assertSqliteRuntime, rollbackQuietly, type SqliteAuthority } from "./sqlite-authority.js";
import type { FrameworkAuthority } from "./authority.js";

export const SQLITE_BACKUP_CONTRACT = "kapelle.sqlite-authority-backup/v1";
const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function privateDirectory(path: string) {
  const st = lstatSync(path);
  assert(st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0 && !resolve(path).includes("/Dropbox/"),
    "sqlite_backup_directory_not_private");
}
export type SqliteBackupManifest = { contract: typeof SQLITE_BACKUP_CONTRACT; file: string; sha256: string; pages: number; schema: string;
  binding: string; authorityId: string; driveId: string; installationId: string;
  counts: { documents: number; operations: number; receipts: number; effects: number }; at: string };

/** Back up between commands (never inside a transaction) into `destDir`, writing `<file>.manifest.json` beside it. */
export async function backupSqliteAuthority(authority: FrameworkAuthority, sqlite: SqliteAuthority, destDir: string, now = () => new Date().toISOString()) {
  privateDirectory(destDir);
  return authority.maintenance(async () => {
    assert(!sqlite.db.isTransaction, "sqlite_backup_inside_transaction");
    const at = now(), file = `authority-${sqlite.identity.installationId}-${at.replace(/[-:.]/g, "")}.sqlite`, path = join(destDir, file);
    assert(!existsSync(path), "sqlite_backup_exists");
    closeSync(openSync(path, "wx", 0o600));
    const pages = await backup(sqlite.db, path);
    let counts: SqliteBackupManifest["counts"];
    chmodSync(path, 0o600);
    // The copy must be a self-contained, schema-valid authority of the same identity (WAL folded into the main file).
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      const meta = Object.fromEntries((check.prepare("SELECT key, value FROM authority_meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
      assert(meta.installationId === sqlite.identity.installationId && meta.schema === SQLITE_AUTHORITY_SCHEMA, "sqlite_backup_identity_mismatch");
      assert((check.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check === "ok", "sqlite_backup_integrity");
      // Counts come from the verified copy itself (Fable N-2): a ledger write racing the backup cannot trip a mismatch,
      // and the manifest describes exactly the bytes it hashes.
      const n = (t: string, w = "") => (check.prepare(`SELECT COUNT(*) AS n FROM ${t} ${w}`).get() as { n: number }).n;
      counts = { documents: n("documents"), operations: n("operations", "WHERE scope='global'"), receipts: n("receipts"), effects: n("effects") };
    } finally { check.close(); }
    const manifest: SqliteBackupManifest = { contract: SQLITE_BACKUP_CONTRACT, file, sha256: sha256File(path), pages, schema: SQLITE_AUTHORITY_SCHEMA,
      binding: sqlite.identity.binding, authorityId: sqlite.identity.authorityId, driveId: sqlite.identity.driveId,
      installationId: sqlite.identity.installationId, counts, at };
    writeFileSync(path + ".manifest.json", JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
    return manifest;
  });
}

/** Restore a verified backup into a NEW empty private state root under a NEW installation id. Returns the new identity. */
export function restoreSqliteAuthority(backupPath: string, newStateRoot: string, expectedBinding: string) {
  const manifest = JSON.parse(readFileSync(backupPath + ".manifest.json", "utf8")) as SqliteBackupManifest;
  assert(manifest.contract === SQLITE_BACKUP_CONTRACT && manifest.file === basename(backupPath) && manifest.binding === expectedBinding &&
    manifest.schema === SQLITE_AUTHORITY_SCHEMA, "sqlite_restore_manifest_invalid");
  assert(sha256File(backupPath) === manifest.sha256, "sqlite_restore_backup_changed");
  if (!existsSync(newStateRoot)) mkdirSync(newStateRoot, { mode: 0o700 });
  privateDirectory(newStateRoot);
  assert(readdirSync(newStateRoot).length === 0, "sqlite_restore_target_not_empty");
  const dbPath = join(newStateRoot, "authority.sqlite");
  copyFileSync(backupPath, dbPath, constants.COPYFILE_EXCL);
  chmodSync(dbPath, 0o600);
  const installationId = randomUUID();
  const db = new DatabaseSync(dbPath);
  try {
    assertSqliteRuntime(db);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    const meta = Object.fromEntries((db.prepare("SELECT key, value FROM authority_meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    assert(meta.installationId === manifest.installationId && meta.binding === manifest.binding && meta.driveId === manifest.driveId, "sqlite_restore_identity_mismatch");
    db.prepare("UPDATE authority_meta SET value=? WHERE key='installationId'").run(installationId);
    db.prepare("INSERT INTO authority_meta(key,value) VALUES ('restoredFrom', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(manifest.installationId);
    // Sent before the backup, outcome after it unknown: hold, never replay.
    db.prepare("UPDATE effects SET state='unsettled', reason='restored_outcome_unknown' WHERE state='sent'").run();
    const unknown = (db.prepare("SELECT COUNT(*) AS n FROM effects WHERE state='unsettled'").get() as { n: number }).n;
    if (unknown > 0) db.prepare("INSERT INTO authority_meta(key,value) VALUES ('restoreHold','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    db.exec("COMMIT");
    writeFileSync(join(newStateRoot, "authority.json"), JSON.stringify({ binding: manifest.binding, backend: "sqlite", driveId: manifest.driveId, installationId }),
      { mode: 0o600, flag: "wx" });
    return { installationId, restoredFrom: manifest.installationId, held: unknown > 0, counts: manifest.counts };
  } catch (e) {
    rollbackQuietly(db);
    throw e;
  } finally { db.close(); }
}
