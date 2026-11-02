// Newsletter send slice 1, S1-c (PLAN-NEWSLETTER-SLICE1; NEWSLETTER-SEND-V1 v2 §2/§4; Fable F-4..F-7, R-1..R-4, R-9):
// the FIXTURE-ONLY release core. Nothing here talks to a provider, renders a test or writes .sent.json (slices 2-3).
// - A release package is frozen and digested: subject (production + the declared [TEST] variant), From, Reply-To, HTML,
//   text, renderer, slug, image references with content hashes, list identity, and the approved recipient set's digest
//   and count (taken from the recipients port at prepare). Any field change is a new digest, hence a new test and approval.
// - evaluateRelease(facts) is PURE (no DB, no clock: `now` is a fact) and returns one fixed label per failed gate, covering
//   the eight CP gates plus F-4 (a [TEST] of exactly this digest to the approver's own address within 24 h), F-5 (no
//   recipient added since approval), F-6 (suppression sync <= 24 h until the old audience is retired), the monthly cap,
//   the kill switch and "any unsettled release blocks every release" (F-7).
// - The mint guard refuses a challenge unless every gate passes; the in-transaction hook (R-2) runs LAST inside the TOTP
//   verification transaction on the same handle (asserts isTransaction, never a.write/a.read), re-checks the gates and
//   writes the release `approved` and its unique effect row. Slice 1 writes no other state (asserted by tests).
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical } from "../../command-boundary.js";
import type { F6Evidence } from "./f6-evidence.js";
import { AccessError } from "../../access/org-access.js";
import { chatTitle } from "../chat/conversations.js";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import { RELEASE_STATES, UNSETTLED_STATES } from "./labels.js";
import { MailError, type ResendMessage } from "../../mail/resend-send.js";

const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
const SHA = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const SLUG = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;
const DAY = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** What a reviewer releases (before the recipient snapshot is added at prepare). */
export const releaseInputSchema = z.object({
  slug: z.string().max(120), subject: z.string().min(1).max(300), testSubject: z.string().min(1).max(320), from: z.string().min(3).max(320),
  replyTo: z.string().min(3).max(320), html: z.string().min(1).max(512 * 1024), text: z.string().max(256 * 1024), renderer: z.string().min(1).max(100),
  images: z.array(z.object({ url: z.string().url().max(500), sha256: SHA }).strict()).max(50), listId: z.string().min(1).max(100),
  // Package E addendum 2 (Fable E-12d): every link decision in the HTML (live: text + host + source; inert: text + reason); the
  // reviewer approves exactly this list (it is in the content digest). Optional: earlier packages carry none.
  links: z.array(z.object({ text: z.string().max(200), url: z.string().max(500), live: z.boolean(), href: z.string().max(600).optional(), host: z.string().max(253).optional(),
    source: z.string().max(300).optional(), reason: z.enum(["malformed_text", "not_https", "display_mismatch", "no_source"]).optional() }).strict()).max(200).optional(),
}).strict();
export type ReleaseInput = z.infer<typeof releaseInputSchema>;
export type ReleasePackage = ReleaseInput & { recipientsSha: string; recipientCount: number; recipientsKnown?: boolean };
export const recipientsDigest = (ids: string[]) => sha(canonical([...ids].sort()));
/** S2-a (Fable answer 3): the CONTENT digest (everything a reader receives: subjects, From, Reply-To, HTML, text, renderer,
 *  slug, images, list identity) binds the test, the duplicate check and the slug check; the RELEASE digest adds the
 *  recipient snapshot and binds the challenge. A new subscriber changes the release digest, not the content digest. */
export const contentDigest = (pkg: ReleaseInput) => { const p = releaseInputSchema.parse(Object.fromEntries(Object.entries(pkg).filter(([k]) => k in releaseInputSchema.shape)));
  return sha(canonical(p)); };
export const releaseDigest = (pkg: ReleasePackage) => sha(canonical(pkg));
/** R-3: the frozen HTML/text carry the provider's unsubscribe placeholder literally (the content digest covers it); a preview
 *  test replaces it with this inert sentence; the release path (slice 3) lets the provider substitute. */
// Package E: one source for the placeholder (render-cp.ts, Fable E-6' default triple form until the owner's inbox proof).
export { UNSUB_TOKEN, UNSUB_ANCHOR } from "./render-cp.js";
import { UNSUB_TOKEN, UNSUB_ANCHOR, RENDERER_V3, referencedImages, unsubscribeFormOk } from "./render-cp.js";
import { hashImages, recheckImages, ImagePreflightError, type PreflightFetch } from "./image-preflight.js";
export const PREVIEW_UNSUB = "[The unsubscribe link appears here in the real send.]";
/** R-5: the fixed attestation the approver confirms on the card (its `attested: true` is part of the approved body). */
export const ATTESTATION = "I received the latest test of this exact newsletter and checked it.";
/** Fable cbae22b4 E-9: the ONE domain rule (the load-time check and Ops' install.sh implement the same): the address inside
 *  <…> if present, else the whole string; exactly one "@"; the domain after it, lower-cased, a trailing dot stripped, ASCII
 *  only. null = not a usable address. */
export function senderDomain(v: string): string | null { const a = senderAddress(v); return a ? a.split("@")[1] : null; }
/** The ONE address extraction (E-9; Fable E-10 ruling 574d8b5d fix 1): the normalized address, local part as written, the domain
 *  lower-cased with one trailing dot stripped; null = not usable. Release-path tests compare these, never the raw strings. */
export function senderAddress(v: string): string | null {
  // Fable (24 Oct, E-9 addition): no control byte anywhere (CR/LF/NUL in a display name = header injection), and "<" / ">" only
  // as the ONE address pair at the end. ASCII-only applies to the address, not the display name ("Ñame <x@…>" is fine).
  if (/[\x00-\x1f\x7f]/.test(v)) return null;
  if (/[<>]/.test(v) && !/^[^<>]*<[^<>]*>\s*$/.test(v)) return null;
  const inner = /<([^<>]*)>\s*$/.exec(v)?.[1] ?? v, addr = inner.trim();
  if (!/^[\x21-\x7e]+$/.test(addr) || (addr.match(/@/g) ?? []).length !== 1) return null;
  const [local, dom] = addr.split("@"), d = dom.toLowerCase().replace(/\.$/, "");
  return local && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? `${local}@${d}` : null;
}
export const TEST_LIMITS = { cooldownMs: 5 * 60_000 } as const;

