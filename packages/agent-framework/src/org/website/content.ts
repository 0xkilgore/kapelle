// Chat content v1, WC-1 (PLAN-CHAT-CONTENT-V1; Fable R-1..R-7): a READ-ONLY copy of the org's PUBLIC website content, so
// chat has something to search on a fresh install. Through a GET-only view of the pinned GitHub port, at the base branch's
// commit, it reads src/data/meeting-notes.json, src/data/events.json, content/newsletter/.sent.json and the newsletters
// that .sent.json lists (sent = public; unsent drafts and sample.md never). It writes generated TEXT files under
// members/website/ (meeting-notes/<date>-<slug>.md, events.md, newsletters/<slug>.md), each opening with a provenance
// line, and records per-file provenance. Never copied: broadcast ids, checksums, images, any other repo file.
// - Names from repo data are untrusted (R-1): dates must be YYYY-MM-DD, slugs [a-z0-9-]{1,80}, every path is checked to
//   resolve under members/website/; anything else is skipped and counted.
// - Bounded (R-3): source files <= 512 KiB, generated files <= 200 KiB (longer ones end "… (truncated)"), <= 200 files and
//   4 MiB, and the set must leave every snapshot (member or reviewer, with a full upload allowance) inside SNAPSHOT_LIMITS.
// - Swap (R-4): built in members/.website-next/, then live -> members/.website-prev, next -> live, prev removed by its fixed
//   path. A failed sync keeps the last good set; the snapshot builder tolerates the root vanishing mid-walk.
// - Raw-HTML newsletter bodies become plain text by htmlToText (R-5; own code, no dependency). Markdown passes unchanged.
// WC-2 (Fable R-8, WC-1 N-2): runs at start, every 6 h and on a reviewer's refresh (12 per org per 24 h). When the base
// branch's commit and the renderer are those of the last good set, only the one refSha GET is made. One sync at a time,
// inside a 60 s wall deadline (a hung GitHub cannot hold the slot; an abandoned GET is harmless).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import { AccessError } from "../../access/org-access.js";
import { SNAPSHOT_LIMITS } from "../chat/tools.js";
import { UPLOAD_LIMITS } from "../chat/files.js";
import { WebsiteError, type GithubPort } from "./github.js";
import { WEBSITE_CONTENT_ROOT, SITE_IMAGES_FILE } from "./content-root.js";

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
export const CONTENT_LIMITS = { sourceBytes: 512 * 1024, fileBytes: 200 * 1024, files: 200, totalBytes: 4 * 1024 * 1024, deadlineMs: 60_000, refreshPerDay: 12 };
/** Bump when the generated text changes shape: an unchanged commit is then rendered again. v2 (Package F, Fable H-8): site-images.md. */
export const CONTENT_RENDERER = "kapelle.website-content/v2";
/** Package F (Fable H-8): the site's newsletter images, as the E-1 URLs they are served at (public/<rest> -> SITE/<rest>). The list
 *  is a generated TEXT file in the website set, so every snapshot carries it and the agent never fetches anything at chat time. */
export const SITE_IMAGES_MAX = 200;
export function siteImagePaths(paths: Iterable<string>) {
  return [...paths].filter((p) => /^public\/(newsletter|images)\/[A-Za-z0-9._\/-]{1,200}\.(jpe?g|png|webp|gif)$/i.test(p) && !p.includes("..") && !p.includes("//")).sort().slice(0, SITE_IMAGES_MAX);
}
export type SyncTrigger = "start" | "timer" | "manual";
export const CONTENT_SOURCES = { meetings: "src/data/meeting-notes.json", events: "src/data/events.json", sent: "content/newsletter/.sent.json" } as const;
const fail = (label: string): never => { throw new WebsiteError(label); };

/** R-6: what the sync may call. An object literal of three closures over the port: the write methods are unreachable. */
export type ContentReader = { refSha: GithubPort["refSha"]; file: GithubPort["file"]; treePaths: GithubPort["treePaths"] };
export function contentReader(p: GithubPort): ContentReader {
  return { refSha: (b) => p.refSha(b), file: (path, c) => p.file(path, c), treePaths: (c) => p.treePaths(c) };
}

