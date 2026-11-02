// Package E T1 (brief 20ebe4ab + addendum a132fb06; Fable e9cdd63c E-1/E-2/E-6, cbae22b4 E-6') and addendum 2 (Fable c06c2772
// E-12..E-15): the CP newsletter renderer v3. Deterministic HTML from the typed content (title, optional headerPhotos,
// sections{heading, body, links}); inline [text](url) links to any https host with provenance. The rules are untouched; the
// catalog's write_draft_artifact describes the link syntax and headerPhotos (toolCatalogHash 5253d856 -> 5d6b3df3).
//
// OSS lift: CP site newsletter template (owner's private repo, lift permitted) — example-org-website
//   src/lib/newsletter-template.tsx (wrapEmailTemplate / renderHeaderHtml): 640 px table shell, header (wordmark, nav, rule,
//   month line, 4-photo strip from /newsletter/photos/), body typography, footer (reply line, Unsubscribe, View on web, org line).
// Adapt notes: styles inlined here (no `juice`), the Google Fonts @import dropped (no external fetch; the site's own fallbacks),
//   the colours and fonts replaced by the site's CURRENT theme tokens (below), the lockup taken from the site header.
// Theme tokens: example-org-website src/app/globals.css @theme (commit 9defe42 "Rebrand site as Example Park with FoCP logo
//   palette"), fonts from src/app/layout.tsx (Fraunces display, Plus Jakarta Sans body), lockup from src/components/Header.tsx.
// Every content string goes through esc(); only **x**, *x* and "- " lists are interpreted, as in v2. No content ever reaches an
// attribute except a URL that passed imageUrl() (E-1) or linkDecision() (E-12/E-13), re-serialized from `new URL`.

export const RENDERER_V3 = "kapelle.newsletter-renderer/v3";
/** The site's current theme tokens (data). `header` is the owner's pick: "navy" = the site hero band, "cream" = the header bar. */
// The lockup text is the site header's own (src/components/Header.tsx: "Example Park" / "Springfield, Example State"); no invented copy.
export const CP_THEME = Object.freeze({
  primary: "#3E6E70", primaryDark: "#171846", primaryLight: "#E3EEED", accent: "#E86129", surface: "#FCF7EE", foreground: "#1E1E30",
  muted: "#66645A", border: "#E8DFCF", header: "navy" as "navy" | "cream",
  display: "Fraunces,Georgia,'Times New Roman',serif", body: "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
});
export const CP_SITE = "https://www.example.org";
const SITE = CP_SITE;
/** E-6: a fixed template constant, never from content (the site has no page for a Kapelle send yet). */
export const VIEW_ON_WEB = `${SITE}/newsletter`;
/** E-6' default: Resend's documented form; the owner's inbox proof decides (a v3 test send waits for it). */
export const UNSUB_TOKEN = "{{{RESEND_UNSUBSCRIBE_URL}}}";
/** The footer's unsubscribe anchor, exactly; the test path replaces the WHOLE anchor with the inert sentence (R-3). */
export const UNSUB_ANCHOR = `<a href="${UNSUB_TOKEN}" style="color:${CP_THEME.muted};text-decoration:underline;">Unsubscribe</a>`;
/** Fable F-1 (dede195b review) / E-6' (proven: the triple form substituted on Sep 29 and Oct 7; the double form was left literal on
 *  Sep 4): EXACTLY one placeholder, the triple form, as the footer anchor's href; a double (a renderer defect) or a missing one
 *  refuses. No other copy of either form anywhere. Checked at prepare and right before the broadcast. */
export function unsubscribeFormOk(html: string) {
  return html.split(UNSUB_TOKEN).length === 2 && html.split(UNSUB_ANCHOR).length === 2 && !html.split(UNSUB_TOKEN).join("").includes("RESEND_UNSUBSCRIBE_URL");
}
/** The default header strip when a draft names no headerPhotos. Director (24 Oct, the owner's ask): four DIFFERENT non-pool site
 *  photos (the September issue's header shots), not the four pool photos of /newsletter/photos/. All E-1, all on the site list. */
