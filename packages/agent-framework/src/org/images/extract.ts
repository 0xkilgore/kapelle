// IMAGES-V1 I2 (design of record §2): "Read this flyer". The member chooses to send ONE of their own sanitized chat images
// to the pinned hosted image profile (the UI says so before they confirm); never on upload. One request, its own ledger entry
// on the org's ONE hosted ledger (reserve -> sent -> settled / released / unsettled, key image:<proposalId>; the chat
// scheduler's rules), no tools, no retries. The answer is a bounded PROPOSAL (flyer.ts) the runtime re-rules (no inferred
// year/address); every field is "From the flyer — check this" until the member saves their checked values. Contributors may
// extract; using the result on the website is a reviewer's separate, approved Website request (I3). Flyer text is data.
import { randomBytes } from "node:crypto";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import type { SqliteSpendLedger } from "../../service/sqlite-effects.js";
import { AccessError } from "../../access/org-access.js";
import { readSecretFile } from "../../agent-kit/hosted/adapter.js";
import { HostedTransportError, HOSTED_UNSETTLED, HOSTED_REFUSED_BEFORE_INFERENCE, hostedBaseLabel, type HostedFetch } from "../../agent-kit/hosted/transport.js";
import { imageExtractComplete, imageProfileHash, imageReservationUsd, imageProfileSchema, type ImageProfile } from "../../agent-kit/interactive/image.js";
import { FLYER_FIELDS, FLYER_SYSTEM, FLYER_USER_TEXT, applyFlyerRules, parseFlyerAnswer } from "../../agent-kit/interactive/flyer.js";
import type { ImageMember, ImageStore } from "./store.js";

export const EXTRACT_CAPS = { perMemberPerDay: 10, perOrgPerDay: 40 };
const LIMITS: Record<string, number> = { title: 200, date: 120, time: 80, location: 200, address: 300, description: 1000 };
const SCHEMA = `CREATE TABLE IF NOT EXISTS image_proposals(id TEXT PRIMARY KEY, image_id TEXT NOT NULL, conversation_id TEXT NOT NULL, member_id TEXT NOT NULL,
  at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','proposed','failed','unsettled')), label TEXT, profile_id TEXT NOT NULL, profile_hash TEXT NOT NULL,
  image_sha256 TEXT NOT NULL, ledger_key TEXT NOT NULL, cost_usd REAL, prompt_tokens INTEGER, image_tokens INTEGER, proposed TEXT, checked TEXT, checked_at TEXT) STRICT;
CREATE INDEX IF NOT EXISTS image_proposals_conv ON image_proposals(conversation_id);`;

