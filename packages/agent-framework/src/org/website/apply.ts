// Website pack v0, W-3 (PLAN §1 steps 5-8, §2; Fable R-1, R-2, R-5, R-6, R-7): an APPROVED proposal becomes a DRAFT pull request.
// - website.apply (consequential, session-fresh; reviewers/admins; receipts to the actor and every admin): the approval's
//   artifact digest must equal the proposal card digest = digest{repo, baseCommit, files[{path, baseBlobSha, newSha256}],
//   requestId, branch, summarySha256, opsSha256} (R-5). Per-org daily cap (R-1). One apply per proposal.
// - On the org's single website chain, the runtime connector (never the model): intent row committed first (website_prs);
//   main must still be at the bound base; READ FIRST (an existing branch must hold exactly our commit; an existing PR is
//   reused), then blobs -> tree -> commit (author = the connected identity; message = the approved summary + the fixed
//   Kapelle trailer + Co-authored-by, R-2; no member email) -> main re-checked -> ref -> DRAFT PR (title/body only from
//   the approved summary + a fixed template, R-5). A write that may have landed and whose answer was lost -> `unsettled`
//   (website_* label) until a read-first resume completes or proves it; a definite refusal -> `failed`.
// - Preview (R-7): Vercel's preview URL read from the commit's GitHub statuses/deployments every 30 s for at most 15 min,
//   accepted only as an https URL on an Ops-allowlisted host, shown as a link, never fetched; then "preview pending" with
//   a manual re-check. No merge: publishing is a maintainer merging on GitHub.
import { digest } from "../../content.js";
import { AccessError, type Authorization } from "../../access/org-access.js";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import { failureLabel, persistedReason } from "../../task-delegation/failure-labels.js";
import { RUNTIME_BRANCH, WebsiteError, type GithubPort, type Identity } from "./github.js";
import { WebsitePrLedger } from "./ledger.js";
import type { WebsiteRequests } from "./requests.js";
import { WEBSITE_FILES } from "./data.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export { WEBSITE_APPLY_REASONS } from "./labels.js";
export const PREVIEW_POLL = { everyMs: 30_000, maxMs: 15 * 60_000 };
/** Fable N-3 (a0a39975): GitHub PR reads per website.list for "update the open draft" eligibility. */
export const PR_READS_PER_LIST = 5;

export function previewHostAllowed(url: string, hosts: readonly string[]) {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = u.hostname, first = host.split(".")[0], rest = host.slice(first.length + 1);
  return hosts.some((h) => {
    if (h.startsWith("*.")) return host.endsWith(h.slice(1)) && host.length > h.length - 1;
    // "*-<label>.<domain>": the host's FIRST label ends in "-<label>" (with something before it, no dots), the rest is exactly <domain>.
    const m = /^\*-([a-z0-9-]+)\.(.+)$/.exec(h);
    if (m) return rest === m[2] && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(first) && first.endsWith("-" + m[1]) && first.length > m[1].length + 1;
    return host === h;
  });
}

