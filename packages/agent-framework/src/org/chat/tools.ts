// Chat agent C-4 (PLAN-SLICE-1 §4, Fable R-3 / R-4 / §12(b)(d)(e), E-5): the slice-1 tools, executed by the RUNTIME under
// its own authority. The model only names a tool and passes arguments; every argument is validated here (Zod mirrors of
// the catalog's JSON Schemas) and every refusal is a fixed label the scheduler counts (3 strikes end the turn).
// - A turn reads ONE snapshot, taken at turn start over the conversation's stored scope roots (never widened by the model):
//     member scope:   members/ (approved notes, shared files, members/shared uploads), plus THIS conversation's own uploads
//                     members/uploads/<member>/<conversationId>/ (Fable §12(e)); other uploads are never in it;
//     reviewer scope: the above + reviewers-private/intake and reviewers-private/transcripts.
//   Text files only (.md .txt .csv), regular files, no hidden names, bounded; paths are org-folder relative.
// - read_org_file / search_org_history return cited line windows (path#Lx-Ly + the file's sha256), bounded.
// - write_draft_artifact / render_newsletter_preview need an open draft envelope (C-5); outside one they refuse
//   (chat_tool_needs_draft_plan). Versions are immutable (wx) under stateRoot/chat/artifacts (never the org folder, so never
//   a canonical source or snapshot input); each records envelope, turn, snapshot hash, renderer version and sha256 (E-5),
//   and every sources[] entry must resolve in the turn's snapshot or the call fails (chat_tool_sources_invalid).
// - The newsletter renderer is a fixed template over the typed content: every text node escaped, a fixed tag allowlist
//   (h1 h2 p ul li strong em), no scripts, no attributes from content, no remote resources, links shown as inert text.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { digest } from "../../content.js";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import { AccessError } from "../../access/org-access.js";
import type { ChatScope } from "./conversations.js";
import { CHAT_RULES_HASH, type ToolHost } from "./scheduler.js";
import { systemMap, type ContextHandbook, type MapFeatures } from "../handbook/context.js";
import { inWebsiteRoot } from "../website/content-root.js";
import { RENDERER_V3, renderNewsletterV3Full, imageUrl, type LinkDecision, type Provenance } from "../newsletter/render-cp.js";
import { applyDraftEdits, draftListFields, entryTitles, missingMemberLinks, type DraftEdit } from "./draft-edits.js";
import { SITE_IMAGES_FILE } from "../website/content-root.js";
import { DRIVE_LIST_FILE } from "../library/drive.js";

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
export const SNAPSHOT_LIMITS = { maxFiles: 1000, maxFileBytes: 256 * 1024, maxBytes: 16 * 1024 * 1024, readBytes: 32 * 1024 - 1024, searchBytes: 16 * 1024, searchHits: 8 };
// v3 (Package E T1 + addendum 2): the CP site template in the site's current theme (src/org/newsletter/render-cp.ts); inline
// [text](url) links to any https host with provenance (Fable E-12/E-13), per-issue header photos (E-14).
// Package F (delta A-1, A-3; Fable): section images and numbered lists change the HTML, so the version string moves (prepared
// versions re-render once, by design); the v3 prefix stays (F-1's unsubscribe check applies to every v3 rendering).
// Package A2: a links[] entry already live in its section's body is shown once (the HTML changes, so the version moves).
// NL-2: a link's text and its href may differ by one leading "www." (that link turns live: the HTML changes, the version moves).
export const RENDERER_VERSION = `${RENDERER_V3};images=2;ol=1;links=3`;
const TEXT = /\.(md|txt|csv)$/i;

export type SnapshotFile = { path: string; sha256: string; bytes: number; lines: string[] };
export type Snapshot = { hash: string; roots: string[]; files: Map<string, SnapshotFile> };

