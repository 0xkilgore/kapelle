// LIBRARY L1 (owner Oct 26: "just store the files in the droplet. it can be like a shared drive"; Fable FABLE-REVIEW-ORG-FILE-
// LIBRARY-R2 Addendum 3 P-4): the Files tab is the team's shared drive on the droplet.
// - Images: only the decoder's normalized JPEG (IMAGES-V1 I3 sanitizer: decoded, metadata stripped, re-encoded) is stored, once
//   per content hash, in stateRoot/library/<sha256>.jpg (backed up: B1). Never under the folder or a webroot. A drive image is
//   visible to every member and listed for the agent by name and size (never its pixels); NOTHING in the drive is public by
//   itself (L2: only a prepared newsletter release publishes an image).
// - The agent's list: a generated file, members/drive/images.md, rewritten on every change, in the website image list's line
//   format. It is in every member conversation's snapshot (members/), in the backups (the folder), and is what
//   list_site_images and the newsletter image rule read alongside the website's list.
// - Text files: members/shared/ (the existing "Share" target) gains a direct upload, recorded with provenance.
// - Removal: reviewers and admins (journaled). A published image is refused until an admin unpublishes it (L2).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AccessError } from "../../access/org-access.js";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import { refuseWebsiteRoot } from "../website/content-root.js";
import { drivePublicUrl } from "../newsletter/render-cp.js";

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
/** The generated list of drive images the agent may place (members/ scope: every member's snapshot). */
export const DRIVE_LIST_FILE = "members/drive/images.md";
export const DRIVE_LIMITS = { perMember: 50, textBytes: 48 * 1024 };
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const TEXT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}\.(md|txt|csv)$/;
type Member = { memberId: string; role: string };
const reviewer = (m: Member) => { if (!["admin", "reviewer"].includes(m.role)) throw new AccessError("access_role_not_permitted"); };
/** A plain image name: the file name without its extension, trimmed; refused unless it is plain. */
export function driveImageName(raw: unknown): string {
  const n = typeof raw === "string" ? raw.trim().replace(/\.(jpe?g|png|webp)$/i, "").trim() : "";
  if (!IMAGE_NAME.test(n)) throw new AccessError("drive_name_invalid");
  return n;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS library_images(sha256 TEXT PRIMARY KEY, name TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL,
  saved_by TEXT NOT NULL, saved_at TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('chat','drive')), source_image_id TEXT, deleted_at TEXT, deleted_by TEXT) STRICT;
CREATE TABLE IF NOT EXISTS drive_texts(path TEXT PRIMARY KEY, member_id TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, at TEXT NOT NULL,
  deleted_at TEXT, deleted_by TEXT) STRICT;
