// Newsletter slice 3, S3-a (PLAN-NEWSLETTER-SLICE3; Fable answer 1, R-1..R-4): the Resend broadcast connector (ProviderPort)
// and the audience reader. Same pinned-client discipline as src/mail/resend-send.ts: one origin (https://api.resend.com), the
// EXNA team's release key read AT USE from an owner-only file (the mail-key checks), redirects refused, a deadline, bounded
// responses, fixed labels and `sent` semantics (may have taken effect: transport failure, 5xx; a 4xx never did).
// - Exactly four broadcast calls (R-1): POST /broadcasts, GET /broadcasts/{id}, POST /broadcasts/{id}/send, GET /broadcasts
//   (paginated, capped; an incomplete listing says so). No idempotency is assumed for broadcasts (not documented): recovery
//   by exact name stays the guard.
// - One list id (R-2) for the broadcast and the audience; the field it is sent as (segment_id or the older audience_id) is
//   configured and pinned by the qualification.
// - The audience (R-3): GET /audiences/{id}/contacts, every page (capped); eligible = not unsubscribed; contact ids only.
//   Any failed or capped read is null ("unknown"). Rules and gates run synchronously inside transactions, so they read a
//   CACHED eligible set that is null once older than its window (fail closed); the executor refreshes it right before the
//   pre-send check and right after the send (the "no additions observed" fence, answer 1).
import { createHash } from "node:crypto";
import { MailError, readMailKey, type MailFetch } from "../../mail/resend-send.js";
import { ProviderError, type ProviderPort } from "./release.js";

const ORIGIN = "https://api.resend.com";
const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
export type ResendFetch = (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; redirect: "error"; signal: AbortSignal }) => Promise<Response>;
type Client = { keyFile: string; fetch?: ResendFetch; timeoutMs?: number; paceMs?: number };

/** S3 live run 2026-10-29 (POST /send = 429 after four calls in ~1 s; q3's listing = 429 on its first page): Resend's documented
 *  default is 2 requests/second per team. ONE pacing point for the whole process: every request waits for its slot (one in flight
 *  at a time, starts >= paceMs apart). Production (no injected fetch) paces at RESEND_PACE_MS; an injected fetch (tests) is unpaced
 *  unless the caller passes paceMs (the qualification harness does). A 429 means "rate limited, not processed": it is retried after
 *  Retry-After (capped, default 1 s), at most RESEND_429_RETRIES times, then answered as the 429 it is (a 4xx: never took effect). */
export const RESEND_PACE_MS = 600, RESEND_429_RETRIES = 2, RESEND_RETRY_AFTER_MAX_MS = 5_000;
let lastStart = 0, queue: Promise<void> = Promise.resolve();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Wait for this process's next Resend slot (exported so the qualification harness's own setup calls share it). */
export function resendSlot(paceMs = RESEND_PACE_MS): Promise<void> {
  const mine = queue.then(async () => { const wait = lastStart + paceMs - Date.now(); if (wait > 0) await sleep(wait); lastStart = Date.now(); });
  queue = mine.catch(() => {});
  return mine;
}
export const retryAfterMs = (h: string | null) => { const n = Number(h); return Number.isFinite(n) && n > 0 ? Math.min(n * 1000, RESEND_RETRY_AFTER_MAX_MS) : 1_000; };

async function call(o: Client, method: "GET" | "POST", path: string, body?: unknown, maxBytes = 1024 * 1024): Promise<{ status: number; json: any }> {
  if (process.env.NODE_USE_ENV_PROXY) throw new ProviderError("newsletter_provider_refused", false);
  let key: string;
  try { key = readMailKey(o.keyFile); } catch { throw new ProviderError("newsletter_provider_refused", false); }
  const doFetch = o.fetch ?? (fetch as unknown as ResendFetch), write = method === "POST", pace = o.paceMs ?? (o.fetch ? 0 : RESEND_PACE_MS);
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    if (pace > 0) await resendSlot(pace);
    try {
      res = await doFetch(ORIGIN + path, { method, redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
        headers: { authorization: "Bearer " + key, accept: "application/json", ...(write ? { "content-type": "application/json" } : {}) }, ...(write ? { body: JSON.stringify(body ?? {}) } : {}) });
    } catch { throw new ProviderError("newsletter_provider_uncertain", write); }
    if (res.status !== 429 || attempt >= RESEND_429_RETRIES) break;
    await res.body?.cancel().catch(() => {});
    await sleep(retryAfterMs(res.headers.get("retry-after")));
  }
  let parsed: any = null;
  try { const r = res.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (r) for (;;) { const p = await r.read(); if (p.done) break; size += p.value.length; if (size > maxBytes) { await r.cancel(); throw new Error("too large"); } chunks.push(p.value); }
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); } catch { parsed = null; }
  return { status: res.status, json: parsed };
}
const failFor = (status: number, write: boolean) => new ProviderError(status >= 400 && status < 500 ? "newsletter_provider_refused" : "newsletter_provider_uncertain", write && !(status >= 400 && status < 500));
const ID = /^[A-Za-z0-9_-]{1,100}$/;
/** Resend statuses -> the executor's three: anything that is neither a draft nor sent (queued, sending, scheduled) counts as on
 *  its way; a status we do not know (e.g. failed) is treated as "draft" so recovery HOLDS it for a human, never adopts it. */
