// PACKAGE P (Astra STACK-AND-HARNESS-REVIEW-20261026 §3; Fable ruling on BRIEF-PACKAGE-P): exact, atomic edits of a saved draft
// version, and the member-link check. Pure functions over the typed content (no I/O); tools.ts reads the parent and saves.
//
// OSS pattern reference (decision #77; NO code or fixture bytes copied, no pinned revision read): Aider's search/replace edit
//   format (Apache-2.0, https://github.com/Aider-AI/aider): a search text must match exactly, else the edit is refused. Codex's
//   apply-patch (Apache-2.0, https://github.com/openai/codex): a patch applies to its exact parent or not at all.
// Adapt notes: typed field targets instead of file text; exactly ONE occurrence required (no fuzzy fallback, no whitespace
//   folding, no regex); lists replaced only against their exact current value; a stale parent refuses (tools.ts). See SOURCES.md.

export type DraftKind = "newsletter" | "agenda";
export type DraftEdit =
  | { op: "replace_text"; field: string; old: string; new: string }
  | { op: "set_list"; field: string; old: unknown[]; new: unknown[] }
  | { op: "add_entry"; after: number; entry: Record<string, unknown> }
  | { op: "remove_entry"; index: number; oldTitle: string };

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);
/** The fields each kind admits: text fields (replace_text) and list fields (set_list); `N` is an entry index. */
const TEXT = { newsletter: /^(title|sections\[(\d{1,2})\]\.(heading|body))$/, agenda: /^(meeting|date|items\[(\d{1,2})\]\.(title|owner|note))$/ };
const LIST = { newsletter: /^(headerPhotos|sections\[(\d{1,2})\]\.(images|links))$/, agenda: /^$/ };
const ENTRIES = { newsletter: "sections", agenda: "items" } as const;
const TITLE_OF = { newsletter: "heading", agenda: "title" } as const;

/** Apply edits IN ORDER to a deep copy. Any refusal returns the label and nothing; on success the new content and the changed
 *  field list (for the version record). Untouched fields are the parent's values, copied by structure, never re-typed. */
export function applyDraftEdits(kind: DraftKind, parent: unknown, edits: DraftEdit[]): { ok: true; content: unknown; changed: string[] } | { ok: false; error: string; at?: number; current?: unknown } {
  // Fable PP-1: two edits naming the same field in one call are refused (no silent last-writer-wins).
  const named = edits.filter((e): e is Extract<DraftEdit, { field: string }> => "field" in e).map((e) => e.field);
  if (new Set(named).size !== named.length) return { ok: false, error: "draft_edit_conflict" };
  const r = applyInOrder(kind, parent, edits);
  return r;
}
function applyInOrder(kind: DraftKind, parent: unknown, edits: DraftEdit[]): { ok: true; content: unknown; changed: string[] } | { ok: false; error: string; at?: number; current?: unknown } {
  const doc = JSON.parse(JSON.stringify(parent)) as Record<string, any>, changed: string[] = [];
  const entries = () => (Array.isArray(doc[ENTRIES[kind]]) ? doc[ENTRIES[kind]] : null) as Record<string, any>[] | null;
  const locate = (field: string, re: RegExp): { obj: Record<string, any>; key: string } | null => {
    const m = re.exec(field); if (!m) return null;
    const idx = field.match(/\[(\d{1,2})\]/);
    if (!idx) return { obj: doc, key: field };
    const list = entries(), i = Number(idx[1]);
    if (!list || i >= list.length) return null;
    return { obj: list[i], key: field.split(".").pop()! };
  };
  for (const [idx, e] of edits.entries()) {
    // P chat run 3 (draft-edit-photos): a refusal for a NAMED field also returns that field's current value (as the evolving
    // document holds it at this edit), so the model's retry can be exact instead of a second guess. Only the label is persisted.
    const no = (error: string, current?: unknown) => ({ ok: false as const, error, at: idx, ...(current !== undefined ? { current } : {}) });
    if (e.op === "replace_text") {
      const at = locate(e.field, TEXT[kind]);
      if (!at) return no("draft_edit_field_unknown");
      const cur = at.obj[at.key];
      if (e.old === "") { // setting an EMPTY or absent optional field (an empty search would match everywhere)
        if (typeof cur === "string" && cur.length) return no("draft_edit_ambiguous", cur);
        at.obj[at.key] = e.new;
      } else {
        if (typeof cur !== "string") return no("draft_edit_not_found", null);
        const first = cur.indexOf(e.old);
        if (first < 0) return no("draft_edit_not_found", cur);
        if (cur.indexOf(e.old, first + 1) >= 0) return no("draft_edit_ambiguous", cur);
        at.obj[at.key] = cur.slice(0, first) + e.new + cur.slice(first + e.old.length);
      }
      if (at.obj[at.key] === "" && /\.(owner|note)$/.test(e.field)) delete at.obj[at.key]; // an emptied optional field is removed
      changed.push(e.field);
    } else if (e.op === "set_list") {
      const at = locate(e.field, LIST[kind]);
      if (!at) return no("draft_edit_field_unknown");
      if (canon(at.obj[at.key] ?? []) !== canon(e.old)) return no("draft_edit_not_found", at.obj[at.key] ?? []);
      if (e.new.length) at.obj[at.key] = e.new; else delete at.obj[at.key];
      changed.push(e.field);
    } else if (e.op === "add_entry") {
      const list = entries();
      if (!list || !Number.isInteger(e.after) || e.after < -1 || e.after >= list.length) return no("draft_edit_field_unknown");
      list.splice(e.after + 1, 0, e.entry);
      changed.push(`${ENTRIES[kind]}[${e.after + 1}] (added)`);
    } else {
      const list = entries();
      if (!list || !Number.isInteger(e.index) || e.index < 0 || e.index >= list.length) return no("draft_edit_field_unknown");
      if (list[e.index][TITLE_OF[kind]] !== e.oldTitle) return no("draft_edit_not_found", list[e.index][TITLE_OF[kind]]);
      list.splice(e.index, 1);
      changed.push(`${ENTRIES[kind]}[${e.index}] (removed)`);
    }
  }
  return { ok: true, content: doc, changed };
}