CREATE TABLE IF NOT EXISTS library_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, member_id TEXT, event TEXT NOT NULL, target TEXT NOT NULL, detail TEXT) STRICT;`;

export class SharedDrive {
  readonly dir: string;
  private readonly now: () => string;
  /** L2 sets this: a published image cannot be removed from the drive until an admin unpublishes it. */
  isPublished: (sha256: string) => boolean = () => false;
  constructor(private readonly a: SqliteAuthority, private readonly o: { stateRoot: string; folder: string; orgId: string; newsletterImages?: boolean }, now?: () => string) {
    this.now = now ?? (() => new Date().toISOString());
    a.db.exec(SCHEMA);
    this.dir = join(o.stateRoot, "library");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  private journal(memberId: string | null, event: string, target: string, detail: unknown = null) {
    this.a.db.prepare("INSERT INTO library_journal(at,member_id,event,target,detail) VALUES (?,?,?,?,?)").run(this.now(), memberId, event, target, detail === null ? null : JSON.stringify(detail));
  }
  /** Bytes the drive holds (counted with chat images against the org's storage cap). Call INSIDE the caller's transaction. */
  bytesUsed() { return (this.a.db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM library_images WHERE deleted_at IS NULL").get() as { n: number }).n; }
  /** Store one ALREADY-NORMALIZED JPEG (the decoder's output, never an original). Idempotent per content hash. */
  save(m: Member, data: Buffer, meta: { width: number; height: number; name: string; source: "chat" | "drive"; sourceImageId?: string | null }) {
    const h = sha(data), name = driveImageName(meta.name), file = join(this.dir, h + ".jpg");
    const r = this.a.write(() => {
      const prior = this.a.db.prepare("SELECT deleted_at FROM library_images WHERE sha256=?").get(h) as { deleted_at: string | null } | undefined;
      if (prior && !prior.deleted_at) return { saved: false };
      if ((this.a.db.prepare("SELECT COUNT(*) AS n FROM library_images WHERE saved_by=? AND deleted_at IS NULL").get(m.memberId) as { n: number }).n >= DRIVE_LIMITS.perMember)
        throw new AccessError("drive_limit");
      if (existsSync(file)) { if (sha(readFileSync(file)) !== h) throw new AccessError("drive_store_failed"); }
      else { const tmp = join(this.dir, `.${h}.tmp`); writeFileSync(tmp, data, { mode: 0o600, flag: "w" }); renameSync(tmp, file); }
      if (prior) this.a.db.prepare("UPDATE library_images SET name=?, saved_by=?, saved_at=?, source=?, source_image_id=?, deleted_at=NULL, deleted_by=NULL WHERE sha256=?")
        .run(name, m.memberId, this.now(), meta.source, meta.sourceImageId ?? null, h);
      else this.a.db.prepare("INSERT INTO library_images(sha256,name,width,height,bytes,saved_by,saved_at,source,source_image_id,deleted_at,deleted_by) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL)")
        .run(h, name, meta.width, meta.height, data.length, m.memberId, this.now(), meta.source, meta.sourceImageId ?? null);
      this.journal(m.memberId, meta.source === "chat" ? "saved_from_chat" : "uploaded", h, { name });
      return { saved: true };
    });
    if (r.saved) this.writeList();
    return { ...this.view(h)!, deduplicated: !r.saved };
  }
  private view(h: string) {
    const r = this.a.read(() => this.a.db.prepare("SELECT * FROM library_images WHERE sha256=? AND deleted_at IS NULL").get(h)) as Record<string, any> | undefined;
    if (!r) return null;
    const email = this.a.read(() => (this.a.db.prepare("SELECT email FROM access_members WHERE member_id=?").get(r.saved_by) as { email: string } | undefined)?.email ?? "a former member");
    return { sha256: r.sha256 as string, name: r.name as string, width: r.width as number, height: r.height as number, bytes: r.bytes as number, addedBy: email, at: r.saved_at as string,
      from: r.source === "chat" ? "Saved from a chat" : "Uploaded to the shared drive", url: drivePublicUrl(this.o.orgId, r.sha256), published: this.isPublished(r.sha256) };
  }
  /** One live drive image's card facts, or null. */
  info(h: string) { return this.view(h); }
  /** Every live drive image, newest first (any member). */
  list() {
    return (this.a.read(() => this.a.db.prepare("SELECT sha256 FROM library_images WHERE deleted_at IS NULL ORDER BY saved_at DESC, sha256").all()) as { sha256: string }[])
      .map((r) => this.view(r.sha256)!);
  }
  /** True once any image was ever saved (removed ones count): the list file exists from then on. */
  everHadImages() { return !!this.a.read(() => this.a.db.prepare("SELECT 1 FROM library_images LIMIT 1").get()); }
  /** True when the hash is a live drive image (the newsletter image rule's check). */
  has(h: string) { return !!this.a.read(() => this.a.db.prepare("SELECT 1 FROM library_images WHERE sha256=? AND deleted_at IS NULL").get(h)); }
  /** The bytes of one live drive image, re-hashed (a mismatch is never served). Any member (the thumbnail GET). */
  read(h: unknown) {
    if (typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h) || !this.has(h)) throw new AccessError("drive_image_unknown");
    return this.bytes(h);
  }
  /** The stored bytes of a hash (live or removed), re-hashed; null when absent or changed. */
  bytes(h: string) {
    const f = join(this.dir, h + ".jpg");
    const data = existsSync(f) ? readFileSync(f) : null;
    if (!data || sha(data) !== h) throw new AccessError("drive_image_unreadable");
    return { data, sha256: h };
  }
  /** A text file straight into members/shared/ (the same rules as a chat upload's share), with provenance. */
  uploadText(m: Member, b: { fileName?: unknown; text?: unknown }) {
    if (typeof b?.fileName !== "string" || !TEXT_NAME.test(b.fileName.trim())) throw new AccessError("chat_upload_type_not_admitted");
    if (typeof b.text !== "string") throw new AccessError("chat_upload_empty");
    const text = b.text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
    if (!text.trim()) throw new AccessError("chat_upload_empty");
    const bytes = Buffer.from(text);
    if (bytes.length > DRIVE_LIMITS.textBytes) throw new AccessError("chat_upload_too_large");
    const rel = `members/shared/${b.fileName.trim()}`, abs = join(this.o.folder, rel);
    refuseWebsiteRoot(this.o.folder, abs, (l) => new AccessError(l));
    if (existsSync(abs)) throw new AccessError("chat_upload_exists");
    if ((this.a.read(() => this.a.db.prepare("SELECT COUNT(*) AS n FROM drive_texts WHERE member_id=? AND deleted_at IS NULL").get(m.memberId)) as { n: number }).n >= DRIVE_LIMITS.perMember)
      throw new AccessError("drive_limit");
    mkdirSync(join(this.o.folder, "members", "shared"), { recursive: true, mode: 0o700 });
    writeFileSync(abs, bytes, { mode: 0o600, flag: "wx" });
    this.a.write(() => {
      this.a.db.prepare("INSERT OR REPLACE INTO drive_texts(path,member_id,sha256,bytes,at,deleted_at,deleted_by) VALUES (?,?,?,?,?,NULL,NULL)").run(rel, m.memberId, sha(bytes), bytes.length, this.now());
      this.journal(m.memberId, "uploaded", rel);
    });
    return { path: rel, sha256: "sha256:" + sha(bytes), bytes: bytes.length };
  }
  /** Provenance for a directly uploaded drive text file (the Files page), or null. Call INSIDE the caller's transaction. */
  textProvenance(rel: string) {
    const r = this.a.db.prepare("SELECT member_id, at FROM drive_texts WHERE path=? AND deleted_at IS NULL").get(rel) as { member_id: string; at: string } | undefined;
    return r ? { memberId: r.member_id, at: r.at } : null;
  }
  /** Reviewers and admins remove a drive file: an image by hash, or a text file under members/shared/. Journaled. */
  remove(m: Member, b: { sha256?: unknown; path?: unknown }) {
    reviewer(m);
    if (typeof b?.sha256 === "string") {
      const h = b.sha256;
      if (!/^[a-f0-9]{64}$/.test(h) || !this.has(h)) throw new AccessError("drive_image_unknown");
      if (this.isPublished(h)) throw new AccessError("drive_image_published");
      this.a.write(() => {
        this.a.db.prepare("UPDATE library_images SET deleted_at=?, deleted_by=? WHERE sha256=? AND deleted_at IS NULL").run(this.now(), m.memberId, h);
        this.journal(m.memberId, "removed", h);
      });
      rmSync(join(this.dir, h + ".jpg"), { force: true });
      this.writeList();
      return { removed: h };
    }
    const rel = typeof b?.path === "string" ? b.path : "";
    if (!/^members\/shared\/[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}\.(md|txt|csv)$/.test(rel)) throw new AccessError("files_unknown");
    const abs = join(this.o.folder, rel);
    refuseWebsiteRoot(this.o.folder, abs, (l) => new AccessError(l));
    if (!existsSync(abs)) throw new AccessError("files_unknown");
    rmSync(abs);
    this.a.write(() => {
      this.a.db.prepare("UPDATE drive_texts SET deleted_at=?, deleted_by=? WHERE path=? AND deleted_at IS NULL").run(this.now(), m.memberId, rel);
      this.journal(m.memberId, "removed", rel);
    });
    return { removed: rel };
  }
  /** Rewrite members/drive/images.md (temp + rename): one line per live image, the website list's format. */
  writeList() {
    // With the public files route off (L2, Fable L-12) the list names no addresses: a newsletter could not use them.
    const imgs = this.o.newsletterImages ? this.list() : [];
    const body = "# Shared drive images\n\n" + (this.o.newsletterImages ? "Images members saved to the shared drive. A newsletter may use these addresses.\n\n"
      : "Shared drive images can't be used in a newsletter yet.\n") + imgs.map((i) => `- ${i.url} (${i.name}, ${i.width}x${i.height})`).join("\n") + (imgs.length ? "\n" : "");
    const dir = join(this.o.folder, "members", "drive"), file = join(this.o.folder, DRIVE_LIST_FILE), tmp = join(dir, ".images.md.tmp");
    refuseWebsiteRoot(this.o.folder, file, (l) => new AccessError(l));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, body, { mode: 0o600 }); renameSync(tmp, file);
  }
  stats() {
    return this.a.read(() => ({ ...(this.a.db.prepare("SELECT COUNT(*) AS images, COALESCE(SUM(bytes),0) AS bytes FROM library_images WHERE deleted_at IS NULL").get() as { images: number; bytes: number }),
      removed: (this.a.db.prepare("SELECT COUNT(*) AS n FROM library_images WHERE deleted_at IS NOT NULL").get() as { n: number }).n,
      texts: (this.a.db.prepare("SELECT COUNT(*) AS n FROM drive_texts WHERE deleted_at IS NULL").get() as { n: number }).n }));
  }
}
