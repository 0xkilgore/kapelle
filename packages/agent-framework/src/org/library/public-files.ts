// LIBRARY L2 (Fable threat model 2ac355ca L-2/L-4/L-12; FABLE-REVIEW-ORG-FILE-LIBRARY-R2 R-2/R-3/R-4, Addenda 1-3 P-1..P-3):
// a shared-drive image becomes PUBLIC only through a reviewer's publish-on-prepare of a newsletter release
// (newsletter.release.publish: consequential, fresh session, journaled). Nothing else publishes; no agent tool can.
// - State per content hash: public | unpublished (410, bytes kept: a sent email never shows a different picture) |
//   quarantined (the bytes on disk no longer match the hash: 500 + an incident; never served until Ops looks).
// - P-2: a release that is abandoned (superseded by a newer prepare of the same draft, or not sent within 14 days) or that
//   failed before sending unpublishes its images, unless another live or sent release references the same hash. A SENT
//   release's images stay public; only an admin's unpublish removes them, and it names the sends (R-3: a DB fact). The 14 days
//   run from the latest publish of that release (re-preparing identical content returns the same release and restarts it).
import { createHash } from "node:crypto";
import { canonical } from "../../command-boundary.js";
import { AccessError } from "../../access/org-access.js";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import { driveUrlSha, referencedImages } from "../newsletter/render-cp.js";
import type { SharedDrive } from "./drive.js";

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
export const PUBLIC_FILES = { abandonDays: 14 } as const;
/** Release states that mean "sent" (its images stay public) and states that are still live (outcome pending). */
const SENT = ["provider_accepted", "archive_pending", "done"];
const LIVE = ["approved", "create_attempted", "draft_known", "send_attempted", "uncertain", "held", "reconcile_required", "restore_reconcile_required"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS public_files(sha256 TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('public','unpublished','quarantined')),
  published_at TEXT NOT NULL, published_by TEXT NOT NULL, changed_at TEXT, changed_by TEXT, reason TEXT) STRICT;
