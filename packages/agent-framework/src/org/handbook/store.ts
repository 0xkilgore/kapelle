// AGENT-HANDBOOK-V1 H1 (design v2 §3; Fable b375b67b): ONE versioned, org-owned handbook in the org SQLite authority. Rows are
// immutable; the active pointer moves only through approve(), one authority transaction that refuses a concurrent edit
// (expected previous version) and anything over the 6 KiB UTF-8 hard cap (never truncated). Rollback = a new approved version.
// H1 ships the schema and this API only; the handbook.read|propose|approve actions, the review card and the access-table change
// are H2. There is no model-proposal path (D-1, N-1).
import { createHash } from "node:crypto";
import { AccessError } from "../../access/org-access.js";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";

export const HANDBOOK_MAX_BYTES = 6 * 1024;
export type HandbookVersion = { version: number; content: string; sha256: string; bytes: number; approvedBy: string; approvedAt: string };
const sha = (s: string) => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");
const refuse = (label: string): never => { throw new AccessError(label); };
const SCHEMA = `
CREATE TABLE IF NOT EXISTS handbook_versions(version INTEGER PRIMARY KEY, content TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
  proposed_by TEXT NOT NULL, approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, prev_version INTEGER) STRICT;
CREATE TABLE IF NOT EXISTS handbook_active(id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL) STRICT;`;
/** The text a reviewer approves: CRLF -> LF, no control characters except newline and tab, trailing space trimmed per line. */
export function normalizeHandbook(content: unknown) {
  if (typeof content !== "string") refuse("handbook_input_invalid");
  const t = (content as string).replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").trim() + "\n";
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(t) || t.trim().length === 0) refuse("handbook_input_invalid");
  return t;
}
/** A small line diff (LCS) for the review card: each line kept, added or removed. Both sides are at most ~6 KiB. */
export function lineDiff(a: string[], b: string[]) {
  const n = a.length, m = b.length, t: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: { op: "same" | "add" | "del"; line: string }[] = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { out.push({ op: "same", line: a[i] }); i++; j++; } else if (t[i + 1][j] >= t[i][j + 1]) out.push({ op: "del", line: a[i++] }); else out.push({ op: "add", line: b[j++] }); }
  while (i < n) out.push({ op: "del", line: a[i++] }); while (j < m) out.push({ op: "add", line: b[j++] });
  return out;
}
export class HandbookStore {
  constructor(private readonly a: SqliteAuthority, private readonly now: () => string = () => new Date().toISOString()) { a.db.exec(SCHEMA); }
  private row(version: number) {
    const r = this.a.db.prepare("SELECT version, content, sha256, bytes, approved_by, approved_at FROM handbook_versions WHERE version=?").get(version) as Record<string, any> | undefined;
    return r ? { version: r.version, content: r.content, sha256: r.sha256, bytes: r.bytes, approvedBy: r.approved_by, approvedAt: r.approved_at } as HandbookVersion : null;
  }
  /** The approved, active handbook (or null: none approved yet). Re-hashed on read: a row whose bytes do not match is not served.
   *  ONE plain statement, no transaction of its own: the task claim and every step's authorization call it inside their writes. */
  active(): HandbookVersion | null {
    const r = this.a.db.prepare("SELECT v.version, v.content, v.sha256, v.bytes, v.approved_by, v.approved_at FROM handbook_active a JOIN handbook_versions v ON v.version=a.version WHERE a.id=1")
      .get() as Record<string, any> | undefined;
    const h = r ? { version: r.version, content: r.content, sha256: r.sha256, bytes: r.bytes, approvedBy: r.approved_by, approvedAt: r.approved_at } as HandbookVersion : null;
    return h && sha(h.content) === h.sha256 ? h : null;
  }
  /** An exact (immutable) version, re-hashed. One plain statement (called while a run loads its plan's context). */
  get(version: number): HandbookVersion | null { const r = this.row(version); return r && sha(r.content) === r.sha256 ? r : null; }
  /** Approve and activate exactly this text in ONE transaction. expectedPrev = the active version the editor started from (null
   *  for the first). Refuses: oversize (6 KiB UTF-8), a concurrent edit, invalid text. Returns the new version. */
  /** H2: every approved version, newest first (no content; the approver as a role word is the caller's to show). */
  history(): { version: number; sha256: string; bytes: number; approvedAt: string; active: boolean }[] {
    const act = (this.a.db.prepare("SELECT version FROM handbook_active WHERE id=1").get() as { version: number } | undefined)?.version ?? null;
    return (this.a.db.prepare("SELECT version, sha256, bytes, approved_at FROM handbook_versions ORDER BY version DESC LIMIT 50").all() as Record<string, any>[])
      .map((r) => ({ version: r.version, sha256: r.sha256, bytes: r.bytes, approvedAt: r.approved_at, active: r.version === act }));
  }
  /** H2 handbook.propose: a PREVIEW, nothing written. The digest to approve is the normalized text's sha256. */
  preview(content: unknown) {
    const text = normalizeHandbook(content), bytes = Buffer.byteLength(text, "utf8"), cur = this.active();
    const was = cur ? cur.content.replace(/\n$/, "").split("\n") : [], now = text.replace(/\n$/, "").split("\n");
    return { text, sha256: sha(text), bytes, maxBytes: HANDBOOK_MAX_BYTES, fits: bytes <= HANDBOOK_MAX_BYTES, basedOn: cur?.version ?? null,
      unchanged: !!cur && cur.sha256 === sha(text), diff: lineDiff(was, now) };
  }
  approve(o: { content: unknown; expectedPrev: number | null; proposedBy: string; approvedBy: string; expectedSha256?: string; onActivate?: (version: number) => void }): HandbookVersion {
    const content = normalizeHandbook(o.content), bytes = Buffer.byteLength(content, "utf8");
    if (bytes > HANDBOOK_MAX_BYTES) refuse("handbook_oversize");
    if (o.expectedSha256 !== undefined && o.expectedSha256 !== sha(content)) refuse("handbook_digest_mismatch"); // Fable C-B: not the previewed text
    const version = this.a.write(() => {
      const cur = (this.a.db.prepare("SELECT version FROM handbook_active WHERE id=1").get() as { version: number } | undefined)?.version ?? null;
      if (cur !== o.expectedPrev) refuse("handbook_approval_conflict");
      const v = ((this.a.db.prepare("SELECT MAX(version) AS v FROM handbook_versions").get() as { v: number | null }).v ?? 0) + 1;
      this.a.db.prepare("INSERT INTO handbook_versions(version,content,sha256,bytes,proposed_by,approved_by,approved_at,prev_version) VALUES (?,?,?,?,?,?,?,?)")
        .run(v, content, sha(content), bytes, o.proposedBy, o.approvedBy, this.now(), cur);
      this.a.db.prepare("INSERT INTO handbook_active(id,version) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version").run(v);
      o.onActivate?.(v); // H2 (D-3): pausing the active schedules happens IN this transaction; a failure there undoes the activation
      return v;
    });
    return this.get(version)!;
  }
}
