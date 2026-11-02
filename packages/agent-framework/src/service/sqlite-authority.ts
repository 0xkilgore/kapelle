// Lean runtime step 1 (Fable C-2, R-1..R-5): the per-org native authority store on node:sqlite, behind the SAME
// ScopedStore/ScopedClient seam NativeBackend uses for the scoped Reactor. Everything above the seam (authority, command
// boundary, reducers, journal, plan/Report hashes) is unchanged; documents are still rebuilt from retained actions by
// NativeBackend.read, so state hashes depend on actions only.
//
// OSS lift: Kapelle scoped-authority Reactor fork (AGPL-3.0-only), packages/reactor/src/authority/
// {kysely-authority-store,action-digest,types}.ts at release b5b76b4-91d8a1361ae7-01 (base powerhouse v6.2.1 aa4170b3).
// digestScopedAuthorityActions is verbatim; the receipt (begin -> reduce -> finish), reconcile and allocation rules are
// ported from Kysely/Postgres to node:sqlite with the same assertions and dispositions.
//
// Transactions: every write is ONE synchronous BEGIN IMMEDIATE..COMMIT block on the single connection, with no await
// inside (R-2), so a concurrent caller observes the state before or after it, never a torn one. Reads that must agree
// (ownership + operations + initial model version, list pages) run in one BEGIN DEFERRED block (R-3). The command
// journal's prepare stays its own committed transaction BEFORE the command transaction (R-1: CommandJournal.save, then
// executeScopedAuthority), exactly as with Reactor.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { Action, PHDocument } from "document-model";
import { canonical as stable, nativeModel, type ModelType, type NativeDocument } from "../command-boundary.js";
import { assert } from "../validation.js";
import type { NativeReceipt, Preconditions, ScopedClient, ScopedStore } from "./native-backend.js";

export const SQLITE_AUTHORITY_SCHEMA = "kapelle.sqlite-authority/v1";
const MAX_REACTOR_INTEGER = 2_147_483_647;
const MAX_ERROR_LENGTH = 2_000;
type Job = { documentId: string; scope: string; branch: string; actions: Action[] };

