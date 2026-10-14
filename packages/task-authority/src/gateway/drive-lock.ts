import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

type LockRecord = {
  driveId: string;
  pid: number;
  token: string;
};

function lockName(driveId: string): string {
  return `task-gateway-${createHash("sha256").update(driveId).digest("hex")}.lock`;
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockRecord(path: string): LockRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    if (
      typeof value.driveId !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.token !== "string"
    ) return null;
    return value as LockRecord;
  } catch {
    return null;
  }
}

export class DriveInstanceLock {
  readonly path: string;
  readonly #record: LockRecord;
  #released = false;

  private constructor(path: string, record: LockRecord) {
    this.path = path;
    this.#record = record;
  }

  static acquire(lockDirectory: string, driveId: string): DriveInstanceLock {
    const normalizedDriveId = driveId.trim();
    if (!normalizedDriveId) throw new Error("Task Gateway drive id is required for locking");
    mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
    const path = join(lockDirectory, lockName(normalizedDriveId));
    const record: LockRecord = {
      driveId: normalizedDriveId,
      pid: process.pid,
      token: randomUUID(),
    };

    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      } finally {
        closeSync(descriptor);
      }
      return new DriveInstanceLock(path, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = lockRecord(path);
      if (existing && processExists(existing.pid)) {
        throw new Error(
          `Task Gateway drive ${normalizedDriveId} is already owned by pid ${existing.pid}`,
        );
      }
      throw new Error(
        `Task Gateway drive ${normalizedDriveId} has a stale or unreadable lock at ${path}; remove it only after verifying no gateway process owns the drive`,
      );
    }
  }

  isOwned(): boolean {
    if (this.#released) return false;
    const existing = lockRecord(this.path);
    return existing?.driveId === this.#record.driveId &&
      existing.pid === this.#record.pid &&
      existing.token === this.#record.token;
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    const existing = lockRecord(this.path);
    if (existing?.token !== this.#record.token) return;
    try {
      unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
