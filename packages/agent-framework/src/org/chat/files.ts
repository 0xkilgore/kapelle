// Chat agent C-6a (PLAN-SLICE-1 §9 uploads; Fable §12(e); owner: a Shared files page with provenance).
// - chat.upload: a member adds a TEXT file (.md .txt .csv, <= 48 KiB: the hub's 64 KiB JSON body bound) to their OWN
//   conversation. It lands in members/uploads/<member>/<conversationId>/<name> and is read ONLY by that conversation's
//   snapshot (and reviewer scopes do not widen it: uploads are never walked except the conversation's own folder).
//   Untrusted content, hashed, per-member count cap, sanitized names, never overwritten.
// - chat.upload.share: an explicit session-tier step copies the upload to members/shared/<name> for the whole org (every
//   member conversation's snapshot then sees it). Member EMAIL Q&A reads members/notes only, so neither ever reaches a reply.
// - files.list / files.read: what the agent can read, by folder, read-only, with provenance (who / when / from where) from
//   runtime records (uploads, shares, approved notes, intake submissions); other files show the folder and the file's
//   own time. A member sees members/ (minus other people's private uploads); reviewers also see their private roots.
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AccessError } from "../../access/org-access.js";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import { refuseWebsiteRoot } from "../website/content-root.js";

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
export const UPLOAD_LIMITS = { bytes: 48 * 1024, perMember: 50 };
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}\.(md|txt|csv)$/;
const TEXT = /\.(md|txt|csv)$/i;

