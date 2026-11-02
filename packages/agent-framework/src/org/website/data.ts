// Website pack v0, W-2 (PLAN §1 steps 3-4; Fable R-3, R-4, R-5, R-8): the two allowlisted data files, their schemas PINNED in
// code (website-data/v1, written from the files at 0xkilgore/example-org-website f3048fd), the typed operations the model may
// return, the runtime sanitizer, and a SURGICAL apply: only the touched array element's text changes; every other byte of the
// file stays as it was (events.json mixes escaped and raw non-ASCII, so a whole-file re-serialization would rewrite unrelated
// lines). A no-op is byte-identical. A base that no longer parses against the pinned schema refuses the request
// (website_base_shape_changed): the schema is updated in code, never inferred at runtime.
import { createHash } from "node:crypto";
import { z } from "zod";

export const WEBSITE_DATA_VERSION = "website-data/v1";
export const WEBSITE_FILES = { events: "src/data/events.json", meetings: "src/data/meeting-notes.json" } as const;
export const WEBSITE_FILE_MAX = 64 * 1024;
// IMAGES-V1 I3 (design §3; Fable N-1): a checked flyer's sanitized JPEG becomes public/images/events/<slug<=80>-<16-hex>.jpg. The
// name is runtime-made (never from the model); the full SHA-256 is the identity (the prefix is not proof); its own binary cap.
export const WEBSITE_IMAGE_POLICY = "kapelle.website-image/v1";
export const WEBSITE_IMAGE_MAX = 1024 * 1024;
/** J2 (Add photos): a gallery photo's public path, from its content hash (the runtime names it, never the model). */
export function galleryPhotoPath(sha256: string) {
  const hex = /^sha256:([a-f0-9]{64})$/.exec(sha256)?.[1];
  if (!hex) throw new WebsiteDataError("website_image_changed");
  return `public/images/gallery/kapelle-${hex.slice(0, 16)}.jpg`;
}
/** J2: put site paths at the TOP of events.json's galleryPhotos (newest first), skipping any already listed; the rest of the
 *  file's bytes are unchanged. Deterministic code, no model. */