export class WebsiteApply {
  readonly ledger: WebsitePrLedger;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly timers = new Set<NodeJS.Timeout>();
  constructor(private readonly a: SqliteAuthority, private readonly o: { repo: string; baseBranch: string; author: Identity; coAuthor: Identity; previewHosts: string[];
    dailyApply: number; origin: string; orgId: string; github: () => GithubPort; requests: WebsiteRequests; poll?: { everyMs: number; maxMs: number } },
    private readonly now: () => string = () => new Date().toISOString()) {
    this.ledger = new WebsitePrLedger(a, now);
  }
  branchOf(requestId: string) { return `kapelle/${requestId.replace(/^wr_/, "wr-").slice(0, 15)}`; }
  /** The card a reviewer approves (rows only) and its digest (the approval's artifact digest). */
  card(requestId: string) {
    const r = this.o.requests.read({ requestId });
    if (r.state !== "ready") throw new AccessError("website_request_not_ready");
    if (r.discardedAt) throw new AccessError("website_request_discarded"); // Owner (Oct 23): a discarded proposal is never approved
    // Update the open draft (Fable ACCEPT e483c8dd): when eligible, the card binds the target PR, its runtime branch and the
    // commit that branch must still point at; approving then adds a commit to THAT PR instead of opening a second one.
    const t = this.target(r), update = t && !t.blocked ? { pr: t.pr, branch: t.branch, expectedHead: t.expectedHead } : null;
    const card = { contract: "kapelle.website-pr-card/v1", repo: this.o.repo, baseCommit: r.baseCommit, requestId: r.requestId, branch: update ? update.branch : this.branchOf(r.requestId),
      ...(update ? { update } : {}),
      files: (r.files as any[]).filter((f) => f.changed).map((f) => ({ path: f.path, baseBlobSha: f.baseBlobSha, newSha256: f.newSha256 })),
      summarySha256: r.summarySha256, opsSha256: r.opsSha256,
      // IMAGES-V1 I3: the bound flyer image (event, attachment, full hash, size, public path, policy) is part of what is approved.
      ...(r.image?.path ? { image: { op: r.image.op, policy: r.image.policy, eventId: r.image.eventId, attachmentId: r.image.attachmentId, sha256: r.image.sha256,
        bytes: r.image.bytes, path: r.image.path } as { op: string; policy: string; eventId: string; attachmentId: string; sha256: string; bytes: number; path: string } } : {}) };
    return { card, cardDigest: digest(card), summary: r.summary };
  }
  /** Consequential: approve exactly this card. Returns at once; the push runs on the chain (the UI polls website.read). */
  approve(z: Authorization, b: { requestId?: unknown }) {
    const requestId = typeof b?.requestId === "string" ? b.requestId : "";
    const prior = this.ledger.get(z.operationId);
    if (prior) return this.view(prior.requestId); // a replay of the same approval: the same effect, never a second one
    const { card, cardDigest } = this.card(requestId);
    if (!z.artifactDigest || z.artifactDigest !== cardDigest) throw new AccessError("website_apply_digest_mismatch");
    const existing = this.a.read(() => this.a.db.prepare("SELECT operation_id FROM website_prs WHERE request_id=?").get(requestId)) as { operation_id: string } | undefined;
    if (existing) throw new AccessError("website_already_applied");
    const since = new Date(Date.parse(this.now()) - 86_400_000).toISOString();
    if ((this.a.read(() => this.a.db.prepare("SELECT COUNT(*) AS n FROM website_prs WHERE created_at>?").get(since)) as { n: number }).n >= this.o.dailyApply)
      throw new AccessError("website_daily_apply_cap");
    this.ledger.intent({ operationId: z.operationId, requestId, memberId: z.memberId, baseCommit: card.baseCommit, branch: card.branch, files: card.files,
      ...(card.update ? { update: card.update } : {}) }); // durable BEFORE any write (C-4: an update counts toward the daily cap like any apply)
    this.enqueue(z.operationId);
    return this.view(requestId);
  }
  private enqueue(op: string) { this.chain = this.chain.then(() => this.push(op)).catch(() => {}); }
  /** Ops: resume an unsettled push (read first; never a blind retry). */
  resume(operationId: string) {
    const r = this.ledger.get(operationId);
    if (!r || !["unsettled", "sent", "intent"].includes(r.state)) throw new AccessError("website_pr_not_resumable");
    this.enqueue(operationId);
    return { operationId, resumed: true };
  }
  /** Start-up: a push in flight when the runtime stopped is unknown, never resumed blindly. */
  recover() {
    return this.a.write(() => this.a.db.prepare("UPDATE website_prs SET state='unsettled', label='website_outcome_unknown_after_restart', updated_at=? WHERE state IN ('intent','sent')").run(this.now()).changes);
  }
  private files(requestId: string, card: ReturnType<WebsiteApply["card"]>["card"]) {
    return card.files.map((f) => ({ path: f.path, bytes: readFileSync(join(this.o.requests.dir(requestId), f.path.split("/").at(-1)!)) }));
  }
  private async push(op: string) {
    const row = this.ledger.get(op);
    if (!row || ["done", "failed"].includes(row.state)) return;
    if (row.kind === "update") return this.pushUpdate(op);
    const gh = this.o.github();
    let stage = "read", landed = false; // landed: our branch exists on GitHub (from now on a failure is unsettled, never failed)
    try {
      this.ledger.update(op, "sent");
      const { card, summary } = this.card(row.requestId);
      const bytes = this.files(row.requestId, card);
      const { createHash } = await import("node:crypto");
      for (const f of bytes) if ("sha256:" + createHash("sha256").update(f.bytes).digest("hex") !== card.files.find((x) => x.path === f.path)!.newSha256)
        throw new WebsiteError(f.path === card.image?.path ? "website_image_changed" : "website_branch_conflict");
      // READ FIRST: our branch may already exist (an earlier attempt whose answer was lost).
      let commit = await gh.refSha(row.branch);
      if (commit) {
        landed = true;
        for (const f of bytes) { const at = await gh.file(f.path, commit); if (!at || !at.bytes.equals(f.bytes)) throw new WebsiteError("website_branch_conflict"); }
      } else {
        if ((await gh.refSha(this.o.baseBranch)) !== row.baseCommit) throw new WebsiteError("website_base_moved");
        stage = "write";
        const blobs = [];
        for (const f of bytes) blobs.push({ path: f.path, blobSha: await gh.createBlob(f.bytes) });
        const tree = await gh.createTree(await gh.commitTree(row.baseCommit), blobs);
        const message = `${summary.title}\n\n${summary.lines.join("\n")}\n\nKapelle-Agent: website-pack v0; requested-by: reviewer\nCo-authored-by: ${this.o.coAuthor.name} <${this.o.coAuthor.email}>`;
        commit = await gh.createCommit({ message, tree, parent: row.baseCommit, author: this.o.author });
        this.ledger.update(op, "sent", { commitSha: commit });
        stage = "read";
        if ((await gh.refSha(this.o.baseBranch)) !== row.baseCommit) throw new WebsiteError("website_base_moved"); // re-checked right before the ref (R-6)
        stage = "write";
        await gh.createRef(row.branch, commit);
        landed = true;
      }
      this.ledger.update(op, "sent", { commitSha: commit });
      stage = "read";
      if (card.image) await this.readBack(gh, commit, card.image); // blob allocation is not publication: the commit must show it
      let pr = await gh.findPull(row.branch);
      if (!pr) {
        stage = "write";
        const body = `${summary.lines.join("\n")}\n\nOpened by the Example Park agent at a reviewer's request and approved in Kapelle (record ${op}).\n` +
          `Review: ${this.o.origin}/o/${this.o.orgId}/#review\n\nThis is a draft. It is published only when a maintainer merges it here.`;
        pr = await gh.openDraftPull({ title: summary.title, body, head: row.branch, base: this.o.baseBranch });
      }
      this.ledger.update(op, "done", { commitSha: commit, prNumber: pr.number, prUrl: pr.url, label: null });
      this.pollPreview(op, Date.parse(this.now()));
    } catch (e) {
      const label = persistedReason(failureLabel(new Error(e instanceof WebsiteError ? e.label : e instanceof Error ? e.message : "")));
      // Unsettled only when a WRITE may have landed (Fable R-6); a definite refusal or a read failure leaves nothing behind.
      const mayHaveLanded = landed || (stage === "write" && e instanceof WebsiteError && e.sent);
      this.ledger.update(op, mayHaveLanded ? "unsettled" : "failed", { label });
    }
  }
  /** Update the open draft (Fable ACCEPT e483c8dd, C-3). Read first; a new commit parented on the BOUND head; the branch re-read
   *  right before a fast-forward-only PATCH (re-read + FF-only is the compare-and-swap); read-back after. Resume: ref == our
   *  recorded commit -> landed, continue at read-back; ref == the bound head with a recorded commit -> re-check, then write;
   *  anything else on resume -> website_branch_moved, unsettled (an admin looks; never a second write). */
  private async pushUpdate(op: string) {
    const row = this.ledger.get(op)!, gh = this.o.github();
    const branch = row.targetBranch!, expected = row.expectedHead!, prN = row.targetPr!, resumed = !!row.commitSha;
    let stage = "read", landed = false, ambiguous = false;
    try {
      this.ledger.update(op, "sent");
      const { card, summary } = this.card(row.requestId);
      const bytes = this.files(row.requestId, card);
      const { createHash } = await import("node:crypto");
      for (const f of bytes) if ("sha256:" + createHash("sha256").update(f.bytes).digest("hex") !== card.files.find((x) => x.path === f.path)!.newSha256)
        throw new WebsiteError(f.path === card.image?.path ? "website_image_changed" : "website_branch_conflict");
      let commit = row.commitSha;
      const ref = await gh.refSha(branch);
      if (commit && ref === commit) landed = true;
      else {
        const pr = await gh.pull(prN);
        if (pr.state !== "open" || pr.merged) throw new WebsiteError("website_pr_closed");
        if (ref !== expected) { ambiguous = resumed; throw new WebsiteError("website_branch_moved"); }
        if (!commit) {
          stage = "write";
          const blobs = [];
          for (const f of bytes) blobs.push({ path: f.path, blobSha: await gh.createBlob(f.bytes) });
          const tree = await gh.createTree(await gh.commitTree(expected), blobs);
          const message = `${summary.title}\n\n${summary.lines.join("\n")}\n\nKapelle-Agent: website-pack v0; requested-by: reviewer; updates #${prN}\nCo-authored-by: ${this.o.coAuthor.name} <${this.o.coAuthor.email}>`;
          commit = await gh.createCommit({ message, tree, parent: expected, author: this.o.author });
          this.ledger.update(op, "sent", { commitSha: commit }); // an unreferenced commit publishes nothing
          stage = "read";
        }
        if ((await gh.refSha(branch)) !== expected) { ambiguous = resumed; throw new WebsiteError("website_branch_moved"); } // re-read right before the write
        stage = "write";
        await gh.updateRef(branch, commit); // FF-only: a moved ref is refused (website_branch_moved, nothing landed)
        landed = true;
      }
      stage = "read";
      if ((await gh.refSha(branch)) !== commit) throw new WebsiteError("website_branch_moved");
      for (const f of bytes) { const at = await gh.file(f.path, commit); if (!at || !at.bytes.equals(f.bytes)) throw new WebsiteError("website_branch_conflict"); }
      if (card.image) await this.readBack(gh, commit, card.image);
      const pr = await gh.pull(prN);
      this.ledger.update(op, "done", { commitSha: commit, prNumber: pr.number, prUrl: pr.url, label: null });
      this.pollPreview(op, Date.parse(this.now()));
    } catch (e) {
      const label = persistedReason(failureLabel(new Error(e instanceof WebsiteError ? e.label : e instanceof Error ? e.message : "")));
      const mayHaveLanded = landed || ambiguous || (stage === "write" && e instanceof WebsiteError && e.sent);
      if (label === "website_pr_closed") this.prOpen.set(prN, { open: false, at: Date.now() }); // GitHub just said so: stop offering it
      this.ledger.update(op, mayHaveLanded ? "unsettled" : "failed", { label });
    }
  }
  /** IMAGES-V1 I3: the commit holds the exact approved image bytes (full hash) and events.json points the event at it. */
  private async readBack(gh: GithubPort, commit: string, image: { eventId: string; sha256: string; bytes: number; path: string }) {
    const { createHash } = await import("node:crypto");
    const at = await gh.file(image.path, commit), events = await gh.file(WEBSITE_FILES.events, commit);
    let ev: any = null;
    try { ev = events ? JSON.parse(events.bytes.toString("utf8")).events?.find((e: any) => e?.id === image.eventId) : null; } catch { /* refused below */ }
    if (!at || at.bytes.length !== image.bytes || "sha256:" + createHash("sha256").update(at.bytes).digest("hex") !== image.sha256 || ev?.image !== image.path.slice("public".length))
      throw new WebsiteError("website_image_readback_failed");
  }
  private pollPreview(op: string, startedMs: number) {
    const p = this.o.poll ?? PREVIEW_POLL;
    const tick = async () => {
      const r = this.ledger.get(op);
      if (!r || r.state !== "done" || r.previewUrl || !r.commitSha) return;
      const url = await this.findPreview(r.commitSha).catch(() => null);
      if (url) { this.ledger.update(op, "done", { previewUrl: url }); return; }
      if (Date.now() - startedMs >= p.maxMs) { this.ledger.update(op, "done", { label: "website_preview_pending" }); return; }
      const t = setTimeout(() => { this.timers.delete(t); void tick(); }, p.everyMs); t.unref(); this.timers.add(t);
    };
    void tick();
  }
  private async findPreview(commit: string) {
    const urls = await this.o.github().previewUrls(commit);
    return urls.find((u) => ["success", "ready"].includes(u.state) && previewHostAllowed(u.url, this.o.previewHosts))?.url ?? null;
  }
  /** Reviewers: re-check the preview now (after the 15-minute window). */
  async checkPreview(requestId: string) {
    const r = this.a.read(() => this.a.db.prepare("SELECT operation_id FROM website_prs WHERE request_id=?").get(requestId)) as { operation_id: string } | undefined;
    const row = r ? this.ledger.get(r.operation_id) : null;
    if (!row || row.state !== "done" || !row.commitSha) throw new AccessError("website_pr_unknown");
    if (!row.previewUrl) { const url = await this.findPreview(row.commitSha); if (url) this.ledger.update(row.operationId, "done", { previewUrl: url, label: null }); }
    return this.view(requestId);
  }
  /** The proposal + its PR (rows only) for the Review card. */
  view(requestId: string) {
    const r = this.o.requests.read({ requestId });
    const pr = this.a.read(() => this.a.db.prepare("SELECT operation_id FROM website_prs WHERE request_id=?").get(requestId)) as { operation_id: string } | undefined;
    const row = pr ? this.ledger.get(pr.operation_id) : null;
    // C-6: the TARGET of a later update shows the branch at the newest commit, its preview, and who updated it (no second Approve).
    const upd = row?.state === "done" && row.kind !== "update" && row.prNumber ? this.ledger.latestUpdate(row.prNumber) : null;
    if (row && upd) { row.commitSha = upd.commitSha; row.previewUrl = upd.previewUrl; row.label = upd.label; }
    let card = null;
    try { if (r.state === "ready") card = this.card(requestId); } catch { /* not ready */ }
    const prState: { state: string; merged: boolean } | null = null;
    // v0.1: the preview opens on the CHANGED page (/events/<id>, /meetings/<slug>) of the same allowlisted preview host; while
    // Vercel is still building (PR open, no ready URL yet, still inside the polling window) the card shows "building", no link.
    const path = typeof r.summary?.previewPath === "string" && /^\/(events|meetings)(\/[a-z0-9-]{1,120})?$/.test(r.summary.previewPath) ? r.summary.previewPath : null;
    let previewPageUrl: string | null = null;
    if (row?.previewUrl && previewHostAllowed(row.previewUrl, this.o.previewHosts)) {
      const u = new URL(row.previewUrl); if (path) u.pathname = path; previewPageUrl = u.toString();
    }
    const previewBuilding = !!row && row.state === "done" && !row.previewUrl && row.label !== "website_preview_pending";
    const t = card && !row ? this.target(r) : null;
    return { ...r, card: card ? { ...card.card, digest: card.cardDigest } : null, overlaps: card && !row ? this.overlaps(r) : [],
      update: t && !t.blocked ? { pr: t.pr, url: t.url } : null, updateBlocked: t?.blocked ?? null, updatedBy: upd ? { at: upd.updatedAt } : null,
      pr: row ? { state: row.state, label: row.label, branch: row.kind === "update" ? row.targetBranch : row.branch, commitSha: row.commitSha, number: row.prNumber, url: row.prUrl, previewUrl: row.previewUrl,
        previewPageUrl, previewBuilding, prState } : null };
  }
  /** Owner (Oct 23): earlier proposals with a Kapelle draft PR that change the SAME page (event/meeting path) as this unapproved
   *  one, grouped by PR (create and update rows). Rows only. */
  private overlapRows(r: { requestId: string; summary: any }) {
    const mine = new Set(((r.summary?.changes ?? []) as { path?: string }[]).map((c) => c.path).filter((x): x is string => typeof x === "string"));
    if (!mine.size) return [];
    const rows = this.a.read(() => this.a.db.prepare(`SELECT p.operation_id, p.request_id, p.pr_number, p.pr_url FROM website_prs p JOIN website_requests q ON q.id=p.request_id
      WHERE p.state='done' AND p.pr_number IS NOT NULL AND q.discarded_at IS NULL AND p.request_id<>? ORDER BY p.created_at DESC LIMIT 40`).all(r.requestId)) as
      { operation_id: string; request_id: string; pr_number: number; pr_url: string }[];
    return rows.filter((x) => ((this.o.requests.read({ requestId: x.request_id }).summary?.changes ?? []) as { path?: string }[]).some((c) => typeof c.path === "string" && mine.has(c.path)));
  }
  private overlaps(r: { requestId: string; summary: any }) {
    const seen = new Set<number>();
    // Fable N-2 (516491d0): a PR that GitHub reported merged or closed (refreshTargets) is no longer named: it opens no conflict.
    return this.overlapRows(r).filter((x) => this.prOpen.get(x.pr_number)?.open !== false && !seen.has(x.pr_number) && !!seen.add(x.pr_number))
      .map((x) => ({ number: x.pr_number, url: x.pr_url }));
  }
  /** C-4 eligibility: exactly ONE overlapping open PR, created by this runtime (kapelle/wr-* branch, our ledger), on the same base,
   *  with nothing of ours in flight on it; the PR's open state comes from GitHub (refreshTargets). Else `blocked` says why. */
  private target(r: { requestId: string; summary: any; baseCommit?: string | null }): { pr: number; url: string; branch: string; expectedHead: string; blocked: string | null } | null {
    const ov = this.overlaps(r);
    if (!ov.length) return null;
    const pr = ov[0].number, url = ov[0].url;
    if (ov.length > 1) return { pr, url, branch: "", expectedHead: "", blocked: "several" };
    const rows = this.a.read(() => this.a.db.prepare("SELECT * FROM website_prs WHERE pr_number=? OR target_pr=? ORDER BY created_at").all(pr, pr)) as any[];
    const create = rows.find((x) => x.kind !== "update" && x.pr_number === pr);
    if (!create || !RUNTIME_BRANCH.test(create.branch)) return { pr, url, branch: "", expectedHead: "", blocked: "not_runtime" };
    if (rows.some((x) => ["intent", "sent", "unsettled"].includes(x.state))) return { pr, url, branch: create.branch, expectedHead: "", blocked: "busy" };
    const last = rows.filter((x) => x.state === "done" && x.commit_sha).at(-1);
    if (create.base_commit !== r.baseCommit) return { pr, url, branch: create.branch, expectedHead: "", blocked: "base_moved" }; // Q2: fall back to a new PR
    const open = this.prOpen.get(pr);
    if (open === undefined) return { pr, url, branch: create.branch, expectedHead: "", blocked: "pr_unknown" };
    if (!open.open) return { pr, url, branch: create.branch, expectedHead: "", blocked: "pr_closed" };
    return { pr, url, branch: create.branch, expectedHead: last.commit_sha, blocked: null };
  }
  /** GitHub's open/merged state of the PRs that unapproved proposals could update (cached 60 s; a read failure leaves it unknown). */
  private readonly prOpen = new Map<number, { open: boolean; at: number }>();
  async refreshTargets() {
    const ids = this.a.read(() => this.a.db.prepare(`SELECT id FROM website_requests q WHERE q.state='ready' AND q.discarded_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM website_prs p WHERE p.request_id=q.id) ORDER BY created_at DESC LIMIT 10`).all()) as { id: string }[];
    const prs = new Set<number>();
    for (const { id } of ids) for (const o of this.overlapRows(this.o.requests.read({ requestId: id }))) prs.add(o.pr_number); // incl. ones cached closed
    // Fable N-3 (a0a39975): at most PR_READS_PER_LIST GitHub reads per list (the newest overlapping PRs); the rest stay unknown
    // (= not eligible: today's path) until a later list.
    let reads = 0;
    for (const n of prs) {
      if (reads >= PR_READS_PER_LIST) break;
      const c = this.prOpen.get(n); if (c && Date.now() - c.at < 60_000) continue;
      reads++; const p = await this.o.github().pull(n).catch(() => null);
      if (p) this.prOpen.set(n, { open: p.state === "open" && !p.merged, at: Date.now() }); else this.prOpen.delete(n);
    }
  }
  /** The live PR state (open / merged / closed) for the card. */
  async prStatus(requestId: string) {
    const v = this.view(requestId);
    if (!v.pr?.number) return v;
    const p = await this.o.github().pull(v.pr.number).catch(() => null);
    return { ...v, pr: { ...v.pr, prState: p ? { state: p.state, merged: p.merged } : null } };
  }
  async idle() { await this.chain.catch(() => {}); }
  stop() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
}