/** Fable PP-4: the canonical form URLs are compared in (the WHATWG serialisation the link renderer stores), so a re-serialised
 *  URL is not a false refusal; null when it does not parse. */
export function canonicalUrl(u: string): string | null { try { const x = new URL(u); return x.protocol === "https:" ? x.href : null; } catch { return null; } }
/** The https addresses the member wrote (trailing sentence punctuation and closing brackets dropped), in order, de-duplicated. */
export function memberLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https:\/\/[^\s<>"'`]+/g)) {
    const u = m[0].replace(/[.,;:!?)\]}]+$/, "");
    if (u.length > 8 && u.length <= 500 && !out.includes(u)) out.push(u);
  }
  return out;
}
/** Every https address the draft carries (a link, an inline [text](url), a placed image, a header photo), canonical. */
function draftUrls(content: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") { for (const m of v.matchAll(/https:\/\/[^\s<>"'`()\[\]]+/g)) { const c = canonicalUrl(m[0].replace(/[.,;:!?]+$/, "")); if (c) out.add(c); } }
    else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(content);
  return out;
}
/** PACKAGE P: the member's addresses the draft does not carry anywhere and the model did not explicitly leave out (Fable PP-4). */
export function missingMemberLinks(memberText: string, content: unknown, leaveOut: readonly { url: string }[] = []): string[] {
  const have = draftUrls(content), left = new Set(leaveOut.map((l) => canonicalUrl(l.url)).filter(Boolean));
  return memberLinks(memberText).filter((u) => { const c = canonicalUrl(u); return c !== null && !have.has(c) && !left.has(c); });
}
/** The entry titles with their indexes (the re-anchoring hint for a not-found / ambiguous edit; never a body). */
export function entryTitles(kind: DraftKind, content: unknown) {
  const c = content as Record<string, any>, list = (kind === "newsletter" ? c?.sections : c?.items) ?? [];
  return (Array.isArray(list) ? list : []).map((x: any, index: number) => ({ index, [kind === "newsletter" ? "heading" : "title"]: String(x?.[kind === "newsletter" ? "heading" : "title"] ?? "") }));
}
/** Fable F-2': every list field's current value (headerPhotos, sections[N].images, sections[N].links), keyed by its field name,
 *  so one refusal hint lets the next edit name any list's exact old value. Agendas have no list fields. */
export function draftListFields(kind: DraftKind, content: unknown): Record<string, unknown[]> {
  if (kind !== "newsletter") return {};
  const c = content as Record<string, any>, out: Record<string, unknown[]> = { headerPhotos: Array.isArray(c?.headerPhotos) ? c.headerPhotos : [] };
  (Array.isArray(c?.sections) ? c.sections : []).forEach((x: any, i: number) => { out[`sections[${i}].images`] = x?.images ?? []; out[`sections[${i}].links`] = x?.links ?? []; });
  return out;
}
