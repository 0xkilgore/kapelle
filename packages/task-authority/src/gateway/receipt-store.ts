import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CachedTask,
  MutationReceipt,
  PendingMutation,
} from "./types.js";
import { GatewayError } from "./types.js";

type ReceiptRow = {
  operation_id: string;
  payload_hash: string;
  status: "PENDING" | "ACCEPTED";
  task_id: string | null;
  action_type: string;
  expected_revision: number;
  action_ids_json: string;
  action_inputs_json: string | null;
  result_state_hash: string | null;
  intent_name: string | null;
  receipt_json: string | null;
  created_at: string;
};

type TaskRow = {
  task_id: string;
  revision: number;
  state_json: string;
  updated_at: string;
};

export class ReceiptStore {
  readonly #db: DatabaseSync;
  readonly #path: string | null;
  readonly #identity: { dev: bigint; ino: bigint } | null;

  constructor(path: string) {
    const databasePath = path === ":memory:" ? path : resolve(path);
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    }
    this.#db = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.#path = databasePath === ":memory:" ? null : databasePath;
    if (this.#path) {
      const identity = statSync(this.#path, { bigint: true });
      this.#identity = { dev: identity.dev, ino: identity.ino };
    } else {
      this.#identity = null;
    }
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS mutation_receipts (
        operation_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING', 'ACCEPTED')),
        task_id TEXT,
        action_type TEXT NOT NULL,
        expected_revision INTEGER NOT NULL,
        action_ids_json TEXT NOT NULL,
        action_inputs_json TEXT,
        result_state_hash TEXT,
        intent_name TEXT,
        receipt_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_index (
        task_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const receiptColumns = this.#db.prepare(
      "SELECT name FROM pragma_table_info('mutation_receipts')",
    ).all() as Array<{ name: string }>;
    if (!receiptColumns.some(({ name }) => name === "action_inputs_json")) {
      this.#db.exec("ALTER TABLE mutation_receipts ADD COLUMN action_inputs_json TEXT");
    }
  }

  close(): void {
    this.#db.close();
  }

  probe(): void {
    if (this.#path && this.#identity) {
      const current = statSync(this.#path, { bigint: true });
      if (current.dev !== this.#identity.dev || current.ino !== this.#identity.ino) {
        throw new Error("receipt store path identity changed");
      }
    }

    this.#db.prepare("SELECT operation_id FROM mutation_receipts LIMIT 1").get();
    this.#db.prepare("SELECT task_id FROM task_index LIMIT 1").get();

    let transactionStarted = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
    } finally {
      if (transactionStarted) this.#db.exec("ROLLBACK");
    }
  }

  find(operationId: string): PendingMutation | MutationReceipt | null {
    const row = this.#db.prepare(
      "SELECT * FROM mutation_receipts WHERE operation_id = ?",
    ).get(operationId) as ReceiptRow | undefined;
    if (!row) return null;
    if (row.status === "ACCEPTED") {
      return JSON.parse(row.receipt_json ?? "null") as MutationReceipt;
    }
    return {
      operationId: row.operation_id,
      payloadHash: row.payload_hash,
      taskId: row.task_id,
      actionType: row.action_type,
      expectedRevision: row.expected_revision,
      actionIds: JSON.parse(row.action_ids_json) as string[],
      actionInputs: row.action_inputs_json == null
        ? null
        : JSON.parse(row.action_inputs_json) as Array<Record<string, unknown>>,
      resultStateHash: row.result_state_hash,
      intentName: row.intent_name,
      createdAt: row.created_at,
    };
  }

  reserve(pending: PendingMutation): PendingMutation | MutationReceipt {
    const existing = this.find(pending.operationId);
    if (existing) {
      if (existing.payloadHash !== pending.payloadHash) {
        throw new GatewayError(
          "operationId already used for a different canonical payload",
          409,
          "IDEMPOTENCY_CONFLICT",
        );
      }
      return existing;
    }
    this.#db.prepare(`
      INSERT INTO mutation_receipts (
        operation_id, payload_hash, status, task_id, action_type,
        expected_revision, action_ids_json, action_inputs_json, result_state_hash, intent_name, receipt_json,
        created_at, updated_at
      ) VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      pending.operationId,
      pending.payloadHash,
      pending.taskId,
      pending.actionType,
      pending.expectedRevision,
      JSON.stringify(pending.actionIds),
      pending.actionInputs == null ? null : JSON.stringify(pending.actionInputs),
      pending.resultStateHash,
      pending.intentName,
      pending.createdAt,
      pending.createdAt,
    );
    return pending;
  }

  attachTask(operationId: string, taskId: string, updatedAt: string): void {
    this.#db.prepare(
      "UPDATE mutation_receipts SET task_id = ?, updated_at = ? WHERE operation_id = ? AND status = 'PENDING'",
    ).run(taskId, updatedAt, operationId);
  }

  prepareResult(
    operationId: string,
    resultStateHash: string,
    actionInputs: Array<Record<string, unknown>>,
    updatedAt: string,
  ): void {
    this.#db.prepare(`
      UPDATE mutation_receipts
      SET result_state_hash = ?, action_inputs_json = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'PENDING'
    `).run(resultStateHash, JSON.stringify(actionInputs), updatedAt, operationId);
  }

  abandon(operationId: string): void {
    this.#db.prepare(
      "DELETE FROM mutation_receipts WHERE operation_id = ? AND status = 'PENDING'",
    ).run(operationId);
  }

  accept(receipt: MutationReceipt, task: CachedTask): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        INSERT INTO task_index (task_id, revision, state_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          revision = excluded.revision,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `).run(task.taskId, task.revision, JSON.stringify(task.state), task.updatedAt);
      this.#db.prepare(`
        UPDATE mutation_receipts
        SET status = 'ACCEPTED', task_id = ?, receipt_json = ?, updated_at = ?
        WHERE operation_id = ? AND status = 'PENDING'
      `).run(
        receipt.taskId,
        JSON.stringify({ ...receipt, replayed: false }),
        task.updatedAt,
        receipt.operationId,
      );
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertTask(task: CachedTask): void {
    this.#db.prepare(`
      INSERT INTO task_index (task_id, revision, state_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        revision = excluded.revision,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(task.taskId, task.revision, JSON.stringify(task.state), task.updatedAt);
  }

  getTask(taskId: string): CachedTask | null {
    const row = this.#db.prepare("SELECT * FROM task_index WHERE task_id = ?").get(
      taskId,
    ) as TaskRow | undefined;
    return row ? this.#task(row) : null;
  }

  listTasks(options: { limit: number; afterId?: string }): CachedTask[] {
    const rows = this.#db.prepare(`
      SELECT * FROM task_index
      WHERE task_id > ?
      ORDER BY task_id ASC
      LIMIT ?
    `).all(options.afterId ?? "", options.limit) as TaskRow[];
    return rows.map((row) => this.#task(row));
  }

  allTasks(): CachedTask[] {
    const rows = this.#db.prepare(
      "SELECT * FROM task_index ORDER BY task_id ASC",
    ).all() as TaskRow[];
    return rows.map((row) => this.#task(row));
  }

  #task(row: TaskRow): CachedTask {
    return {
      taskId: row.task_id,
      revision: row.revision,
      state: JSON.parse(row.state_json) as CachedTask["state"],
      updatedAt: row.updated_at,
    };
  }
}