export const DEFAULT_HEADER_PHOTOS = Object.freeze(["ice-cream-social-header", "neighborhood-4822-header", "neighborhood-5829-header", "pickleball-courts-open-newsletter"]
  .map((n) => `${SITE}/newsletter/2026-09/${n}.jpg`));
const HEADER_PHOTOS = [...DEFAULT_HEADER_PHOTOS];
const EMBLEM = `${SITE}/images/brand/example-org-emblem.png`;
/** E-1 image hosts (exact); links have no host list since addendum 2 (Fable E-12/E-13: any https host, with provenance). */
export const CP_HOSTS = Object.freeze(["www.example.org", "example.org"]);
export const CP_MAILTO = "mailto:hello@example.org";
/** LIBRARY (Fable R-1): the dedicated host for shared-drive images. One reaches it only once a prepared release published it. */
export const FILES_HOST = "files.example.org";
export const drivePublicUrl = (orgId: string, sha256: string) => `https://${FILES_HOST}/o/${orgId}/files/${sha256}.jpg`;
/** A shared-drive image's public URL, exactly (host, org, 64 hex, .jpg, nothing else); null otherwise. */
export function driveUrlSha(url: string): { orgId: string; sha256: string } | null {
  const m = /^https:\/\/files\.example\.org\/o\/([a-z0-9][a-z0-9-]{1,62})\/files\/([a-f0-9]{64})\.jpg$/.exec(url);
  return m ? { orgId: m[1], sha256: m[2] } : null;
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const ASCII_HOST = /^[a-z0-9.-]+$/;
const parse = (s: string) => { try { return new URL(s); } catch { return null; } };
/** A host as written must already be its own ASCII, lower-case form (punycode, unicode, upper case and trailing dots refuse). */
function plainHost(raw: string, u: URL) {
  const written = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1] ?? "";
  return written === u.host && ASCII_HOST.test(u.hostname) && !u.hostname.endsWith(".") && !u.hostname.startsWith("xn--") && !u.hostname.includes(".xn--");
}

/** Package E (Fable E-4) Ops-held link-host extras (org.json newsletter.linkHosts): exact lower-case ASCII hosts, no wildcards, at
 *  most ten. Package F (Fable ruling (a), the deprecation release): still VALIDATED at load, IGNORED by the renderer; Package G drops it. */
export const LINK_HOSTS_MAX = 10;
export function normalizeLinkHosts(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > LINK_HOSTS_MAX || !v.every((h) => typeof h === "string" && ASCII_HOST.test(h) && h.includes(".") && !h.startsWith(".") && !h.endsWith(".") && !h.includes("*")))
    throw new Error("newsletter_link_hosts_invalid");
  return [...new Set(v as string[])].sort();
}

