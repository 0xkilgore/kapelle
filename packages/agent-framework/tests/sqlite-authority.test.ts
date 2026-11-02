// Lean runtime step 1, gate G-2 evidence that is not covered by re-running the whole suite on the SQLite backend:
// - differential: one scripted sequence (authority commands + backend-level edge dispositions + the R-1 crash gaps) on the
//   scoped Reactor AND on SQLite yields the byte-identical transcript (receipts, results, document states), ids normalised;
// - export/replay (C-2.6): every Reactor document + journalled operation, re-applied to SQLite with its original ids,
//   reproduces each receipt and every state digest, with equal operation/receipt counts;
// - Fable R-2 (no torn state under concurrency), R-3 (list order/cursor), R-4 (read-only observers, refuse-create),
//   R-5 (installation identity in lock, store and backup; restore under a new id with a write hold), backup/restore, and
//   the per-org spend ledger (2d rules) driven through the hosted adapter. Fake data only.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync, chmodSync, readdirSync, renameSync, mkdirSync, symlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openFrameworkRuntime } from "../src/service/runtime.js";
import { canonical, digest, nativeModel, type ModelType } from "../src/command-boundary.js";
import { openSqliteDatabase, type SqliteAuthority } from "../src/service/sqlite-authority.js";
import { adoptBody } from "../src/org/task-model.js";
import { SqliteSpendLedger } from "../src/service/sqlite-effects.js";
import { backupSqliteAuthority, restoreSqliteAuthority } from "../src/service/sqlite-backup.js";
import { hostedProfileSchema } from "../src/agent-kit/hosted/profile.js";
import { hostedInferenceFor } from "../src/agent-kit/hosted/profile.js";
import { openHostedAdapter } from "../src/agent-kit/hosted/adapter.js";
import type { Entry } from "../src/service/journal.js";
import { context, release, policy } from "./fixtures.js";

const reactorRoot = process.env.KAPELLE_SCOPED_REACTOR_ROOT;
const enabled = !!reactorRoot && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const sha = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
const ctx = context();
const privateDir = (prefix: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); chmodSync(d, 0o700); return d; };
const options = (stateRoot: string, backend: "reactor" | "sqlite", extra: Record<string, unknown> = {}) =>
  ({ stateRoot, reactorRoot: reactorRoot!, ownerId: "owner", scopeRef: "synthetic-league", facts: async () => ({ ...ctx }), now: () => ctx.occurredAt, backend, ...extra });
type Rt = Awaited<ReturnType<typeof openFrameworkRuntime>>;
const sqliteOf = (rt: Rt) => (rt as Rt & { sqlite?: SqliteAuthority }).sqlite!;

