// Website pack v0, W-1 (PLAN §2; Fable R-6): the `website-pr` effect ledger. One row per approval operationId, written as
// `intent` (base commit, files, branch) and COMMITTED before any GitHub write; then `sent` while writes are in flight, `done`
// with the commit, PR and preview, `unsettled` when a write may have landed (reconciled by reads, never a blind retry), or
// `failed` with a fixed label when nothing landed. The row is the idempotency key: a retried approval resumes it.
import type { SqliteAuthority } from "../../service/sqlite-authority.js";

export type WebsitePrState = "intent" | "sent" | "done" | "unsettled" | "failed";
export type WebsitePr = { operationId: string; requestId: string; memberId: string; state: WebsitePrState; baseCommit: string; branch: string; files: string;
  commitSha: string | null; prNumber: number | null; prUrl: string | null; previewUrl: string | null; label: string | null; createdAt: string; updatedAt: string;
  /** Update the open draft (Fable ACCEPT e483c8dd, C-2): null = a new branch + draft PR; "update" = a new commit on the target PR's
   *  EXISTING runtime branch (targetBranch, bound to expectedHead). `branch` then holds the unique "update:<operationId>". */
  kind: "update" | null; targetPr: number | null; targetBranch: string | null; expectedHead: string | null };
const COLS: Record<string, string> = { commitSha: "commit_sha", prNumber: "pr_number", prUrl: "pr_url", previewUrl: "preview_url", label: "label" };

export class WebsitePrLedger {
  constructor(private readonly a: SqliteAuthority, private readonly now: () => string = () => new Date().toISOString()) {
    a.db.exec(`CREATE TABLE IF NOT EXISTS website_prs(operation_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, member_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('intent','sent','done','unsettled','failed')), base_commit TEXT NOT NULL, branch TEXT NOT NULL UNIQUE, files TEXT NOT NULL,
      commit_sha TEXT, pr_number INTEGER, pr_url TEXT, preview_url TEXT, label TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;`);
    // C-2 (U-2, additive): four nullable columns under the PRAGMA guard (old rows: a create; old code ignores them on rollback).
    const have = new Set((a.db.prepare("PRAGMA table_info(website_prs)").all() as { name: string }[]).map((c) => c.name));
    for (const [c, t] of [["kind", "TEXT"], ["target_pr", "INTEGER"], ["target_branch", "TEXT"], ["expected_head", "TEXT"]]) if (!have.has(c)) a.db.exec(`ALTER TABLE website_prs ADD COLUMN ${c} ${t}`);
  }
  private row(r: any): WebsitePr | null {
    return r ? { operationId: r.operation_id, requestId: r.request_id, memberId: r.member_id, state: r.state, baseCommit: r.base_commit, branch: r.branch, files: r.files,
      commitSha: r.commit_sha, prNumber: r.pr_number, prUrl: r.pr_url, previewUrl: r.preview_url, label: r.label, createdAt: r.created_at, updatedAt: r.updated_at,
      kind: r.kind === "update" ? "update" : null, targetPr: r.target_pr ?? null, targetBranch: r.target_branch ?? null, expectedHead: r.expected_head ?? null } : null;
  }
  get(operationId: string) { return this.row(this.a.read(() => this.a.db.prepare("SELECT * FROM website_prs WHERE operation_id=?").get(operationId))); }
  /** Durable intent BEFORE any write. The same operationId returns the existing row (never a second intent). */
  intent(o: { operationId: string; requestId: string; memberId: string; baseCommit: string; branch: string; files: unknown;
    update?: { pr: number; branch: string; expectedHead: string } }) {
    const u = o.update ?? null;
    this.a.write(() => this.a.db.prepare(`INSERT INTO website_prs(operation_id,request_id,member_id,state,base_commit,branch,files,created_at,updated_at,kind,target_pr,target_branch,expected_head)
      VALUES (?,?,?, 'intent', ?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING`).run(o.operationId, o.requestId, o.memberId, o.baseCommit, u ? "update:" + o.operationId : o.branch,
      JSON.stringify(o.files), this.now(), this.now(), u ? "update" : null, u?.pr ?? null, u?.branch ?? null, u?.expectedHead ?? null));
    return this.get(o.operationId)!;
  }
  /** Move state and record facts as they become known (fixed columns only). */
  update(operationId: string, state: WebsitePrState, facts: Partial<Pick<WebsitePr, "commitSha" | "prNumber" | "prUrl" | "previewUrl" | "label">> = {}) {
    const keys = Object.keys(facts).filter((k) => k in COLS) as (keyof typeof facts)[];
    this.a.write(() => this.a.db.prepare(`UPDATE website_prs SET state=?, updated_at=?${keys.map((k) => `, ${COLS[k]}=?`).join("")} WHERE operation_id=?`)
      .run(state, this.now(), ...keys.map((k) => (facts[k] ?? null) as string | number | null), operationId));
    return this.get(operationId)!;
  }
  /** C-6: the newest DONE update of a PR (its commit and preview now stand for that PR). */
  latestUpdate(prNumber: number) {
    return this.row(this.a.read(() => this.a.db.prepare("SELECT * FROM website_prs WHERE kind='update' AND target_pr=? AND state='done' ORDER BY updated_at DESC LIMIT 1").get(prNumber)));
  }
  /** Ops status: counts by state and the unsettled ones (ids and labels only). */
  status() {
    return this.a.read(() => ({ byState: Object.fromEntries((this.a.db.prepare("SELECT state, COUNT(*) AS n FROM website_prs GROUP BY state").all() as { state: string; n: number }[]).map((r) => [r.state, r.n])),
      // Fable N-1 (a0a39975): an update row lists the REAL branch it moves (target_branch), not its "update:<op>" key.
      unsettled: (this.a.db.prepare("SELECT operation_id, COALESCE(target_branch, branch) AS branch, label FROM website_prs WHERE state='unsettled' ORDER BY created_at").all() as any[]) }));
  }
}
