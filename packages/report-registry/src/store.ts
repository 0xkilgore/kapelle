import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reduceReport, type ReportDocument, type ReportOperation } from "./model.ts";

function safeRef(ref: string): string {
  return Buffer.from(ref).toString("base64url");
}

export class FilesystemReportStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, "operations"), { recursive: true });
    mkdirSync(join(root, "snapshots"), { recursive: true });
    mkdirSync(join(root, "locks"), { recursive: true });
  }

  apply(reportRef: string, operation: ReportOperation): ReportDocument {
    return this.withLock(reportRef, () => {
      const current = this.load(reportRef);
      if (current?.state.global.applied_operation_ids.includes(operation.operation_id)) return current;
      const next = reduceReport(current, operation);
      const line = `${JSON.stringify(operation)}\n`;
      const fd = openSync(this.operationPath(reportRef), "a", 0o600);
      try { appendFileSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
      this.writeSnapshot(reportRef, next);
      return next;
    });
  }

  load(reportRef: string): ReportDocument | null {
    const path = this.operationPath(reportRef);
    if (!existsSync(path)) return null;
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    let document: ReportDocument | null = null;
    for (const line of lines) document = reduceReport(document, JSON.parse(line) as ReportOperation);
    return document;
  }

  list(): ReportDocument[] {
    const indexPath = join(this.root, "report-refs.json");
    if (!existsSync(indexPath)) return [];
    const refs = JSON.parse(readFileSync(indexPath, "utf8")) as string[];
    return refs.map((ref) => this.load(ref)).filter((d): d is ReportDocument => d !== null);
  }

  remember(reportRef: string): void {
    const path = join(this.root, "report-refs.json");
    const refs: string[] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
    if (!refs.includes(reportRef)) {
      refs.push(reportRef);
      refs.sort();
      this.atomicJson(path, refs);
    }
  }

  private operationPath(ref: string): string { return join(this.root, "operations", `${safeRef(ref)}.jsonl`); }

  private writeSnapshot(ref: string, document: ReportDocument): void {
    this.atomicJson(join(this.root, "snapshots", `${safeRef(ref)}.json`), document);
    this.remember(ref);
  }

  private atomicJson(path: string, value: unknown): void {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  }

  private withLock<T>(ref: string, work: () => T): T {
    const lock = join(this.root, "locks", `${safeRef(ref)}.lock`);
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`report is locked: ${ref}`);
      throw error;
    }
    try { return work(); }
    finally { closeSync(fd); try { unlinkSync(lock); } catch {} }
  }
}