// ---- verbatim: packages/reactor/src/authority/action-digest.ts ----
function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot digest a non-finite action value");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        const entry = record[key];
        if (entry === undefined) {
          throw new Error("Cannot digest an undefined action value");
        }
        return `${JSON.stringify(key)}:${canonical(entry)}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new Error("Cannot digest an unsupported action value");
}

export function digestScopedAuthorityActions(actions: Action[]): string {
  // Signer context is transport/authentication evidence, not part of the
  // prepared mutation tuple. The authority binds the five reducer inputs that
  // remain stable when ReactorClient signs an action.
  const bytes = canonical(
    actions.map((action) => ({
      id: action.id,
      type: action.type,
      timestampUtcMs: action.timestampUtcMs,
      input: action.input,
      scope: action.scope,
    })),
  );
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}
// ---- end verbatim ----

// ---- verbatim behaviour: packages/reactor/src/core/utils.ts signAction with the client's default PassthroughSigner ----
// The Reactor client stores every scoped action with this empty signer context (signatures ["","","","",""]); the lean
// store does the same so stored bytes match. It is NOT authentication: member passkey assertions are lean step 2 (C-1).
function passthroughSigned(action: Action): Action {
  const existingSignatures = action.context?.signer?.signatures;
  if (existingSignatures && existingSignatures.length > 0) return action;
  return { ...action, context: { ...action.context,
    signer: { user: { address: "", networkId: "", chainId: 0 }, app: { name: "", key: "" }, signatures: [["", "", "", "", ""]] } } } as Action;
}
// ---- ported: kysely-authority-store.ts validation and receipt rules ----
const isCanonicalText = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && v === v.trim();
const isReactorInteger = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= MAX_REACTOR_INTEGER;
function expectedOperationIndexes(expectedRevision: number, actionCount: number) {
  if (expectedRevision > MAX_REACTOR_INTEGER - actionCount) throw new Error("Scoped authority revision window exceeds integer range");
  return Array.from({ length: actionCount }, (_, i) => expectedRevision + i);
}
function assertPreconditions(p: Preconditions, job: Job) {
  if (String(p.contract) !== "task-authority/v1" || !isCanonicalText(p.authorityId, 200) || !isCanonicalText(p.collectionId, 1_000) ||
    !/^(0|[1-9]\d*)$/.test(p.membershipIncarnation) || !isCanonicalText(p.documentType, 500) || !isCanonicalText(p.operationId, 500) ||
    !isReactorInteger(p.expectedRevision) || !/^sha256:[a-f0-9]{64}$/.test(p.actionDigest) || !Number.isInteger(p.actionCount) ||
    p.actionCount < 1 || p.actionCount > 8 || p.actionCount !== job.actions.length || p.actionDigest !== digestScopedAuthorityActions(job.actions) ||
    job.scope !== "global" || job.branch !== "main")
    throw new Error("Invalid scoped authority preconditions");
  expectedOperationIndexes(p.expectedRevision, p.actionCount);
}
type Terminal =
  | { disposition: "ACCEPTED"; revision: number; operationIndexes: number[] }
  | { disposition: "REVISION_CONFLICT"; currentRevision: number }
  | { disposition: "REFUSED" }
  | { disposition: "REJECTED_BY_MODEL"; revision: number; operationIndexes: number[]; errors: string[] };
function assertTerminal(p: Pick<Preconditions, "expectedRevision" | "actionCount">, o: Terminal) {
  if (o.disposition === "ACCEPTED" || o.disposition === "REJECTED_BY_MODEL") {
    if (!isReactorInteger(o.revision)) throw new Error("Scoped authority outcome has an invalid revision");
    const expected = expectedOperationIndexes(p.expectedRevision, p.actionCount);
    if (o.revision !== p.expectedRevision + p.actionCount || o.operationIndexes.length !== expected.length || o.operationIndexes.some((v, i) => v !== expected[i]))
      throw new Error("Scoped authority outcome has an invalid operation window");
  }
  if (o.disposition === "REJECTED_BY_MODEL" && (o.errors.length === 0 || o.errors.some((e) => typeof e !== "string" || e.length === 0)))
    throw new Error("Scoped authority rejection has invalid errors");
  if (o.disposition === "REVISION_CONFLICT" && (!isReactorInteger(o.currentRevision) || o.currentRevision === p.expectedRevision))
    throw new Error("Scoped authority conflict has an invalid revision");
}
type ReceiptRow = { contract: string; collection_id: string; membership_incarnation: string; document_id: string; document_type: string; scope: string;
  branch: string; expected_revision: number; action_digest: string; action_count: number; disposition: string; revision: number | null;
  current_revision: number | null; operation_indexes: string | null; errors: string | null };
const sameTuple = (r: ReceiptRow, p: Preconditions, job: Job) =>
  r.contract === p.contract && r.collection_id === p.collectionId && r.membership_incarnation === p.membershipIncarnation && r.document_id === job.documentId &&
  r.document_type === p.documentType && r.scope === job.scope && r.branch === job.branch && r.expected_revision === p.expectedRevision &&
  r.action_digest === p.actionDigest && r.action_count === p.actionCount;
function numberArray(v: unknown): number[] {
  if (!Array.isArray(v) || v.some((e) => !isReactorInteger(e))) throw new Error("Invalid scoped authority receipt operation indexes");
  return v as number[];
}
function stringArray(v: unknown): string[] {
  if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) throw new Error("Invalid scoped authority receipt errors");
  return (v as string[]).map((e) => e.slice(0, MAX_ERROR_LENGTH));
}
function outcomeFromRow(r: ReceiptRow): NativeReceipt {
  const p = { expectedRevision: r.expected_revision, actionCount: r.action_count };
  switch (r.disposition) {
    case "ACCEPTED": {
      if (!isReactorInteger(r.revision)) throw new Error("Invalid accepted scoped authority receipt");
      const o = { disposition: "ACCEPTED", revision: r.revision, operationIndexes: numberArray(JSON.parse(r.operation_indexes ?? "null")) } as const;
      assertTerminal(p, o); return { ...o, replayed: true };
    }
    case "REVISION_CONFLICT": {
      if (!isReactorInteger(r.current_revision)) throw new Error("Invalid revision-conflict scoped authority receipt");
      const o = { disposition: "REVISION_CONFLICT", currentRevision: r.current_revision } as const;
      assertTerminal(p, o); return { ...o, replayed: true };
    }
    case "REFUSED": return { disposition: "REFUSED", replayed: true };
    case "REJECTED_BY_MODEL": {
      if (!isReactorInteger(r.revision)) throw new Error("Invalid rejected scoped authority receipt");
      const o = { disposition: "REJECTED_BY_MODEL", revision: r.revision, operationIndexes: numberArray(JSON.parse(r.operation_indexes ?? "null")),
        errors: stringArray(JSON.parse(r.errors ?? "null")) } as const;
      assertTerminal(p, o); return { ...o, replayed: true };
    }
    default: throw new Error("Scoped authority receipt is not terminal");
  }
}
/** Postgres JSONB object key order (shorter keys first, then bytewise), which the Reactor store returns. Stored actions
 *  and allocation documents use it so documents rebuilt from SQLite are byte-identical to Reactor reads, not merely
 *  canonical-equal (any JSON.stringify consumer sees the same bytes). The action digest is order-independent. */
export function jsonbOrdered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbOrdered);
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return Object.fromEntries(keys.map((k) => [k, jsonbOrdered((value as Record<string, unknown>)[k])]));
  }
  return value;
}
const jsonb = (value: unknown) => JSON.stringify(jsonbOrdered(value));
function parseAction(value: unknown): Record<string, unknown> | null {
  try { const v = typeof value === "string" ? JSON.parse(value) : value; return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}
// ---- end ported rules ----

const SCHEMA = `
CREATE TABLE IF NOT EXISTS authority_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, document_type TEXT NOT NULL,
  incarnation INTEGER NOT NULL UNIQUE, left_at TEXT) STRICT;
