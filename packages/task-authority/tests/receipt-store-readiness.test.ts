import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ReceiptStore } from "../src/gateway/receipt-store.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "task-gateway-receipts-"));
  directories.push(directory);
  return join(directory, "receipts.sqlite");
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("ReceiptStore readiness", () => {
  it("proves the expected schema and a write lock are available", () => {
    const store = new ReceiptStore(databasePath());
    try {
      expect(() => store.probe()).not.toThrow();
    } finally {
      store.close();
    }
  });

  it("fails when another connection holds the database write lock", () => {
    const path = databasePath();
    const store = new ReceiptStore(path);
    const blocker = new DatabaseSync(path);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      expect(() => store.probe()).toThrow();
      blocker.exec("ROLLBACK");
    } finally {
      blocker.close();
      store.close();
    }
  });

  it("fails when the expected receipt schema is missing", () => {
    const path = databasePath();
    const store = new ReceiptStore(path);
    const mutator = new DatabaseSync(path);
    try {
      mutator.exec("DROP TABLE task_index");
      expect(() => store.probe()).toThrow();
    } finally {
      mutator.close();
      store.close();
    }
  });

  it("fails when its open database has been detached from the configured path", () => {
    const path = databasePath();
    const store = new ReceiptStore(path);
    try {
      unlinkSync(path);
      expect(() => store.probe()).toThrow();
    } finally {
      store.close();
    }
  });

  it("fails after the store is closed", () => {
    const store = new ReceiptStore(databasePath());
    store.close();
    expect(() => store.probe()).toThrow();
  });
});