CREATE TABLE IF NOT EXISTS library_release_refs(release_id TEXT NOT NULL, sha256 TEXT NOT NULL, conversation_id TEXT NOT NULL, artifact_id TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY(release_id, sha256)) STRICT;
CREATE TABLE IF NOT EXISTS library_incidents(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, sha256 TEXT NOT NULL, label TEXT NOT NULL) STRICT;`;

/** The drive images (content hashes, in order) a rendered newsletter references for this org. */
export function driveImagesOf(html: string, orgId: string): string[] {
  return [...new Set(referencedImages(html).map(driveUrlSha).filter((x): x is { orgId: string; sha256: string } => !!x && x.orgId === orgId).map((x) => x.sha256))];
}
/** What a publish approval binds: the exact set of hashes (the challenge's artifact digest). */
export const publishDigest = (shas: readonly string[]) => "sha256:" + sha(canonical([...new Set(shas)].sort()));

export class PublicFiles {
  private readonly now: () => string;
  constructor(private readonly a: SqliteAuthority, private readonly drive: SharedDrive, private readonly o: { orgId: string; enabled: boolean }, now?: () => string) {
    this.now = now ?? (() => new Date().toISOString());
    a.db.exec(SCHEMA);
    drive.isPublished = (h) => this.stateRaw(h) === "public";
  }
  get enabled() { return this.o.enabled; }
  private stateRaw(h: string) { return (this.a.db.prepare("SELECT state FROM public_files WHERE sha256=?").get(h) as { state: string } | undefined)?.state ?? null; }
  private journal(memberId: string | null, event: string, target: string, detail: unknown = null) {
    this.a.db.prepare("INSERT INTO library_journal(at,member_id,event,target,detail) VALUES (?,?,?,?,?)").run(this.now(), memberId, event, target, detail === null ? null : JSON.stringify(detail));
  }
  /** Publish exactly these drive hashes (R-4: idempotent per hash; one journal line per newly public hash). */
  publish(memberId: string, shas: readonly string[]) {
    if (!this.o.enabled) throw new AccessError("files_public_route_off");
    for (const h of shas) if (!this.drive.has(h)) throw new AccessError("drive_image_unknown");
    for (const h of shas) this.drive.bytes(h); // every hash re-checks before anything is public
    return this.a.write(() => {
      const fresh: string[] = [];
      for (const h of shas) {
        const s = this.stateRaw(h);
        if (s === "quarantined") throw new AccessError("drive_image_unreadable");
        if (s === "public") continue;
        if (s === "unpublished") this.a.db.prepare("UPDATE public_files SET state='public', published_at=?, published_by=?, changed_at=NULL, changed_by=NULL, reason=NULL WHERE sha256=?").run(this.now(), memberId, h);
        else this.a.db.prepare("INSERT INTO public_files(sha256,state,published_at,published_by,changed_at,changed_by,reason) VALUES (?,'public',?,?,NULL,NULL,NULL)").run(h, this.now(), memberId);
        this.journal(memberId, "published", h);
        fresh.push(h);
      }
      return { published: fresh, already: shas.filter((h) => !fresh.includes(h)) };
    });
  }
  /** Record which release a publish served (the P-2 sweep and the R-3 "referenced by a sent release" check read these). */
  link(releaseId: string, shas: readonly string[], conversationId: string, artifactId: string) {
    // Re-preparing identical content returns the SAME release; its 14-day clock restarts at the latest publish.
    this.a.write(() => { for (const h of shas) this.a.db.prepare(`INSERT INTO library_release_refs(release_id,sha256,conversation_id,artifact_id,at) VALUES (?,?,?,?,?)
      ON CONFLICT(release_id, sha256) DO UPDATE SET at=excluded.at`).run(releaseId, h, conversationId, artifactId, this.now()); });
  }
  /** The newsletter tables exist only when the org has a newsletter (no release can then reference anything). */
  private hasReleases() { return !!this.a.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='newsletter_effects'").get(); }
  /** Releases (sent) that reference a hash. Call inside the caller's transaction. */
  private sentRefs(h: string) {
    if (!this.hasReleases()) return [];
    return (this.a.db.prepare(`SELECT r.release_id, n.slug FROM library_release_refs r JOIN newsletter_releases n ON n.id=r.release_id
      LEFT JOIN newsletter_effects e ON e.release_id=r.release_id WHERE r.sha256=? AND COALESCE(e.state, n.state) IN (${SENT.map((s) => `'${s}'`).join(",")})`).all(h) as { release_id: string; slug: string }[]);
  }
  /** The public route's answer for one hash: 200 + bytes, 404 (never public / unknown), 410 (unpublished), 500 (quarantined). */
  read(h: string): { status: 200; data: Buffer } | { status: 404 | 410 | 500 } {
    if (!this.o.enabled || !/^[a-f0-9]{64}$/.test(h)) return { status: 404 };
    const s = this.a.read(() => this.stateRaw(h));
    if (s === null) return { status: 404 };
    if (s === "unpublished") return { status: 410 };
    if (s === "quarantined") return { status: 500 };
    try { return { status: 200, data: this.drive.bytes(h).data }; }
    catch { // R-2: the bytes on disk are not the hash: stop serving, raise an incident, never serve mismatching bytes
      this.a.write(() => {
        if (this.stateRaw(h) !== "public") return;
        this.a.db.prepare("UPDATE public_files SET state='quarantined', changed_at=?, changed_by=NULL, reason='hash_mismatch' WHERE sha256=?").run(this.now(), h);
        this.a.db.prepare("INSERT INTO library_incidents(at,sha256,label) VALUES (?,?,'library_hash_mismatch')").run(this.now(), h);
        this.journal(null, "quarantined", h);
      });
      return { status: 500 };
    }
  }
  /** An admin unpublishes one hash (410 from now on; bytes kept). A hash a SENT release used needs override:true, and the
   *  refusal names those sends so the card can show them. */
  unpublish(m: { memberId: string; role: string }, b: { sha256?: unknown; override?: unknown }) {
    if (m.role !== "admin") throw new AccessError("access_role_not_permitted");
    const h = typeof b?.sha256 === "string" && /^[a-f0-9]{64}$/.test(b.sha256) ? b.sha256 : null;
    if (!h) throw new AccessError("drive_image_unknown");
    return this.a.write(() => {
      const s = this.stateRaw(h);
      if (s !== "public" && s !== "quarantined") throw new AccessError("files_not_public");
      const sent = this.sentRefs(h);
      if (sent.length && b.override !== true) throw new AccessError("files_used_in_sent_newsletter", JSON.stringify(sent.map((x) => x.slug)));
      this.a.db.prepare("UPDATE public_files SET state='unpublished', changed_at=?, changed_by=?, reason=? WHERE sha256=?").run(this.now(), m.memberId, sent.length ? "admin_override" : "admin", h);
      this.journal(m.memberId, "unpublished", h, { sentReleases: sent.map((x) => x.slug) });
      return { unpublished: h, sentReleases: sent.map((x) => x.slug) };
    });
  }
  /** The slugs of sent releases that used a hash (the unpublish card). */
  sentReleasesOf(h: string) { return this.a.read(() => this.sentRefs(h).map((x) => x.slug)); }
  /** P-2: unpublish every public hash with no live or sent release left. A release is dead when it failed, was superseded by
   *  a newer prepare of the same draft, or stayed prepared (unsent) for 14 days. Hourly and at each publish. */
  sweep() {
    const cutoff = new Date(Date.parse(this.now()) - PUBLIC_FILES.abandonDays * 86_400_000).toISOString();
    return this.a.write(() => {
      if (!this.hasReleases() && !this.a.db.prepare("SELECT 1 FROM public_files WHERE state='public' LIMIT 1").get()) return { unpublished: 0 };
      const refs = !this.hasReleases() ? [] : this.a.db.prepare(`SELECT r.release_id, r.sha256, r.conversation_id, r.artifact_id, r.at, COALESCE(e.state, n.state) AS state
        FROM library_release_refs r JOIN newsletter_releases n ON n.id=r.release_id LEFT JOIN newsletter_effects e ON e.release_id=r.release_id`).all() as
        { release_id: string; sha256: string; conversation_id: string; artifact_id: string; at: string; state: string }[];
      const newest = new Map<string, string>(); // the newest publish per draft
      for (const r of refs) { const k = r.conversation_id + "/" + r.artifact_id; if (!newest.has(k) || newest.get(k)! < r.at) newest.set(k, r.at); }
      const alive = (r: (typeof refs)[number]) => SENT.includes(r.state) || LIVE.includes(r.state)
        || (r.state === "prepared" && r.at === newest.get(r.conversation_id + "/" + r.artifact_id) && r.at > cutoff);
      const keep = new Set(refs.filter(alive).map((r) => r.sha256));
      const pub = (this.a.db.prepare("SELECT sha256 FROM public_files WHERE state='public'").all() as { sha256: string }[]).map((r) => r.sha256);
      const gone = pub.filter((h) => !keep.has(h));
      for (const h of gone) {
        this.a.db.prepare("UPDATE public_files SET state='unpublished', changed_at=?, changed_by=NULL, reason='release_abandoned' WHERE sha256=?").run(this.now(), h);
        this.journal(null, "unpublished", h, { reason: "release_abandoned" });
      }
      return { unpublished: gone.length };
    });
  }
  stats() {
    return this.a.read(() => {
      const n = (q: string) => (this.a.db.prepare(q).get() as { n: number }).n;
      return { public: n("SELECT COUNT(*) AS n FROM public_files WHERE state='public'"), unpublished: n("SELECT COUNT(*) AS n FROM public_files WHERE state='unpublished'"),
        quarantined: n("SELECT COUNT(*) AS n FROM public_files WHERE state='quarantined'"), incidents: n("SELECT COUNT(*) AS n FROM library_incidents") };
    });
  }
}