CREATE TABLE IF NOT EXISTS operations(document_id TEXT NOT NULL REFERENCES documents(id), scope TEXT NOT NULL CHECK(scope IN ('document','global')),
  idx INTEGER NOT NULL CHECK(idx >= 0), action TEXT NOT NULL, error TEXT, PRIMARY KEY(document_id, scope, idx)) STRICT;
CREATE TABLE IF NOT EXISTS receipts(authority_id TEXT NOT NULL, operation_id TEXT NOT NULL, contract TEXT NOT NULL, collection_id TEXT NOT NULL,
  membership_incarnation TEXT NOT NULL, document_id TEXT NOT NULL, document_type TEXT NOT NULL, scope TEXT NOT NULL, branch TEXT NOT NULL,
  expected_revision INTEGER NOT NULL, action_digest TEXT NOT NULL, action_count INTEGER NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('PENDING','ACCEPTED','REVISION_CONFLICT','REFUSED','REJECTED_BY_MODEL')),
  revision INTEGER, current_revision INTEGER, operation_indexes TEXT, errors TEXT, completed_at TEXT, PRIMARY KEY(authority_id, operation_id)) STRICT;
CREATE TABLE IF NOT EXISTS allocations(authority_id TEXT NOT NULL, operation_id TEXT NOT NULL, collection_id TEXT NOT NULL, document_type TEXT NOT NULL,
  name TEXT NOT NULL, document_id TEXT NOT NULL, document TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','ALLOCATED')), completed_at TEXT,
  PRIMARY KEY(authority_id, operation_id)) STRICT;
CREATE TABLE IF NOT EXISTS effects(key TEXT PRIMARY KEY, kind TEXT NOT NULL, profile_id TEXT NOT NULL, month TEXT NOT NULL,
  document_id TEXT, operation_id TEXT, dispatch_ref TEXT UNIQUE, proposal_hash TEXT, reserved_usd REAL NOT NULL CHECK(reserved_usd >= 0),
  state TEXT NOT NULL CHECK(state IN ('reserved','sent','settled','released','unsettled')), cost_usd REAL, reason TEXT, at TEXT NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS effects_state ON effects(state, month);`;

export interface SqliteAuthorityIdentity { binding: string; authorityId: string; driveId: string; installationId: string }

/** Open the org's authority file. A missing file is refused unless `create`; read-only opens never create (R-4). */
/** Fable B1 R-1: the runtime is pinned to Node 24 (deploy/cloud-init install 24.18.0). A stray Node lacking
 *  DatabaseSync.isTransaction would never roll back after a refusal and wedge the org: refuse to start instead. */
export const SQLITE_NODE_MAJOR = 24;
export function assertSqliteRuntime(db: { isTransaction?: unknown }, nodeVersion = process.versions.node) {
  assert(Number(nodeVersion.split(".")[0]) === SQLITE_NODE_MAJOR, "node_version_unsupported");
  assert(typeof db.isTransaction === "boolean", "sqlite_api_incomplete");
}
/** Roll back without trusting the flag: attempt it whenever a transaction may be open; "no transaction" is not an error. */
export function rollbackQuietly(db: { isTransaction?: unknown; exec(sql: string): unknown }) {
  if (db.isTransaction === false) return;
  try { db.exec("ROLLBACK"); } catch { /* nothing was open */ }
}
export function openSqliteDatabase(path: string, o: { create: boolean; readOnly?: boolean }) {
  if (o.readOnly) {
    const db = new DatabaseSync(path, { readOnly: true });
    assertSqliteRuntime(db);
    db.exec("PRAGMA busy_timeout=5000; PRAGMA query_only=ON;");
    return db;
  }
  const db = new DatabaseSync(path, { open: true });
  assertSqliteRuntime(db);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; ${SCHEMA}`);
  assert((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode === "wal", "sqlite_authority_wal_required");
  return db;
}

