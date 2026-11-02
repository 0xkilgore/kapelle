import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DriveInstanceLock } from "../src/gateway/drive-lock.js";

const directories: string[] = [];

function lockDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "task-gateway-lock-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("DriveInstanceLock", () => {
  it("refuses a second gateway for the same drive and releases cleanly", () => {
    const directory = lockDirectory();
    const first = DriveInstanceLock.acquire(directory, "drive-a");
    expect(first.isOwned()).toBe(true);

    expect(() => DriveInstanceLock.acquire(directory, "drive-a")).toThrow(
      /already owned/,
    );
    first.release();
    expect(first.isOwned()).toBe(false);

    const replacement = DriveInstanceLock.acquire(directory, "drive-a");
    expect(existsSync(replacement.path)).toBe(true);
    replacement.release();
  });

  it("reports lost ownership when its lock record is removed or replaced", () => {
    const directory = lockDirectory();
    const lock = DriveInstanceLock.acquire(directory, "drive-a");
    writeFileSync(lock.path, JSON.stringify({
      driveId: "drive-a",
      pid: process.pid,
      token: "replacement-owner",
    }));

    expect(lock.isOwned()).toBe(false);
    lock.release();
    expect(existsSync(lock.path)).toBe(true);
  });

  it("keys locks by drive rather than receipt database", () => {
    const directory = lockDirectory();
    const first = DriveInstanceLock.acquire(directory, "drive-a");
    const second = DriveInstanceLock.acquire(directory, "drive-b");

    expect(first.path).not.toBe(second.path);
    first.release();
    second.release();
  });

  it("fails closed on a stale lock record instead of racing to replace it", () => {
    const directory = lockDirectory();
    const probe = DriveInstanceLock.acquire(directory, "drive-a");
    const path = probe.path;
    probe.release();
    writeFileSync(path, JSON.stringify({ driveId: "drive-a", pid: 999_999_999, token: "stale" }));

    expect(() => DriveInstanceLock.acquire(directory, "drive-a")).toThrow(
      /stale or unreadable lock/,
    );
    expect(existsSync(path)).toBe(true);
  });
});