// ---- R-5: raw HTML -> plain text (script/style/head and friends dropped with their content; links only https:/mailto:) ----
const DROP = new Set(["script", "style", "head", "title", "noscript", "template", "svg", "iframe", "object", "embed", "math"]);
const BLOCK = new Set(["p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "section", "article", "header", "footer", "blockquote", "hr", "ul", "ol", "center"]);
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", ldquo: "“",
  rdquo: "”", hellip: "…", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·", eacute: "é", rarr: "→", larr: "←" };
/** Entities decoded ONCE, in a single pass: "&amp;lt;" becomes "&lt;", never "<". Unknown entities stay as written. */
export const decodeEntities = (s: string) => s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (m, e: string) => {
  if (e[0] !== "#") return NAMED[e] ?? m;
  const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
});
export function htmlToText(html: string) {
  if (Buffer.byteLength(html) > CONTENT_LIMITS.sourceBytes) fail("website_content_too_large");
  let out = "", i = 0, href: string | null = null, aStart = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) { const e = html.indexOf("-->", lt + 4); i = e < 0 ? html.length : e + 3; continue; }
    let gt = lt + 1, q = "";                    // the tag's end, skipping quoted attribute values (a ">" inside quotes)
    for (; gt < html.length; gt++) { const c = html[gt]; if (q) { if (c === q) q = ""; } else if (c === '"' || c === "'") q = c; else if (c === ">") break; }
    if (gt >= html.length) break;               // an unterminated tag: the rest is dropped
    const tag = html.slice(lt + 1, gt), m = /^(\/?)([A-Za-z][A-Za-z0-9]*)/.exec(tag);
    i = gt + 1;
    if (!m) continue;                           // <!DOCTYPE>, <?xml?>, stray "<": nothing
    const name = m[2].toLowerCase(), closing = m[1] === "/";
    if (!closing && DROP.has(name)) { const end = new RegExp(`</${name}\\s*>`, "gi"); end.lastIndex = i; i = end.exec(html) ? end.lastIndex : html.length; continue; }
    if (name === "a") {
      if (!closing) { const h = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag), v = h ? decodeEntities((h[1] ?? h[2] ?? h[3]).trim()) : "";
        href = /^(https:\/\/|mailto:)[^\s<>"']{1,500}$/i.test(v) ? v : null; aStart = out.length; }
      else if (href) { if (out.slice(aStart).trim()) out += ` (${href.replace(/&/g, "&amp;")})`; href = null; } // an image-only link: no bare "(url)"
      continue;
    }
    if (name === "li") { if (!closing) out += "\n- "; }
    else if (name === "td" || name === "th") out += " ";
    else if (BLOCK.has(name)) out += "\n";
  }
  return decodeEntities(out).replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- R-1: names and text from repo data ----
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Reduce to [a-z0-9-]{1,80}; null when nothing usable is left. */
export const slugOf = (v: unknown) => { const s = typeof v === "string" ? v.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "") : "";
  return s ? s : null; };
