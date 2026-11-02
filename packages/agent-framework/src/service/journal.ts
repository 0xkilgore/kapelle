import { DatabaseSync } from "node:sqlite";
import { assert } from "../validation.js";
import type { Command } from "../command-boundary.js";
import type { PreparedNative, NativeReceipt } from "./native-backend.js";
export interface Entry {
  /** Durable pilot restriction survives reopening without runtime configuration. */
  pilot?:import("../task-delegation/pilot.js").TaskPilot;
  requestHash: string;
  command: Command;
  prepared: PreparedNative;
  result?: NativeReceipt;
}
/** Prepared-command recovery metadata. Native operations and terminal receipts stay in Reactor. */
export class CommandJournal {
  readonly db: DatabaseSync;
  constructor(path: string, binding: string, readonly readOnly = false) {
    this.db = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
    if (readOnly) {
      try {
        for (const [table, columns] of [['binding', ['value']], ['commands', ['id', 'body']]] as const) {
          const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string;type:string;pk:number}[];
          assert(rows.length === columns.length && rows.every((r,i) => r.name === columns[i] &&
            r.type.toUpperCase() === 'TEXT' && r.pk === (i === 0 ? 1 : 0)), 'Journal schema unavailable');
        }
        const rows = this.db.prepare('SELECT value FROM binding LIMIT 2').all() as {value:string}[];
        assert(rows.length === 1 && rows[0].value === binding, 'Journal authority binding mismatch');
      } catch (error) { this.db.close(); throw error; }
      return;
    }
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS binding(value TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,body TEXT NOT NULL);",
    );
    const row = this.db.prepare("SELECT value FROM binding").get() as { value: string } | undefined;
    if (row) assert(row.value === binding, "Journal authority binding mismatch");
    else this.db.prepare("INSERT INTO binding VALUES (?)").run(binding);
  }
  get(id: string): Entry | undefined {
    const row = this.db.prepare("SELECT body FROM commands WHERE id=?").get(id) as
      | { body: string }
      | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  save(entry: Entry) {
    assert(!this.readOnly, "observation_only");
    this.db
      .prepare(
        "INSERT INTO commands(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(entry.command.operationId, JSON.stringify(entry));
  }
  pending() {
    return (this.db.prepare("SELECT body FROM commands").all() as { body: string }[])
      .map((r) => JSON.parse(r.body) as Entry)
      .filter((e) => !e.result);
  }
  close() {
    this.db.close();
  }
}