export function addGalleryPhotos(src: string, paths: string[]) {
  const doc = JSON.parse(src) as { galleryPhotos?: unknown[] };
  if (!Array.isArray(doc.galleryPhotos)) return refuse("website_gallery_missing");
  const fresh = paths.filter((p, i) => !doc.galleryPhotos!.includes(p) && paths.indexOf(p) === i);
  if (!fresh.length) return src;
  // The key's own '"galleryPhotos": [' (the strict schema admits no such key elsewhere, and a key inside a string would be escaped).
  const m = /"galleryPhotos"\s*:\s*\[/g, hits = [...src.matchAll(m)];
  if (hits.length !== 1) return refuse("website_base_shape_changed");
  const open = hits[0].index! + hits[0][0].length, next = /^(\s*)(\S)/.exec(src.slice(open))!;
  const out = next[2] === "]" // empty list: one element per line at the key's indent + 2
    ? src.slice(0, open) + "\n" + indentAt(src, hits[0].index!) + "  " + fresh.map((p) => JSON.stringify(p)).join(",\n" + indentAt(src, hits[0].index!) + "  ") + "\n" + indentAt(src, hits[0].index!) + src.slice(open + next[1].length)
    : src.slice(0, open) + next[1] + fresh.map((p) => JSON.stringify(p)).join("," + next[1]) + "," + src.slice(open);
  if (Buffer.byteLength(out) > WEBSITE_FILE_MAX) refuse("website_file_too_large");
  parseBase("events", Buffer.from(out));
  return out;
}
export function eventImagePath(eventId: string, sha256: string) {
  const hex = /^sha256:([a-f0-9]{64})$/.exec(sha256)?.[1];
  if (!hex) throw new WebsiteDataError("website_image_changed");
  const slug = eventId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").slice(0, 80).replace(/^-+|-+$/g, "") || "event";
  return `public/images/events/${slug}-${hex.slice(0, 16)}.jpg`;
}
const sha = (s: string | Buffer) => "sha256:" + createHash("sha256").update(s).digest("hex");

// ---- R-4 the sanitizer: plain text or a markdown subset; the site's own renderer is not ours ----
const BAD = /<|javascript:|data:|vbscript:/i;
/** Markdown links: https:// or a site-relative /path only (the live notes already use /meetings/... links). */
const linksOk = (t: string) => [...t.matchAll(/\]\(([^)\s]*)\)/g)].every((m) => /^https:\/\/[^\s/]+/.test(m[1]) || /^\/(?!\/)[A-Za-z0-9._~\/-]*$/.test(m[1]));
const text = (max: number) => z.string().max(max).refine((t) => !BAD.test(t), "website_content_unsafe").refine(linksOk, "website_content_unsafe");
const line = (max: number) => text(max).refine((t) => !/[\r\n]/.test(t), "website_content_unsafe");
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const https = z.string().max(500).regex(/^https:\/\/[^\s<>"']+$/);
const image = z.string().max(200).regex(/^\/images\/[A-Za-z0-9._\/-]+\.(jpg|jpeg|png|webp|gif)$/i);
const contact = z.object({ name: line(100), email: z.string().email().max(200) }).strict();
const EVENT_TYPES = ["social", "meeting", "community", "cleanup"] as const;

// ---- R-3 pinned base schemas (every field present in the live files; unknown fields refuse) ----
export const baseEventZ = z.object({ id: z.string().min(1).max(120), title: z.string().max(300), date, time: z.string().max(80), location: z.string().max(300),
  address: z.string().max(400), description: z.string().max(8000), type: z.string().max(40), image: z.string().max(300).optional(), contact: z.object({ name: z.string(), email: z.string() }).strict().optional(),
  link: z.object({ label: z.string(), url: z.string() }).strict().optional(), highlights: z.array(z.string()).optional(), showSignup: z.boolean().optional(), rsvp: z.boolean().optional(),
  rsvp_question: z.string().optional(), showQR: z.boolean().optional(), photos: z.array(z.string()).optional(), flyer_pdf: z.string().optional(), volunteer: z.boolean().optional(),
  richContent: z.boolean().optional() }).strict();
export const baseEventsFileZ = z.object({ events: z.array(baseEventZ).max(500), meetingOverrides: z.record(z.string(), z.unknown()).optional(), pastEvents: z.array(z.unknown()).optional(),
  galleryPhotos: z.array(z.unknown()).optional() }).strict();
export const baseMeetingZ = z.object({ id: z.string().min(1).max(40), date, title: z.string().max(300), slug: z.string().max(120),
  sections: z.array(z.object({ heading: z.string().max(300), body: z.string().max(20000) }).strict()).max(60) }).strict();
export const baseMeetingsFileZ = z.object({ meetings: z.array(baseMeetingZ).max(200) }).strict();

// ---- the typed operations (the ONLY thing the model returns) ----
const eventFields = { title: line(200), date, time: line(60), location: line(200), address: line(300), description: text(4000), type: z.enum(EVENT_TYPES),
  image: z.union([z.literal(""), image]), contact, link: z.object({ label: line(200), url: https }).strict() };
const meetingFields = { date, title: line(200), slug, sections: z.array(z.object({ heading: line(200), body: text(8000) }).strict()).min(1).max(30) };
export const opZ = z.discriminatedUnion("op", [
  z.object({ op: z.literal("upsert_event"), event: z.object({ id: slug, ...Object.fromEntries(Object.entries(eventFields).map(([k, v]) => [k, v.optional()])) }).strict() }).strict(),
  z.object({ op: z.literal("remove_event"), id: z.string().min(1).max(120) }).strict(),
  z.object({ op: z.literal("upsert_meeting"), meeting: z.object({ id: z.string().regex(/^\d{4}-\d{2}$/), ...Object.fromEntries(Object.entries(meetingFields).map(([k, v]) => [k, v.optional()])) }).strict() }).strict(),
  z.object({ op: z.literal("remove_meeting"), id: z.string().min(1).max(40) }).strict(),
]);
export const opsZ = z.object({ ops: z.array(opZ).min(1).max(10) }).strict();
export type Op = z.infer<typeof opZ>;
const REQUIRED_NEW_EVENT = ["title", "date", "time", "location", "address", "description", "type"] as const;
const REQUIRED_NEW_MEETING = ["date", "title", "slug", "sections"] as const;

export class WebsiteDataError extends Error { constructor(readonly label: string) { super(label); this.name = "WebsiteDataError"; } }
const refuse = (label: string): never => { throw new WebsiteDataError(label); };

/** Parse the model's answer: ONE JSON object {ops:[...]} (a ```json fence is tolerated); anything else is refused. */
export function parseOps(answer: string): Op[] {
  const t = answer.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, "$1").trim();
  let v: unknown;
  try { v = JSON.parse(t); } catch { return refuse("website_ops_not_json"); }
  const p = opsZ.safeParse(v);
  if (!p.success) return refuse(p.error.issues.some((i) => i.message === "website_content_unsafe") ? "website_content_unsafe" : "website_ops_invalid");
  return p.data.ops;
}
export function parseBase(file: keyof typeof WEBSITE_FILES, bytes: Buffer) {
  if (bytes.length > WEBSITE_FILE_MAX) refuse("website_base_too_large");
  let v: unknown;
  try { v = JSON.parse(bytes.toString("utf8")); } catch { return refuse("website_base_shape_changed"); }
  const p = (file === "events" ? baseEventsFileZ : baseMeetingsFileZ).safeParse(v);
  if (!p.success) refuse("website_base_shape_changed");
  return p.data as any;
}

// ---- surgical span editing over the original text ----
/** The [start,end) span of each element of the top-level array under `key`, plus the array's brackets. */
function arraySpans(src: string, key: string) {
  let i = 0, depth = 0, arrOpen = -1;
  const spans: [number, number][] = [];
  let elemStart = -1;
  const skipString = () => { i++; while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1; i++; };
  for (; i < src.length;) {
    const c = src[i];
    if (c === '"') {
      const s = i; skipString();
      if (depth === 1 && arrOpen < 0 && JSON.parse(src.slice(s, i)) === key && /^\s*:\s*\[/.test(src.slice(i))) { i = src.indexOf("[", i); arrOpen = i; depth++; i++; continue; }
      if (arrOpen >= 0 && depth === 2 && elemStart < 0) elemStart = s;
      continue;
    }
    if (c === "{" || c === "[") { if (arrOpen >= 0 && depth === 2 && elemStart < 0) elemStart = i; depth++; i++; continue; }
    if (c === "}" || c === "]") {
      depth--;
      if (arrOpen >= 0 && depth === 2 && elemStart >= 0) { spans.push([elemStart, i + 1]); elemStart = -1; }
      if (arrOpen >= 0 && depth === 1) return { open: arrOpen, close: i, spans };
      i++; continue;
    }
    if (arrOpen >= 0 && depth === 2 && elemStart < 0 && !/[\s,]/.test(c)) elemStart = i;
    i++;
  }
  return refuse("website_base_shape_changed");
}
/** Serialize one element in the file's style: 2-space JSON indented to the element's column; non-ASCII escaped only when the
 *  element (or, for a new one, the file) never uses raw non-ASCII. */
function serialize(v: unknown, indent: string, escape: boolean) {
  let s = JSON.stringify(v, null, 2).split("\n").map((l, k) => (k ? indent + l : l)).join("\n");
  if (escape) s = s.replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  return s;
}
const indentAt = (src: string, pos: number) => /([ \t]*)$/.exec(src.slice(src.lastIndexOf("\n", pos - 1) + 1, pos))![1];

// v0.1 polish (owner: the agent wrote Address = "Community Center", copying the place name): known places come from the BASE file
// (a location with exactly one distinct address, never the location itself); an event whose address is empty or just repeats its
// location gets the known address of that exact place, else an empty address, and the change list flags it. Never invented.
const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
export function knownPlaces(eventsText: string) {
  const by = new Map<string, { location: string; addresses: Set<string>; title: string }>();
  for (const e of ((JSON.parse(eventsText) as { events?: Record<string, unknown>[] }).events ?? [])) {
    const loc = norm(e.location), addr = String(e.address ?? "").trim();
    if (!loc || !addr || norm(addr) === loc) continue;
    const k = by.get(loc) ?? { location: String(e.location).trim(), addresses: new Set<string>(), title: String(e.title ?? e.id) };
    k.addresses.add(addr); by.set(loc, k);
  }
  return new Map([...by].filter(([, v]) => v.addresses.size === 1).map(([k, v]) => [k, { location: v.location, address: [...v.addresses][0], title: v.title }]));
}
function settleAddress(item: Record<string, unknown>, places: ReturnType<typeof knownPlaces>) {
  const loc = norm(item.location), addr = norm(item.address);
  if (addr && addr !== loc) return;
  const known = places.get(loc);
  item.address = known ? known.address : "";
}

/** Apply the ops for ONE file to its original text. Returns the new text (identical bytes when nothing changes). */
export function applyOps(file: keyof typeof WEBSITE_FILES, original: string, ops: Op[], treePaths: Set<string>) {
  const key = file === "events" ? "events" : "meetings";
  let src = original;
  const places = file === "events" ? knownPlaces(original) : new Map();
  for (const op of ops) {
    const isEvent = op.op === "upsert_event" || op.op === "remove_event";
    if (isEvent !== (file === "events")) continue;
    const { open, close, spans } = arraySpans(src, key);
    const items = spans.map(([s, e]) => JSON.parse(src.slice(s, e)) as Record<string, unknown>);
    const id = op.op === "upsert_event" ? op.event.id : op.op === "upsert_meeting" ? op.meeting.id : op.id;
    const at = items.findIndex((x) => x.id === id);
    if (op.op === "remove_event" || op.op === "remove_meeting") {
      if (at < 0) refuse("website_op_target_unknown");
      const [s, e] = spans[at];
      // Remove the element with its separator: the comma before it (or after it when it is first).
      const before = at > 0 ? spans[at - 1][1] : -1, after = at < spans.length - 1 ? spans[at + 1][0] : -1;
      src = at > 0 ? src.slice(0, before) + src.slice(e) : after > 0 ? src.slice(0, s) + src.slice(after) : src.slice(0, open + 1) + "\n" + indentAt(src, close) + src.slice(close);
      continue;
    }
    const patch = (op.op === "upsert_event" ? op.event : op.meeting) as Record<string, unknown>;
    if (typeof patch.image === "string" && patch.image && !treePaths.has("public" + patch.image)) refuse("website_image_missing");
    if (at >= 0) {
      const merged = { ...items[at] };
      for (const [k, v] of Object.entries(patch)) merged[k] = v;
      if (op.op === "upsert_event" && ("address" in patch || "location" in patch)) settleAddress(merged, places);
      const [s, e] = spans[at], old = src.slice(s, e);
      const escape = /\\u[0-9a-fA-F]{4}/.test(old) || !/[^\x00-\x7f]/.test(old);
      const next = serialize(merged, indentAt(src, s), escape);
      if (JSON.stringify(merged) !== JSON.stringify(items[at])) src = src.slice(0, s) + next + src.slice(e);
    } else {
      for (const k of op.op === "upsert_event" ? REQUIRED_NEW_EVENT : REQUIRED_NEW_MEETING) if (patch[k] === undefined) refuse("website_op_incomplete");
      const item = { ...patch }; // never mutate the parsed op (its hash is the approval's opsSha256)
      if (op.op === "upsert_event") settleAddress(item, places);
      const indent = spans.length ? indentAt(src, spans[0][0]) : indentAt(src, close) + "  ";
      const escape = file === "events" && !/[^\x00-\x7f]/.test(original);
      const next = serialize(item, indent, escape);
      src = spans.length ? src.slice(0, spans.at(-1)![1]) + ",\n" + indent + next + src.slice(spans.at(-1)![1])
        : src.slice(0, open + 1) + "\n" + indent + next + "\n" + indentAt(src, close) + src.slice(close);
    }
  }
  if (Buffer.byteLength(src) > WEBSITE_FILE_MAX) refuse("website_file_too_large");
  parseBase(file, Buffer.from(src)); // the result must still match the pinned schema
  return src;
}

/** A deterministic, human summary of the ops (R-5: the PR title/body come only from this). Never model prose. */
export function summarize(ops: Op[]) {
  const parts = (ops as any[]).map((o) => o.op === "upsert_event" ? `${o.event.title ? `event "${o.event.title}"` : `event ${o.event.id}`}${o.event.date ? ` (${o.event.date})` : ""}`
    : o.op === "remove_event" ? `remove event ${o.id}` : o.op === "upsert_meeting" ? `meeting notes ${o.meeting.title ? `"${o.meeting.title}"` : o.meeting.id}` : `remove meeting notes ${o.id}`);
  const title = ("Website: " + parts.join("; ")).replace(/[\r\n]+/g, " ").slice(0, 120);
  return { title, lines: parts.map((p) => "- " + p) };
}
// v0.1 (owner feedback after the first live PR): a plain-language "before -> after" per field, computed by the RUNTIME from the
// files themselves (base vs result, for exactly the entries the ops touched; never model prose), and the site path of the changed
// page for the preview deep link (/events/<id>, /meetings/<slug>; the list page when an entry is removed). Both live inside the
// approved summary, so the approval digest (summarySha256) covers them.
const FIELD_LABELS: Record<string, string> = { title: "Title", date: "Date", time: "Time", location: "Location", address: "Address", description: "Description", type: "Type",
  image: "Image", contact: "Contact", link: "Link", highlights: "Highlights", slug: "Page address", sections: "Sections" };
const show = (k: string, v: unknown): string => {
  if (v === undefined || v === null || v === "") return "(empty)";
  if (k === "contact" && typeof v === "object") { const c = v as { name?: string; email?: string }; return `${c.name ?? ""} <${c.email ?? ""}>`; }
  if (k === "link" && typeof v === "object") { const l = v as { label?: string; url?: string }; return `${l.label ?? ""} (${l.url ?? ""})`; }
  if (k === "sections" && Array.isArray(v)) return `${v.length} section${v.length === 1 ? "" : "s"}: ` + v.map((s: any) => String(s?.heading ?? "")).join(", ");
  if (Array.isArray(v)) return v.map(String).join("; ");
  const t = String(v).replace(/\s+/g, " ").trim();
  return t.length > 160 ? t.slice(0, 157) + "…" : t;
};
export type FieldChange = { field: string; before: string; after: string };
export type EntryChange = { kind: "event" | "meeting"; id: string; action: "added" | "changed" | "removed"; title: string; path: string; fields: FieldChange[]; date?: string;
  /** Fixed notes the reviewer should see (address_not_provided, address_from_known_place). */ notes?: string[] };
export function describeChanges(base: { events: string; meetings: string }, result: { events: string; meetings: string }, ops: Op[]): EntryChange[] {
  const arr = (text: string, key: string) => ((JSON.parse(text) as Record<string, unknown[]>)[key] ?? []) as Record<string, unknown>[];
  const out: EntryChange[] = [];
  for (const o of ops as any[]) {
    const kind: "event" | "meeting" = /event/.test(o.op) ? "event" : "meeting", id = String(o.event?.id ?? o.meeting?.id ?? o.id);
    if (out.some((c) => c.kind === kind && c.id === id)) continue;
    const key = kind === "event" ? "events" : "meetings";
    const before = arr(kind === "event" ? base.events : base.meetings, key).find((x) => x.id === id);
    const after = arr(kind === "event" ? result.events : result.meetings, key).find((x) => x.id === id);
    const action = !before ? "added" : !after ? "removed" : "changed";
    const item = (after ?? before ?? {}) as Record<string, unknown>;
    const fields: FieldChange[] = [];
    for (const k of [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]) {
      if (k === "id" || JSON.stringify(before?.[k]) === JSON.stringify(after?.[k])) continue;
      if (action === "removed") continue;
      fields.push({ field: FIELD_LABELS[k] ?? k, before: action === "added" ? "" : show(k, before?.[k]), after: show(k, after?.[k]) });
    }
    const page = kind === "event" ? (action === "removed" ? "/events" : `/events/${id}`) : (action === "removed" ? "/meetings" : `/meetings/${String(item.slug ?? "")}`);
    const notes: string[] = [];
    if (kind === "event" && action !== "removed") {
      // Empty: the reviewer should add it. Different from what the model sent: the runtime filled it from a known place.
      const given = o.event?.address;
      if (!String(item.address ?? "").trim()) notes.push("address_not_provided");
      else if (given !== undefined && norm(given) !== norm(item.address)) notes.push("address_from_known_place");
    }
    out.push({ kind, id, action, title: String(item.title ?? id).slice(0, 200), ...(typeof item.date === "string" ? { date: item.date } : {}), ...(notes.length ? { notes } : {}), path: /^\/(events|meetings)(\/[a-z0-9-]{1,120})?$/.test(page) ? page : kind === "event" ? "/events" : "/meetings", fields });
  }
  return out;
}
export const opsSha = (ops: Op[]) => sha(JSON.stringify(ops));
export const textSha = sha;

/** A small line diff (LCS) with 2 lines of context, as unified-style hunks. Bounded inputs (two files <= 64 KiB). */
export function lineDiff(a: string, b: string, context = 2) {
  if (a === b) return "";
  const A = a.split("\n"), B = b.split("\n");
  // Trim the common prefix/suffix first: edits are local, so the LCS table stays small.
  let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
  if (a2.length * b2.length > 4_000_000) return `@@ changed lines ${pre + 1}-${A.length - suf} @@\n(too large to show line by line)`;
  const L = Array.from({ length: a2.length + 1 }, () => new Uint32Array(b2.length + 1));
  for (let i = a2.length - 1; i >= 0; i--) for (let j = b2.length - 1; j >= 0; j--) L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: string[] = [];
  for (let k = Math.max(0, pre - context); k < pre; k++) out.push("  " + A[k]);
  let i = 0, j = 0;
  while (i < a2.length || j < b2.length) {
    if (i < a2.length && j < b2.length && a2[i] === b2[j]) { out.push("  " + a2[i]); i++; j++; }
    // v0.1: removed lines come before added lines (a change reads "- old" then "+ new").
    else if (i < a2.length && (j >= b2.length || L[i + 1][j] >= L[i][j + 1])) out.push("- " + a2[i++]);
    else out.push("+ " + b2[j++]);
  }
  for (let k = A.length - suf; k < Math.min(A.length, A.length - suf + context); k++) out.push("  " + A[k]);
  return `@@ -${pre + 1} +${pre + 1} @@\n` + out.join("\n");
}