export class SqliteAuthority {
  readonly collectionId: string;
  private now: () => string;
  constructor(readonly db: DatabaseSync, readonly identity: SqliteAuthorityIdentity, o: { create: boolean; now?: () => string }) {
    this.now = o.now ?? (() => new Date().toISOString());
    this.collectionId = `drive.main.${identity.driveId}`; // the Reactor DriveCollectionId key shape
    const meta = this.meta();
    if (Object.keys(meta).length === 0) {
      assert(o.create, "sqlite_authority_missing");
      this.write(() => {
        for (const [k, v] of Object.entries({ schema: SQLITE_AUTHORITY_SCHEMA, binding: identity.binding, authorityId: identity.authorityId,
          driveId: identity.driveId, installationId: identity.installationId, collectionId: this.collectionId }))
          this.db.prepare("INSERT INTO authority_meta(key,value) VALUES (?,?)").run(k, v);
      }, false);
    }
    this.assertIdentity();
  }
  private meta(): Record<string, string> {
    return Object.fromEntries((this.db.prepare("SELECT key, value FROM authority_meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  }
  /** R-5: the file must be THIS installation (binding, authority, Drive, installation id); checked at open and in every write. */
  private assertIdentity() {
    const m = this.meta();
    assert(m.schema === SQLITE_AUTHORITY_SCHEMA && m.binding === this.identity.binding && m.authorityId === this.identity.authorityId &&
      m.driveId === this.identity.driveId && m.installationId === this.identity.installationId && m.collectionId === this.collectionId,
      "sqlite_authority_identity_mismatch");
  }
  /** A restored copy refuses native writes until its unknown-outcome effects are reconciled (reads and the ledger work). */
  private assertWritable() {
    const hold = this.db.prepare("SELECT value FROM authority_meta WHERE key='restoreHold'").get() as { value: string } | undefined;
    assert(!hold, "sqlite_authority_restore_reconciliation_required");
  }
  restoreHeld() { return this.read(() => !!this.db.prepare("SELECT 1 FROM authority_meta WHERE key='restoreHold'").get()); }
  /** Lift the restore hold only when no effect outcome is still unknown. */
  releaseRestoreHold() {
    this.write(() => {
      assert(!this.db.prepare("SELECT 1 FROM effects WHERE state IN ('sent','unsettled')").get(), "sqlite_authority_restore_effects_unreconciled");
      this.db.prepare("DELETE FROM authority_meta WHERE key='restoreHold'").run();
    });
  }
  /** One synchronous write transaction. `fn` MUST be synchronous: no await between BEGIN IMMEDIATE and COMMIT (R-2). */
  write<T>(fn: () => T, checkIdentity = true): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (checkIdentity) this.assertIdentity();
      const r = fn();
      assert(!(r instanceof Promise), "sqlite_authority_async_in_transaction");
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      rollbackQuietly(this.db);
      throw e;
    }
  }
  /** One consistent read snapshot (R-3). */
  read<T>(fn: () => T): T {
    this.db.exec("BEGIN DEFERRED");
    try { const r = fn(); assert(!(r instanceof Promise), "sqlite_authority_async_in_transaction"); this.db.exec("COMMIT"); return r; }
    catch (e) { rollbackQuietly(this.db); throw e; }
  }

  // ---- ownership (ported inspectOwned; must run inside a transaction) ----
  private owned(collectionId: string, documentId: string, documentType: string) {
    const m = this.db.prepare("SELECT document_type, incarnation, left_at FROM documents WHERE id=? AND collection_id=?").get(documentId, collectionId) as
      { document_type: string; incarnation: number; left_at: string | null } | undefined;
    if (!m || m.left_at !== null) return { disposition: "REFUSED" as const };
    const first = this.db.prepare("SELECT action FROM operations WHERE document_id=? AND scope='document' ORDER BY idx ASC LIMIT 1").get(documentId) as { action: string } | undefined;
    const latest = this.db.prepare("SELECT action FROM operations WHERE document_id=? AND scope='document' ORDER BY idx DESC LIMIT 1").get(documentId) as { action: string } | undefined;
    if (!first || m.document_type !== documentType || parseAction(first.action)?.type !== "CREATE_DOCUMENT" || parseAction(latest?.action)?.type === "DELETE_DOCUMENT")
      return { disposition: "REFUSED" as const };
    const top = this.db.prepare("SELECT MAX(idx) AS idx FROM operations WHERE document_id=? AND scope='global'").get(documentId) as { idx: number | null };
    return { disposition: "OWNED" as const, membershipIncarnation: String(m.incarnation), currentRevision: top.idx === null ? 0 : top.idx + 1 };
  }
  /** The genesis spine checks of versioned-snapshot.ts: exactly one clean 0 -> N upgrade with N's initial state. */
  private initialModelVersion(documentId: string, documentType: string) {
    const rows = this.db.prepare("SELECT action, error FROM operations WHERE document_id=? AND scope='document' ORDER BY idx ASC LIMIT 101").all(documentId) as { action: string; error: string | null }[];
    assert(rows.length <= 100, "Native document spine exceeds bound");
    const upgrades = rows.map((r) => ({ a: parseAction(r.action), error: r.error })).filter((r) => r.a?.type === "UPGRADE_DOCUMENT");
    assert(upgrades.length === 1 && !upgrades[0].error, "Native in-place upgrades require versioned spine replay");
    const u = upgrades[0].a!.input as Record<string, any>;
    assert(u.fromVersion === 0 && Number.isInteger(u.toVersion), "Native initial model version unavailable");
    const model = nativeModel(documentType as ModelType, u.toVersion);
    assert(u.initialState && u.initialState.document?.version === u.toVersion && stable(u.initialState.global) === stable(model.utils.createState().global),
      "Native imported initial state requires versioned spine replay");
    return u.toVersion as number;
  }

  // ---- ScopedStore ----
  readonly store: ScopedStore = {
    inspectOwned: async (i) => this.read(() => this.owned(i.collectionId, i.documentId, i.documentType)),
    readOwnedOperationSnapshot: async (i) => this.read(() => {
      const own = this.owned(i.collectionId, i.documentId, i.documentType);
      if (own.disposition !== "OWNED") return null;
      const create = parseAction((this.db.prepare("SELECT action FROM operations WHERE document_id=? AND scope='document' ORDER BY idx ASC LIMIT 1").get(i.documentId) as { action: string }).action);
      const name = parseAction(create?.input)?.name;
      if (create?.type !== "CREATE_DOCUMENT" || typeof name !== "string") return null;
      const rows = this.db.prepare("SELECT action, error FROM operations WHERE document_id=? AND scope='global' ORDER BY idx ASC").all(i.documentId) as { action: string; error: string | null }[];
      if (rows.length !== own.currentRevision || rows.reduce((n, r) => n + Buffer.byteLength(r.action), 0) + rows.length + 1 > 2_000_000)
        throw new Error("Scoped authority read snapshot exceeds its contract");
      return { documentId: i.documentId, name, revision: own.currentRevision, initialModelVersion: this.initialModelVersion(i.documentId, i.documentType),
        operations: rows.map((r) => ({ action: JSON.parse(r.action) as Action, error: r.error || undefined })) };
    }),
    // Same order and cursor as the fork: document id ascending; the cursor is the last id examined.
    listOwnedDocumentIds: async (i) => {
      if (!Number.isInteger(i.limit) || i.limit < 1 || i.limit > 200) throw new Error("Invalid scoped authority list limit");
      return this.read(() => {
        const candidates = (i.cursor === null
          ? this.db.prepare("SELECT id FROM documents WHERE collection_id=? AND left_at IS NULL ORDER BY id ASC LIMIT 1001").all(i.collectionId)
          : this.db.prepare("SELECT id FROM documents WHERE collection_id=? AND left_at IS NULL AND id > ? ORDER BY id ASC LIMIT 1001").all(i.collectionId, i.cursor)) as { id: string }[];
        const documentIds: string[] = []; let examined: string | null = null, exhausted = true;
        for (const c of candidates) {
          examined = c.id;
          if (this.owned(i.collectionId, c.id, i.documentType).disposition === "OWNED") documentIds.push(c.id);
          if (documentIds.length === i.limit) { exhausted = false; break; }
        }
        if (candidates.length > 1_000 && documentIds.length < i.limit) exhausted = false;
        return { documentIds, nextCursor: exhausted ? null : examined };
      });
    },
    reserveAllocation: async (i) => {
      if (!isCanonicalText(i.authorityId, 200) || !isCanonicalText(i.operationId, 500) || !isCanonicalText(i.collectionId, 1_000) ||
        !isCanonicalText(i.documentType, 500) || !isCanonicalText(i.name, 500) || i.document.header.id.length < 1 ||
        i.document.header.documentType !== i.documentType || i.document.header.name !== i.name)
        throw new Error("Invalid scoped authority allocation");
      return this.write(() => {
        this.assertWritable();
        const inserted = this.db.prepare(`INSERT INTO allocations(authority_id,operation_id,collection_id,document_type,name,document_id,document,status,completed_at)
          VALUES (?,?,?,?,?,?,?,'PENDING',NULL) ON CONFLICT DO NOTHING`).run(i.authorityId, i.operationId, i.collectionId, i.documentType, i.name,
          i.document.header.id, jsonb(i.document)).changes === 1;
        const row = this.db.prepare("SELECT * FROM allocations WHERE authority_id=? AND operation_id=?").get(i.authorityId, i.operationId) as
          { collection_id: string; document_type: string; name: string; document_id: string; document: string; status: string } | undefined;
        if (!row) throw new Error("Scoped authority allocation reservation was lost");
        if (row.collection_id !== i.collectionId || row.document_type !== i.documentType || row.name !== i.name || (row.status !== "PENDING" && row.status !== "ALLOCATED"))
          return { kind: "IDEMPOTENCY_CONFLICT" };
        const document = JSON.parse(row.document) as PHDocument;
        if (document.header.id !== row.document_id || document.header.documentType !== row.document_type || document.header.name !== row.name)
          throw new Error("Stored scoped authority allocation is corrupt");
        return { kind: "RESERVED", document, completed: row.status === "ALLOCATED", replayed: !inserted };
      });
    },
    finishAllocation: async (i) => this.write(() => {
      this.assertWritable();
      const r = this.db.prepare("UPDATE allocations SET status='ALLOCATED', completed_at=? WHERE authority_id=? AND operation_id=? AND document_id=? AND status IN ('PENDING','ALLOCATED')")
        .run(this.now(), i.authorityId, i.operationId, i.documentId);
      if (Number(r.changes) !== 1) throw new Error("Scoped authority allocation completion was not durable");
    }),
    reconcile: async (p, job) => {
      assertPreconditions(p, job);
      return this.read(() => {
        const r = this.db.prepare("SELECT * FROM receipts WHERE authority_id=? AND operation_id=?").get(p.authorityId, p.operationId) as ReceiptRow | undefined;
        if (r) {
          if (!sameTuple(r, p, job)) return { disposition: "IDEMPOTENCY_CONFLICT" };
          if (r.disposition === "PENDING") return { disposition: "UNRESOLVED" };
          const o = outcomeFromRow(r);
          switch (o.disposition) {
            case "ACCEPTED": return { disposition: "MATCH_ACCEPTED", revision: o.revision, operationIndexes: o.operationIndexes };
            case "REJECTED_BY_MODEL": return { disposition: "MATCH_REJECTED", revision: o.revision, operationIndexes: o.operationIndexes, errors: o.errors };
            case "REVISION_CONFLICT": return { disposition: "MATCH_REVISION_CONFLICT" };
            default: return { disposition: "MATCH_REFUSED" };
          }
        }
        const expected = expectedOperationIndexes(p.expectedRevision, p.actionCount);
        const ops = this.db.prepare("SELECT idx, action, error FROM operations WHERE document_id=? AND scope=? AND idx >= ? AND idx < ? ORDER BY idx ASC")
          .all(job.documentId, job.scope, p.expectedRevision, p.expectedRevision + p.actionCount) as { idx: number; action: string; error: string | null }[];
        if (ops.length === p.actionCount) {
          const actions = ops.map((o) => parseAction(o.action));
          if (actions.every(Boolean) && ops.every((o, i) => o.idx === expected[i]) && digestScopedAuthorityActions(actions as unknown as Action[]) === p.actionDigest) {
            const errors = ops.map((o) => o.error).filter((e): e is string => typeof e === "string").map((e) => e.slice(0, MAX_ERROR_LENGTH));
            return errors.length > 0
              ? { disposition: "MATCH_REJECTED", revision: p.expectedRevision + p.actionCount, operationIndexes: expected, errors }
              : { disposition: "MATCH_ACCEPTED", revision: p.expectedRevision + p.actionCount, operationIndexes: expected };
          }
        }
        return ops.length > 0 ? { disposition: "CONFLICT" } : { disposition: "UNRESOLVED" };
      });
    },
  };

  // ---- ScopedClient ----
  readonly client: ScopedClient = {
    drives: { addFile: async (driveId, document) => this.attach(driveId, document) },
    executeScopedAuthority: async (documentId, actions, p) => this.execute(documentId, actions, p),
  };

  /** Attach a reserved document: its genesis (CREATE_DOCUMENT named, UPGRADE_DOCUMENT 0 -> N) becomes the document spine. */
  private attach(driveId: string, document: PHDocument) {
    assert(driveId === this.identity.driveId, "Drive mismatch");
    const genesis = structuredClone(document.operations.document ?? []).map((op) => op.action);
    const create = genesis[0]?.input as Record<string, unknown> | undefined, upgrade = genesis[1]?.input as Record<string, unknown> | undefined;
    assert(genesis.length === 2 && genesis[0].type === "CREATE_DOCUMENT" && genesis[1].type === "UPGRADE_DOCUMENT" &&
      create?.documentId === document.header.id && upgrade?.documentId === document.header.id && upgrade?.fromVersion === 0 &&
      upgrade?.toVersion === document.state.document.version && (document.operations.global ?? []).length === 0,
      "Native allocation requires intact genesis actions");
    create!.name = document.header.name;
    return this.write(() => {
      this.assertWritable();
      assert(!this.db.prepare("SELECT 1 FROM documents WHERE id=?").get(document.header.id), "Document already attached");
      const next = (this.db.prepare("SELECT COALESCE(MAX(incarnation),0)+1 AS n FROM documents").get() as { n: number }).n;
      this.db.prepare("INSERT INTO documents(id,collection_id,document_type,incarnation,left_at) VALUES (?,?,?,?,NULL)")
        .run(document.header.id, this.collectionId, document.header.documentType, next);
      genesis.forEach((a, i) => this.db.prepare("INSERT INTO operations(document_id,scope,idx,action,error) VALUES (?,'document',?,?,NULL)").run(document.header.id, i, jsonb(a)));
      return { documentId: document.header.id };
    });
  }

  /** The ported begin -> reduce -> finish, as ONE synchronous BEGIN IMMEDIATE block (R-2). */
  private execute(documentId: string, actions: Action[], p: Preconditions): NativeReceipt {
    const job: Job = { documentId, scope: "global", branch: "main", actions };
    assertPreconditions(p, job);
    const stored = actions.map((a) => jsonb(passthroughSigned(a))); // stored bytes (signed, JSONB order) before any reducer touches them
    return this.write(() => {
      this.assertWritable();
      const prior = this.db.prepare("SELECT * FROM receipts WHERE authority_id=? AND operation_id=?").get(p.authorityId, p.operationId) as ReceiptRow | undefined;
      if (prior) {
        if (!sameTuple(prior, p, job)) return { disposition: "IDEMPOTENCY_CONFLICT" };
        if (prior.disposition === "PENDING") throw new Error("Scoped authority receipt is unexpectedly pending");
        return outcomeFromRow(prior);
      }
      this.db.prepare(`INSERT INTO receipts(authority_id,operation_id,contract,collection_id,membership_incarnation,document_id,document_type,scope,branch,
        expected_revision,action_digest,action_count,disposition) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'PENDING')`)
        .run(p.authorityId, p.operationId, p.contract, p.collectionId, p.membershipIncarnation, documentId, p.documentType, job.scope, job.branch,
          p.expectedRevision, p.actionDigest, p.actionCount);
      const finish = (o: Terminal): NativeReceipt => {
        assertTerminal(p, o);
        const accepted = o.disposition === "ACCEPTED" || o.disposition === "REJECTED_BY_MODEL";
        this.db.prepare("UPDATE receipts SET disposition=?, revision=?, current_revision=?, operation_indexes=?, errors=?, completed_at=? WHERE authority_id=? AND operation_id=? AND disposition='PENDING'")
          .run(o.disposition, accepted ? o.revision : null, o.disposition === "REVISION_CONFLICT" ? o.currentRevision : null,
            accepted ? JSON.stringify(o.operationIndexes) : null, o.disposition === "REJECTED_BY_MODEL" ? JSON.stringify(o.errors.map((e) => e.slice(0, MAX_ERROR_LENGTH))) : null,
            this.now(), p.authorityId, p.operationId);
        return { ...o, replayed: false };
      };
      const m = this.db.prepare("SELECT incarnation, left_at FROM documents WHERE id=? AND collection_id=?").get(documentId, p.collectionId) as { incarnation: number; left_at: string | null } | undefined;
      if (!m || m.left_at !== null || String(m.incarnation) !== p.membershipIncarnation) return finish({ disposition: "REFUSED" });
      const own = this.owned(p.collectionId, documentId, p.documentType);
      if (own.disposition !== "OWNED") return finish({ disposition: "REFUSED" });
      if (own.currentRevision !== p.expectedRevision) return finish({ disposition: "REVISION_CONFLICT", currentRevision: own.currentRevision });
      // Reduce with the same reducers NativeBackend.read uses; a throwing reducer rolls the whole command back (no receipt).
      const create = parseAction((this.db.prepare("SELECT action FROM operations WHERE document_id=? AND scope='document' ORDER BY idx ASC LIMIT 1").get(documentId) as { action: string }).action);
      const model = nativeModel(p.documentType as ModelType, this.initialModelVersion(documentId, p.documentType));
      const reduce = model.reducer as (d: NativeDocument, a: Action) => NativeDocument;
      let doc = model.utils.createDocument() as NativeDocument;
      doc.header.id = documentId; doc.header.name = String(parseAction(create?.input)?.name ?? "");
      for (const r of this.db.prepare("SELECT action FROM operations WHERE document_id=? AND scope='global' ORDER BY idx ASC").all(documentId) as { action: string }[])
        doc = reduce(doc, JSON.parse(r.action));
      const generated: { index: number; error?: string }[] = [];
      actions.forEach((a, i) => {
        doc = reduce(doc, JSON.parse(stored[i]));
        const op = doc.operations.global.at(-1)!;
        assert(op.index === p.expectedRevision + i, "Scoped authority reducer produced an unexpected operation index");
        this.db.prepare("INSERT INTO operations(document_id,scope,idx,action,error) VALUES (?,'global',?,?,?)").run(documentId, op.index, stored[i], op.error ?? null);
        generated.push({ index: op.index, ...(typeof op.error === "string" ? { error: op.error } : {}) });
      });
      const operationIndexes = generated.map((g) => g.index), errors = generated.flatMap((g) => (g.error ? [g.error] : []));
      const revision = Math.max(...operationIndexes) + 1;
      const receipt = finish(errors.length ? { disposition: "REJECTED_BY_MODEL", revision, operationIndexes, errors } : { disposition: "ACCEPTED", revision, operationIndexes });
      // Effect-outbox intent in the SAME transaction as the accepted reservation (C-2.2); a reused dispatch claim aborts it.
      if (receipt.disposition === "ACCEPTED")
        for (const a of actions.filter((x) => x.type === "RESERVE_EFFECT")) {
          const input = a.input as { outboxRef: string; dispatchRef: string; proposalHash: string };
          this.db.prepare(`INSERT INTO effects(key,kind,profile_id,month,document_id,operation_id,dispatch_ref,proposal_hash,reserved_usd,state,cost_usd,reason,at)
            VALUES (?,'publication','publication',?,?,?,?,?,0,'reserved',NULL,NULL,?)`).run(input.outboxRef, this.now().slice(0, 7), documentId, p.operationId, input.dispatchRef, input.proposalHash, this.now());
        }
      // Fable N-3: the rest of the publication outbox lifecycle, in the same transaction as the accepted operation.
      // CLAIM_EXECUTION is the durable claim BEFORE the provider call -> 'sent'; RECORD_DELIVERY settles a definite outcome
      // (DELIVERED / FAILED), holds an UNCERTAIN one as 'unsettled', and keeps a provider ACCEPTED as 'sent'.
      if (receipt.disposition === "ACCEPTED")
        for (const a of actions) {
          if (a.type === "CLAIM_EXECUTION") {
            const ref = (a.input as { outboxRef: string }).outboxRef;
            const row = this.db.prepare("SELECT state FROM effects WHERE key=? AND kind='publication' AND document_id=?").get(ref, documentId) as { state: string } | undefined;
            assert(row, "effect_outbox_intent_missing"); // no intent, no claim: the whole command rolls back
            if (row!.state === "reserved") this.db.prepare("UPDATE effects SET state='sent', reason=NULL, at=? WHERE key=?").run(this.now(), ref);
          }
          if (a.type === "RECORD_DELIVERY") {
            const ref = (doc.state.global as { effect?: { outboxRef?: string } }).effect?.outboxRef;
            const status = (a.input as { status: string }).status;
            assert(ref && this.db.prepare("SELECT 1 FROM effects WHERE key=? AND kind='publication' AND document_id=?").get(ref, documentId), "effect_outbox_intent_missing");
            const to = status === "DELIVERED" || status === "FAILED" ? "settled" : status === "UNCERTAIN" ? "unsettled" : "sent";
            this.db.prepare("UPDATE effects SET state=?, reason=?, at=? WHERE key=? AND state IN ('sent','unsettled')")
              .run(to, "delivery:" + status.toLowerCase(), this.now(), ref);
          }
        }
      return receipt;
    });
  }

  /** Fixed allocation query for the pilot observation (same rows the Reactor reader returns). */
  pilotAllocations(prefix: string) {
    return this.read(() => (this.db.prepare("SELECT authority_id, collection_id, operation_id, document_id, document_type, status, completed_at FROM allocations WHERE authority_id=? AND collection_id=? AND operation_id LIKE ? ORDER BY operation_id ASC LIMIT 201")
      .all(this.identity.authorityId, this.collectionId, `${prefix}%`) as Record<string, string | null>[])
      .map((r) => ({ authorityId: r.authority_id, collectionId: r.collection_id, operationId: r.operation_id, documentId: r.document_id,
        documentType: r.document_type, status: r.status, completedAt: r.completed_at })));
  }
  /** Counts for export/backup manifests (R-5). */
  counts() {
    return this.read(() => ({
      documents: (this.db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n,
      operations: (this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE scope='global'").get() as { n: number }).n,
      receipts: (this.db.prepare("SELECT COUNT(*) AS n FROM receipts").get() as { n: number }).n,
      effects: (this.db.prepare("SELECT COUNT(*) AS n FROM effects").get() as { n: number }).n,
    }));
  }
}