/** E-1: a whole body line that is exactly one image URL on CP's own site; the re-serialized URL, or null. */
export function imageUrl(line: string): string | null {
  const s = line.trim(); if (!/^https:\/\/\S+$/.test(s)) return null;
  if (driveUrlSha(s)) return s; // LIBRARY L1/L2 (Fable L-7): exactly a shared-drive public URL (host, org, 64 hex, .jpg)
  const u = parse(s); if (!u || u.protocol !== "https:" || !plainHost(s, u) || !CP_HOSTS.includes(u.hostname)) return null;
  if (u.username || u.password || u.port || u.search || u.hash || s.includes("?") || s.includes("#")) return null;
  if (!/^\/(newsletter|images)\//.test(u.pathname) || !/\.(jpe?g|png|webp|gif)$/i.test(u.pathname)) return null;
  return u.href;
}

/** Fable E-13: where an exact URL string came from: a frozen snapshot path, or "member message"; null = nowhere. */
export type Provenance = (url: string) => string | null;
export type LinkDecision = { text: string; url: string; live: boolean; href?: string; host?: string; source?: string;
  reason?: "malformed_text" | "not_https" | "display_mismatch" | "no_source" };
const DISPLAY_HOST = /^(https?:\/\/)?([A-Za-z0-9.-]+\.[A-Za-z]{2,})(\/\S*)?$/, ADDRESS = /^[^\s@]+@[^\s@]+$/;
/** THE link rule (Fable E-12 a-c, E-13), one implementation for body links, links[] and the release card's list:
 *  text non-empty with no [ ] < >; https only (no userinfo, no port, the host lower-case ASCII as written) or exactly
 *  mailto:hello@example.org; a text that looks like a host/URL must name the href's host, and a text that looks like an
 *  address must be hello@example.org for the mailto and is refused for an https link; the exact URL must have a source.
 *  The href is the `new URL` re-serialisation. Anything else is inert text, never dropped. */
export function linkDecision(text: string, url: string, prov: Provenance): LinkDecision {
  const t = text.trim(), s = url.trim(), no = (reason: LinkDecision["reason"]): LinkDecision => ({ text: t, url: s, live: false, reason });
  if (!t || /[[\]<>]/.test(t)) return no("malformed_text");
  if (s === CP_MAILTO) {
    if (ADDRESS.test(t) && t.toLowerCase() !== "hello@example.org") return no("display_mismatch");
    return { text: t, url: s, live: true, href: CP_MAILTO, host: "example.org", source: "fixed address" };
  }
  const u = parse(s);
  if (!u || u.protocol !== "https:" || !plainHost(s, u) || u.username || u.password || u.port) return no("not_https");
  // NL-2 (live send 2026-10-29: "example.org/events" -> https://www.example.org/events was refused): ONE leading "www."
  // is ignored on both sides; any other difference (another subdomain, a look-alike suffix, another site) is still a mismatch.
  const d = DISPLAY_HOST.exec(t), bare = (h: string) => h.replace(/^www\./, "");
  if ((d && bare(d[2].toLowerCase()) !== bare(u.hostname)) || ADDRESS.test(t)) return no("display_mismatch");
  const source = prov(s);
  if (!source) return no("no_source");
  return { text: t, url: s, live: true, href: u.href, host: u.hostname, source };
}

const T = CP_THEME;
const A = (href: string, label: string) => `<a href="${esc(href)}" style="color:${T.primary};text-decoration:underline;font-weight:600;">${label}</a>`;
const emph = (t: string) => esc(t).replace(/\*\*([^*\n]{1,200})\*\*/g, "<strong>$1</strong>").replace(/\*([^*\n]{1,200})\*/g, "<em>$1</em>");
/** [text](url), exactly (E-12a: text without [ ] newline; url without spaces or parentheses); anything else is plain text. */
const INLINE = /\[([^\[\]\n]*)\]\(([^()\s]*)\)/g;
/** Inline text: [text](url) goes through linkDecision (live, or inert = its TEXT only, Director 24 Oct; the release card still shows
 *  the refused URL); bare URLs are TEXT (no autolinking). */
function inline(t: string, prov: Provenance, sink: LinkDecision[]) {
  let out = "", last = 0;
  for (const m of t.matchAll(INLINE)) {
    out += emph(t.slice(last, m.index)); last = m.index! + m[0].length;
    const d = linkDecision(m[1], m[2], prov); sink.push(d);
    out += d.live ? A(d.href!, esc(d.text)) : !m[1].trim() ? esc(m[0]) : esc(m[1]);
  }
  return out + emph(t.slice(last));
}
const P = `margin:0 0 14px;font-size:16px;line-height:1.6;color:${T.foreground};`;
/** The section body (delta A-3): paragraphs, "- " lists and "1." lists. A blank line inside a list, or an indented line under an
 *  item (it continues that item), does not end it; any other line does. A numbered list keeps the model's first number as
 *  `start` (only when above 1; the item regex allows at most three digits, so <= 999). A line that is one E-1 image URL is an image. */
function body(t: string, prov: Provenance, sink: LinkDecision[]) {
  const out: string[] = [];
  let para: string[] = [], list: { tag: "ul" | "ol"; start: number; items: string[][] } | null = null;
  const flushPara = () => { if (para.length) out.push(`<p style="${P}">` + para.map((l) => inline(l, prov, sink)).join("<br>") + "</p>"); para = []; };
  const flushList = () => {
    if (!list) return;
    const open = list.tag === "ul" ? `<ul style="margin:0 0 16px;padding-left:22px;">` : `<ol${list.start > 1 ? ` start="${list.start}"` : ""} style="margin:0 0 16px;padding-left:${list.start + list.items.length > 100 ? 40 : 24}px;">`; // 3-digit markers need room
    out.push(open + list.items.map((it) => `<li style="margin-bottom:8px;line-height:1.55;color:${T.foreground};">${it.map((l) => inline(l, prov, sink)).join("<br>")}</li>`).join("") + `</${list.tag}>`);
    list = null;
  };
  for (const raw of t.replace(/\r\n?/g, "\n").split("\n")) {
    const l = raw.replace(/[ \t]+$/, "");
    if (!l.trim()) { flushPara(); continue; } // a blank line ends a paragraph; an open list waits for the next line
    const img = imageUrl(l);
    if (img) { flushPara(); flushList(); out.push(`<p style="margin:8px 0 18px;"><img src="${esc(img)}" alt="" width="400" style="display:block;width:400px;max-width:100%;height:auto;border:0;border-radius:6px;"></p>`); continue; }
    const ul = /^\s*[-*] (.*)$/.exec(l), ol = ul ? null : /^\s*(\d{1,3})[.)] (.*)$/.exec(l);
    if (ul || ol) {
      flushPara();
      const tag = ul ? "ul" : "ol";
      if (!list || list.tag !== tag) { flushList(); list = { tag, start: ol ? Number(ol[1]) : 1, items: [] }; }
      list.items.push([ul ? ul[1] : ol![2]]); continue;
    }
    if (list && /^[ \t]{2,}\S/.test(l)) { list.items[list.items.length - 1].push(l.trim()); continue; }
    flushList(); para.push(l);
  }
  flushPara(); flushList();
  return out.join("");
}
/** Every image URL a rendered newsletter references (header strip, emblem, image lines), for the E-2 preflight. */
export function referencedImages(html: string): string[] {
  return [...new Set([...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&")))];
}

export type SectionImage = { url: string; alt: string; caption?: string; position: "above" | "below" | "left" | "right" };
type Content = { title: string; headerPhotos?: string[]; sections: { heading: string; body: string; links?: { text: string; url: string }[]; images?: SectionImage[] }[] };
/** Delta A-1 (Fable): a section image, full width above or below the body, with its caption (plain text, escaped, no parsing). */
function wideImage(im: SectionImage) {
  const src = imageUrl(im.url); if (!src) return "";
  return `<p style="margin:8px 0 ${im.caption ? 4 : 18}px;"><img src="${esc(src)}" alt="${esc(im.alt)}" width="584" style="display:block;width:100%;max-width:584px;height:auto;border:0;border-radius:6px;"></p>` +
    (im.caption ? `<p style="margin:0 0 18px;font-size:13px;line-height:1.45;color:${T.muted};">${esc(im.caption)}</p>` : "");
}
/** Delta A-1: an image beside the body (left or right), two columns that stack on a narrow screen. The image comes FIRST in the
 *  source, so a client that ignores the columns (Outlook) shows it above the text; dir="rtl" puts it visually on the right.
 *  OSS lift: Cerberus (MIT, github.com/emailmonday/Cerberus, LICENSE): the hybrid "stack-column" pattern (inline-block columns
 *  with max-width/min-width inside a font-size:0 row, the dir="rtl" reversal). Adapt notes: no <style> block or MSO conditional
 *  comments (Outlook takes the stacked fallback, Fable delta A-1), widths 40/60 inside the 584 px body, the theme's type. */
function sideImage(im: SectionImage, inner: string) {
  const src = imageUrl(im.url); if (!src) return inner;
  const right = im.position === "right";
  // Pixel max-widths (230 + 354 = the 584 px body): side by side at email width; stacked, each is full width (no media query).
  const col = (w: number, min: number, html: string) => `<div dir="ltr" style="display:inline-block;margin:0 -1px;max-width:${w}px;min-width:${min}px;vertical-align:top;width:100%;">${html}</div>`;
  const pic = `<div style="padding:4px ${right ? "0 12px 16px" : "16px 12px 0"};"><img src="${esc(src)}" alt="${esc(im.alt)}" width="220" style="display:block;width:100%;max-width:220px;height:auto;border:0;border-radius:6px;">` +
    (im.caption ? `<p style="margin:4px 0 0;font-size:13px;line-height:1.45;color:${T.muted};">${esc(im.caption)}</p>` : "") + `</div>`;
  return `<div dir="${right ? "rtl" : "ltr"}" style="font-size:0;text-align:left;">` + col(230, 200, pic) +
    col(354, 240, `<div style="font-size:16px;line-height:1.6;color:${T.foreground};">${inner}</div>`) + `</div>`;
}
/** Fable E-14: exactly four E-1 URLs, or the site's default strip. */
export function headerPhotosOf(c: { headerPhotos?: string[] }): string[] {
  const p = c.headerPhotos?.map(imageUrl);
  return p && p.length === 4 && p.every((x): x is string => !!x) ? p : HEADER_PHOTOS;
}
export function renderNewsletterV3(c: Content, o: { provenance?: Provenance } = {}) { return renderNewsletterV3Full(c, o).html; }
/** The HTML and every link decision in it (the release card's list, Fable E-12d), from ONE pass. No provenance = no live link. */
export function renderNewsletterV3Full(c: Content, o: { provenance?: Provenance } = {}): { html: string; links: LinkDecision[] } {
  const prov = o.provenance ?? (() => null), links: LinkDecision[] = [];
  const navy = T.header === "navy", bg = navy ? T.primaryDark : T.surface, mark = navy ? T.surface : T.primaryDark, small = navy ? T.accent : T.muted, nav = navy ? T.primaryLight : T.primary;
  const navLink = (href: string, label: string) => `<a href="${href}" style="color:${nav};text-decoration:none;font-weight:700;">${label}</a>`;
  const dot = `<span style="color:${small};">&nbsp;&middot;&nbsp;</span>`;
  const header =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;background:${bg};"><tr><td bgcolor="${bg}" style="padding:0;background-color:${bg};">` +
    `<div style="padding:30px 24px 6px;text-align:center;">` +
    `<a href="${SITE}/" style="text-decoration:none;display:inline-block;"><img src="${EMBLEM}" alt="" width="64" height="64" style="display:block;margin:0 auto 10px;border:0;width:64px;height:64px;">` +
    `<span style="display:block;font-family:${T.display};font-size:38px;font-weight:600;line-height:1.05;letter-spacing:-0.015em;color:${mark};">Example Park</span>` +
    `<span style="display:block;margin-top:6px;font-family:${T.body};font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${small};">Springfield, Example State</span></a>` +
    `<div style="font-family:${T.body};font-size:12px;line-height:1.5;margin:12px 0 0;letter-spacing:0.02em;">` +
    [navLink(`${SITE}/events`, "Events"), navLink(`${SITE}/meetings`, "Meetings"), navLink(`${SITE}/gallery`, "Gallery"), navLink(`${SITE}/newsletter`, "Sign up")].join(dot) + `</div>` +
    `<div style="width:180px;max-width:45%;height:2px;background:${T.accent};margin:14px auto 10px;line-height:2px;font-size:0;">&nbsp;</div>` +
    `<div style="font-family:${T.display};font-size:24px;font-weight:600;line-height:1.15;color:${mark};margin:0 0 2px;">${emph(c.title)}</div></div>` +
    `<div style="padding:16px 18px 20px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:6px 0;"><tr>` +
    headerPhotosOf(c).map((src) => `<td width="25%" style="padding:0;"><img src="${src}" alt="" width="140" height="76" style="display:block;width:100%;max-width:140px;height:auto;border-radius:6px;border:0;outline:none;"></td>`).join("") +
    `</tr></table></div></td></tr></table>`;
  const sections = c.sections.map((x, i) => {
    const head = (i ? `<hr style="border:0;border-top:1px solid ${T.border};margin:24px 0;">` : "") +
      `<h2 style="color:${T.primaryDark};font-family:${T.display};font-weight:600;letter-spacing:-0.01em;margin:${i ? 8 : 4}px 0 10px;line-height:1.15;font-size:24px;">${emph(x.heading)}</h2>`;
    const from = links.length, inner = body(x.body, prov, links), side = x.images?.find((im) => im.position === "left" || im.position === "right");
    const placed = (x.images ?? []).filter((im) => im.position === "above").map(wideImage).join("") + (side ? sideImage(side, inner) : inner) +
      (x.images ?? []).filter((im) => im.position === "below").map(wideImage).join("");
    // Package A2 (the owner's first live edit): a links[] entry whose link is ALREADY live in this section's body is not shown a
    // second time (the model often writes a link in the text and in links[]); its decision is listed once on the release card.
    const inBody = new Set(links.slice(from).filter((d) => d.live).map((d) => d.href));
    const rest = (x.links ?? []).map((l) => ({ l, d: linkDecision(l.text, l.url, prov) })).filter(({ d }) => !(d.live && inBody.has(d.href)));
    links.push(...rest.map(({ d }) => d));
    return head + placed + (rest.length ? `<ul style="margin:0 0 16px;padding-left:22px;">` + rest.map(({ l, d }) =>
      `<li style="margin-bottom:8px;line-height:1.55;color:${T.foreground};">` + (d.live ? A(d.href!, esc(d.text)) : esc(l.text)) + "</li>").join("") + "</ul>" : "");
  }).join("");
  const footer = `<div style="background:${T.surface};padding:20px 28px 32px;border-top:1px solid ${T.border};margin-top:12px;text-align:left;font-family:${T.body};">` +
    `<p style="margin:0 0 8px;font-size:12px;line-height:1.55;color:${T.muted};">Reply to this email or write us at <a href="${CP_MAILTO}" style="color:${T.muted};text-decoration:underline;">hello@example.org</a>.</p>` +
    `<p style="margin:0 0 8px;font-size:12px;line-height:1.55;color:${T.muted};">${UNSUB_ANCHOR} &nbsp;&middot;&nbsp; <a href="${VIEW_ON_WEB}" style="color:${T.muted};text-decoration:underline;">View on web</a></p>` +
    // The org lines as on the latest sent issue (content/newsletter/2026-10-07-october-neighborhood-newsletter.md footer).
    `<p style="margin:0 0 8px;font-size:12px;line-height:1.55;color:${T.foreground};font-weight:600;">Example Park Neighborhood Association + Friends of Example Park</p>` +
    `<p style="margin:0;font-size:12px;line-height:1.55;color:${T.muted};">100 Main St, Springfield, EX 00000</p></div>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(c.title)}</title></head>` +
    `<body style="margin:0;padding:0;background:${T.primaryLight};font-family:${T.body};color:${T.foreground};">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${T.primaryLight};"><tr><td>` +
    `<div style="width:100%;max-width:640px;margin:0 auto;background:${T.surface};text-align:left;">` + header +
    `<div style="background:${T.surface};padding:28px 28px 8px;font-size:16px;line-height:1.6;color:${T.foreground};font-family:${T.body};">${sections}</div>` + footer +
    `</div></td></tr></table></body></html>`;
  return { html, links };
}