const statusOf = (s: unknown): "draft" | "queued" | "sent" => s === "sent" ? "sent" : ["queued", "sending", "scheduled"].includes(String(s)) ? "queued" : "draft";

export function resendBroadcastPort(o: Client & { listId: string; listField: "segment_id" | "audience_id"; maxPages?: number }): ProviderPort & { readonly listId: string } {
  if (!ID.test(o.listId)) throw new MailError("mail_arg_invalid");
  return {
    listId: o.listId,
    async createDraft(d) {
      const r = await call(o, "POST", "/broadcasts", { [o.listField]: o.listId, from: d.from, reply_to: d.replyTo, subject: d.subject, name: d.name, html: d.html, text: d.text });
      if (r.status === 200 || r.status === 201) { if (typeof r.json?.id === "string" && ID.test(r.json.id)) return { id: r.json.id }; throw new ProviderError("newsletter_provider_uncertain", true); }
      throw failFor(r.status, true);
    },
    async getBroadcast(id) {
      if (!ID.test(id)) return null;
      const r = await call(o, "GET", `/broadcasts/${id}`);
      if (r.status === 404) return null;
      if (r.status !== 200 || typeof r.json?.html !== "string") throw failFor(r.status === 200 ? 500 : r.status, false);
      const list = r.json.segment_id ?? r.json.audience_id;
      return { id, name: String(r.json.name ?? ""), status: statusOf(r.json.status), subject: String(r.json.subject ?? ""), htmlSha256: sha(r.json.html),
        ...(typeof list === "string" ? { listId: list } : {}) };
    },
    async send(id) {
      if (!ID.test(id)) throw new ProviderError("newsletter_provider_refused", false);
      const r = await call(o, "POST", `/broadcasts/${id}/send`, {});
      if (r.status === 200 || r.status === 201) return { accepted: true };
      throw failFor(r.status, true);
    },
    async listBroadcasts() {
      const items: { id: string; name: string }[] = [];
      let after: string | null = null;
      for (let page = 0; page < (o.maxPages ?? 50); page++) {
        let r;
        try { r = await call(o, "GET", `/broadcasts?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`); } catch { return { complete: false, items }; }
        if (r.status !== 200 || !Array.isArray(r.json?.data)) return { complete: false, items };
        for (const b of r.json.data) if (typeof b?.id === "string" && ID.test(b.id)) items.push({ id: b.id, name: String(b.name ?? "") });
        if (!r.json.has_more) return { complete: true, items };
        after = items.at(-1)?.id ?? null;
        if (!after) return { complete: false, items };
      }
      return { complete: false, items }; // the page cap: never "complete" by assumption
    },
  };
}

/** Read every page of the audience; eligible = not unsubscribed; ids only; any failure or the page cap = null. */
export async function readAudience(o: Client & { audienceId: string; maxPages?: number }): Promise<string[] | null> {
  if (!ID.test(o.audienceId)) return null;
  const ids: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < (o.maxPages ?? 200); page++) {
    let r;
    try { r = await call(o, "GET", `/audiences/${o.audienceId}/contacts?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`, undefined, 4 * 1024 * 1024); } catch { return null; }
    if (r.status !== 200 || !Array.isArray(r.json?.data)) return null;
    for (const c of r.json.data) { if (typeof c?.id !== "string" || !ID.test(c.id)) return null; if (c.unsubscribed !== true) ids.push(c.id); after = c.id; }
    if (!r.json.has_more) return [...new Set(ids)].sort();
    if (!r.json.data.length) return null;
  }
  return null;
}

/** The eligible set for the synchronous gates: the last successful read, or null once older than `maxAgeMs` (fail closed). */
export class AudienceCache {
  private last: { ids: string[]; at: number } | null = null;
  constructor(private readonly read: () => Promise<string[] | null>, private readonly maxAgeMs = 5 * 60_000, private readonly nowMs: () => number = Date.now) {}
  async refresh() { const ids = await this.read(); this.last = ids ? { ids, at: this.nowMs() } : null; return ids; }
  current(): string[] | null { return this.last && this.nowMs() - this.last.at <= this.maxAgeMs ? this.last.ids : null; }
  /** How old the last successful read is (null = none). */
  ageMs(): number | null { return this.last ? this.nowMs() - this.last.at : null; }
}