export class ChatFiles {
  constructor(private readonly a: SqliteAuthority, private readonly o: { folder: string; conversation: (memberId: string, id: unknown) => { id: string; deleted_at: string | null };
      website?: () => { provenance(rel: string): { addedBy: null; at: string; from: string; visibleTo: string } | null;
        status(): { commit: string | null; fetchedAt: string | null; files: number; lastOutcome: string | null; lastAt: string | null; running: boolean } } | null;
      /** LIBRARY L1: provenance for files uploaded straight to the shared drive. */
      drive?: () => { textProvenance(rel: string): { memberId: string; at: string } | null } | null },
    private readonly now: () => string = () => new Date().toISOString()) {
    a.db.exec(`CREATE TABLE IF NOT EXISTS chat_uploads(id TEXT PRIMARY KEY, member_id TEXT NOT NULL, conversation_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, at TEXT NOT NULL, shared_path TEXT, shared_at TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS notes_provenance(path TEXT PRIMARY KEY, member_id TEXT NOT NULL, operation_id TEXT NOT NULL, at TEXT NOT NULL) STRICT;`);
  }
  upload(memberId: string, b: { conversationId?: unknown; fileName?: unknown; text?: unknown }) {
    const c = this.o.conversation(memberId, b?.conversationId);
    if (c.deleted_at) throw new AccessError("chat_conversation_unknown");
    if (typeof b.fileName !== "string" || !NAME.test(b.fileName.trim())) throw new AccessError("chat_upload_type_not_admitted");
    if (typeof b.text !== "string") throw new AccessError("chat_upload_empty");
    const text = b.text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
    if (!text.trim()) throw new AccessError("chat_upload_empty");
    const bytes = Buffer.from(text);
    if (bytes.length > UPLOAD_LIMITS.bytes) throw new AccessError("chat_upload_too_large");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(memberId)) throw new AccessError("chat_upload_failed");
    const name = b.fileName.trim(), rel = `members/uploads/${memberId}/${c.id}/${name}`, abs = join(this.o.folder, rel);
    const prior = this.a.read(() => this.a.db.prepare("SELECT id, sha256 FROM chat_uploads WHERE path=?").get(rel)) as { id: string; sha256: string } | undefined;
    if (prior) { if (prior.sha256 !== sha(bytes)) throw new AccessError("chat_upload_exists"); return this.uploadView(prior.id); }
    if ((this.a.read(() => this.a.db.prepare("SELECT COUNT(*) AS n FROM chat_uploads WHERE member_id=?").get(memberId)) as { n: number }).n >= UPLOAD_LIMITS.perMember)
      throw new AccessError("chat_upload_limit");
    refuseWebsiteRoot(this.o.folder, abs, (l) => new AccessError(l)); // Fable R-2: never inside the website copy
    mkdirSync(join(this.o.folder, "members", "uploads", memberId, c.id), { recursive: true, mode: 0o700 });
    if (existsSync(abs)) { if (sha(readFileSync(abs)) !== sha(bytes)) throw new AccessError("chat_upload_exists"); } else writeFileSync(abs, bytes, { mode: 0o600, flag: "wx" });
    const id = "up_" + randomUUID().replaceAll("-", "");
    this.a.write(() => this.a.db.prepare("INSERT INTO chat_uploads(id,member_id,conversation_id,path,name,sha256,bytes,at,shared_path,shared_at) VALUES (?,?,?,?,?,?,?,?,NULL,NULL)")
      .run(id, memberId, c.id, rel, name, sha(bytes), bytes.length, this.now()));
    return this.uploadView(id);
  }
  share(memberId: string, b: { uploadId?: unknown }) {
    const u = typeof b?.uploadId === "string" && /^up_[a-f0-9]{32}$/.test(b.uploadId)
      ? this.a.read(() => this.a.db.prepare("SELECT * FROM chat_uploads WHERE id=? AND member_id=?").get(b.uploadId as string, memberId)) as Record<string, any> | undefined : undefined;
    if (!u) throw new AccessError("chat_upload_unknown");
    if (u.shared_path) return this.uploadView(u.id);
    const src = join(this.o.folder, u.path);
    if (!existsSync(src) || sha(readFileSync(src)) !== u.sha256) throw new AccessError("chat_upload_failed");
    refuseWebsiteRoot(this.o.folder, join(this.o.folder, "members", "shared", "x"), (l) => new AccessError(l));
    mkdirSync(join(this.o.folder, "members", "shared"), { recursive: true, mode: 0o700 });
    let rel = `members/shared/${u.name}`;
    if (existsSync(join(this.o.folder, rel))) rel = `members/shared/${String(u.name).replace(TEXT, "")}-${u.id.slice(3, 11)}.${String(u.name).split(".").pop()}`;
    if (existsSync(join(this.o.folder, rel))) throw new AccessError("chat_upload_exists");
    refuseWebsiteRoot(this.o.folder, join(this.o.folder, rel), (l) => new AccessError(l));
    copyFileSync(src, join(this.o.folder, rel));
    this.a.write(() => this.a.db.prepare("UPDATE chat_uploads SET shared_path=?, shared_at=? WHERE id=?").run(rel, this.now(), u.id));
    return this.uploadView(u.id);
  }
  private uploadView(id: string) {
    const u = this.a.read(() => this.a.db.prepare("SELECT * FROM chat_uploads WHERE id=?").get(id)) as Record<string, any>;
    return { uploadId: u.id, conversationId: u.conversation_id, name: u.name, path: u.path, sha256: "sha256:" + u.sha256, bytes: u.bytes, at: u.at, sharedPath: u.shared_path, sharedAt: u.shared_at };
  }
  /** TEAM-TASKS-V1 T2b (F-1): the bytes of ONE of the member's own text uploads, hash re-checked, for "Make this a task" (the
   *  task store COPIES them after the member confirmed the disclosure; a private chat row is never read later). */
  adoptable(memberId: string, uploadId: unknown) {
    const u = typeof uploadId === "string" && /^up_[a-f0-9]{32}$/.test(uploadId)
      ? this.a.read(() => this.a.db.prepare("SELECT * FROM chat_uploads WHERE id=? AND member_id=?").get(uploadId, memberId)) as Record<string, any> | undefined : undefined;
    if (!u) throw new AccessError("teamtask_adoption_refused");
    const src = join(this.o.folder, u.path), bytes = existsSync(src) ? readFileSync(src) : null;
    if (!bytes || sha(bytes) !== u.sha256) throw new AccessError("teamtask_adoption_refused");
    return { uploadId: u.id as string, name: u.name as string, bytes, sha256: "sha256:" + u.sha256 };
  }
  uploads(memberId: string, conversationId: string) {
    return (this.a.read(() => this.a.db.prepare("SELECT id FROM chat_uploads WHERE member_id=? AND conversation_id=? ORDER BY at").all(memberId, conversationId)) as { id: string }[]).map((r) => this.uploadView(r.id));
  }
  /** Record who approved a member notes file (the notes.approve handler calls this after the write). */
  notesApproved(path: string, memberId: string, operationId: string) {
    this.a.write(() => this.a.db.prepare("INSERT OR IGNORE INTO notes_provenance(path,member_id,operation_id,at) VALUES (?,?,?,?)").run(path, memberId, operationId, this.now()));
  }

  /** The roots a member may browse: members/ (without other people's uploads); reviewers add their private roots. */
  private visible(m: { memberId: string; role: string }, rel: string) {
    if (!TEXT.test(rel) || rel.split("/").some((s) => !s || s.startsWith(".") || s === "..")) return false;
    if (rel.startsWith("members/uploads/")) return rel.startsWith(`members/uploads/${m.memberId}/`);
    if (rel.startsWith("members/")) return true;
    return ["admin", "reviewer"].includes(m.role) && (rel.startsWith("reviewers-private/intake/") || rel.startsWith("reviewers-private/transcripts/"));
  }
  private walk(m: { memberId: string; role: string }) {
    const out: string[] = [];
    const go = (rel: string, depth: number) => {
      const abs = join(this.o.folder, rel);
      if (depth > 6 || out.length >= 2000) return;
      let st; try { st = lstatSync(abs); } catch { return; } // vanished mid-walk (WC-1 swap): not listed
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) { let names: string[] = []; try { names = readdirSync(abs); } catch { return; } for (const n of names.sort()) if (!n.startsWith(".")) go(`${rel}/${n}`, depth + 1); return; }
      if (st.isFile() && this.visible(m, rel)) out.push(rel);
    };
    for (const r of ["members", ...(["admin", "reviewer"].includes(m.role) ? ["reviewers-private/intake", "reviewers-private/transcripts"] : [])]) go(r, 0);
    return out;
  }
  private provenance(rel: string, mtime: string) {
    const email = (id: string | null) => id ? (this.a.db.prepare("SELECT email FROM access_members WHERE member_id=?").get(id) as { email: string } | undefined)?.email ?? "a former member" : null;
    if (rel.startsWith("members/website/")) return this.o.website?.()?.provenance(rel) ?? { addedBy: null, at: mtime, from: "The website copy", visibleTo: "All members and the agent" };
    return this.a.read(() => {
      const up = this.a.db.prepare("SELECT * FROM chat_uploads WHERE path=? OR shared_path=?").get(rel, rel) as Record<string, any> | undefined;
      if (up) return up.shared_path === rel
        ? { addedBy: email(up.member_id), at: up.shared_at, from: "Shared from a chat upload", visibleTo: "All members and the agent" }
        : { addedBy: email(up.member_id), at: up.at, from: "Uploaded in a chat", visibleTo: "Only that chat (and its member)" };
      const d = this.o.drive?.()?.textProvenance(rel);
      if (d) return { addedBy: email(d.memberId), at: d.at, from: "Uploaded to the shared drive", visibleTo: "All members and the agent" };
      if (rel === "members/drive/images.md") return { addedBy: null, at: mtime, from: "The list of shared drive images", visibleTo: "All members and the agent" };
      const n = this.a.db.prepare("SELECT * FROM notes_provenance WHERE path=?").get(rel.replace(/^members\//, "")) as Record<string, any> | undefined;
      if (n) return { addedBy: email(n.member_id), at: n.at, from: "Approved meeting notes", visibleTo: "All members and the agent" };
      const im = /^reviewers-private\/intake\/(intake_[a-f0-9]{32})\//.exec(rel);
      const ir = im ? this.a.db.prepare("SELECT member_id, received_at, installation_id FROM intake_records WHERE intake_id=?").get(im[1]) as Record<string, any> | undefined : undefined;
      if (ir) return { addedBy: email(ir.member_id), at: ir.received_at, from: ir.installation_id === "web-reviewer" ? "Added on the Review page" : "Submitted by email", visibleTo: "Reviewers" };
      if (rel.startsWith("reviewers-private/transcripts/")) return { addedBy: null, at: mtime, from: "Meeting transcript", visibleTo: "Reviewers" };
      return { addedBy: null, at: mtime, from: "The organization folder", visibleTo: "All members and the agent" };
    });
  }
  list(m: { memberId: string; role: string }) {
    return { files: this.walk(m).flatMap((rel) => { let st; try { st = lstatSync(join(this.o.folder, rel)); } catch { return []; } // vanished mid-swap
      return [{ path: rel, folder: rel.split("/").slice(0, -1).join("/"), name: rel.split("/").at(-1)!, bytes: st.size, ...this.provenance(rel, st.mtime.toISOString()) }]; }),
      // WC-2: the website copy's state for the Files page (null when the org has no website connected).
      website: this.o.website?.()?.status() ?? null };
  }
  read(m: { memberId: string; role: string }, b: { path?: unknown }) {
    const rel = typeof b?.path === "string" ? b.path : "";
    if (!this.visible(m, rel) || !this.walk(m).includes(rel)) throw new AccessError("files_unknown");
    const buf = readFileSync(join(this.o.folder, rel)), st = lstatSync(join(this.o.folder, rel));
    if (buf.length > 192 * 1024) throw new AccessError("files_too_large"); // the hub relays answers up to 256 KiB
    return { path: rel, text: buf.toString("utf8"), sha256: "sha256:" + sha(buf), bytes: buf.length, ...this.provenance(rel, st.mtime.toISOString()) };
  }
}