const text = (v: unknown) => typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "") : typeof v === "number" ? String(v) : "";
const line = (v: unknown) => text(v).replace(/\s+/g, " ").trim();
/** A simple "key: value" front-matter block (quoted or bare values); returns the fields and the body after it. */
export function frontMatter(src: string) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src.replace(/\r\n?/g, "\n"));
  if (!m) return { fields: {} as Record<string, string>, body: src };
  const fields: Record<string, string> = {};
  for (const l of m[1].split("\n")) { const f = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(l); if (f) fields[f[1]] = f[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"); }
  return { fields, body: src.replace(/\r\n?/g, "\n").slice(m[0].length) };
}

export type Generated = { rel: string; text: string; sourcePath: string; blobSha: string };
type Source = { path: string; blobSha: string; text: string };
const provenanceLine = (repo: string, path: string, commit: string, at: string) => `Source: ${repo} ${path} at commit ${commit.slice(0, 7)}, fetched ${at}.`;
/** Cap one generated file at CONTENT_LIMITS.fileBytes (whole lines; a final "… (truncated)" line). */
function capped(body: string) {
  if (Buffer.byteLength(body) <= CONTENT_LIMITS.fileBytes) return body;
  const lines = body.split("\n"), keep: string[] = []; let n = Buffer.byteLength("… (truncated)\n");
  for (const l of lines) { const b = Buffer.byteLength(l) + 1; if (n + b > CONTENT_LIMITS.fileBytes) break; keep.push(l); n += b; }
  return keep.join("\n") + "\n… (truncated)\n";
}

/** Render the generated set from the fetched sources (pure; tests drive it directly). `skipped` counts refused items. */
export function renderContent(o: { repo: string; commit: string; at: string; meetings: Source | null; events: Source | null; newsletters: { slug: string; sentAt: string; src: Source }[];
  siteImages?: { base: string; paths: string[] } }) {
  const files: Generated[] = [], names = new Set<string>(); let skipped = 0;
  const add = (rel: string, src: Source, body: string) => {
    const r = relative(WEBSITE_CONTENT_ROOT, rel);
    if (names.has(rel) || !r || r.startsWith("..") || isAbsolute(r) || !/^[a-z0-9-]+(\/[a-z0-9-]+)?\.md$/.test(r)) { skipped++; return; }
    names.add(rel); files.push({ rel, sourcePath: src.path, blobSha: src.blobSha, text: capped(provenanceLine(o.repo, src.path, o.commit, o.at) + "\n\n" + body.trim() + "\n") });
  };
  const json = (s: Source) => { try { return JSON.parse(s.text); } catch { return fail("website_content_malformed"); } };
  if (o.meetings) {
    const d = json(o.meetings), list = Array.isArray(d?.meetings) ? d.meetings : fail("website_content_malformed");
    for (const m of list) {
      const date = typeof m?.date === "string" && DATE.test(m.date) ? m.date : null, slug = slugOf(m?.slug);
      if (!date || !slug || !Array.isArray(m.sections)) { skipped++; continue; }
      const body = [`# ${line(m.title) || "Meeting notes"}`, `Date: ${date}`, ...m.sections.map((s: any) => `## ${line(s?.heading) || "Notes"}\n\n${text(s?.body).trim()}`)].join("\n\n");
      add(`${WEBSITE_CONTENT_ROOT}/meeting-notes/${date}-${slug}.md`, o.meetings, body);
    }
  }
  if (o.events) {
    const d = json(o.events);
    if (!d || typeof d !== "object") fail("website_content_malformed");
    const one = (e: any) => {
      const date = typeof e?.date === "string" && DATE.test(e.date) ? e.date : null;
      if (!date || !line(e?.title)) { skipped++; return null; }
      const contact = e.contact && typeof e.contact === "object" ? [line(e.contact.name), line(e.contact.email) && `(${line(e.contact.email)})`].filter(Boolean).join(" ") : line(e.contact);
      return [`## ${line(e.title)}`, `Date: ${date}`, line(e.time) && `Time: ${line(e.time)}`, line(e.location) && `Location: ${line(e.location)}`,
        line(e.address) && `Address: ${line(e.address)}`, contact && `Contact: ${contact}`, text(e.description).trim()].filter(Boolean).join("\n");
    };
    const up = (Array.isArray(d.events) ? d.events : []).map(one).filter(Boolean), past = (Array.isArray(d.pastEvents) ? d.pastEvents : []).map(one).filter(Boolean);
    add(`${WEBSITE_CONTENT_ROOT}/events.md`, o.events, ["# Events", "## Upcoming and recent", ...(up.length ? up : ["None listed."]), ...(past.length ? ["# Past events", ...past] : [])].join("\n\n"));
  }
  for (const n of o.newsletters) {
    const { fields, body } = frontMatter(n.src.text);
    const plain = fields.format === "raw_html" ? htmlToText(body) : text(body).trim();
    add(`${WEBSITE_CONTENT_ROOT}/newsletters/${n.slug}.md`, n.src, [`# ${line(fields.subject_line) || line(fields.title) || n.slug}`, `Sent: ${n.sentAt.slice(0, 10)}`,
      line(fields.preview_text) && `Summary: ${line(fields.preview_text)}`, plain].filter(Boolean).join("\n\n"));
  }
  if (o.siteImages) {
    const lines = o.siteImages.paths.map((p) => `- ${o.siteImages!.base}/${p.slice("public/".length)} (${p.replace(/^.*\//, "").replace(/\.[a-z]+$/i, "").replace(/[-_.]+/g, " ").trim()})`);
    add(SITE_IMAGES_FILE, { path: "public/newsletter, public/images", blobSha: sha(lines.join("\n")), text: "" },
      ["# Site images", "The newsletter may use only these images (each line: the address, then a hint from its file name).", ...(lines.length ? lines : ["None found."])].join("\n\n"));
  }
  return { files, skipped };
}

/** Files and bytes the snapshot would read outside the website set (text, regular, <= maxFileBytes), for the R-3 check. */
function otherSnapshotLoad(folder: string) {
  let files = 0, bytes = 0;
  const walk = (rel: string) => {
    let st; try { st = lstatSync(join(folder, rel)); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { if (rel === WEBSITE_CONTENT_ROOT || rel === "members/uploads") return; let names: string[] = []; try { names = readdirSync(join(folder, rel)); } catch { return; }
      for (const n of names) if (!n.startsWith(".")) walk(`${rel}/${n}`); return; }
    if (st.isFile() && st.nlink === 1 && /\.(md|txt|csv)$/i.test(rel) && st.size <= SNAPSHOT_LIMITS.maxFileBytes) { files++; bytes += st.size; }
  };
  for (const r of ["members", "reviewers-private/intake", "reviewers-private/transcripts"]) walk(r);
  // A conversation also reads its own uploads: allow the full per-member upload allowance.
  return { files: files + UPLOAD_LIMITS.perMember, bytes: bytes + UPLOAD_LIMITS.perMember * UPLOAD_LIMITS.bytes };
}

export type ContentStatus = { commit: string | null; fetchedAt: string | null; files: number; lastOutcome: string | null; lastAt: string | null; running: boolean };

export class WebsiteContent {
  private running: Promise<{ ok: boolean; label?: string; unchanged?: boolean }> | null = null;
  constructor(private readonly a: SqliteAuthority, private readonly o: { folder: string; repo: string; baseBranch: string; reader: () => ContentReader; deadlineMs?: number;
    /** Package F (H-8): the site origin images are served from (the newsletter's E-1 host); absent = no site-images.md. */
    siteImagesBase?: string },
    private readonly now: () => string = () => new Date().toISOString()) {
    a.db.exec(`CREATE TABLE IF NOT EXISTS website_content_files(path TEXT PRIMARY KEY, repo TEXT NOT NULL, source_path TEXT NOT NULL, commit_sha TEXT NOT NULL,
        blob_sha TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, fetched_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS website_content_syncs(id TEXT PRIMARY KEY, at TEXT NOT NULL, commit_sha TEXT, files INTEGER NOT NULL, bytes INTEGER NOT NULL,
        skipped INTEGER NOT NULL, outcome TEXT NOT NULL, trigger TEXT NOT NULL, renderer TEXT NOT NULL) STRICT;`);
    // A crash between the swap's two renames leaves only .website-prev: it is the last good set, put it back.
    const live = join(o.folder, WEBSITE_CONTENT_ROOT), prev = join(o.folder, "members", ".website-prev");
    if (!existsSync(live) && existsSync(prev)) renameSync(prev, live);
  }
  /** One sync at a time: a second call while one runs returns the running one. */
  sync(trigger: SyncTrigger = "manual") { return this.running ??= this.run(trigger).finally(() => { this.running = null; }); }
  /** A reviewer's refresh (R-8): joins a running sync, else at most CONTENT_LIMITS.refreshPerDay manual syncs per 24 h. */
  refresh() {
    if (this.running) return this.running;
    const since = new Date(Date.parse(this.now()) - 86_400_000).toISOString();
    const n = (this.a.read(() => this.a.db.prepare("SELECT COUNT(*) AS n FROM website_content_syncs WHERE trigger='manual' AND at>?").get(since)) as { n: number }).n;
    if (n >= CONTENT_LIMITS.refreshPerDay) throw new AccessError("website_content_refresh_cap");
    return this.sync("manual");
  }
  /** Resolves when no sync is running (close waits for it). */
  idle() { return (this.running ?? Promise.resolve()).then(() => {}, () => {}); }
  private async run(trigger: SyncTrigger): Promise<{ ok: boolean; label?: string; unchanged?: boolean }> {
    const at = this.now(), id = "wcs_" + randomUUID().replaceAll("-", ""), members = join(this.o.folder, "members");
    const next = join(members, ".website-next"), prev = join(members, ".website-prev"), live = join(this.o.folder, WEBSITE_CONTENT_ROOT);
    let commit: string | null = null;
    // N-2: one wall deadline over every GET; past it the sync fails and frees the slot (the abandoned GET is harmless).
    const end = Date.now() + (this.o.deadlineMs ?? CONTENT_LIMITS.deadlineMs);
    const within = <T>(p: Promise<T>) => new Promise<T>((res, rej) => {
      const t = setTimeout(() => rej(new WebsiteError("website_content_deadline")), Math.max(0, end - Date.now())); t.unref?.();
      p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
    });
    const row = (outcome: string, files = 0, bytes = 0, skipped = 0) => this.a.db.prepare("INSERT INTO website_content_syncs(id,at,commit_sha,files,bytes,skipped,outcome,trigger,renderer) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, at, commit, files, bytes, skipped, outcome, trigger, CONTENT_RENDERER);
    try {
      const r = this.o.reader();
      commit = (await within(r.refSha(this.o.baseBranch))) ?? fail("website_content_failed");
      const good = this.a.read(() => this.a.db.prepare("SELECT commit_sha, renderer FROM website_content_syncs WHERE outcome='ok' ORDER BY at DESC, rowid DESC LIMIT 1").get()) as { commit_sha: string; renderer: string } | undefined;
      if (good && good.commit_sha === commit && good.renderer === CONTENT_RENDERER && existsSync(live)) {
        this.a.write(() => row("unchanged"));
        return { ok: true, unchanged: true };
      }
      const get = async (path: string): Promise<Source | null> => {
        const f = await within(r.file(path, commit!));
        if (!f) return null;
        if (f.bytes.length > CONTENT_LIMITS.sourceBytes) fail("website_content_too_large");
        return { path, blobSha: f.blobSha, text: f.bytes.toString("utf8") };
      };
      const meetings = await get(CONTENT_SOURCES.meetings), events = await get(CONTENT_SOURCES.events), sent = await get(CONTENT_SOURCES.sent);
      const newsletters: { slug: string; sentAt: string; src: Source }[] = [];
      let skipped = 0;
      if (sent) {
        let list: unknown; try { list = JSON.parse(sent.text); } catch { fail("website_content_malformed"); }
        // The site's send script writes {"sent": [...]} (scripts/send-newsletter.ts); a bare list is read the same way.
        const rows = Array.isArray(list) ? list : Array.isArray((list as any)?.sent) ? (list as any).sent : fail("website_content_malformed");
        for (const s of rows as any[]) {
          // The slug names a repo path: it must ALREADY be clean (never reduced: a reduced slug would read a different file).
          if (typeof s?.slug !== "string" || !/^[a-z0-9-]{1,80}$/.test(s.slug) || s.slug === "sample" || typeof s.sent_at !== "string" || newsletters.some((n) => n.slug === s.slug)) { skipped++; continue; }
          if (newsletters.length >= CONTENT_LIMITS.files) fail("website_content_too_large");
          const src = await get(`content/newsletter/${s.slug}.md`);
          if (src) newsletters.push({ slug: s.slug, sentAt: s.sent_at, src }); else skipped++;
        }
      }
      // Package F (Fable H-8): the image list from the same commit's tree (read-only; two GETs).
      const siteImages = this.o.siteImagesBase ? { base: this.o.siteImagesBase, paths: siteImagePaths(await within(r.treePaths(commit!))) } : undefined;
      const set = renderContent({ repo: this.o.repo, commit, at, meetings, events, newsletters, siteImages });
      skipped += set.skipped;
      const bytes = set.files.reduce((n, f) => n + Buffer.byteLength(f.text), 0), other = otherSnapshotLoad(this.o.folder);
      if (set.files.length > CONTENT_LIMITS.files || bytes > CONTENT_LIMITS.totalBytes) fail("website_content_too_large");
      if (other.files + set.files.length > SNAPSHOT_LIMITS.maxFiles || other.bytes + bytes > SNAPSHOT_LIMITS.maxBytes) fail("website_content_too_large");
      if (Date.now() > end) fail("website_content_deadline");
      // R-4: build next, swap, remove prev (fixed paths under members/).
      if (existsSync(live) && lstatSync(live).isSymbolicLink()) fail("website_content_failed");
      rmSync(next, { recursive: true, force: true }); rmSync(prev, { recursive: true, force: true });
      for (const f of set.files) {
        const abs = join(next, relative(WEBSITE_CONTENT_ROOT, f.rel));
        mkdirSync(join(abs, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(abs, f.text, { mode: 0o600, flag: "wx" });
      }
      mkdirSync(next, { recursive: true, mode: 0o700 });
      if (existsSync(live)) renameSync(live, prev);
      renameSync(next, live);
      rmSync(prev, { recursive: true, force: true });
      this.a.write(() => {
        this.a.db.prepare("DELETE FROM website_content_files").run();
        const ins = this.a.db.prepare("INSERT INTO website_content_files(path,repo,source_path,commit_sha,blob_sha,sha256,bytes,fetched_at) VALUES (?,?,?,?,?,?,?,?)");
        for (const f of set.files) ins.run(f.rel, this.o.repo, f.sourcePath, commit, f.blobSha, sha(f.text), Buffer.byteLength(f.text), at);
        row("ok", set.files.length, bytes, skipped);
      });
      return { ok: true };
    } catch (e) {
      rmSync(next, { recursive: true, force: true });
      // A crash between the two renames leaves only prev: put it back so the last good set stays.
      if (!existsSync(live) && existsSync(prev)) renameSync(prev, live);
      const label = e instanceof WebsiteError ? e.label : "website_content_failed";
      this.a.write(() => row(label));
      return { ok: false, label };
    }
  }
  /** Provenance for a generated file (Files page), or null when the path is not part of the current set. */
  provenance(rel: string) {
    const r = this.a.read(() => this.a.db.prepare("SELECT * FROM website_content_files WHERE path=?").get(rel)) as Record<string, any> | undefined;
    return r ? { addedBy: null, at: r.fetched_at as string, from: `The website (${r.repo}), ${r.source_path} at ${String(r.commit_sha).slice(0, 7)}`, visibleTo: "All members and the agent" } : null;
  }
  status(): ContentStatus {
    return this.a.read(() => {
      const good = this.a.db.prepare("SELECT * FROM website_content_syncs WHERE outcome='ok' ORDER BY at DESC, rowid DESC LIMIT 1").get() as Record<string, any> | undefined;
      const last = this.a.db.prepare("SELECT * FROM website_content_syncs ORDER BY at DESC, rowid DESC LIMIT 1").get() as Record<string, any> | undefined;
      return { commit: good?.commit_sha ?? null, fetchedAt: good?.at ?? null, files: good?.files ?? 0, lastOutcome: last?.outcome ?? null, lastAt: last?.at ?? null, running: !!this.running };
    });
  }
}
