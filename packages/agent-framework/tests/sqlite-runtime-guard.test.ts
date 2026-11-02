// Fable B1 R-1: a stray Node (e.g. 23.x without DatabaseSync.isTransaction) once wedged an org after its first refusal
// ("cannot start a transaction within a transaction"). The runtime now refuses to start on an unsupported Node or an incomplete
// SQLite API, and its rollback paths no longer depend on the flag: a refusal inside a transaction never leaves it open.
import { it, expect } from "vitest";
import { chmodSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertSqliteRuntime, rollbackQuietly, openSqliteDatabase, SqliteAuthority, SQLITE_NODE_MAJOR } from "../src/service/sqlite-authority.js";

it("refuses an unsupported Node major or an incomplete SQLite API at open", () => {
  expect(() => assertSqliteRuntime({ isTransaction: false }, "23.7.0")).toThrow("node_version_unsupported");
  expect(() => assertSqliteRuntime({ isTransaction: false }, "22.22.3")).toThrow("node_version_unsupported");
  expect(() => assertSqliteRuntime({}, `${SQLITE_NODE_MAJOR}.18.0`)).toThrow("sqlite_api_incomplete");
  expect(() => assertSqliteRuntime({ isTransaction: false }, `${SQLITE_NODE_MAJOR}.18.0`)).not.toThrow();
  expect(Number(process.versions.node.split(".")[0]), "the suite itself must run on the pinned Node").toBe(SQLITE_NODE_MAJOR);
});

it("a refusal inside a write never wedges the connection, even without the isTransaction flag", () => {
  const dir = realpathSync(mkdtempSync("/tmp/ksg-")); chmodSync(dir, 0o700);
  const real = openSqliteDatabase(join(dir, "authority.sqlite"), { create: true });
  // Simulate the broken runtime: the same connection, with the isTransaction flag missing.
  const db = new Proxy(real, { get(t, k) { if (k === "isTransaction") return undefined; const v = Reflect.get(t, k, t); return typeof v === "function" ? v.bind(t) : v; } });
  const a = new SqliteAuthority(db, { binding: "test", authorityId: randomUUID(), driveId: randomUUID(), installationId: randomUUID() }, { create: true });
  for (let i = 0; i < 3; i++) expect(() => a.write(() => { throw new Error("refused_by_test"); })).toThrow("refused_by_test");
  expect(a.write(() => 42)).toBe(42);          // was: "cannot start a transaction within a transaction"
  expect(a.read(() => 7)).toBe(7);
  expect(() => a.read(() => { throw new Error("read_refused"); })).toThrow("read_refused");
  expect(a.write(() => "still fine")).toBe("still fine");
  // rollbackQuietly: harmless with nothing open.
  expect(() => rollbackQuietly(db)).not.toThrow();
  real.close();
});