export class FlyerExtractor {
  private readonly now: () => string;
  private readonly profile: ImageProfile;
  constructor(private readonly a: SqliteAuthority, private readonly o: { images: ImageStore; profile: ImageProfile; ledger: SqliteSpendLedger; secretFile: string;
    fetch?: HostedFetch; allowUnqualified?: boolean }, now?: () => string) {
    this.now = now ?? (() => new Date().toISOString());
    this.profile = imageProfileSchema.parse(o.profile);
    a.db.exec(SCHEMA);
    // A run cut by a restart: its outcome is unknown (the ledger entry stays unsettled; never resent).
    a.write(() => a.db.prepare("UPDATE image_proposals SET state='unsettled', label='image_extract_interrupted' WHERE state='running'").run());
  }
  get qualified() { return !/^pending:/.test(this.profile.qualificationRef) || !!this.o.allowUnqualified; }
  /** Routine `image.extract`: send one of the member's own chat images to the pinned image profile and keep the proposal. */
  async extract(m: ImageMember, body: any) {
    if (!this.qualified) throw new AccessError("image_profile_not_qualified");
    const imageId = typeof body?.imageId === "string" ? body.imageId : "";
    const { data, sha256 } = this.o.images.read(m, { imageId }); // owner-only, hash re-checked
    const conv = (this.a.read(() => this.a.db.prepare("SELECT conversation_id FROM chat_images WHERE id=?").get(imageId)) as { conversation_id: string }).conversation_id;
    const id = "ip_" + randomBytes(16).toString("hex"), key = `image:${id}`, at = this.now(), dayAgo = new Date(Date.parse(at) - 86_400_000).toISOString();
    this.a.write(() => {
      if ((this.a.db.prepare("SELECT COUNT(*) AS n FROM image_proposals WHERE member_id=? AND state='running'").get(m.memberId) as { n: number }).n) throw new AccessError("image_extract_busy");
      if ((this.a.db.prepare("SELECT COUNT(*) AS n FROM image_proposals WHERE member_id=? AND at>?").get(m.memberId, dayAgo) as { n: number }).n >= EXTRACT_CAPS.perMemberPerDay)
        throw new AccessError("image_extract_cap");
      if ((this.a.db.prepare("SELECT COUNT(*) AS n FROM image_proposals WHERE at>?").get(dayAgo) as { n: number }).n >= EXTRACT_CAPS.perOrgPerDay) throw new AccessError("image_extract_org_cap");
      this.a.db.prepare(`INSERT INTO image_proposals(id,image_id,conversation_id,member_id,at,state,label,profile_id,profile_hash,image_sha256,ledger_key)
        VALUES (?,?,?,?,?,'running',NULL,?,?,?,?)`).run(id, imageId, conv, m.memberId, at, this.profile.id, imageProfileHash(this.profile), sha256, key);
    });
    const finish = (state: string, label: string | null, extra: Record<string, unknown> = {}) => {
      this.a.write(() => this.a.db.prepare(`UPDATE image_proposals SET state=?, label=?, cost_usd=COALESCE(?, cost_usd), prompt_tokens=COALESCE(?, prompt_tokens),
        image_tokens=COALESCE(?, image_tokens), proposed=COALESCE(?, proposed) WHERE id=?`)
        .run(state, label, (extra.cost as number) ?? null, (extra.prompt as number) ?? null, (extra.imageTokens as number) ?? null, (extra.proposed as string) ?? null, id));
      return this.view(id)!;
    };
    const approxBytes = Math.ceil(data.length * 4 / 3) + Buffer.byteLength(FLYER_SYSTEM) + 512;
    try { this.o.ledger.reserve(key, this.profile.id, imageReservationUsd(this.profile, approxBytes), this.profile.limits.usdPerExtraction); }
    catch (e) { return finish("failed", e instanceof Error && e.message === "hosted_monthly_cap_exceeded" ? "image_extract_org_cap" : "image_extract_cap"); }
    let apiKey: string;
    try { apiKey = readSecretFile(this.o.secretFile); } catch { this.o.ledger.release(key, "hosted_key_missing"); return finish("failed", "hosted_key_missing"); }
    this.o.ledger.markSent(key);
    let r;
    try {
      r = await imageExtractComplete({ profile: this.profile, apiKey, system: FLYER_SYSTEM, text: FLYER_USER_TEXT, jpeg: data },
        { fetch: this.o.fetch ?? ((u, i) => fetch(u, i)), signal: AbortSignal.timeout(this.profile.limits.timeoutMs + 5_000), deadlineMs: this.profile.limits.timeoutMs });
    } catch (e) {
      const reason = e instanceof HostedTransportError ? e.reason : "hosted_transport_failed", sent = !(e instanceof HostedTransportError) || e.sent;
      if (!sent) { this.o.ledger.release(key, reason); return finish("failed", reason); }
      if (HOSTED_UNSETTLED.has(reason)) { this.o.ledger.markUnsettled(key, reason); return finish("unsettled", reason); }
      const cost = e instanceof HostedTransportError ? e.costUsd : null;
      if (HOSTED_REFUSED_BEFORE_INFERENCE.has(hostedBaseLabel(reason))) this.o.ledger.release(key, reason);
      else if (cost !== null) this.o.ledger.settle(key, cost, reason);
      else { this.o.ledger.markUnsettled(key, reason); return finish("unsettled", reason); }
      return finish("failed", reason, { cost });
    }
    this.o.ledger.settle(key, r.costUsd);
    const answer = parseFlyerAnswer(r.text);
    if (!answer) return finish("failed", "image_extract_unreadable", { cost: r.costUsd, prompt: r.usage.promptTokens, imageTokens: r.usage.imageTokens });
    return finish("proposed", null, { cost: r.costUsd, prompt: r.usage.promptTokens, imageTokens: r.usage.imageTokens, proposed: JSON.stringify(applyFlyerRules(answer)) });
  }
  /** Routine `image.proposal.save`: the member's CHECKED values (each field a bounded string or empty). The proposal stays. */
  save(m: ImageMember, body: any) {
    const p = typeof body?.proposalId === "string" ? this.a.read(() => this.a.db.prepare("SELECT * FROM image_proposals WHERE id=? AND member_id=?").get(body.proposalId, m.memberId)) as
      { state: string } | undefined : undefined;
    if (!p || p.state !== "proposed") throw new AccessError("image_proposal_unknown");
    const f = body?.fields, checked: Record<string, string | null> = {};
    if (!f || typeof f !== "object" || Object.keys(f).some((k) => !(FLYER_FIELDS as readonly string[]).includes(k))) throw new AccessError("image_proposal_invalid");
    for (const k of FLYER_FIELDS) {
      const v = f[k] === undefined || f[k] === null ? "" : f[k];
      if (typeof v !== "string" || v.length > LIMITS[k] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) || (k !== "description" && /[\r\n]/.test(v))) throw new AccessError("image_proposal_invalid");
      if (k === "date" && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new AccessError("image_proposal_invalid");
      checked[k] = v.trim() || null;
    }
    this.a.write(() => this.a.db.prepare("UPDATE image_proposals SET checked=?, checked_at=? WHERE id=?").run(JSON.stringify(checked), this.now(), body.proposalId));
    return this.view(body.proposalId)!;
  }
  /** IMAGES-V1 I3: "Use for a website event": the member's OWN proposal, CHECKED, its image still theirs and unchanged (same
   *  conversation, same hash as when it was read). Never a contributor's or another conversation's image. */
  source(m: ImageMember, proposalId: unknown) {
    const p = typeof proposalId === "string" && /^ip_[a-f0-9]{32}$/.test(proposalId) ? this.a.read(() => this.a.db.prepare(`SELECT p.id, p.image_id, p.image_sha256 FROM image_proposals p
      JOIN chat_images i ON i.id=p.image_id AND i.conversation_id=p.conversation_id WHERE p.id=? AND p.member_id=? AND p.state='proposed' AND p.checked IS NOT NULL`)
      .get(proposalId, m.memberId)) as { id: string; image_id: string; image_sha256: string } | undefined : undefined;
    if (!p) throw new AccessError("image_proposal_not_checked");
    const { data, sha256 } = this.o.images.read(m, { imageId: p.image_id }); // owner-only, hash re-checked
    if (sha256 !== p.image_sha256) throw new AccessError("image_unknown");
    return { proposalId: p.id, imageId: p.image_id, data, sha256 };
  }
  view(id: string) {
    const r = this.a.read(() => this.a.db.prepare("SELECT * FROM image_proposals WHERE id=?").get(id)) as Record<string, any> | undefined;
    return r ? { proposalId: r.id, imageId: r.image_id, conversationId: r.conversation_id, state: r.state, label: r.label, at: r.at, imageSha256: r.image_sha256,
      profileId: r.profile_id, costUsd: r.cost_usd, proposed: r.proposed ? JSON.parse(r.proposed) : null, checked: r.checked ? JSON.parse(r.checked) : null, checkedAt: r.checked_at } : null;
  }
  /** A conversation's proposals, for its starter (images of tombstoned chats are gone; their proposals are not listed). */
  list(memberId: string, conversationId: string) {
    return (this.a.read(() => this.a.db.prepare(`SELECT p.id FROM image_proposals p JOIN chat_images i ON i.id=p.image_id WHERE p.conversation_id=? AND p.member_id=?
      AND i.deleted_at IS NULL ORDER BY p.at, p.id`).all(conversationId, memberId)) as { id: string }[]).map((r) => this.view(r.id)!);
  }
}