export type ReleaseFacts = {
  now: string; installationId: string;
  release: { slug: string; digest: string; contentDigest: string; state: string; imageUrls: string[]; recipientsSha: string; approvedRecipients: string[];
    /** Package E (Fable E-2): the bytes each image had at prepare. */
    images?: { url: string; sha256: string }[] } | null;
  approver: { email: string; permitted: boolean };
  /** The test named in the approval body (R-5), else the approver's latest; `digest` is its CONTENT digest. */
  lastTest: { digest: string; to: string; receivedAt: string; path: string; state: string } | null;
  attested: boolean;
  preflight: { ok: boolean; images: { url: string; ok: boolean; sha256?: string }[] } | null;
  history: { complete: boolean; digests: string[]; slugs: Record<string, string> };
  transfer: { installationId: string; frozenAt: string; oldAudienceRetiredAt: string | null } | null;
  suppressionSyncAt: string | null;
  currentRecipients: string[] | null;
  releasesThisMonth: number; releasesPerMonth: number; killed: boolean; unsettled: number;
};
const age = (now: string, at: string) => Date.parse(now) - Date.parse(at);
/** Every failed gate as a fixed label, in a stable order; [] = releasable. Pure. */
export function evaluateRelease(f: ReleaseFacts): string[] {
  const r = f.release, out: string[] = [];
  if (!r) return ["newsletter_release_unknown"];
  if (f.killed) out.push("newsletter_killed");
  if (f.unsettled > 0) out.push("newsletter_uncertain_release");
  if (r.state !== "prepared") out.push("newsletter_release_state");
  if (!f.approver.permitted) out.push("newsletter_approver_not_permitted");
  // Gate 4: canonical dated slug; changed content under a used slug refuses.
  if (!SLUG.test(r.slug)) out.push("newsletter_slug_invalid");
  else if (f.history.slugs[r.slug] && f.history.slugs[r.slug] !== r.contentDigest) out.push("newsletter_slug_reused");
  // Gate 3: never sent before, against a COMPLETE history (local manifest + provider history + owner-imported index).
  if (!f.history.complete) out.push("newsletter_history_incomplete");
  else if (f.history.digests.includes(r.contentDigest)) out.push("newsletter_duplicate"); // same content to another set = still a duplicate
  // Gate 1 / F-4 / R-5: the approver received a RELEASE-PATH [TEST] of exactly this content within 24 h, and attests to it.
  const t = f.lastTest;
  if (!t) out.push("newsletter_test_missing");
  else {
    if (t.path !== "release") out.push("newsletter_test_preview_only"); // a preview proves the content, not the path (conflict 1)
    if (t.state !== "sent") out.push("newsletter_test_unknown");
    if (t.digest !== r.contentDigest) out.push("newsletter_test_mismatch");
    if (t.to.toLowerCase() !== f.approver.email.toLowerCase()) out.push("newsletter_test_wrong_recipient");
    const a = age(f.now, t.receivedAt);
    if (!(a >= -60_000 && a <= DAY)) out.push("newsletter_test_stale");
  }
  if (!f.attested) out.push("newsletter_attestation_required");
  // Gate 2: the dry-run image preflight passed for this exact digest. Gate 5: every image the release references was served.
  if (!f.preflight || !f.preflight.ok) out.push("newsletter_preflight_failed");
  const served = new Set((f.preflight?.images ?? []).filter((i) => i.ok).map((i) => i.url));
  if (!r.imageUrls.every((u) => served.has(u))) out.push("newsletter_images_unserved");
  // Package E (Fable E-2): the bytes the test's preflight saw must be the bytes prepare bound ("replaced", not "gone").
  const seen = new Map((f.preflight?.images ?? []).filter((i) => i.ok && i.sha256).map((i) => [i.url, i.sha256]));
  if ((r.images ?? []).some((i) => seen.has(i.url) && seen.get(i.url) !== i.sha256)) out.push("newsletter_image_changed");
  // Gates 6 and 8: an owner transfer record naming THIS installation (the old broadcaster frozen).
  if (!f.transfer) out.push("newsletter_transfer_missing");
  else if (f.transfer.installationId !== f.installationId) out.push("newsletter_installation_not_authorized");
  // F-6: old-audience suppressions synced within 24 h, until the owner retires the old audience.
  if (!f.transfer?.oldAudienceRetiredAt && !(f.suppressionSyncAt && age(f.now, f.suppressionSyncAt) >= -60_000 && age(f.now, f.suppressionSyncAt) <= DAY))
    out.push("newsletter_suppression_stale");
  // F-5: the approved set is what the digest says; removals shrink N, any addition refuses.
  if (!f.currentRecipients) out.push("newsletter_recipients_unknown");
  else {
    const approved = new Set(r.approvedRecipients);
    if (recipientsDigest(r.approvedRecipients) !== r.recipientsSha || f.currentRecipients.some((id) => !approved.has(id))) out.push("newsletter_recipients_changed");
  }
  if (f.releasesThisMonth >= f.releasesPerMonth) out.push("newsletter_release_cap");
  return out;
}

/** The authoritative audience, read by the runtime (slice 3: the EXNA team's one key). Slice 1: a fixture port; null = unknown. */
export type RecipientsPort = () => string[] | null;
/** A provider call's fixed outcome: `sent` = the request may have taken effect (hold and reconcile by reads); false = it
 *  definitely did not (a refusal). Never the provider's text. */
export class ProviderError extends Error { constructor(readonly label: string, readonly sent: boolean) { super(label); this.name = "ProviderError"; } }
/** The provider operations slices 2-3 implement (create draft with the operationId in its name, read back, send by id,
 *  list, recipient count). Slice 1 has the interface only; no implementation calls a provider. */
export type ProviderPort = {
  createDraft(o: { name: string; subject: string; html: string; text: string; from: string; replyTo: string; listId: string }): Promise<{ id: string }>;
  getBroadcast(id: string): Promise<{ id: string; name: string; status: "draft" | "queued" | "sent"; subject: string; htmlSha256: string; listId?: string } | null>;
  send(id: string): Promise<{ accepted: boolean }>;
  listBroadcasts(): Promise<{ complete: boolean; items: { id: string; name: string }[] }>;
  // S3-a: no recipient count exists on a Resend broadcast; the post-send fence re-reads the audience instead (answer 1).
};
export type TotpHookContext = { action: string; memberId: string; body: unknown; artifactDigest: string | null; operationId: string };

