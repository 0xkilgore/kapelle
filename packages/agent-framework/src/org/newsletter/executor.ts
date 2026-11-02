// Newsletter slice 2, S2-b (NEWSLETTER-SEND-V1 v2 §4 F-7; PLAN-NEWSLETTER-SLICE2): the release executor over the ProviderPort.
// The DB is authoritative; <stateRoot>/newsletter/sent.json is a PROJECTION of it (temp + fsync + rename + parent-dir fsync).
// One release runs the fixed order under one writer (this executor runs one release at a time):
//   (1) `approved` (written by the TOTP verification transaction, S1-c)  (2) projection intent, before any provider call
//   (3) txn create_attempted  (4) create the draft, the operationId in its name (never create-and-send)
//   (5) txn draft_known + broadcast id, projection  (6) read the draft back against the package; re-check kill, recipients,
//   other unsettled releases, installation  (7) txn send_attempted  (8) send by the persisted id  (9) txn provider_accepted,
//   projection  (10) recipient count: above N = newsletter_overrun -> reconcile_required; unknown = reconcile_required
//   (never silently verified); otherwise archive_pending (the website PR is slice 3).
// A definite provider refusal (sent=false) fails the release; an ambiguous one (sent=true) leaves it where it was:
// create_attempted / send_attempted are UNSETTLED and block every release of the org until recover() settles them by
// reads: create -> the complete listing by exact name (one match adopts, none = failed, several or an incomplete listing
// = held); send -> GET (queued/sent adopts, still a draft = held for a human). Never an automatic re-create or re-send.
// recover() also rebuilds a missing/behind projection from the DB and refuses (restore_reconcile_required) a projection
// that is AHEAD of the DB or names a release the DB does not know (a restore from backup behind the JSON).
import { recheckImages, type PreflightFetch } from "./image-preflight.js";
import { RENDERER_V3, unsubscribeFormOk } from "./render-cp.js";
import { closeSync, copyFileSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import { NewsletterReleases, ProviderError, recipientsDigest, type ProviderPort } from "./release.js";
import { PROGRESS } from "./labels.js";

const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
type Row = { release_id: string; operation_id: string; state: string; broadcast_id: string | null; label: string | null; recipient_count: number | null; at: string; slug: string; digest: string };
export type ProjectionRow = { releaseId: string; slug: string; digest: string; operationId: string; state: string; broadcastId: string | null; at: string };
/** Thrown by the test-only crash hook to simulate the process dying at a boundary. */
export class Crash extends Error { constructor(readonly point: string) { super("crash:" + point); } }
const rank = (s: string) => PROGRESS.indexOf(s as (typeof PROGRESS)[number]);
/** Fable S2-b F-3: "the JSON says it went out and the DB does not know". */
const SENT_STATES = ["provider_accepted", "archive_pending", "done"], SENT_OR_RECONCILING = [...SENT_STATES, "reconcile_required"];
const projectionAhead = (p: string, d: string) => (SENT_STATES.includes(p) && !SENT_OR_RECONCILING.includes(d)) || (rank(p) >= 0 && rank(d) >= 0 && rank(p) > rank(d));

export class NewsletterExecutor {
  readonly manifest: string;
  constructor(private readonly a: SqliteAuthority, private readonly o: { stateRoot: string; releases: NewsletterReleases; provider: ProviderPort;
    /** S3-a: a FRESH read of the eligible audience (ids), refreshing the cache the synchronous gates use; null = unknown. */
    audience: { refresh(): Promise<string[] | null> };
    /** R-2: the one configured list id (broadcast + audience); the package and the provider's draft must name it. */
    listId?: string;
    /** Package E (Fable E-2): the image preflight's fetch; the send re-checks every image against its prepared bytes. */
    imageFetch?: PreflightFetch | null;
    crash?: (point: string) => void }, private readonly now: () => string = () => new Date().toISOString()) {
    this.manifest = join(o.stateRoot, "newsletter", "sent.json");
  }
  private at(point: string) { this.o.crash?.(point); }
  private rows(): Row[] {
    return this.a.db.prepare(`SELECT e.release_id, e.operation_id, e.state, e.broadcast_id, e.label, e.recipient_count, COALESCE(e.updated_at, e.at) AS at, r.slug, r.digest
      FROM newsletter_effects e JOIN newsletter_releases r ON r.id=e.release_id ORDER BY e.at, e.release_id`).all() as Row[];
  }
  private row(releaseId: string) { return this.rows().find((r) => r.release_id === releaseId); }
  private set(releaseId: string, state: string, extra: { broadcastId?: string; label?: string | null; recipientCount?: number; postSendSha?: string } = {}) {
    this.a.write(() => {
      this.a.db.prepare(`UPDATE newsletter_effects SET state=?, updated_at=?, broadcast_id=COALESCE(?, broadcast_id), label=?, recipient_count=COALESCE(?, recipient_count),
          post_send_recipients_sha=COALESCE(?, post_send_recipients_sha) WHERE release_id=?`)
        .run(state, this.now(), extra.broadcastId ?? null, extra.label ?? null, extra.recipientCount ?? null, extra.postSendSha ?? null, releaseId);
      this.a.db.prepare("UPDATE newsletter_releases SET state=? WHERE id=?").run(state, releaseId);
    });
  }
  /** The projection, written atomically: temp file, fsync, rename, parent directory fsync. */
  private project() {
    const dir = join(this.o.stateRoot, "newsletter"), tmp = join(dir, ".sent.json.tmp");
    const rows: ProjectionRow[] = this.a.read(() => this.rows()).map((r) => ({ releaseId: r.release_id, slug: r.slug, digest: r.digest, operationId: r.operation_id, state: r.state, broadcastId: r.broadcast_id, at: r.at }));
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = openSync(tmp, "w", 0o600);
      try { writeSync(fd, JSON.stringify({ contract: "kapelle.newsletter-manifest/v1", rows }, null, 1) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, this.manifest);
      const dfd = openSync(dir, "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); }
    } catch { throw new ProviderError("newsletter_manifest_unwritable", false); }
  }
  private readProjection(): ProjectionRow[] | null {
    if (!existsSync(this.manifest)) return null;
    try { const j = JSON.parse(readFileSync(this.manifest, "utf8")); return Array.isArray(j?.rows) ? j.rows : []; } catch { return []; }
  }

  /** Run one approved release through the protocol. Returns its final state (or where it stopped). */
  async run(releaseId: string): Promise<{ state: string; label: string | null }> {
    // F-1: a projection the DB cannot explain stops everything: no projection write, no provider call, the row unchanged.
    if ((await this.recover()).restoreReconcile) { const cur = this.row(releaseId); return { state: cur?.state ?? "unknown", label: "newsletter_restore_reconcile" }; }
    let r = this.row(releaseId);
    if (!r) return { state: "unknown", label: "newsletter_release_unknown" };
    const pkg = this.a.read(() => this.o.releases.packageOf(releaseId));
    const stop = (state: string, label: string | null) => {
      this.set(releaseId, state, { label });
      // N-2: the DB is authoritative; a projection that could not follow is recorded on the row, never silent.
      try { this.project(); } catch { this.set(releaseId, state, { label: label ? `${label}:projection_unwritable` : "newsletter_manifest_unwritable" }); }
      return { state, label };
    };
    // F-2: before any mutation (projection or provider), the release-wide facts; a failure leaves the row UNCHANGED in
    // `approved` (nothing happened yet; it may proceed once the facts change).
    const gate = () => this.a.read(() => this.o.releases.preMutationFailures(releaseId));
    if (r.state === "approved") {
      let g = gate(); if (g.length) return { state: "approved", label: g[0] };
      // Package E (Fable E-2): right before the first mutation, every image is live and still the prepared bytes; a gone or
      // replaced image fails the release (a new release needs a new prepare, test and approval). No provider call.
      // Fable F-1 / E-6': right before the first mutation, a v3 package's footer carries exactly the triple-brace unsubscribe anchor;
      // otherwise the release fails (a new prepare is needed) and the provider is never called.
      if (String(pkg.renderer).startsWith(RENDERER_V3) && !unsubscribeFormOk(pkg.html)) return stop("failed", "newsletter_unsubscribe_invalid");
      if (pkg.images.length) {
        const c = this.o.imageFetch ? await recheckImages(this.o.imageFetch, pkg.images) : { ok: false as const, label: "newsletter_images_unserved" as const, url: "" };
        if (!c.ok) return stop("failed", c.label);
      }
      this.project(); this.at("after-intent");                                     // (2) unwritable projection stops here
      g = gate(); if (g.length) return { state: "approved", label: g[0] };          // again, right before the first state change
      this.set(releaseId, "create_attempted"); this.at("after-create-attempted");   // (3)
      let id: string;
      try { id = (await this.o.provider.createDraft({ name: `kapelle:${r.operation_id}`, subject: pkg.subject, html: pkg.html, text: pkg.text, from: pkg.from,
        replyTo: pkg.replyTo, listId: pkg.listId })).id; }                          // (4)
      catch (e) { if (e instanceof ProviderError && !e.sent) return stop("failed", e.label); return { state: "create_attempted", label: "newsletter_provider_uncertain" }; }
      this.at("after-create");
      this.set(releaseId, "draft_known", { broadcastId: id }); this.project(); this.at("after-draft-known"); // (5)
      r = this.row(releaseId)!;
    }
    if (r.state === "draft_known") {
      // Fable S3-a F-1: a read that FAILS (transport/5xx) proves nothing: keep draft_known and retry the idempotent READ next
      // run (failing would invite a re-approval and a second draft). Only a missing draft (404) or a real mismatch fails.
      let b: Awaited<ReturnType<ProviderPort["getBroadcast"]>>;
      try { b = await this.o.provider.getBroadcast(r.broadcast_id!); } catch { return { state: "draft_known", label: "newsletter_provider_uncertain" }; } // (6)
      if (!b || b.status !== "draft" || b.subject !== pkg.subject || b.htmlSha256 !== sha(pkg.html)) return stop("failed", "newsletter_draft_mismatch");
      // R-2: one list: the frozen package, the configured list and the provider's draft name the same id.
      if (this.o.listId !== undefined && (pkg.listId !== this.o.listId || (b.listId !== undefined && b.listId !== this.o.listId))) return stop("failed", "newsletter_draft_mismatch");
      await this.o.audience.refresh(); // F-5: the pre-send recipient re-read (fresh), feeding preSendFailures below
      const failed = this.a.read(() => this.o.releases.preSendFailures(releaseId));
      if (failed.length) return stop("held", failed[0]);                            // the facts changed: a human decides
      this.set(releaseId, "send_attempted"); this.at("after-send-attempted");       // (7)
      try { await this.o.provider.send(r.broadcast_id!); }                           // (8)
      catch (e) { if (e instanceof ProviderError && !e.sent) return stop("held", "newsletter_draft_held"); return { state: "send_attempted", label: "newsletter_provider_uncertain" }; }
      this.at("after-send");
      this.set(releaseId, "provider_accepted"); this.project(); this.at("after-accepted"); // (9)
      r = this.row(releaseId)!;
    }
    if (r.state === "provider_accepted") return this.fence(releaseId); // (10)
    return { state: r.state, label: r.label };
  }
  /** (10) S3-a, answer 1: the post-send "no additions observed" check (Resend reports no recipient count). Re-read the audience
   *  right after the send and record its digest: any eligible contact outside the approved set = newsletter_overrun ("an
   *  addition was observed; the provider may have included it"); an incomplete read = newsletter_count_unknown; both
   *  reconcile_required. Never "verified" without the read. */
  private async fence(releaseId: string) {
    const ids = await this.o.audience.refresh().catch(() => null);
    const approved = new Set(JSON.parse((this.a.read(() => this.a.db.prepare("SELECT recipients FROM newsletter_releases WHERE id=?").get(releaseId)) as { recipients: string }).recipients) as string[]);
    const [state, label] = ids === null ? ["reconcile_required", "newsletter_count_unknown"] : ids.some((id) => !approved.has(id)) ? ["reconcile_required", "newsletter_overrun"] : ["archive_pending", null];
    this.set(releaseId, state, { label, ...(ids !== null ? { recipientCount: ids.length, postSendSha: recipientsDigest(ids) } : {}) });
    this.project();
    return { state, label };
  }

  /** Before any provider call (and at start): reconcile the projection with the DB, then settle unsettled rows by reads. */
  async recover() {
    // F-1: once flagged, nothing here touches the projection until Ops reconciles and clears the flag.
    if (this.a.read(() => this.o.releases.restoreReconcile())) return { restoreReconcile: true, settled: 0 };
    const db = this.a.read(() => this.rows()), proj = this.readProjection();
    if (proj) {
      const byId = new Map(db.map((r) => [r.release_id, r]));
      // A row the DB does not know, or a state the DB is behind on (F-3 incl. non-progress DB states): a restore behind the JSON.
      const ahead = proj.some((p) => { const d = byId.get(p.releaseId); return !d || projectionAhead(p.state, d.state); });
      if (ahead) {
        // F-1: keep the evidence: a copy that is never overwritten; the live file stays as it is.
        try { copyFileSync(this.manifest, `${this.manifest}.reconcile-${this.now().replace(/[:.]/g, "-")}`, constants.COPYFILE_EXCL); } catch { /* an earlier copy of this instant exists */ }
        this.a.write(() => this.o.releases.setRestoreReconcile(true));
        return { restoreReconcile: true, settled: 0 };
      }
    }
    this.project(); // missing or behind: rebuilt from the DB
    let settled = 0;
    for (const r of db) {
      if (r.state === "create_attempted" && !r.broadcast_id) {
        let list: { complete: boolean; items: { id: string; name: string }[] } | null = null;
        try { list = await this.o.provider.listBroadcasts(); } catch { list = null; }
        if (!list || !list.complete) { this.set(r.release_id, "held", { label: "newsletter_history_unavailable" }); continue; }
        const hits = list.items.filter((b) => b.name === `kapelle:${r.operation_id}`);
        if (hits.length === 1) this.set(r.release_id, "draft_known", { broadcastId: hits[0].id });
        else if (hits.length === 0) this.set(r.release_id, "failed", { label: "newsletter_create_absent" }); // a new release needs a new approval
        else this.set(r.release_id, "held", { label: "newsletter_create_ambiguous" });
        settled++;
      } else if (r.state === "send_attempted") {
        const b = await this.o.provider.getBroadcast(r.broadcast_id!).catch(() => null);
        if (b && (b.status === "queued" || b.status === "sent")) this.set(r.release_id, "provider_accepted");
        else this.set(r.release_id, "held", { label: "newsletter_draft_held" }); // still a draft (or unreadable): a human decides, never a resend
        settled++;
      }
    }
    if (settled) this.project();
    return { restoreReconcile: false, settled };
  }
}