const grant = (principalId: string, id: string) => ({ id, principalId, resourceRef: "contracts", actions: ["read"], expiresAt: "2026-09-11T12:00:00.000Z", reviewPolicy: "ALWAYS" });
/** The same script on either backend. Returns the transcript and the allocated ids (in order) for normalisation. */
async function script(rt: Rt) {
  const a = rt.authority, b = a.backend, ids: string[] = [], out: unknown[] = [];
  let n = 0;
  const allocate = async (type: ModelType, op = `allocation-${n++}`) => { const r = await a.allocate(op, type, "Synthetic native qualification"); if (!ids.includes(r.documentId)) ids.push(r.documentId); out.push({ allocate: op, ...r }); return r.documentId; };
  const command = async (id: string, type: ModelType, typeName: string, input: Record<string, unknown>, op = `command-${n++}`) => {
    const d = await a.read(id, type);
    const r = await a.command({ operationId: op, documentId: id, documentType: type, expectedRevision: d.state.global.revision, type: typeName, input });
    out.push({ command: typeName, ...r }); return r;
  };
  const definition = await allocate("kapelle/agent-definition");
  await command(definition, "kapelle/agent-definition", "PUBLISH_DEFINITION", { release: release() });
  const instance = await allocate("kapelle/agent-instance"), r = release();
  await command(instance, "kapelle/agent-instance", "CREATE_INSTANCE", { instanceId: instance, scopeRef: ctx.scopeRef,
    definitionRef: { id: r.definitionId, version: r.packageVersion, contentHash: r.contentHash }, name: "Synthetic scoped reviewer",
    responsibilities: ["Review supplied document"], operatingPolicy: "Read only", modelPolicy: policy });
  await command(instance, "kapelle/agent-instance", "SET_RUNTIME_BINDING", { runtimeBindingRef: "local-adapter" });
  // Allocation replay keeps the same identity; a second document of the same type joins the list.
  await allocate("kapelle/agent-instance", "allocation-2");
  const second = await allocate("kapelle/agent-instance");
  // R-1 crash gap A: the journal prepare is committed, then the process "dies" before the native command; the re-issued
  // command finds the pending entry, reconciles (UNRESOLVED) and executes it once.
  const commit = b.commit.bind(b);
  const resume = async (op: string) => { const r = await a.command(JSON.parse(JSON.stringify((a.journal.get(op) as Entry).command))); out.push({ resumed: op, ...r }); };
  b.commit = async () => { throw new Error("simulated crash before native commit"); };
  await expect(command(instance, "kapelle/agent-instance", "GRANT_CAPABILITY", { grant: grant(instance, "crash-a") }, "crash-a")).rejects.toThrow("simulated crash");
  b.commit = commit;
  out.push({ pending: a.journal.pending().map((e) => e.command.operationId) });
  await resume("crash-a"); // reconcile UNRESOLVED, then the retained prepared action executes once
  // Crash gap B: the native command commits, then the response is lost; the re-issue reconciles to MATCH_ACCEPTED, once.
  b.commit = async (id, p) => { await commit(id, p); throw new Error("simulated response loss"); };
  await expect(command(instance, "kapelle/agent-instance", "GRANT_CAPABILITY", { grant: grant(instance, "crash-b") }, "crash-b")).rejects.toThrow("response loss");
  b.commit = commit;
  await resume("crash-b");
  // Org Task (lifted kilgore/task, step 4): passkey-authorized adopt, then a note, so parity covers Tasks too.
  const orgTask = await allocate("kilgore/task" as ModelType);
  const taskInput = { id: orgTask, title: "Draft the Oct 8 minutes", ownerId: "owner", source: "HUMAN", sourceRef: "intake:intake_AAAAAAAAAAAAAAAAAAAAAAAA" };
  const member = "m-11111111-1111-4111-8111-111111111111";
  out.push({ task: (await a.orgTaskCommand({ operationId: "task-adopt-0001", documentId: orgTask, documentType: "kilgore/task", expectedRevision: 0, type: "CREATE_TASK", input: taskInput },
    `member:org-a:${member}:v0`, { memberId: member, action: "task.adopt", bodyHash: digest(adoptBody(taskInput)), operationId: "task-adopt-0001" })).result });
  out.push({ task: (await a.orgTaskCommand({ operationId: "task-note-0001", documentId: orgTask, documentType: "kilgore/task", expectedRevision: 1, type: "ADD_COMMENT",
    input: { id: "n1", bodyMarkdown: "check flyer" } }, `member:org-a:${member}:v0`)).result });
  // Backend-level edge dispositions the authority itself never issues.
  const instanceType = "kapelle/agent-instance" as const, cur = await b.read(instance, instanceType);
  const prior = (a.journal.get("command-3") as Entry).prepared.action; // CREATE_INSTANCE
  const again = { ...prior, id: "rejected-create-instance" };
  const rejected = await b.prepare(instance, instanceType, "edge-rejected", cur.nativeRevision, again);
  out.push({ edge: "model-rejection", receipt: await b.commit(instance, rejected) });
  out.push({ edge: "exact-replay", receipt: await b.commit(instance, rejected) });
  out.push({ edge: "reconcile-committed", receipt: await b.reconcile(instance, rejected) });
  const stale = await b.prepare(instance, instanceType, "edge-stale", cur.nativeRevision, { ...prior, id: "stale-create-instance" });
  out.push({ edge: "revision-conflict", receipt: await b.commit(instance, stale) });
  const conflicting = await b.prepare(instance, instanceType, "edge-rejected", cur.nativeRevision + 1, { ...prior, id: "other-action" });
  out.push({ edge: "idempotency-conflict", receipt: await b.commit(instance, conflicting) });
  const unexecuted = await b.prepare(second, instanceType, "edge-unexecuted", (await b.read(second, instanceType)).nativeRevision, { ...prior, id: "never-sent" });
  out.push({ edge: "reconcile-unexecuted", receipt: await b.reconcile(second, unexecuted) });
  // R-3: page order and cursor semantics (document id ascending; cursor = last id examined).
  const pages: unknown[] = [];
  for (let cursor: string | null = null, i = 0; i < 5; i++) { const p = await b.listPage(instanceType, cursor, 1); pages.push(p); cursor = p.nextCursor; if (!cursor) break; }
  out.push({ list: await b.list(instanceType), pages, sorted: [...(await b.list(instanceType))].sort() });
  const states: Record<string, unknown> = {};
  for (const [id, type] of [[definition, "kapelle/agent-definition"], [instance, instanceType], [second, instanceType], [orgTask, "kilgore/task"]] as const) {
    const d = await b.read(id, type); states[id] = { revision: d.nativeRevision, state: d.document.state, // action id + timestamp are minted per run by the authority (random id, wall clock), not by the store: keep every other
      // stored byte (key order included) and compare it.
      operations: d.document.operations.global.map((o) => { const { id: _, timestampUtcMs: __, ...rest } = o.action as Record<string, unknown>; return { index: o.index, action: JSON.stringify(rest), error: o.error ?? null }; }) };
  }
  out.push({ states });
  return { out, ids };
}
function normalise(v: unknown, ids: string[]) {
  let s = JSON.stringify(v);
  // List order is a per-backend rule (id ascending); ids are random per allocation, so compare the rule, then mask ids.
  ids.forEach((id, i) => { s = s.split(id).join(`<doc${i}>`); });
  return s;
}