export class NewsletterReleases {
  constructor(private readonly a: SqliteAuthority, private readonly o: { orgId: string; installationId: string; approvers: string[]; releasesPerMonth: number;
    recipients: RecipientsPort;
    /** S2-a: the org runtime's own test sender (the agent@ key copy; B2: never the hub) and its caps; null = not configured. */
    test?: { send(m: ResendMessage): Promise<{ id: string }>; perMemberPerDay: number; perOrgPerDay: number; path: "preview" | "release" } | null;
    /** S2-a: the release sender facts frozen into every package (null = not configured). */
    sender?: { from: string; replyTo: string; listId: string } | null;
    /** Package E (Fable E-2): the fetch for the image preflight (production: the global fetch; tests: a fake). Only ever
     *  called with a URL that passed the E-1 allowlist. Absent = any newsletter with images refuses (unserved). */
    imageFetch?: PreflightFetch | null;
    /** Package E N1 (Fable E-5): org.json newsletter.testAlsoTo, <= 3 member ids; resolved to active admins at send time. */
    testAlsoTo?: readonly string[] },
    private readonly now: () => string = () => new Date().toISOString()) {
    const states = RELEASE_STATES.map((s) => `'${s}'`).join(",");
    a.db.exec(`CREATE TABLE IF NOT EXISTS newsletter_releases(id TEXT PRIMARY KEY, slug TEXT NOT NULL, digest TEXT NOT NULL UNIQUE, package TEXT NOT NULL,
        recipients TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN (${states})), operation_id TEXT UNIQUE, created_at TEXT NOT NULL, approved_at TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS newsletter_effects(release_id TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL UNIQUE, approved_by TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (${states})), at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS newsletter_tests(id TEXT PRIMARY KEY, digest TEXT NOT NULL, to_email TEXT NOT NULL, received_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS newsletter_preflights(digest TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok IN (0,1)), images TEXT NOT NULL, at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS newsletter_history(digest TEXT PRIMARY KEY, slug TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('provider','historical'))) STRICT;
      CREATE TABLE IF NOT EXISTS newsletter_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS newsletter_ops_audit(at TEXT NOT NULL, event TEXT NOT NULL, record_sha256 TEXT NOT NULL, installation_id TEXT NOT NULL) STRICT;`);
    // S2-b: what the executor learns (additive, nullable columns on a table slice 1 created).
    const cols = (a.db.prepare("PRAGMA table_info(newsletter_effects)").all() as { name: string }[]).map((c) => c.name);
    for (const [c, t] of [["broadcast_id", "TEXT"], ["label", "TEXT"], ["recipient_count", "INTEGER"], ["updated_at", "TEXT"], ["post_send_recipients_sha", "TEXT"], ["incident_mail", "TEXT"]] as const)
      if (!cols.includes(c)) a.db.exec(`ALTER TABLE newsletter_effects ADD COLUMN ${c} ${t}`);
    // S2-a: what a test send records (additive, nullable columns on a slice-1 table); `digest` holds the CONTENT digest.
    const tcols = (a.db.prepare("PRAGMA table_info(newsletter_tests)").all() as { name: string }[]).map((c) => c.name);
    for (const c of ["path", "state", "member_id", "provider_id", "label"]) if (!tcols.includes(c)) a.db.exec(`ALTER TABLE newsletter_tests ADD COLUMN ${c} TEXT`);
    // Fable S2-a N-1: a test still "sending" at start was interrupted mid-POST: it may have left, so it is unknown (and counts).
    a.write(() => a.db.prepare("UPDATE newsletter_tests SET state='unknown', label='newsletter_test_unknown' WHERE state='sending'").run());
  }
  private meta(k: string) { return (this.a.db.prepare("SELECT value FROM newsletter_meta WHERE key=?").get(k) as { value: string } | undefined)?.value ?? null; }
  private setMeta(k: string, v: string) { this.a.db.prepare("INSERT INTO newsletter_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v); }

  /** Freeze a release package with the recipient snapshot (digest + N). Slice 2 calls this from the reviewed chat draft. */
  prepare(input: unknown) {
    const p = releaseInputSchema.safeParse(input);
    if (!p.success) throw new AccessError("newsletter_package_invalid");
    // S2-a: without an audience (production until slice 3) the release is content-only: N = 0, recipientsKnown false; minting
    // still refuses newsletter_recipients_unknown, and once an audience exists any member of it is an addition (re-prepare).
    const ids = this.o.recipients();
    const approved = [...new Set(ids ?? [])].sort(), pkg: ReleasePackage = { ...p.data, recipientsSha: recipientsDigest(approved), recipientCount: approved.length, recipientsKnown: !!ids };
    const digest = releaseDigest(pkg), content = contentDigest(pkg), id = "nr_" + randomUUID().replaceAll("-", "");
    return this.a.write(() => {
      const prior = this.a.db.prepare("SELECT id FROM newsletter_releases WHERE digest=?").get(digest) as { id: string } | undefined;
      if (prior) return { releaseId: prior.id, digest, contentDigest: content, recipientCount: pkg.recipientCount, recipientsKnown: !!ids };
      this.a.db.prepare("INSERT INTO newsletter_releases(id,slug,digest,package,recipients,state,operation_id,created_at,approved_at) VALUES (?,?,?,?,?,'prepared',NULL,?,NULL)")
        .run(id, pkg.slug, digest, canonical(pkg), JSON.stringify(approved), this.now());
      return { releaseId: id, digest, contentDigest: content, recipientCount: pkg.recipientCount, recipientsKnown: !!ids };
    });
  }
  /** R-4: a release from a reviewed chat newsletter version: its sanitized preview HTML and the text from the same typed
   *  content, the configured sender, a dated slug (release date + the title through the title sanitizer), the provider's
   *  unsubscribe placeholder appended literally (R-3). Re-preparing identical content returns the same release. */
  async prepareDraft(d: { title: string; html: string; text: string; renderer?: string; links?: { text: string; url: string; live: boolean; href?: string; host?: string; source?: string; reason?: string }[] }) {
    if (!this.o.sender) throw new AccessError("newsletter_sender_not_configured");
    const words = chatTitle(d.title, 60).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "newsletter";
    const footerHtml = `<p>Unsubscribe: ${UNSUB_TOKEN}</p>`;
    // v3 carries its own footer with the unsubscribe anchor; older HTML gets the plain footer line as before.
    const html = d.html.includes(UNSUB_ANCHOR) ? d.html : /<\/body>/i.test(d.html) ? d.html.replace(/<\/body>/i, footerHtml + "</body>") : d.html + footerHtml;
    // Fable F-1 / E-6': a v3 rendering carries exactly one triple-brace unsubscribe placeholder, as the footer anchor's href.
    if ((d.renderer ?? RENDERER_V3).startsWith(RENDERER_V3) && !unsubscribeFormOk(html)) throw new AccessError("newsletter_unsubscribe_invalid");
    const subject = chatTitle(d.title, 200) || "Newsletter";
    // Package E (Fable E-2): every image the HTML references, live on CP's site, its bytes bound into the package (and digest).
    const urls = referencedImages(html);
    if (urls.length && !this.o.imageFetch) throw new AccessError("newsletter_images_unserved");
    let images: { url: string; sha256: string }[] = [];
    try { images = urls.length ? await hashImages(this.o.imageFetch!, urls) : []; }
    catch (e) { throw new AccessError(e instanceof ImagePreflightError ? e.label : "newsletter_images_unserved"); }
    return this.prepare({ slug: `${this.now().slice(0, 10)}-${words}`, subject, testSubject: `[TEST] ${subject}`, from: this.o.sender.from, replyTo: this.o.sender.replyTo,
      html, text: d.text.trimEnd() + `\n\nUnsubscribe: ${UNSUB_TOKEN}\n`, renderer: d.renderer ?? RENDERER_V3, images, listId: this.o.sender.listId, ...(d.links ? { links: d.links as never } : {}) });
  }
  /** S2-a, R-1/R-2: "Send me a test". To the member's OWN verified email (server-held; nothing in the body names an address),
   *  admins/reviewers only, `[TEST] ` + the frozen subject, five-minute cooldown, per-member and per-org caps per 24 h (rows,
   *  so they survive a restart), Idempotency-Key = the test id. A provably-not-sent refusal keeps the allowance; an unknown
   *  outcome counts. The preview path replaces the unsubscribe placeholder with an inert sentence (R-3). */
  async sendTest(memberId: string, body: { releaseId?: unknown }) {
    const t = this.o.test;
    if (!t) throw new AccessError("newsletter_test_not_configured");
    const id = "nt_" + randomUUID().replaceAll("-", ""), now = this.now();
    // Package E (Fable E-2): re-run the preflight and COMPARE with the prepared bytes before anything is written or sent.
    const pre = typeof body?.releaseId === "string" ? this.a.read(() => this.a.db.prepare("SELECT package FROM newsletter_releases WHERE id=?").get(body.releaseId as string)) as { package: string } | undefined : undefined;
    const preImages = pre ? (JSON.parse(pre.package) as ReleasePackage).images : [];
    let checked: { url: string; ok: boolean; sha256?: string }[] = [];
    if (preImages.length) {
      if (!this.o.imageFetch) throw new AccessError("newsletter_images_unserved");
      const c = await recheckImages(this.o.imageFetch, preImages);
      if (!c.ok) {
        this.a.write(() => this.a.db.prepare("INSERT INTO newsletter_preflights(digest,ok,images,at) VALUES (?,0,?,?) ON CONFLICT(digest) DO UPDATE SET ok=0, images=excluded.images, at=excluded.at")
          .run(contentDigest(JSON.parse(pre!.package)), JSON.stringify(preImages.map((i) => ({ url: i.url, ok: i.url !== c.url }))), now));
        throw new AccessError(c.label);
      }
      checked = preImages.map((i) => ({ url: i.url, ok: true, sha256: i.sha256 }));
    }
    const row = this.a.write(() => {
      const m = this.a.db.prepare("SELECT email, role, status FROM access_members WHERE member_id=?").get(memberId) as { email: string; role: string; status: string } | undefined;
      if (!m || m.status !== "active" || !["admin", "reviewer"].includes(m.role)) throw new AccessError("access_role_not_permitted");
      const r = typeof body?.releaseId === "string" ? this.a.db.prepare("SELECT id, package FROM newsletter_releases WHERE id=?").get(body.releaseId) as { id: string; package: string } | undefined : undefined;
      if (!r) throw new AccessError("newsletter_release_unknown");
      const pkg = JSON.parse(r.package) as ReleasePackage;
      const since = new Date(Date.parse(now) - DAY).toISOString(), counted = "state IN ('sending','sent','unknown') AND received_at > ?";
      const last = this.a.db.prepare(`SELECT received_at FROM newsletter_tests WHERE member_id=? AND state IN ('sending','sent','unknown') ORDER BY received_at DESC LIMIT 1`).get(memberId) as { received_at: string } | undefined;
      if (last && Date.parse(now) - Date.parse(last.received_at) < TEST_LIMITS.cooldownMs) throw new AccessError("newsletter_test_cooldown");
      // Package E N1 (Fable E-5): the also-to members, resolved NOW: each must be an active admin with an email on file (an
      // account's email is its verified sign-in address); anyone else is skipped with a fixed label, the test still goes out.
      const own = m.email.toLowerCase(), also: string[] = [], skipped: string[] = [];
      for (const other of (this.o.testAlsoTo ?? []).filter((x) => x !== memberId)) {
        const o = this.a.db.prepare("SELECT email, role, status FROM access_members WHERE member_id=?").get(other) as { email: string; role: string; status: string } | undefined;
        const e = o?.email?.toLowerCase();
        if (o && o.status === "active" && o.role === "admin" && e && e !== own && !also.includes(e)) also.push(e); else skipped.push(other);
      }
      // Every recipient counts against both caps, checked for ALL of them before any send (never a partial fan-out).
      const n = 1 + also.length;
      if ((this.a.db.prepare(`SELECT COUNT(*) AS n FROM newsletter_tests WHERE member_id=? AND ${counted}`).get(memberId, since) as { n: number }).n + n > t.perMemberPerDay
        || (this.a.db.prepare(`SELECT COUNT(*) AS n FROM newsletter_tests WHERE ${counted}`).get(since) as { n: number }).n + n > t.perOrgPerDay) throw new AccessError("newsletter_test_cap");
      const content = contentDigest(pkg), ins = this.a.db.prepare("INSERT INTO newsletter_tests(id,digest,to_email,received_at,path,state,member_id,provider_id,label) VALUES (?,?,?,?,?,?,?,NULL,?)");
      ins.run(id, content, own, now, t.path, "sending", memberId, null);
      const extra = also.map((to) => { const xid = "nt_" + randomUUID().replaceAll("-", ""); ins.run(xid, content, to, now, t.path, "sending", memberId, null); return { id: xid, to }; });
      for (const _ of skipped) ins.run("nt_" + randomUUID().replaceAll("-", ""), content, "", now, t.path, "skipped", memberId, "newsletter_test_recipient_skipped");
      // Gate 2: the image preflight for this content, as just re-run above (Package E: every image live, bytes unchanged).
      if (pkg.images.length !== checked.length) throw new AccessError("newsletter_release_changed");
      this.a.db.prepare("INSERT INTO newsletter_preflights(digest,ok,images,at) VALUES (?,1,?,?) ON CONFLICT(digest) DO UPDATE SET ok=1, images=excluded.images, at=excluded.at").run(content, JSON.stringify(checked), now);
      return { to: own, pkg, content, extra, skipped: skipped.length };
    });
    // R-3 / S3-b: /emails never substitutes the broadcast unsubscribe placeholder, on either path, so every test carries the
    // inert sentence (the declared broadcast-only difference the card states).
    const swap = (s: string) => s.split(UNSUB_ANCHOR).join(PREVIEW_UNSUB).split(UNSUB_TOKEN).join(PREVIEW_UNSUB); // v3: the whole anchor
    // One /emails call per recipient, each with its own idempotency key (= its row id) and its own recorded outcome.
    const deliver = async (rid: string, to: string) => {
      let state = "sent", label: string | null = null, providerId: string | null = null;
      try { providerId = (await t.send({ to, subject: row.pkg.testSubject, html: swap(row.pkg.html), text: swap(row.pkg.text),
        ...(t.path === "release" ? { replyTo: row.pkg.replyTo } : {}), idempotencyKey: rid })).id; }
      catch (e) { label = e instanceof MailError ? e.label : "mail_transport_failed"; state = e instanceof MailError && !e.sent ? "refused" : "unknown"; }
      this.a.write(() => this.a.db.prepare("UPDATE newsletter_tests SET state=?, provider_id=?, label=? WHERE id=?").run(state, providerId, label, rid));
      return state;
    };
    const state = await deliver(id, row.to), alsoStates: string[] = [];
    for (const x of row.extra) alsoStates.push(await deliver(x.id, x.to));
    if (state === "refused") throw new AccessError("newsletter_test_refused");
    // Content-free about the others: counts only, never their addresses (the sender's own address is theirs to see).
    return { testId: id, state, path: t.path, to: row.to, contentDigest: row.content, sentAt: now,
      also: { sent: alsoStates.filter((x) => x === "sent").length, notSent: alsoStates.filter((x) => x !== "sent").length, skipped: row.skipped } };
  }
  // ---- fixture recorders (slice 2/3 replace them with the real test sender, preflight, history import and Ops routes) ----
  recordTest(t: { digest: string; to: string; receivedAt: string; path?: "preview" | "release"; state?: string }) {
    const id = "nt_" + randomUUID().replaceAll("-", "");
    this.a.write(() => this.a.db.prepare("INSERT INTO newsletter_tests(id,digest,to_email,received_at,path,state) VALUES (?,?,?,?,?,?)")
      .run(id, t.digest, t.to.toLowerCase(), t.receivedAt, t.path ?? "release", t.state ?? "sent"));
    return id;
  }
  recordPreflight(p: { digest: string; ok: boolean; images: { url: string; ok: boolean }[] }) {
    this.a.write(() => this.a.db.prepare("INSERT INTO newsletter_preflights(digest,ok,images,at) VALUES (?,?,?,?) ON CONFLICT(digest) DO UPDATE SET ok=excluded.ok, images=excluded.images, at=excluded.at")
      .run(p.digest, p.ok ? 1 : 0, JSON.stringify(p.images), this.now()));
  }
  importHistory(entries: { digest: string; slug: string; source: "provider" | "historical" }[], complete: boolean) {
    this.a.write(() => { for (const e of entries) this.a.db.prepare("INSERT OR IGNORE INTO newsletter_history(digest,slug,source) VALUES (?,?,?)").run(e.digest, e.slug, e.source);
      this.setMeta("historyComplete", complete ? "1" : "0"); });
  }
  recordSuppressionSync(at: string, evidenceSha: string) { this.a.write(() => { this.setMeta("suppressionSyncAt", at); this.setMeta("suppressionSyncSha", evidenceSha); }); }
  recordTransfer(t: { installationId: string; frozenAt: string; oldAudienceRetiredAt?: string | null; attestedBy: string }) {
    this.a.write(() => this.setMeta("transfer", JSON.stringify({ installationId: t.installationId, frozenAt: t.frozenAt, oldAudienceRetiredAt: t.oldAudienceRetiredAt ?? null, attestedBy: t.attestedBy })));
  }
  // ---- S3-c (Fable R-7): the cutover facts as Ops routes (owner-attested), replacing the fixture recorders in production ----
  /** Audited by the record's sha256 and this installation id only (never names or content). */
  private opsAudit(event: string, record: unknown) {
    this.a.db.prepare("INSERT INTO newsletter_ops_audit(at,event,record_sha256,installation_id) VALUES (?,?,?,?)")
      .run(this.now(), event, sha(canonical(record)), this.o.installationId);
  }
  /** An exact ISO instant (the shape toISOString writes), not in the future (60 s of clock skew). */
  private pastIso(v: unknown) { return typeof v === "string" && ISO.test(v) && new Date(v).toISOString() === v && Date.parse(v) <= Date.parse(this.now()) + 60_000; }
  /** Owner decision 1: the old broadcaster is frozen and THIS installation sends. A new record clears an earlier retirement
   *  (retirement is one-way; undoing it needs a new transfer record). */
  transferOps(b: any) {
    const keys = ["installationId", "packVersion", "policyVersion", "frozenAt", "attestedBy"];
    if (!b || typeof b !== "object" || Object.keys(b).sort().join() !== [...keys].sort().join() || !this.pastIso(b.frozenAt)
      || ![b.packVersion, b.policyVersion, b.attestedBy].every((v) => typeof v === "string" && /^[A-Za-z0-9._:/@+-]{1,100}$/.test(v))) throw new AccessError("newsletter_transfer_invalid");
    if (b.installationId !== this.o.installationId) throw new AccessError("newsletter_installation_not_authorized");
    const t = { installationId: b.installationId, packVersion: b.packVersion, policyVersion: b.policyVersion, frozenAt: b.frozenAt, oldAudienceRetiredAt: null, attestedBy: b.attestedBy };
    this.a.write(() => { this.setMeta("transfer", JSON.stringify(t)); this.opsAudit("transfer", t); });
    return { installationId: t.installationId, frozenAt: t.frozenAt };
  }
  /** F-6: the Mac-side suppression export, by its evidence hash only (no addresses). */
  suppressionSyncOps(b: any) {
    if (!b || typeof b !== "object" || Object.keys(b).sort().join() !== "at,evidenceSha256" || !this.pastIso(b.at) || typeof b.evidenceSha256 !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(b.evidenceSha256)) throw new AccessError("newsletter_suppression_invalid");
    this.a.write(() => this.syncRecorded("mac", b.at, b.evidenceSha256));
    return { at: b.at };
  }
  /** F6-S (Fable 83a20aeb + Addendum 1, a496290c): a COMPLETE server-side audience walk is the F-6 sync. The evidence lives in the
   *  DB only (no file): `at` = this clock at completion, its sha256 = the evidence document's (`doc` = f6EvidenceJson; passed in so
   *  this module does not import the connector), the counts beside it. */
  recordServerSuppressionSync(e: F6Evidence, doc: (at: string) => string) {
    const at = this.now(), evidenceSha256 = sha(doc(at));
    this.a.write(() => this.syncRecorded("server", at, evidenceSha256, { total: e.total, unsubscribed: e.unsubscribed, eligible: e.eligible }));
    return { at, evidenceSha256 };
  }
  /** newsletter_meta + the ops-audit row {at, evidenceSha256, total, unsubscribed, eligible, source} (counts only from a server walk;
   *  the Mac route has its own evidence file and records none). No address, no contact id. */
  private syncRecorded(source: "server" | "mac", at: string, evidenceSha256: string, counts?: { total: number; unsubscribed: number; eligible: number }) {
    this.setMeta("suppressionSyncAt", at); this.setMeta("suppressionSyncSha", evidenceSha256); this.setMeta("suppressionSyncSource", source);
    this.setMeta("suppressionSyncCounts", counts ? JSON.stringify(counts) : "");
    this.opsAudit("suppression_sync", { at, evidenceSha256, ...(counts ?? {}), source });
  }
  /** Lifts F-6, one-way: needs the transfer record; not before its freeze; a second call keeps the first instant. */
  oldAudienceRetiredOps(b: any) {
    if (!b || typeof b !== "object" || Object.keys(b).join() !== "at" || !this.pastIso(b.at)) throw new AccessError("newsletter_retire_invalid");
    return this.a.write(() => {
      const raw = this.meta("transfer"); if (!raw) throw new AccessError("newsletter_transfer_missing");
      const t = JSON.parse(raw);
      if (t.oldAudienceRetiredAt) return { at: t.oldAudienceRetiredAt as string, unchanged: true };
      if (Date.parse(b.at) < Date.parse(t.frozenAt)) throw new AccessError("newsletter_retire_invalid");
      this.setMeta("transfer", JSON.stringify({ ...t, oldAudienceRetiredAt: b.at })); this.opsAudit("old_audience_retired", { at: b.at, transfer: t });
      return { at: b.at as string, unchanged: false };
    });
  }
  /** S2-c (Fable R-9): the owner's offline history index, through the Ops socket only. Every entry validated (digest shape,
   *  dated slug, source enum), `complete` explicit; returns counts only. Replaces the fixture recorder in production. */
  importHistoryOps(b: { entries?: unknown; complete?: unknown }) {
    const entries = Array.isArray(b?.entries) ? b.entries : null;
    if (!entries || entries.length > 1000 || typeof b.complete !== "boolean") throw new AccessError("newsletter_history_import_invalid");
    const ok = entries.every((e: any) => e && typeof e === "object" && /^sha256:[a-f0-9]{64}$/.test(e.digest) && typeof e.slug === "string" && SLUG.test(e.slug)
      && ["provider", "historical"].includes(e.source) && Object.keys(e).length === 3);
    if (!ok) throw new AccessError("newsletter_history_import_invalid");
    const before = this.a.read(() => (this.a.db.prepare("SELECT COUNT(*) AS n FROM newsletter_history").get() as { n: number }).n);
    this.importHistory(entries as { digest: string; slug: string; source: "provider" | "historical" }[], b.complete);
    const after = this.a.read(() => (this.a.db.prepare("SELECT COUNT(*) AS n FROM newsletter_history").get() as { n: number }).n);
    return { received: entries.length, added: after - before, total: after, complete: b.complete };
  }
  /** S2-c (Fable R-8): the release card's facts, from runtime rows only; `test` is THIS member's latest test of this content. */
  card(memberId: string, body: { releaseId?: unknown }) {
    return this.a.read(() => {
      const r = typeof body?.releaseId === "string" ? this.a.db.prepare("SELECT id, digest, package, state, created_at FROM newsletter_releases WHERE id=?").get(body.releaseId) as
        { id: string; digest: string; package: string; state: string; created_at: string } | undefined : undefined;
      if (!r) throw new AccessError("newsletter_release_unknown");
      const pkg = JSON.parse(r.package) as ReleasePackage, content = contentDigest(pkg);
      const t = this.a.db.prepare("SELECT id, path, state, received_at FROM newsletter_tests WHERE member_id=? AND digest=? ORDER BY received_at DESC LIMIT 1").get(memberId, content) as
        { id: string; path: string; state: string; received_at: string } | undefined;
      return { releaseId: r.id, digest: r.digest, contentShort: content.slice(7, 19), state: r.state, subject: pkg.subject, from: pkg.from, slug: pkg.slug,
        recipientCount: pkg.recipientCount, recipientsKnown: pkg.recipientsKnown !== false, preparedAt: r.created_at, attestation: ATTESTATION,
        // F6S-2: when the unsubscribes were last read, and where (CP itself, or the Mac fallback).
        suppressionSync: this.meta("suppressionSyncAt") ? { at: this.meta("suppressionSyncAt"), source: this.meta("suppressionSyncSource") ?? "mac" } : null,
        test: t ? { testId: t.id, path: t.path, state: t.state, sentAt: t.received_at } : null, testConfigured: !!this.o.test, testPath: this.o.test?.path ?? null,
        // Fable E-12d/E-13c: the links the reviewer approves (in the content digest): live = text + host + source; inert = text + reason.
        // Director (24 Oct): the email shows an inert link as its text only; the card still shows the refused URL.
        links: (pkg.links ?? []).map((l) => l.live ? { text: l.text, host: l.host, source: l.source, live: true } : { text: l.text, url: l.url, live: false, reason: l.reason }) };
    });
  }
  /** Ops kill switch (runtime-local, like replyKill): checked by the mint guard and inside the approval transaction. */
  setKill(on: boolean) { this.a.write(() => this.setMeta("killed", on ? "1" : "0")); return { on }; }

  /** Gather the facts for one release and approver from the DB (no clock: the caller's `now`). Reads on the CURRENT handle,
   *  so it is valid inside a write transaction (R-2) and outside one. */
  private facts(releaseId: unknown, memberId: string, now: string, sel: { testId?: unknown; attested?: unknown } = {}): ReleaseFacts {
    const db = this.a.db;
    const r = typeof releaseId === "string" && /^nr_[a-f0-9]{32}$/.test(releaseId)
      ? db.prepare("SELECT * FROM newsletter_releases WHERE id=?").get(releaseId) as { slug: string; digest: string; state: string; package: string; recipients: string } | undefined : undefined;
    const m = db.prepare("SELECT email, role, status FROM access_members WHERE member_id=?").get(memberId) as { email: string; role: string; status: string } | undefined;
    const email = m?.email ?? "";
    const permitted = !!m && m.status === "active" && ["admin", "reviewer"].includes(m.role) && this.o.approvers.map((e) => e.toLowerCase()).includes(email.toLowerCase());
    const pkg = r ? JSON.parse(r.package) as ReleasePackage : null;
    const content = pkg ? contentDigest(pkg) : null;
    // R-5: the test named in the approval body; else the approver's latest; else the latest test of THIS content to anyone
    // (so a test sent to the wrong address reads as newsletter_test_wrong_recipient, not as missing).
    const cols = "SELECT digest, to_email AS \"to\", received_at AS receivedAt, COALESCE(path,'release') AS path, COALESCE(state,'sent') AS state FROM newsletter_tests";
    const lastTest = (typeof sel.testId === "string" ? db.prepare(`${cols} WHERE id=?`).get(sel.testId)
      : (email ? db.prepare(`${cols} WHERE to_email=? ORDER BY received_at DESC LIMIT 1`).get(email.toLowerCase()) : undefined)
        ?? (content ? db.prepare(`${cols} WHERE digest=? ORDER BY received_at DESC LIMIT 1`).get(content) : undefined)) as ReleaseFacts["lastTest"] | undefined;
    const pf = content ? db.prepare("SELECT ok, images FROM newsletter_preflights WHERE digest=?").get(content) as { ok: number; images: string } | undefined : undefined;
    const hist = db.prepare("SELECT digest, slug FROM newsletter_history").all() as { digest: string; slug: string }[];
    const sent = (db.prepare("SELECT r.package, r.slug FROM newsletter_effects e JOIN newsletter_releases r ON r.id=e.release_id").all() as { package: string; slug: string }[])
      .flatMap((x) => { try { return [{ digest: contentDigest(JSON.parse(x.package)), slug: x.slug }]; } catch { return []; } }); // an unreadable row adds nothing
    const transfer = this.meta("transfer");
    const month = now.slice(0, 7), unsettled = UNSETTLED_STATES.map((s) => `'${s}'`).join(",");
    return {
      now, installationId: this.o.installationId,
      release: r && pkg ? { slug: r.slug, digest: r.digest, contentDigest: content!, state: r.state, imageUrls: pkg.images.map((i) => i.url), images: pkg.images, recipientsSha: pkg.recipientsSha, approvedRecipients: JSON.parse(r.recipients) } : null,
      approver: { email, permitted }, lastTest: lastTest ?? null, attested: sel.attested === true,
      preflight: pf ? { ok: pf.ok === 1, images: JSON.parse(pf.images) } : null,
      history: { complete: this.meta("historyComplete") === "1", digests: [...hist, ...sent].map((h) => h.digest),
        slugs: Object.fromEntries([...hist, ...sent].map((h) => [h.slug, h.digest])) },
      transfer: transfer ? JSON.parse(transfer) : null, suppressionSyncAt: this.meta("suppressionSyncAt"),
      currentRecipients: this.o.recipients(),
      releasesThisMonth: (db.prepare("SELECT COUNT(*) AS n FROM newsletter_effects WHERE substr(at,1,7)=?").get(month) as { n: number }).n,
      releasesPerMonth: this.o.releasesPerMonth, killed: this.meta("killed") === "1",
      // A projection the DB cannot explain (restore behind the JSON) blocks every release too (F-7).
      unsettled: (db.prepare(`SELECT COUNT(*) AS n FROM newsletter_effects WHERE state IN (${unsettled})`).get() as { n: number }).n + (this.meta("restoreReconcile") === "1" ? 1 : 0),
    };
  }
  private gate(ctx: TotpHookContext) {
    const b = (ctx.body ?? {}) as { releaseId?: unknown; testId?: unknown; attested?: unknown };
    const releaseId = b.releaseId, f = this.facts(releaseId, ctx.memberId, this.now(), { testId: b.testId, attested: b.attested });
    const failed = evaluateRelease(f);
    if (failed.length) throw new AccessError(failed[0]);
    if (ctx.artifactDigest !== f.release!.digest) throw new AccessError("newsletter_release_changed"); // the challenge binds this exact digest
    return { releaseId: releaseId as string, digest: f.release!.digest };
  }
  /** F-4 + every gate before a challenge is minted (runs inside the mint transaction, on the same handle). */
  mintGuard(ctx: TotpHookContext) { if (ctx.action === "newsletter.send") this.gate(ctx); }
  /** R-2: LAST step of the TOTP verification transaction: same handle, never a.write/a.read; re-checks the gates (facts may
   *  have changed since mint) and writes the release `approved` + its unique effect row. Throwing rolls everything back. */
  approveInTxn(ctx: TotpHookContext) {
    if (ctx.action !== "newsletter.send") return;
    if (this.a.db.isTransaction !== true) throw new AccessError("newsletter_release_state");
    const g = this.gate(ctx), now = this.now();
    if (this.a.db.prepare("UPDATE newsletter_releases SET state='approved', operation_id=?, approved_at=? WHERE id=? AND state='prepared'").run(ctx.operationId, now, g.releaseId).changes !== 1)
      throw new AccessError("newsletter_release_state");
    this.a.db.prepare("INSERT INTO newsletter_effects(release_id,operation_id,approved_by,state,at) VALUES (?,?,?,'approved',?)").run(g.releaseId, ctx.operationId, ctx.memberId, now);
  }
  /** S2-b, F-7 step 6: what must still hold immediately before the send of an APPROVED release (not the approval-time
   *  gates: an aged test does not undo an approval). Kill switch, the recipient fence (any addition), other unsettled
   *  releases and the installation pin. Reads on the current handle. */
  preSendFailures(releaseId: string) {
    const f = this.facts(releaseId, "", this.now()), r = f.release, out: string[] = [];
    if (!r) return ["newsletter_release_unknown"];
    if (f.killed) out.push("newsletter_killed");
    const others = (this.a.db.prepare(`SELECT COUNT(*) AS n FROM newsletter_effects WHERE release_id<>? AND state IN (${UNSETTLED_STATES.map((s) => `'${s}'`).join(",")})`).get(releaseId) as { n: number }).n;
    if (others > 0 || this.meta("restoreReconcile") === "1") out.push("newsletter_uncertain_release");
    if (!f.transfer || f.transfer.installationId !== f.installationId) out.push("newsletter_installation_not_authorized");
    if (!f.currentRecipients) out.push("newsletter_recipients_unknown");
    else if (recipientsDigest(r.approvedRecipients) !== r.recipientsSha || f.currentRecipients.some((id) => !r.approvedRecipients.includes(id))) out.push("newsletter_recipients_changed");
    return out;
  }
  /** Fable S2-b F-2: the release-wide facts that must hold before ANY mutation (projection or provider): kill switch, other
   *  unsettled releases, an unexplained projection, the installation pin. (The recipient fence is a send-time check.) */
  preMutationFailures(releaseId: string) {
    const f = this.facts(releaseId, "", this.now()), out: string[] = [];
    if (!f.release) return ["newsletter_release_unknown"];
    if (f.killed) out.push("newsletter_killed");
    if (this.meta("restoreReconcile") === "1") out.push("newsletter_restore_reconcile");
    const others = (this.a.db.prepare(`SELECT COUNT(*) AS n FROM newsletter_effects WHERE release_id<>? AND state IN (${UNSETTLED_STATES.map((s) => `'${s}'`).join(",")})`).get(releaseId) as { n: number }).n;
    if (others > 0) out.push("newsletter_uncertain_release");
    if (!f.transfer || f.transfer.installationId !== f.installationId) out.push("newsletter_installation_not_authorized");
    return out;
  }
  restoreReconcile() { return this.meta("restoreReconcile") === "1"; }
  /** The frozen package of a release (the executor's create input and read-back reference). */
  packageOf(releaseId: string) {
    const r = this.a.db.prepare("SELECT package FROM newsletter_releases WHERE id=?").get(releaseId) as { package: string } | undefined;
    if (!r) throw new AccessError("newsletter_release_unknown");
    return JSON.parse(r.package) as ReleasePackage;
  }
  /** Ops/recovery: mark that a projection row exists the DB cannot back (cleared only by Ops after reconciling). */
  setRestoreReconcile(on: boolean) { this.setMeta("restoreReconcile", on ? "1" : "0"); }
  view(releaseId: unknown) {
    return this.a.read(() => {
      const r = typeof releaseId === "string" ? this.a.db.prepare("SELECT id, slug, digest, state, approved_at FROM newsletter_releases WHERE id=?").get(releaseId) as Record<string, unknown> | undefined : undefined;
      if (!r) throw new AccessError("newsletter_release_unknown");
      return { releaseId: r.id, slug: r.slug, digest: r.digest, state: r.state, approvedAt: r.approved_at };
    });
  }
  status() {
    return this.a.read(() => ({
      killed: this.meta("killed") === "1",
      releases: Object.fromEntries((this.a.db.prepare("SELECT state, COUNT(*) AS n FROM newsletter_releases GROUP BY state").all() as { state: string; n: number }[]).map((r) => [r.state, r.n])),
      unsettled: (this.a.db.prepare(`SELECT COUNT(*) AS n FROM newsletter_effects WHERE state IN (${UNSETTLED_STATES.map((s) => `'${s}'`).join(",")})`).get() as { n: number }).n,
      suppressionSyncAt: this.meta("suppressionSyncAt"),
      // F6-S Addendum 1 (A4): the read-back line: when, the evidence sha, the counts (server walks only) and the source.
      suppressionSync: this.meta("suppressionSyncAt") ? { at: this.meta("suppressionSyncAt"), sha: this.meta("suppressionSyncSha"),
        ...(this.meta("suppressionSyncCounts") ? JSON.parse(this.meta("suppressionSyncCounts")!) : {}), source: this.meta("suppressionSyncSource") ?? "mac" } : null,
      historyComplete: this.meta("historyComplete") === "1", transferRecorded: !!this.meta("transfer"),
      restoreReconcile: this.meta("restoreReconcile") === "1",
      // N-1: what stands in for admin receipts until slice 3: every unsettled release with its label and broadcast id.
      unsettledRows: this.a.db.prepare(`SELECT release_id AS releaseId, state, label, broadcast_id AS broadcastId, incident_mail AS incidentMail FROM newsletter_effects
        WHERE state IN (${UNSETTLED_STATES.map((s) => `'${s}'`).join(",")}) ORDER BY at`).all(),
    }));
  }
}