/** The roots a conversation's snapshot covers (org-folder relative). Fixed by the stored scope; never model input. */
export function snapshotRoots(scope: ChatScope, memberId: string, conversationId: string) {
  const own = `members/uploads/${memberId}/${conversationId}`;
  return { roots: ["members", ...(scope === "reviewer" ? ["reviewers-private/intake", "reviewers-private/transcripts"] : [])], ownUploads: own };
}
/** Take the snapshot (bounded). Throws chat_snapshot_too_large past the bounds (never a partial view). */
export function takeSnapshot(folder: string, scope: ChatScope, memberId: string, conversationId: string): Snapshot {
  const { roots, ownUploads } = snapshotRoots(scope, memberId, conversationId), files = new Map<string, SnapshotFile>();
  let total = 0, entries = 0;
  // WC-1 (Fable R-4): a path that vanishes mid-walk (the website set's swap) is simply not in the snapshot; never a throw.
  const gone = <T>(f: () => T): T | null => { try { return f(); } catch (e: any) { if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null; throw e; } };
  const walk = (rel: string) => {
    const abs = join(folder, rel);
    const st = gone(() => lstatSync(abs));
    if (!st || st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      // Uploads: only this conversation's own folder is ever walked.
      if (rel === "members/uploads") { if (existsSync(join(folder, ownUploads))) walk(ownUploads); return; }
      for (const name of (gone(() => readdirSync(abs)) ?? []).sort()) if (!name.startsWith(".")) walk(`${rel}/${name}`);
      return;
    }
    if (!st.isFile() || st.nlink !== 1 || !TEXT.test(rel) || st.size > SNAPSHOT_LIMITS.maxFileBytes) return;
    const buf = gone(() => readFileSync(abs));
    if (!buf) return;
    if (++entries > SNAPSHOT_LIMITS.maxFiles || (total += buf.length) > SNAPSHOT_LIMITS.maxBytes) throw new Error("chat_snapshot_too_large");
    const text = buf.toString("utf8");
    files.set(rel, { path: rel, sha256: sha(buf), bytes: buf.length, lines: text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n") });
  };
  for (const r of roots) walk(r);
  const hash = digest({ roots, ownUploads, files: [...files.values()].map((f) => [f.path, f.sha256]) });
  return { hash, roots: [...roots, ownUploads], files };
}

// Zod mirrors of the catalog's JSON Schemas (tests assert they accept/refuse the same shapes).
const s = (max: number) => z.string().min(1).max(max);
const sourcesZ = z.array(z.object({ path: s(300), line: z.number().int().min(1) }).strict()).max(50);
const linkZ = z.object({ text: s(200), url: s(500) }).strict();
/** Delta A-1 (Fable): a section image. alt is required (may be empty); the caption is plain text (escaped, never parsed). */
const imageZ = z.object({ url: s(500), alt: z.string().max(200), caption: s(300).optional(), position: z.enum(["above", "below", "left", "right"]) }).strict();
export const newsletterZ = z.object({ title: s(200), headerPhotos: z.array(s(500)).length(4).optional(), sections: z.array(z.object({ heading: s(200), body: s(4000), links: z.array(linkZ).max(10).optional(), images: z.array(imageZ).max(4).optional() }).strict()).min(1).max(20),
  sources: sourcesZ }).strict();
export const agendaZ = z.object({ meeting: s(200), date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  items: z.array(z.object({ title: s(200), owner: s(100).optional(), note: s(1000).optional() }).strict()).min(1).max(30), sources: sourcesZ }).strict();
/** Delta A-4: the site images this snapshot lists (E-1 URLs only, at most 200), from the website set's generated file. */
/** LIBRARY L1: plus the shared drive's generated list (members/drive/images.md), in the same line format. */
export function siteImagesOf(snap: Snapshot): string[] {
  const out: string[] = [];
  for (const file of [SITE_IMAGES_FILE, DRIVE_LIST_FILE]) {
    const f = snap.files.get(file); if (!f) continue;
    for (const l of f.lines) { const u = /^- (https:\/\/\S+)/.exec(l)?.[1]; const ok = u ? imageUrl(u) : null; if (ok && !out.includes(ok)) out.push(ok); if (out.length >= 200) return out; }
  }
  return out;
}
/** PACKAGE P (Fable PP-4): a link the member asked to drop or not use, with the reason shown to the member under the reply. */
const leaveOutZ = z.array(z.object({ url: s(500), reason: s(200) }).strict()).max(10);
export const TOOL_ARGS = {
  read_org_file: z.object({ path: s(300), fromLine: z.number().int().min(1).optional(), toLine: z.number().int().min(1).optional() }).strict(),
  search_org_history: z.object({ query: s(200), limit: z.number().int().min(1).max(8).optional() }).strict(),
  write_draft_artifact: z.discriminatedUnion("kind", [z.object({ kind: z.literal("newsletter"), content: newsletterZ, leaveOut: leaveOutZ.optional() }).strict(),
    z.object({ kind: z.literal("agenda"), content: agendaZ, leaveOut: leaveOutZ.optional() }).strict()]),
  // PACKAGE P: mirrors the catalog's edit_draft_artifact schema (the typed content is re-validated after the edits apply).
  edit_draft_artifact: z.object({ artifactId: z.string().regex(/^art_[a-f0-9]{32}$/), parentVersion: z.number().int().min(1), parentSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    edits: z.array(z.discriminatedUnion("op", [
      z.object({ op: z.literal("replace_text"), field: z.string().regex(/^(title|meeting|date|sections\[[0-9]{1,2}\]\.(heading|body)|items\[[0-9]{1,2}\]\.(title|owner|note))$/),
        old: z.string().max(4000), new: z.string().max(4000) }).strict(),
      z.object({ op: z.literal("set_list"), field: z.string().regex(/^(headerPhotos|sections\[[0-9]{1,2}\]\.(images|links))$/),
        old: z.array(z.union([s(500), linkZ, imageZ])).max(10), new: z.array(z.union([s(500), linkZ, imageZ])).max(10) }).strict(),
      z.object({ op: z.literal("add_entry"), after: z.number().int().min(-1).max(29), entry: z.record(z.string(), z.unknown()) }).strict(),
      z.object({ op: z.literal("remove_entry"), index: z.number().int().min(0).max(29), oldTitle: s(200) }).strict()])).min(1).max(8), leaveOut: leaveOutZ.optional() }).strict(),
  render_newsletter_preview: z.object({ artifactId: z.string().regex(/^art_[a-f0-9]{32}$/), version: z.number().int().min(1) }).strict(),
  list_site_images: z.object({}).strict(),
} as const;

/** Deterministic HTML for a newsletter version: renderer v3 (render-cp.ts; R-4 as amended by Fable e9cdd63c E-1, E-12/E-13). */
export function renderNewsletter(c: z.infer<typeof newsletterZ>, o: { provenance?: Provenance } = {}) { return renderNewsletterV3Full(c, o).html; }

export type DraftEnvelope = { envelopeId: string; snapshotHash: string; capability?: "newsletter" | "agenda"; turnsLeft?: number; usdLeft?: number };
/** The runtime's tool host for chat turns. `envelopeFor` (C-5) names the open draft envelope of a turn, if any. */
/** TEAM-TASKS-V1 T2: read_org_file / search_org_history over ANY snapshot (a chat turn's, or a team task's frozen sources), so
 *  the task runner uses the same tools and output format as chat, never a second implementation. Args already validated. */
export function snapshotToolCall(snap: Snapshot, name: "read_org_file" | "search_org_history", data: unknown): { ok: true; content: string } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  const ok = (v: unknown) => ({ ok: true as const, content: typeof v === "string" ? v : JSON.stringify(v) });
  const p = { data };
  switch (name) {
    case "read_org_file": {
      const a = p.data as z.infer<typeof TOOL_ARGS.read_org_file>, f = snap.files.get(a.path);
      if (!f) return fail("chat_tool_path_not_admitted");
      const from = Math.min(a.fromLine ?? 1, f.lines.length), want = Math.max(from, Math.min(a.toLine ?? f.lines.length, f.lines.length));
      const out: string[] = []; let bytes = 0, to = from - 1;
      for (let i = from; i <= want; i++) { const l = `L${i}: ${f.lines[i - 1]}\n`; if (bytes + Buffer.byteLength(l) > SNAPSHOT_LIMITS.readBytes) break; out.push(l); bytes += Buffer.byteLength(l); to = i; }
      return ok(`${f.path}#L${from}-L${Math.max(from, to)} sha256:${f.sha256} lines:${f.lines.length}${to < want ? " (truncated; ask for later lines)" : ""}\n` + out.join(""));
    }
    case "search_org_history": {
      const a = p.data as z.infer<typeof TOOL_ARGS.search_org_history>, limit = a.limit ?? SNAPSHOT_LIMITS.searchHits;
      const terms = [...new Set(a.query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2))].slice(0, 8);
      if (!terms.length) return fail("chat_tool_args_invalid");
      const hits: { score: number; f: SnapshotFile; i: number }[] = [];
      for (const f of snap.files.values()) f.lines.forEach((line, i) => { const l = line.toLowerCase(); const score = terms.filter((t) => l.includes(t)).length; if (score) hits.push({ score, f, i }); });
      hits.sort((x, y) => y.score - x.score || x.f.path.localeCompare(y.f.path) || x.i - y.i);
      const out: string[] = []; let bytes = 0;
      for (const h of hits.slice(0, limit)) {
        const lo = Math.max(1, h.i), hi = Math.min(h.f.lines.length, h.i + 2);
        const block = `${h.f.path}#L${lo}-L${hi} sha256:${h.f.sha256}\n` + h.f.lines.slice(lo - 1, hi).map((l, k) => `L${lo + k}: ${l}`).join("\n") + "\n";
        if (bytes + Buffer.byteLength(block) > SNAPSHOT_LIMITS.searchBytes) break;
        out.push(block); bytes += Buffer.byteLength(block);
      }
      return ok(out.length ? out.join("\n") : "No matches in the organization's files.");
    }
  }
}
export class ChatTools implements ToolHost {
  private readonly snaps = new Map<string, Snapshot>();
  constructor(private readonly a: SqliteAuthority, private readonly o: { folder: string; stateRoot: string; envelopeFor?: (turnId: string) => DraftEnvelope | null;

    /** C-5: at turn start, bind the turn to the conversation's usable envelope (pinned snapshot, E-3), or none. */
    bindEnvelope?: (turnId: string, conversationId: string, snapshotHash: string) => DraftEnvelope | null;
    /** AGENT-HANDBOOK-V1 H1: present ONLY when org.json handbook is enabled (the active approved handbook; installed features). */
    context?: { handbook: () => ContextHandbook | null; features: () => MapFeatures } },
    private readonly now: () => string = () => new Date().toISOString()) {
    a.db.exec(`CREATE TABLE IF NOT EXISTS chat_artifacts(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('newsletter','agenda')), created_at TEXT NOT NULL,
        UNIQUE(conversation_id, kind)) STRICT;
      CREATE TABLE IF NOT EXISTS chat_artifact_versions(artifact_id TEXT NOT NULL, version INTEGER NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, envelope_id TEXT NOT NULL,
        turn_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL, renderer_version TEXT, html_sha256 TEXT, created_at TEXT NOT NULL, PRIMARY KEY(artifact_id, version)) STRICT;
      CREATE TABLE IF NOT EXISTS chat_turn_snapshots(turn_id TEXT PRIMARY KEY, snapshot_hash TEXT NOT NULL, files INTEGER NOT NULL, bytes INTEGER NOT NULL) STRICT;`);
    // AGENT-HANDBOOK-V1 H1 (Fable C-7; U-2 additive, PRAGMA-guarded): every turn receipt records the chat prompt pin, and with the
    // feature on the handbook version/hash and the system-map hash it ran with.
    const have = new Set((a.db.prepare("PRAGMA table_info(chat_turn_snapshots)").all() as { name: string }[]).map((c) => c.name));
    // H2 (C-3; the cite chips): the turn's map BYTES too, so a system-map:<turn>#Lx chip resolves the frozen text (<= 2 KiB).
    for (const [col, type] of [["chat_rules_hash", "TEXT"], ["handbook_version", "INTEGER"], ["handbook_sha256", "TEXT"], ["map_sha256", "TEXT"], ["map_text", "TEXT"]] as const)
      if (!have.has(col)) a.db.exec(`ALTER TABLE chat_turn_snapshots ADD COLUMN ${col} ${type}`);
    // PACKAGE P (Fable PP-3/PP-4; additive, PRAGMA-guarded): a version's edit provenance and left-out links.
    const vcols = new Set((a.db.prepare("PRAGMA table_info(chat_artifact_versions)").all() as { name: string }[]).map((c) => c.name));
    for (const col of ["edited_from", "changed", "left_out"]) if (!vcols.has(col)) a.db.exec(`ALTER TABLE chat_artifact_versions ADD COLUMN ${col} TEXT`);
    // J2 (Director, option a; chats stay private): a member shares ONE newsletter draft with reviewers (its latest version is
    // what they see) and can stop; nothing else in the chat is shared. Additive.
    a.db.exec(`CREATE TABLE IF NOT EXISTS chat_draft_shares(artifact_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, member_id TEXT NOT NULL,
      shared_at TEXT NOT NULL, unshared_at TEXT) STRICT;`);
  }
  private dir(conversationId: string, artifactId: string) { return join(this.o.stateRoot, "chat", "artifacts", conversationId, artifactId); }
  /** Turn start: take and record the snapshot. */
  async begin(ctx: { turnId: string; conversationId: string; memberId: string; scope: ChatScope }) {
    const snap = takeSnapshot(this.o.folder, ctx.scope, ctx.memberId, ctx.conversationId);
    // WC-3 (Fable R-9): nothing to read = no model request, no reservation, no envelope turn; the turn ends with a fixed label.
    if (!snap.files.size) throw new Error("chat_no_files");
    // AGENT-HANDBOOK-V1 H1 (C-6): with the feature on and no approved handbook, refuse BEFORE the envelope is bound or anything sent.
    const handbook = this.o.context ? this.o.context.handbook() : null;
    if (this.o.context && !handbook) throw new Error("chat_handbook_missing");
    this.snaps.set(ctx.turnId, snap);
    const bytes = [...snap.files.values()].reduce((n, f) => n + f.bytes, 0);
    const envelope = this.o.bindEnvelope?.(ctx.turnId, ctx.conversationId, snap.hash) ?? null;
    // C-3/C-4: the map from THIS turn's frozen snapshot (the actor's scope + this conversation's own uploads) and the installed features.
    const map = this.o.context ? systemMap({ id: ctx.turnId, snapshotHash: snap.hash, generatedAt: this.now(), paths: [...snap.files.keys()],
      ownUploads: snapshotRoots(ctx.scope, ctx.memberId, ctx.conversationId).ownUploads, chat: true, features: this.o.context.features(),
      tools: envelope ? ["read_org_file", "search_org_history", "write_draft_artifact", "edit_draft_artifact", "render_newsletter_preview", "list_site_images"] : ["read_org_file", "search_org_history"] }) : null;
    if (this.o.context && !map) { this.snaps.delete(ctx.turnId); throw new Error("chat_system_map_unavailable"); }
    this.a.write(() => this.a.db.prepare("INSERT OR REPLACE INTO chat_turn_snapshots(turn_id,snapshot_hash,files,bytes,chat_rules_hash,handbook_version,handbook_sha256,map_sha256,map_text) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(ctx.turnId, snap.hash, snap.files.size, bytes, CHAT_RULES_HASH, handbook?.version ?? null, handbook?.sha256 ?? null, map?.sha256 ?? null, map?.text ?? null));
    // PACKAGE P: the conversation's latest saved draft of the envelope's kind (the parent an edit names), for the turn note.
    const cap = envelope?.capability === "agenda" ? "agenda" : "newsletter";
    const latest = envelope ? this.a.db.prepare(`SELECT v.artifact_id, v.version, v.sha256 FROM chat_artifact_versions v JOIN chat_artifacts a ON a.id=v.artifact_id
      WHERE a.conversation_id=? AND a.kind=? ORDER BY v.version DESC LIMIT 1`).get(ctx.conversationId, cap) as { artifact_id: string; version: number; sha256: string } | undefined : undefined;
    const latestDraft = latest ? { artifactId: latest.artifact_id, version: latest.version, sha256: "sha256:" + latest.sha256 } : null;
    return { snapshotHash: snap.hash, envelopeId: envelope?.envelopeId ?? null, envelope, latestDraft, context: handbook && map ? { handbook, map } : null };
  }
  end(turnId: string) { this.snaps.delete(turnId); }
  snapshotOf(turnId: string) { return this.snaps.get(turnId) ?? null; }
  /** H2 cite chips: a turn's frozen system map (or null), re-hashed. The CALLER checks the member may read the turn. */
  mapOf(turnId: string): { id: string; text: string; handbookVersion: number | null } | null {
    const r = this.a.db.prepare("SELECT map_text, map_sha256, handbook_version FROM chat_turn_snapshots WHERE turn_id=?").get(turnId) as Record<string, any> | undefined;
    if (!r?.map_text || "sha256:" + createHash("sha256").update(r.map_text, "utf8").digest("hex") !== r.map_sha256) return null;
    return { id: turnId, text: r.map_text, handbookVersion: r.handbook_version ?? null };
  }

  async call(name: string, argsJson: string, ctx: { turnId: string; conversationId: string; memberId: string; scope: ChatScope }) {
    const fail = (error: string) => ({ ok: false as const, error });
    if (!(name in TOOL_ARGS)) return fail("chat_tool_unknown");
    let raw: unknown;
    try { raw = JSON.parse(argsJson); } catch { return fail("chat_tool_args_invalid"); }
    const p = TOOL_ARGS[name as keyof typeof TOOL_ARGS].safeParse(raw);
    if (!p.success) return fail("chat_tool_args_invalid");
    const snap = this.snaps.get(ctx.turnId);
    if (!snap) return fail("chat_tool_failed");
    const ok = (v: unknown) => ({ ok: true as const, content: typeof v === "string" ? v : JSON.stringify(v) });
    switch (name) {
      case "read_org_file": case "search_org_history": return snapshotToolCall(snap, name, p.data);
      case "write_draft_artifact": {
        const env = this.o.envelopeFor?.(ctx.turnId) ?? null;
        if (!env) return fail("chat_tool_needs_draft_plan");
        const a = p.data as z.infer<typeof TOOL_ARGS.write_draft_artifact>;
        return this.saveVersion(ctx, env, snap, a.kind, a.content, null, a.leaveOut ?? []);
      }
      // PACKAGE P (Astra STACK-AND-HARNESS-REVIEW §3; Fable ruling on BRIEF-PACKAGE-P): an exact, atomic edit of the LATEST saved
      // version. The parent (version + sha256) must be current; each edit names a typed field and the exact text (exactly one
      // occurrence) or the exact current list it replaces; code copies every untouched field. All edits apply, or none.
      case "edit_draft_artifact": {
        const env = this.o.envelopeFor?.(ctx.turnId) ?? null;
        if (!env) return fail("chat_tool_needs_draft_plan");
        const a = p.data as z.infer<typeof TOOL_ARGS.edit_draft_artifact>;
        const art = this.a.db.prepare("SELECT id, kind FROM chat_artifacts WHERE id=? AND conversation_id=?").get(a.artifactId, ctx.conversationId) as { id: string; kind: "newsletter" | "agenda" } | undefined;
        if (!art) return fail("chat_tool_artifact_unknown");
        const latest = this.a.db.prepare("SELECT version, sha256 FROM chat_artifact_versions WHERE artifact_id=? ORDER BY version DESC LIMIT 1").get(art.id) as { version: number; sha256: string } | undefined;
        // Fable PP-2: a refusal re-anchors the model (the latest version + sha256; or the entry titles with their indexes).
        if (!latest || latest.version !== a.parentVersion || "sha256:" + latest.sha256 !== a.parentSha256)
          return { ok: false as const, error: "draft_edit_stale", hint: latest ? { latestVersion: latest.version, latestSha256: "sha256:" + latest.sha256 } : {} };
        const stored = readFileSync(join(this.dir(ctx.conversationId, art.id), `v${latest.version}.${latest.sha256}.json`));
        if (sha(stored) !== latest.sha256) return fail("chat_tool_failed");
        const parent = JSON.parse(stored.toString("utf8")).content;
        const e = applyDraftEdits(art.kind, parent, a.edits as DraftEdit[]);
        if (!e.ok) {
          // Fable FABLE-REVIEW-P-CHAT-RUN3-FAIL Addendum 1 F-2': one refusal re-anchors the WHOLE next call (a turn ends after three
          // tool refusals): the failing edit, the headings, the target field's current value AND every list field's current value,
          // under the 4 KiB hint cap; over it, the target field only. The label alone is persisted.
          const base = { ...(e.at !== undefined ? { failedEdit: e.at } : {}), ...("current" in e ? { current: e.current } : {}), entries: entryTitles(art.kind, parent) };
          const full = { ...base, lists: draftListFields(art.kind, parent) };
          return { ok: false as const, error: e.error, hint: Buffer.byteLength(JSON.stringify({ error: e.error, ...full })) <= 4096 ? full : base };
        }
        return this.saveVersion(ctx, env, snap, art.kind, e.content, { parentVersion: latest.version, parentSha256: "sha256:" + latest.sha256, changed: e.changed }, a.leaveOut ?? []);
      }
      case "list_site_images": {
        // Delta A-4 (Fable): read-only, in a draft envelope only (like the draft tools), from THIS turn's frozen snapshot (the
        // website set's generated list; never a fetch). The same list write_draft_artifact enforces.
        if (!this.o.envelopeFor?.(ctx.turnId)) return fail("chat_tool_needs_draft_plan");
        const list = siteImagesOf(snap), lines = [SITE_IMAGES_FILE, DRIVE_LIST_FILE].flatMap((p) => snap.files.get(p)?.lines ?? []);
        const hint = (u: string) => lines.find((l) => l.startsWith(`- ${u} `))?.slice(u.length + 3).replace(/^\(|\)$/g, "") ?? "";
        return ok(list.length ? { images: list.map((url) => ({ url, hint: hint(url) })) } : { images: [], note: "No site images are listed." });
      }
      case "render_newsletter_preview": {
        const env = this.o.envelopeFor?.(ctx.turnId) ?? null;
        if (!env) return fail("chat_tool_needs_draft_plan");
        const a = p.data as z.infer<typeof TOOL_ARGS.render_newsletter_preview>;
        const art = this.a.db.prepare("SELECT kind FROM chat_artifacts WHERE id=? AND conversation_id=?").get(a.artifactId, ctx.conversationId) as { kind: string } | undefined;
        const v = this.a.db.prepare("SELECT sha256, html_sha256, renderer_version FROM chat_artifact_versions WHERE artifact_id=? AND version=?").get(a.artifactId, a.version) as { sha256: string; html_sha256: string | null; renderer_version: string | null } | undefined;
        if (!art || !v || art.kind !== "newsletter") return fail("chat_tool_artifact_unknown");
        const dir = this.dir(ctx.conversationId, a.artifactId), stored = readFileSync(join(dir, `v${a.version}.${v.sha256}.json`));
        if (sha(stored) !== v.sha256) return fail("chat_tool_failed");
        const rv = RENDERER_VERSION;
        // Package E addendum 2: a version already rendered by THIS renderer keeps its stored HTML and link list (provenance is
        // judged once, against this turn's frozen snapshot and the member's messages; a later turn's context never rewrites it).
        if (v.html_sha256 && v.renderer_version === rv) return ok({ rendered: true, artifactId: a.artifactId, version: a.version, htmlSha256: "sha256:" + v.html_sha256 });
        // Fable E-13: provenance = the exact URL occurs in this turn's frozen snapshot (its path), or in a MEMBER-authored message of
        // this conversation ("member message"); never the model's turns, the system map or the handbook.
        const member = (this.a.db.prepare("SELECT text FROM chat_messages WHERE conversation_id=? AND role='user' ORDER BY seq").all(ctx.conversationId) as { text: string }[]).map((m) => m.text);
        const provenance: Provenance = (url) => {
          for (const f of snap.files.values()) if (f.lines.join("\n").includes(url)) return f.path;
          return member.some((t) => t.includes(url)) ? "member message" : null;
        };
        const r = renderNewsletterV3Full(newsletterZ.parse(JSON.parse(stored.toString("utf8")).content), { provenance });
        const html = Buffer.from(r.html), hs = sha(html), file = join(dir, `v${a.version}.${hs}.html`), linksFile = join(dir, `v${a.version}.${hs}.links.json`);
        if (inWebsiteRoot(this.o.folder, file)) return fail("chat_tool_failed");
        if (!existsSync(file)) writeFileSync(file, html, { mode: 0o600, flag: "wx" });
        if (!existsSync(linksFile)) writeFileSync(linksFile, JSON.stringify(r.links), { mode: 0o600, flag: "wx" });
        this.a.write(() => this.a.db.prepare("UPDATE chat_artifact_versions SET html_sha256=?, renderer_version=? WHERE artifact_id=? AND version=? AND html_sha256 IS ? AND renderer_version IS ?")
          .run(hs, rv, a.artifactId, a.version, v.html_sha256, v.renderer_version));
        return ok({ rendered: true, artifactId: a.artifactId, version: a.version, htmlSha256: "sha256:" + hs, bytes: html.length, links: { live: r.links.filter((x) => x.live).length, inert: r.links.filter((x) => !x.live).length } });
      }
    }
    return fail("chat_tool_unknown");
  }
  /** One saved version (a write or an edit): every content rule, the member-link check, then the content-addressed file + row. */
  private saveVersion(ctx: { turnId: string; conversationId: string }, env: DraftEnvelope, snap: Snapshot, kind: "newsletter" | "agenda", content: unknown,
    edit: { parentVersion: number; parentSha256: string; changed: string[] } | null, leaveOut: { url: string; reason: string }[]) {
    const fail = (error: string, hint?: Record<string, unknown>) => ({ ok: false as const, error, ...(hint ? { hint } : {}) });
    const ok = (v: unknown) => ({ ok: true as const, content: JSON.stringify(v) });
    const parsed = (kind === "newsletter" ? newsletterZ : agendaZ).safeParse(content);
    if (!parsed.success) return fail("chat_tool_args_invalid");
    const a = { kind, content: parsed.data } as z.infer<typeof TOOL_ARGS.write_draft_artifact>;
    if (a.kind === "newsletter") {
      // Delta A-1/A-4 (Fable): every image (the header four and each section's) is an E-1 URL on the site image list of THIS
      // turn's snapshot, else the version is refused and the model told which rule; at most one image beside the text per
      // section; at most 24 images in the issue (the E-2 preflight stays bounded).
      const listed = new Set(siteImagesOf(snap)), all = [...(a.content.headerPhotos ?? []), ...a.content.sections.flatMap((x) => (x.images ?? []).map((im) => im.url))];
      if (!all.every((u) => { const ok = imageUrl(u); return !!ok && ok === u && listed.has(ok); })) return fail("newsletter_image_not_listed");
      if (all.length > 24 || a.content.sections.some((x) => (x.images ?? []).filter((im) => im.position === "left" || im.position === "right").length > 1)) return fail("chat_tool_args_invalid");
    }
    // E-5: every cited source resolves in this turn's snapshot (path present, line within it).
    if (!a.content.sources.every((s2) => { const f = snap.files.get(s2.path); return !!f && s2.line <= f.lines.length; })) return fail("chat_tool_sources_invalid");
    // PACKAGE P (member input): every https link the member wrote in THIS turn's message must be in the draft (a link, an inline
    // link or a placed image), else the version is refused with the missing address: include it, or tell the member why not.
    // Fable PP-4: a link the member asked to drop goes in leaveOut (shown to the member); canonical URL comparison.
    const missing = missingMemberLinks(this.memberMessageOf(ctx), a.content, leaveOut);
    if (missing.length) return fail("draft_member_link_missing", { missing }); // the label is persisted; the URLs go only to the model
    // Fable R-2: the artifact store never resolves into the website copy (a fixed refusal, nothing written).
    if (inWebsiteRoot(this.o.folder, this.dir(ctx.conversationId, "art"))) return fail("chat_tool_failed");
    const at = this.now(), bytes = Buffer.from(JSON.stringify({ kind: a.kind, content: a.content }));
    const r = this.a.write(() => {
      let art = this.a.db.prepare("SELECT id FROM chat_artifacts WHERE conversation_id=? AND kind=?").get(ctx.conversationId, a.kind) as { id: string } | undefined;
      if (!art) { art = { id: "art_" + randomUUID().replaceAll("-", "") }; this.a.db.prepare("INSERT INTO chat_artifacts(id,conversation_id,kind,created_at) VALUES (?,?,?,?)").run(art.id, ctx.conversationId, a.kind, at); }
      const version = 1 + ((this.a.db.prepare("SELECT MAX(version) AS v FROM chat_artifact_versions WHERE artifact_id=?").get(art.id) as { v: number | null }).v ?? 0);
      // An edit applies only to the version it read (a concurrent save in between makes it stale, atomically).
      if (edit && version !== edit.parentVersion + 1) return null;
      const dir = this.dir(ctx.conversationId, art.id); mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Content-addressed name: a crash between this write and the commit leaves a file no row names; a retry of the
      // same content finds identical bytes, different content gets a different name (never an overwrite).
      const file = join(dir, `v${version}.${sha(bytes)}.json`);
      if (!existsSync(file)) writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
      this.a.db.prepare("INSERT INTO chat_artifact_versions(artifact_id,version,sha256,bytes,envelope_id,turn_id,snapshot_hash,renderer_version,html_sha256,created_at) VALUES (?,?,?,?,?,?,?,NULL,NULL,?)")
        .run(art.id, version, sha(bytes), bytes.length, env.envelopeId, ctx.turnId, snap.hash, at);
      // Fable PP-3/PP-4: the version records what it was edited from, the fields it touched, and any link left out (and why).
      this.a.db.prepare("UPDATE chat_artifact_versions SET edited_from=?, changed=?, left_out=? WHERE artifact_id=? AND version=?")
        .run(edit ? JSON.stringify({ version: edit.parentVersion, sha256: edit.parentSha256 }) : null, edit ? JSON.stringify(edit.changed) : null,
          leaveOut.length ? JSON.stringify(leaveOut) : null, art.id, version);
      return { artifactId: art.id, version, sha256: "sha256:" + sha(bytes) };
    });
    if (!r) return fail("draft_edit_stale");
    return ok({ saved: true, kind: a.kind, ...r, ...(edit ? { editedFrom: { version: edit.parentVersion, sha256: edit.parentSha256 }, changed: edit.changed } : {}),
      ...(leaveOut.length ? { leftOut: leaveOut.map((l) => l.url) } : {}) });
  }
  /** PACKAGE P (never silent): in a drafting conversation, the member's links from their LATEST message that no version saved in
   *  that turn carries (also when the turn saved nothing). Null when there is nothing to say. Deterministic: no model involved. */
  memberLinkGaps(conversationId: string) {
    if (!this.a.db.prepare("SELECT 1 FROM chat_artifacts WHERE conversation_id=? LIMIT 1").get(conversationId)) return null;
    const m = this.a.db.prepare("SELECT turn_id, text FROM chat_messages WHERE conversation_id=? AND role='user' ORDER BY seq DESC LIMIT 1").get(conversationId) as { turn_id: string; text: string } | undefined;
    if (!m) return null;
    const answered = this.a.db.prepare("SELECT 1 FROM chat_messages WHERE conversation_id=? AND turn_id=? AND role='assistant' LIMIT 1").get(conversationId, m.turn_id);
    if (!answered) return null; // the turn is still running
    // Fable PP-4: said whenever a version was saved THIS turn without the URL and without a leaveOut entry for it.
    const rows = this.a.db.prepare(`SELECT v.artifact_id, v.version, v.sha256, v.left_out FROM chat_artifact_versions v JOIN chat_artifacts a ON a.id=v.artifact_id
      WHERE a.conversation_id=? AND v.turn_id=?`).all(conversationId, m.turn_id) as { artifact_id: string; version: number; sha256: string; left_out: string | null }[];
    if (!rows.length) return null;
    const saved = rows.map((v) => { try { return JSON.parse(readFileSync(join(this.dir(conversationId, v.artifact_id), `v${v.version}.${v.sha256}.json`), "utf8")).content; } catch { return null; } });
    const missing = missingMemberLinks(m.text, saved, rows.flatMap((v) => v.left_out ? JSON.parse(v.left_out) as { url: string }[] : []));
    return missing.length ? { turnId: m.turn_id, missing } : null;
  }
  /** The member's message that started this turn (the drafting instructions the link check reads). */
  private memberMessageOf(ctx: { turnId: string; conversationId: string }) {
    return (this.a.db.prepare("SELECT text FROM chat_messages WHERE conversation_id=? AND turn_id=? AND role='user' ORDER BY seq DESC LIMIT 1").get(ctx.conversationId, ctx.turnId) as { text: string } | undefined)?.text ?? "";
  }
  /** For the UI (C-6) and Records: an artifact's versions (rows) and one version's preview HTML (served only into the sandbox). */
  versions(conversationId: string) {
    return (this.a.db.prepare(`SELECT v.artifact_id, a.kind, v.version, v.sha256, v.envelope_id, v.turn_id, v.snapshot_hash, v.renderer_version, v.html_sha256, v.created_at,
      v.edited_from, v.changed, v.left_out FROM chat_artifact_versions v JOIN chat_artifacts a ON a.id=v.artifact_id WHERE a.conversation_id=? ORDER BY v.rowid`).all(conversationId) as Record<string, any>[])
      .map(({ edited_from, changed, left_out, ...v }) => ({ ...v, editedFrom: edited_from ? JSON.parse(edited_from) : null, changed: changed ? JSON.parse(changed) : null,
        leftOut: left_out ? JSON.parse(left_out) : null }));
  }
  previewHtml(conversationId: string, artifactId: string, version: number) {
    const v = this.a.db.prepare("SELECT v.html_sha256 FROM chat_artifact_versions v JOIN chat_artifacts a ON a.id=v.artifact_id WHERE a.conversation_id=? AND v.artifact_id=? AND v.version=?")
      .get(conversationId, artifactId, version) as { html_sha256: string | null } | undefined;
    if (!v?.html_sha256) return null;
    const html = readFileSync(join(this.dir(conversationId, artifactId), `v${version}.${v.html_sha256}.html`));
    return sha(html) === v.html_sha256 ? html.toString("utf8") : null;
  }
  /** J2 (owner, Oct 26: the Newsletter page = Drafts + Sent): the LATEST version of each newsletter draft in these conversations
   *  (the caller passes only the member's own), newest first, with its title from the stored typed content (hash-checked). */
  newsletterDrafts(conversationIds: string[], o: { sharedBy?: "others"; memberId?: string } = {}) {
    if (!conversationIds.length && !o.sharedBy) return [];
    // Own drafts: the caller's conversations. Shared: every draft shared now by ANOTHER member (reviewers' list).
    const where = o.sharedBy ? "a.id IN (SELECT artifact_id FROM chat_draft_shares WHERE unshared_at IS NULL AND member_id<>?)" : `a.conversation_id IN (${conversationIds.map(() => "?").join(",")})`;
    const rows = this.a.db.prepare(`SELECT a.conversation_id, v.artifact_id, v.version, v.sha256, v.html_sha256, v.renderer_version, v.created_at,
      (SELECT member_id FROM chat_draft_shares s WHERE s.artifact_id=a.id AND s.unshared_at IS NULL) AS shared_by FROM chat_artifact_versions v
      JOIN chat_artifacts a ON a.id=v.artifact_id WHERE a.kind='newsletter' AND ${where}
      AND v.version=(SELECT MAX(version) FROM chat_artifact_versions WHERE artifact_id=v.artifact_id) ORDER BY v.created_at DESC LIMIT 50`).all(...(o.sharedBy ? [o.memberId ?? ""] : conversationIds)) as Record<string, any>[];
    return rows.map((r) => {
      let title = "";
      try { const f = readFileSync(join(this.dir(r.conversation_id, r.artifact_id), `v${r.version}.${r.sha256}.json`)); if (sha(f) === r.sha256) title = String(JSON.parse(f.toString("utf8")).content?.title ?? ""); } catch { /* listed untitled */ }
      const sharedBy = r.shared_by ? (this.a.db.prepare("SELECT email FROM access_members WHERE member_id=?").get(r.shared_by) as { email: string } | undefined)?.email ?? "a former member" : null;
      return { conversationId: r.conversation_id, artifact_id: r.artifact_id, version: r.version, title, created_at: r.created_at, html_sha256: r.html_sha256, current: r.renderer_version === RENDERER_VERSION,
        shared: !!r.shared_by, ...(o.sharedBy ? { sharedBy } : {}) };
    });
  }
  /** J2 option a: the owner (the caller checked the conversation is theirs) shares or stops sharing one newsletter draft;
   *  audited in chat_audit (who, which conversation, which artifact). Idempotent. */
  shareDraft(conversationId: string, artifactId: unknown, memberId: string, on: boolean) {
    const a = typeof artifactId === "string" ? this.a.db.prepare("SELECT id, kind FROM chat_artifacts WHERE id=? AND conversation_id=?").get(artifactId, conversationId) as { id: string; kind: string } | undefined : undefined;
    if (!a || a.kind !== "newsletter") throw new AccessError("chat_artifact_unknown");
    const now = this.now(), cur = this.sharedNow(a.id);
    if (on !== cur) this.a.write(() => {
      if (on) this.a.db.prepare("INSERT INTO chat_draft_shares(artifact_id,conversation_id,member_id,shared_at,unshared_at) VALUES (?,?,?,?,NULL) ON CONFLICT(artifact_id) DO UPDATE SET shared_at=excluded.shared_at, unshared_at=NULL, member_id=excluded.member_id")
        .run(a.id, conversationId, memberId, now);
      else this.a.db.prepare("UPDATE chat_draft_shares SET unshared_at=? WHERE artifact_id=? AND unshared_at IS NULL").run(now, a.id);
      this.a.db.prepare("INSERT INTO chat_audit(at,event,conversation_id,member_id,detail) VALUES (?,?,?,?,?)").run(now, on ? "draft_shared" : "draft_unshared", conversationId, memberId, a.id);
    });
    return { artifactId: a.id, shared: on };
  }
  /** J2 option a: is this artifact (in this conversation) shared with reviewers right now? */
  sharedNow(artifactId: string, conversationId?: string) {
    return !!this.a.db.prepare(`SELECT 1 FROM chat_draft_shares WHERE artifact_id=? AND unshared_at IS NULL${conversationId ? " AND conversation_id=?" : ""}`).get(...(conversationId ? [artifactId, conversationId] : [artifactId]));
  }
  /** P2 K1 (owner, Oct 26: "we had the old colors"): what Open preview SHOWS. A version rendered by the current renderer: its stored
   *  HTML (above). An older rendering: the stored typed content rendered NOW with the current renderer, in memory only: never
   *  stored and never releasable (newsletterVersion still requires the current renderer's stored HTML; the agent renders again
   *  inside a plan). Links: those the stored list made live, or that occur in a member's message; every other link inert. */
  displayHtml(conversationId: string, artifactId: string, version: number): { html: string; rerendered: boolean } | null {
    const v = this.a.db.prepare("SELECT v.sha256, v.html_sha256, v.renderer_version, a.kind FROM chat_artifact_versions v JOIN chat_artifacts a ON a.id=v.artifact_id WHERE a.conversation_id=? AND v.artifact_id=? AND v.version=?")
      .get(conversationId, artifactId, version) as { sha256: string; html_sha256: string | null; renderer_version: string | null; kind: string } | undefined;
    if (!v || !v.html_sha256) return null;
    if (v.renderer_version === RENDERER_VERSION) { const html = this.previewHtml(conversationId, artifactId, version); return html === null ? null : { html, rerendered: false }; }
    if (v.kind !== "newsletter") return null;
    const dir = this.dir(conversationId, artifactId), stored = readFileSync(join(dir, `v${version}.${v.sha256}.json`));
    if (sha(stored) !== v.sha256) return null;
    const parsed = newsletterZ.safeParse(JSON.parse(stored.toString("utf8")).content);
    if (!parsed.success) return null;
    const lf = join(dir, `v${version}.${v.html_sha256}.links.json`);
    const wasLive = new Map((existsSync(lf) ? JSON.parse(readFileSync(lf, "utf8")) as LinkDecision[] : []).filter((l) => l.live).map((l) => [l.url, l.source ?? "earlier preview"] as [string, string]));
    const member = (this.a.db.prepare("SELECT text FROM chat_messages WHERE conversation_id=? AND role='user' ORDER BY seq").all(conversationId) as { text: string }[]).map((m) => m.text);
    const provenance: Provenance = (url) => wasLive.get(url) ?? (member.some((t) => t.includes(url)) ? "member message" : null);
    return { html: renderNewsletterV3Full(parsed.data, { provenance }).html, rerendered: true };
  }
  /** Newsletter slice 2 (Fable R-4): a newsletter version's typed content and its rendered preview, both checked against the
   *  hashes recorded with the version (the E-5 chain); null if either is missing or does not match. */
  newsletterVersion(conversationId: string, artifactId: string, version: number) {
    const v = this.a.db.prepare("SELECT v.sha256, v.html_sha256, v.renderer_version, a.kind FROM chat_artifact_versions v JOIN chat_artifacts a ON a.id=v.artifact_id WHERE a.conversation_id=? AND v.artifact_id=? AND v.version=?")
      .get(conversationId, artifactId, version) as { sha256: string; html_sha256: string | null; renderer_version: string | null; kind: string } | undefined;
    if (!v || v.kind !== "newsletter" || !v.html_sha256) return null;
    const html = this.previewHtml(conversationId, artifactId, version), stored = readFileSync(join(this.dir(conversationId, artifactId), `v${version}.${v.sha256}.json`));
    if (html === null || sha(stored) !== v.sha256) return null;
    // Package E: only a v3 rendering is releasable (an older version re-renders first: renderer v2 -> v3 re-prepares).
    if (v.renderer_version !== RENDERER_VERSION) return null;
    // Fable E-12d: the link list the reviewer approves (live: text + host + source; inert: text + reason), stored with the HTML.
    const lf = join(this.dir(conversationId, artifactId), `v${version}.${v.html_sha256}.links.json`);
    const links = existsSync(lf) ? JSON.parse(readFileSync(lf, "utf8")) as LinkDecision[] : null;
    if (!links) return null;
    return { content: newsletterZ.parse(JSON.parse(stored.toString("utf8")).content), html, htmlSha256: v.html_sha256, renderer: String(v.renderer_version), links };
  }
}
/** The plain-text part of a newsletter, from the same typed content as the HTML (links as "text (url)", never anchors). */
export function newsletterText(c: z.infer<typeof newsletterZ>) {
  return [c.title, "", ...c.sections.flatMap((x) => [x.heading, "", x.body.replace(/\r\n?/g, "\n").trim(), ...(x.links ?? []).map((l) => `- ${l.text} (${l.url})`), ""])].join("\n").trim() + "\n";
}