describe.skipIf(!enabled)("lean runtime step 1: SQLite authority parity (G-2)", () => {
  it("differential: the scripted transcript is byte-identical on Reactor and SQLite (receipts, results, crash gaps, states)", async () => {
    const roots = { reactor: privateDir("parity-reactor-"), sqlite: privateDir("parity-sqlite-") };
    const runs: Record<string, { out: unknown[]; ids: string[] }> = {};
    for (const backend of ["reactor", "sqlite"] as const) {
      const rt = await openFrameworkRuntime(options(roots[backend], backend) as never);
      try { runs[backend] = await script(rt); } finally { await rt.close(); }
    }
    expect(existsSync(join(roots.sqlite, "authority.sqlite"))).toBe(true);
    expect(existsSync(join(roots.reactor, "pglite"))).toBe(true);
    for (const r of Object.values(runs)) {
      const list = r.out.find((x: any) => x.list) as { list: string[]; sorted: string[]; pages: { documentIds: string[] }[] };
      expect(list.list).toEqual(list.sorted);                              // same order rule on both
      expect(list.pages.flatMap((p) => p.documentIds)).toEqual(list.sorted); // same cursor walk
    }
    // Ids differ per allocation, so their sorted order can differ: mask the list entry's order, compare everything else bytes.
    const masked = (r: { out: unknown[]; ids: string[] }) => normalise(r.out.map((x: any) => (x.list ? { list: x.list.length, pages: x.pages.length } : x)), r.ids);
    expect(masked(runs.sqlite)).toBe(masked(runs.reactor));
    const edges = Object.fromEntries(runs.sqlite.out.filter((x: any) => x.edge).map((x: any) => [x.edge, x.receipt.disposition]));
    expect(edges).toEqual({ "model-rejection": "REJECTED_BY_MODEL", "exact-replay": "REJECTED_BY_MODEL", "reconcile-committed": "MATCH_REJECTED",
      "revision-conflict": "REVISION_CONFLICT", "idempotency-conflict": "IDEMPOTENCY_CONFLICT", "reconcile-unexecuted": "UNRESOLVED" });
  }, 180_000);

  it("export/replay: Reactor documents and journalled operations re-apply to SQLite with original ids, same receipts and state digests", async () => {
    const reactorDir = privateDir("export-reactor-"), sqliteDir = privateDir("export-sqlite-");
    const rt = await openFrameworkRuntime(options(reactorDir, "reactor") as never);
    const exported: { id: string; type: ModelType; name: string; version: number; digest: string; revision: number; actions: unknown[] }[] = [];
    let entries: Entry[] = [];
    try {
      await script(rt);
      for (const type of ["kapelle/agent-definition", "kapelle/agent-instance", "kilgore/task"] as const)
        for (const id of await rt.authority.backend.list(type)) {
          const snap = (await rt.authority.backend.store.readOwnedOperationSnapshot({ collectionId: rt.authority.backend.collectionId, documentId: id, documentType: type }))!;
          const d = await rt.authority.backend.read(id, type);
          exported.push({ id, type, name: snap.name, version: snap.initialModelVersion!, digest: sha(d.document.state), revision: d.nativeRevision, actions: snap.operations.map((o) => o.action) });
        }
      entries = (rt.authority.journal.db.prepare("SELECT body FROM commands").all() as { body: string }[]).map((r) => JSON.parse(r.body));
    } finally { await rt.close(); }
    const target = await openFrameworkRuntime(options(sqliteDir, "sqlite") as never);
    try {
      const sqlite = sqliteOf(target), b = target.authority.backend;
      for (const e of exported) {
        const doc = nativeModel(e.type, e.version).utils.createDocument() as any;
        doc.header.id = e.id; doc.header.name = e.name;
        for (const op of doc.operations.document) { op.action.input.documentId = e.id; if (op.action.input.signing) op.action.input.signing.signature = e.id; }
        await sqlite.client.drives.addFile(b.driveId, doc);
      }
      // Re-apply every retained operation, per document in revision order, with its original action bytes. Journalled ones
      // keep their original operation id and must reproduce the Reactor's receipt; backend-level ones get an export id.
      const byAction = new Map(entries.filter((e) => e.result).map((e) => [e.prepared.action.id, e]));
      let compared = 0;
      for (const e of exported)
        for (const [i, action] of (e.actions as Entry["prepared"]["action"][]).entries()) {
          const own = await b.store.inspectOwned({ collectionId: b.collectionId, documentId: e.id, documentType: e.type });
          const j = byAction.get(action.id);
          const p = j ? { ...j.prepared.preconditions, collectionId: b.collectionId, membershipIncarnation: (own as { membershipIncarnation: string }).membershipIncarnation }
            : (await b.prepare(e.id, e.type, `export:${e.id}:${i}`, i, action)).preconditions;
          expect(p.expectedRevision).toBe(i);
          const receipt = await sqlite.client.executeScopedAuthority(e.id, [action], p);
          if (j) {
            const { replayed: _, ...want } = j.result as unknown as Record<string, unknown>, { replayed: __, ...got } = receipt as unknown as Record<string, unknown>;
            expect(JSON.stringify(got), j.command.operationId).toBe(JSON.stringify(want)); compared++;
          }
        }
      expect(compared).toBe(7); // PUBLISH, CREATE, BIND, crash-a, crash-b, task adopt, task note
      for (const e of exported) {
        const d = await b.read(e.id, e.type);
        expect([d.nativeRevision, sha(d.document.state)], e.id).toEqual([e.revision, e.digest]);
      }
      const counts = sqlite.counts();
      expect(counts.receipts).toBe(exported.reduce((n, e) => n + e.revision, 0));
      expect(counts.operations).toBe(exported.reduce((n, e) => n + e.revision, 0));
      expect(counts.documents).toBe(exported.length);
    } finally { await target.close(); }
  }, 180_000);

  it("R-2: no torn state; concurrent same-revision commits serialize to one ACCEPTED and one REVISION_CONFLICT; async inside a transaction is refused", async () => {
    const rt = await openFrameworkRuntime(options(privateDir("r2-"), "sqlite") as never);
    try {
      const b = rt.authority.backend, sqlite = sqliteOf(rt);
      const def = (await rt.authority.allocate("r2-def", "kapelle/agent-definition", "Definition")).documentId;
      expect((await rt.authority.command({ operationId: "r2-publish", documentId: def, documentType: "kapelle/agent-definition", expectedRevision: 0,
        type: "PUBLISH_DEFINITION", input: { release: release() } })).result.disposition).toBe("ACCEPTED");
      const id = (await rt.authority.allocate("r2-alloc", "kapelle/agent-instance", "Concurrency")).documentId;
      const r = release();
      const create = await rt.authority.command({ operationId: "r2-create", documentId: id, documentType: "kapelle/agent-instance", expectedRevision: 0, type: "CREATE_INSTANCE",
        input: { instanceId: id, scopeRef: ctx.scopeRef, definitionRef: { id: r.definitionId, version: r.packageVersion, contentHash: r.contentHash }, name: "C",
          responsibilities: ["r"], operatingPolicy: "Read only", modelPolicy: policy } });
      expect(create.result.disposition).toBe("ACCEPTED");
      expect((await rt.authority.command({ operationId: "r2-bind", documentId: id, documentType: "kapelle/agent-instance", expectedRevision: 1,
        type: "SET_RUNTIME_BINDING", input: { runtimeBindingRef: "local-adapter" } })).result.disposition).toBe("ACCEPTED");
      const base = (rt.authority.journal.get("r2-bind") as Entry).prepared.action, rev = (await b.read(id, "kapelle/agent-instance")).nativeRevision;
      const p1 = await b.prepare(id, "kapelle/agent-instance", "r2-a", rev, { ...base, id: "a" });
      const p2 = await b.prepare(id, "kapelle/agent-instance", "r2-b", rev, { ...base, id: "b" });
      const [x, y, seen] = await Promise.all([b.commit(id, p1), b.commit(id, p2), b.read(id, "kapelle/agent-instance")]);
      // Exactly one applies at the shared revision (accepted or model-rejected, it is appended either way); the other conflicts.
      expect([x, y].filter((r) => r.disposition === "REVISION_CONFLICT")).toHaveLength(1);
      expect([x, y].filter((r) => ["ACCEPTED", "REJECTED_BY_MODEL"].includes(r.disposition) && r.revision === rev + 1)).toHaveLength(1);
      expect([rev, rev + 1]).toContain(seen.nativeRevision); // a whole snapshot before or after, never between
      expect(() => sqlite.write(async () => 1 as never)).toThrow("sqlite_authority_async_in_transaction");
      expect(sqlite.db.isTransaction).toBe(false);
    } finally { await rt.close(); }
  }, 60_000);

  it("R-4/R-5: read-only observers, refuse-create, installation identity in lock/store, tamper refused", async () => {
    const root = privateDir("r45-"), dbPath = join(root, "authority.sqlite");
    // Observation of a store that does not exist refuses and creates nothing.
    await expect(openFrameworkRuntime(options(root, "sqlite", { requireExistingAuthority: true }) as never)).rejects.toThrow();
    expect(existsSync(dbPath) || existsSync(join(root, "authority.json"))).toBe(false);
    expect(() => openSqliteDatabase(join(root, "absent.sqlite"), { create: false, readOnly: true })).toThrow();
    expect(existsSync(join(root, "absent.sqlite"))).toBe(false);
    const rt = await openFrameworkRuntime(options(root, "sqlite") as never);
    let installationId = "";
    try {
      const id = (await rt.authority.allocate("r45-alloc", "kapelle/agent-instance", "Observed")).documentId;
      installationId = sqliteOf(rt).identity.installationId;
      expect(readFileSync(join(root, "writer.lock"), "utf8").split("\n")[2]).toBe(`installation:${installationId}`);
      // A read-only observer connection reads the WAL store while the writer holds it.
      const observer = openSqliteDatabase(dbPath, { create: false, readOnly: true });
      try { expect((observer.prepare("SELECT id FROM documents").all() as { id: string }[]).map((r) => r.id)).toEqual([id]); } finally { observer.close(); }
    } finally { await rt.close(); }
    // Observation runtime opens the closed store read-only: reads work, writes are refused, the journal schema is asserted.
    const obs = await openFrameworkRuntime(options(root, "sqlite", { requireExistingAuthority: true }) as never);
    try {
      expect(await obs.authority.backend.list("kapelle/agent-instance")).toHaveLength(1);
      expect(() => obs.authority.allocate("r45-other", "kapelle/agent-instance", "No")).toThrow("observation_only");
    } finally { await obs.close(); }
    // A store whose installation id differs from authority.json (swapped/restored file) is refused.
    const meta = JSON.parse(readFileSync(join(root, "authority.json"), "utf8"));
    writeFileSync(join(root, "authority.json"), JSON.stringify({ ...meta, installationId: randomUUID() }), { mode: 0o600 });
    await expect(openFrameworkRuntime(options(root, "sqlite") as never)).rejects.toThrow("sqlite_authority_identity_mismatch");
    // An existing Reactor-created authority never reopens as SQLite, and vice versa.
    writeFileSync(join(root, "authority.json"), JSON.stringify(meta), { mode: 0o600 });
    await expect(openFrameworkRuntime(options(root, "reactor") as never)).rejects.toThrow("authority_backend_mismatch");
  }, 60_000);

  it("cold capture + existing-authority checks on SQLite (equivalents of the Reactor-storage suites)", async () => {
    // A rejected capture runs with only the lock present and constructs nothing; the lock is released.
    const root = privateDir("cold-");
    await expect(openFrameworkRuntime(options(root, "sqlite", { beforeDatabaseOpen: async (c: { assertOwnership(): void }) => {
      c.assertOwnership(); expect(readdirSync(root)).toEqual(["writer.lock"]); throw new Error("capture_failed"); } }) as never)).rejects.toThrow("capture_failed");
    expect(readdirSync(root)).toEqual([]);
    // A cancelled open never calls capture and leaves nothing.
    const ac = new AbortController(); ac.abort(); let called = false;
    await expect(openFrameworkRuntime(options(root, "sqlite", { openSignal: ac.signal, beforeDatabaseOpen() { called = true; } }) as never)).rejects.toThrow();
    expect([called, readdirSync(root)]).toEqual([false, []]);
    // Normal open, close, reopen keeps the same installation; metadata naming a store that is gone is refused, not recreated.
    const rt = await openFrameworkRuntime(options(root, "sqlite") as never); const installation = sqliteOf(rt).identity.installationId; await rt.close();
    const again = await openFrameworkRuntime(options(root, "sqlite") as never); expect(sqliteOf(again).identity.installationId).toBe(installation); await again.close();
    const moved = privateDir("moved-");
    for (const f of readdirSync(root).filter((f) => f.startsWith("authority.sqlite"))) renameSync(join(root, f), join(moved, f));
    await expect(openFrameworkRuntime(options(root, "sqlite") as never)).rejects.toThrow("existing_authority_store_invalid");
    expect(existsSync(join(root, "authority.sqlite"))).toBe(false);
    expect(existsSync(join(root, "writer.lock"))).toBe(false);
    // A state root that resolves into Dropbox is refused before any store is created, and the lock is released.
    const fake = privateDir("dbx-"), synced = join(fake, "Dropbox"); mkdirSync(synced, { mode: 0o700 });
    const linked = join(privateDir("link-"), "state"); symlinkSync(synced, linked);
    await expect(openFrameworkRuntime(options(linked, "sqlite") as never)).rejects.toThrow();
    expect(readdirSync(synced)).toEqual([]);
    const inside = join(synced, "org"); mkdirSync(inside, { mode: 0o700 });
    await expect(openFrameworkRuntime(options(inside, "sqlite") as never)).rejects.toThrow("sqlite_authority_in_dropbox");
    expect(readdirSync(inside)).toEqual([]);
  }, 60_000);

  it("backup mid-run + restore under a new installation id: same state at the backup point, write hold until sent effects are reconciled", async () => {
    const root = privateDir("bk-src-"), backups = privateDir("bk-dst-"), restored = join(privateDir("bk-new-"), "state");
    const rt = await openFrameworkRuntime(options(root, "sqlite") as never);
    let manifest: Awaited<ReturnType<typeof backupSqliteAuthority>>, atBackup = "", binding = "";
    try {
      const { out } = await script(rt);
      const sqlite = sqliteOf(rt), ledger = new SqliteSpendLedger(sqlite, { monthlyUsd: 10 }, () => ctx.occurredAt);
      ledger.reserve("in-flight", "hosted-sonnet", 0.2, 1); ledger.markSent("in-flight"); // sent, outcome unknown at backup time
      atBackup = JSON.stringify(out.at(-1));
      binding = sqlite.identity.binding;
      manifest = await backupSqliteAuthority(rt.authority, sqlite, backups, () => ctx.occurredAt);
      expect(manifest).toMatchObject({ installationId: sqlite.identity.installationId, counts: sqlite.counts() });
      // Work after the backup is NOT in the restored copy.
      await rt.authority.allocate("after-backup", "kapelle/agent-instance", "Later");
    } finally { await rt.close(); }
    const r = restoreSqliteAuthority(join(backups, manifest!.file), restored, binding);
    expect(r.installationId).not.toBe(manifest!.installationId);
    expect(r.held).toBe(true);
    await expect(() => restoreSqliteAuthority(join(backups, manifest!.file), restored, binding)).toThrow("sqlite_restore_target_not_empty");
    const back = await openFrameworkRuntime(options(restored, "sqlite") as never);
    try {
      const sqlite = sqliteOf(back), b = back.authority.backend;
      expect(sqlite.identity.installationId).toBe(r.installationId);
      expect(sqlite.counts()).toEqual(manifest!.counts);
      const states = (JSON.parse(atBackup) as { states: Record<string, { state: { global: unknown }; revision: number }> }).states;
      for (const [id, s] of Object.entries(states)) {
        const type = (await b.list("kapelle/agent-definition")).includes(id) ? "kapelle/agent-definition" : (await b.list("kilgore/task")).includes(id) ? "kilgore/task" : "kapelle/agent-instance";
        const d = await b.read(id, type as ModelType);
        expect([d.nativeRevision, JSON.stringify(d.document.state.global)]).toEqual([s.revision, JSON.stringify(s.state.global)]);
      }
      await expect(back.authority.allocate("held", "kapelle/agent-instance", "Held")).rejects.toThrow("sqlite_authority_restore_reconciliation_required");
      const ledger = new SqliteSpendLedger(sqlite, { monthlyUsd: 10 }, () => ctx.occurredAt);
      expect(ledger.entry("in-flight")).toMatchObject({ state: "unsettled", reason: "restored_outcome_unknown" });
      expect(() => sqlite.releaseRestoreHold()).toThrow("sqlite_authority_restore_effects_unreconciled");
      ledger.reconcile(ctx.occurredAt.slice(0, 7), "in-flight", 0.01);
      sqlite.releaseRestoreHold();
      expect((await back.authority.allocate("after-restore", "kapelle/agent-instance", "Resumed")).documentId).toBeTruthy();
    } finally { await back.close(); }
  }, 180_000);

  it("per-org spend ledger: the 2d rules on SQLite, and the hosted adapter settles through it", async () => {
    const rt = await openFrameworkRuntime(options(privateDir("ledger-"), "sqlite") as never);
    try {
      const sqlite = sqliteOf(rt);
      let now = "2026-10-31T23:59:00.000Z";
      const l = new SqliteSpendLedger(sqlite, { monthlyUsd: 1 }, () => now);
      l.reserve("held", "p", 0.5, 1); l.markSent("held"); l.markUnsettled("held", "hosted_deadline_exceeded");
      l.reserve("late", "p", 0.1, 1); l.markSent("late");
      l.reserve("crashed", "p", 0.05, 1); l.markSent("crashed");
      now = "2026-11-01T00:00:30.000Z";
      l.settle("late", 0.02);
      expect(l.entries("2026-10").find((e) => e.sessionId === "late")).toMatchObject({ state: "settled", costUsd: 0.02 });
      l.recoverAtStart();
      expect(l.entry("crashed")).toMatchObject({ state: "unsettled", reason: "hosted_outcome_unknown_after_restart" });
      expect(l.carriedUnsettledUsd()).toBeCloseTo(0.55);
      expect(() => l.reserve("x", "p", 0.5, 1)).toThrow("hosted_monthly_cap_exceeded");
      expect(() => l.reserve("held", "p", 0.01, 1)).toThrow("hosted_session_reused");
      expect(l.status()).toMatchObject({ month: "2026-11", settledUsd: 0, openUsd: 0, unsettled: [{ sessionId: "held", month: "2026-10" }, { sessionId: "crashed" }] });
      l.reconcile("2026-10", "held", 0.03);
      expect(l.entry("held")).toMatchObject({ state: "settled", costUsd: 0.03, reason: "reconciled:hosted_deadline_exceeded" });
      // The hosted adapter (fake fetch) reserves, marks sent and settles in the org's SQLite outbox.
      const secretDir = privateDir("secret-"), secret = join(secretDir, "key");
      writeFileSync(secret, "sk-or-v1-SYNTHETIC-NOT-A-REAL-KEY\n", { mode: 0o600 });
      const profile = hostedProfileSchema.parse({ id: "hosted-sonnet", contract: "kapelle.restricted-execution/v3", qualificationRef: "synthetic:hosted",
        runtime: { kind: "hosted-api", locality: "remote-provider", model: "anthropic/claude-sonnet-4.6", origin: "https://openrouter.ai/api/v1", providers: ["Anthropic"],
          dataPolicy: { dataCollection: "deny", zdr: true }, contextTokens: 200000, reasoning: "off", tools: [], concurrencyLimit: 1, usage: "required" },
        harness: { kind: "hosted-openai-compatible", adapterContract: "kapelle.hosted-api-adapter/v1" },
        pricing: { version: "synthetic", inputUsdPerMTok: 3, outputUsdPerMTok: 15, reservationMargin: 1.5 }, limits: { maxOutputTokens: 5000, maxBudgetUsd: 1, timeoutMs: 120000 } });
      const ledger = new SqliteSpendLedger(sqlite, { monthlyUsd: 30 }, () => now);
      const adapter = openHostedAdapter({ profile, secretFile: secret, ledger, fetch: async () => new Response(JSON.stringify({ id: "gen-1", model: "anthropic/claude-sonnet-4.6",
        provider: "Anthropic", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Draft." } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.0004 } }),
        { status: 200, headers: { "content-type": "application/json" } }) });
      const session = randomUUID(), outputs: unknown[] = [];
      await adapter.run({ ...hostedInferenceFor(profile, { maxOutputTokens: 1000, maxBudgetUsd: 1, timeoutMs: 60000 }), system: "s", user: "u" } as never, session, new AbortController().signal,
        { runtime: () => {}, output: (o: unknown) => outputs.push(o) } as never);
      expect(ledger.entry(session)).toMatchObject({ state: "settled", costUsd: 0.0004 });
      expect(outputs).toHaveLength(1);
      expect(JSON.stringify((sqlite.db.prepare("SELECT * FROM effects").all()))).not.toContain("SYNTHETIC-NOT-A-REAL-KEY");
    } finally { await rt.close(); }
  }, 60_000);
});
