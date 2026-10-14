import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  executeCommand,
  type AuthorityPort,
  type Transaction,
  type Receipt,
} from "../src/authority-port.js";
import type { NativeDocument, TrustedContext } from "../src/command-boundary.js";
import { ready, context, command } from "./fixtures.js";

/** Synthetic qualification adapter, not a second production native authority. */
class SqliteFixture implements AuthorityPort {
  db: DatabaseSync;
  constructor(
    path: string,
    private context: TrustedContext,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(owner TEXT,scope TEXT,operation TEXT,body TEXT NOT NULL,PRIMARY KEY(owner,scope,operation));",
    );
  }
  seed(d: NativeDocument) {
    this.db.prepare("INSERT INTO documents VALUES (?,?)").run(d.header.id, JSON.stringify(d));
  }
  atomic<T>(op: (tx: Transaction) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const getDocument = (id: string): NativeDocument =>
        JSON.parse(
          (this.db.prepare("SELECT body FROM documents WHERE id=?").get(id) as { body: string })
            .body,
        );
      const result = op({
        getDocument,
        getReceipt: (owner, scope, operation) => {
          const r = this.db
            .prepare("SELECT body FROM receipts WHERE owner=? AND scope=? AND operation=?")
            .get(owner, scope, operation) as { body: string } | undefined;
          return r ? JSON.parse(r.body) : undefined;
        },
        contextFor: (id) => ({
          ...this.context,
          instance: getDocument(id).state.global as TrustedContext["instance"],
        }),
        save: (d, r) => {
          this.db
            .prepare("UPDATE documents SET body=? WHERE id=?")
            .run(JSON.stringify(d), d.header.id);
          this.db
            .prepare("INSERT INTO receipts VALUES (?,?,?,?)")
            .run(r.ownerId, r.scopeRef, r.operationId, JSON.stringify(r));
        },
      });
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
const identity = { principalId: "owner", ownerId: "owner", scopeRef: "synthetic-league" };
describe("Native authority integration contract", () => {
  it("retains one operation after lost acknowledgement, database reopen and retry through another connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "kapelle-framework-"));
    let a: SqliteFixture | undefined, b: SqliteFixture | undefined;
    try {
      const path = join(dir, "qualification.sqlite"),
        d = ready(),
        ctx = context();
      a = new SqliteFixture(path, ctx);
      a.seed(d);
      const c = command(d, "REQUEST_PAUSE", {}, "stable-operation");
      const receipt = executeCommand(a, c, identity);
      // Response is lost AFTER atomic commit. Close the writer and reopen the durable store.
      a.close();
      a = undefined;
      b = new SqliteFixture(path, ctx);
      const retry = executeCommand(b, c, identity);
      expect(retry).toEqual(receipt);
      a = new SqliteFixture(path, ctx);
      expect(executeCommand(a, c, identity)).toEqual(receipt);
      const stored = a.atomic((tx) => tx.getDocument(d.header.id));
      expect(stored.state.global.revision).toBe(d.state.global.revision + 1);
      expect(stored.operations.global.at(-1)?.action.id).toBe(receipt.action.id);
      expect(() =>
        executeCommand(a!, { ...c, input: { unexpected: "changed" } }, identity),
      ).toThrow(/conflicts/);
    } finally {
      a?.close();
      b?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rolls back rejected mutations and rejects two edits based on the same revision", () => {
    const dir = mkdtempSync(join(tmpdir(), "kapelle-framework-")),
      a = new SqliteFixture(join(dir, "q.sqlite"), context());
    try {
      const d = ready();
      a.seed(d);
      const c = command(d, "REQUEST_PAUSE", {});
      expect(() => executeCommand(a, c, { ...identity, principalId: "member" })).toThrow(/owner/);
      expect(
        a.atomic((tx) => tx.getReceipt("owner", "synthetic-league", c.operationId)),
      ).toBeUndefined();
      executeCommand(a, c, identity);
      expect(() => executeCommand(a, { ...c, operationId: "different-op" }, identity)).toThrow(
        /Stale/,
      );
      expect(
        a.atomic((tx) => tx.getReceipt("owner", "synthetic-league", "different-op")),
      ).toBeUndefined();
    } finally {
      a.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("returns exact accepted receipt even when current projection is unavailable, but never to another owner", () => {
    const dir = mkdtempSync(join(tmpdir(), "kapelle-framework-")),
      a = new SqliteFixture(join(dir, "q.sqlite"), context());
    try {
      const d = ready();
      a.seed(d);
      const c = command(d, "REQUEST_PAUSE", {}),
        r = executeCommand(a, c, identity);
      const unavailable: AuthorityPort = {
        atomic(fn) {
          return a.atomic((tx) =>
            fn({
              ...tx,
              contextFor() {
                throw Error("projection unavailable");
              },
              getDocument() {
                throw Error("projection unavailable");
              },
            }),
          );
        },
      };
      expect(executeCommand(unavailable, c, identity)).toEqual(r);
      expect(() =>
        executeCommand(unavailable, c, { ...identity, principalId: "attacker" }),
      ).toThrow(/owner/);
    } finally {
      a.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
