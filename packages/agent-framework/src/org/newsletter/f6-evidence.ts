// F6-S (BRIEF-F6S 135b3752; Fable ruling 83a20aeb): the F-6 suppression evidence, read ON CP with the release key it already holds.
// A separate file by ruling (Q4): resend-broadcast.ts stays byte-identical (RESEND_CONNECTOR_SHA does not move). This walk makes the
// SAME requests as its readAudience: GET /audiences/{id}/contacts?limit=100, through the one process-wide resendSlot, the same headers,
// redirect "error", the 20 s deadline, 429-only retry after Retry-After, the 200-page cap. It keeps each contact's "<id>:<s|u>" line
// besides the eligible ids, so the audience cache takes its eligible set from here (no second walk) and every complete walk is also
// the F-6 evidence. The evidence recipe is Ops' f6_evidence.mjs (4fff4f6f): contactsSha256 = sha256 of the sorted unique lines, one
// per line, newline-terminated. Any failure, cap or malformed page is null (nothing is recorded: F-6 fails closed).
import { createHash } from "node:crypto";
import { readMailKey } from "../../mail/resend-send.js";
import { RESEND_429_RETRIES, RESEND_PACE_MS, resendSlot, retryAfterMs, type ResendFetch } from "./resend-broadcast.js";

const ORIGIN = "https://api.resend.com", ID = /^[A-Za-z0-9_-]{1,100}$/, MAX_BYTES = 4 * 1024 * 1024;
const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const F6_EVIDENCE_KIND = "kapelle.exna-f6-shared-audience/v1";
/** Counts and hashes only: no address, no contact id. */
export type F6Evidence = { audienceIdSha256: string; total: number; unsubscribed: number; eligible: number; contactsSha256: string };

async function get(o: { keyFile: string; fetch?: ResendFetch; timeoutMs?: number; paceMs?: number }, path: string): Promise<{ status: number; json: any } | null> {
  if (process.env.NODE_USE_ENV_PROXY) return null;
  let key: string;
  try { key = readMailKey(o.keyFile); } catch { return null; }
  const doFetch = o.fetch ?? (fetch as unknown as ResendFetch), pace = o.paceMs ?? (o.fetch ? 0 : RESEND_PACE_MS);
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    if (pace > 0) await resendSlot(pace);
    try {
      res = await doFetch(ORIGIN + path, { method: "GET", redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
        headers: { authorization: "Bearer " + key, accept: "application/json" } });
    } catch { return null; }
    if (res.status !== 429 || attempt >= RESEND_429_RETRIES) break;
    await res.body?.cancel().catch(() => {});
    await sleep(retryAfterMs(res.headers.get("retry-after")));
  }
  try { const r = res.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (r) for (;;) { const p = await r.read(); if (p.done) break; size += p.value.length; if (size > MAX_BYTES) { await r.cancel(); return null; } chunks.push(p.value); }
    return { status: res.status, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }; } catch { return null; }
}

/** One complete walk: the eligible ids (exactly readAudience's result) + the F-6 evidence; null = unknown. */
export async function readAudienceEvidence(o: { keyFile: string; audienceId: string; fetch?: ResendFetch; timeoutMs?: number; paceMs?: number; maxPages?: number }):
  Promise<{ eligible: string[]; evidence: F6Evidence } | null> {
  if (!ID.test(o.audienceId)) return null;
  const ids: string[] = [], lines: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < (o.maxPages ?? 200); page++) {
    const r = await get(o, `/audiences/${o.audienceId}/contacts?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    if (!r || r.status !== 200 || !Array.isArray(r.json?.data)) return null;
    for (const c of r.json.data) { if (typeof c?.id !== "string" || !ID.test(c.id)) return null; if (c.unsubscribed !== true) ids.push(c.id); lines.push(c.id + ":" + (c.unsubscribed === true ? "u" : "s")); after = c.id; }
    if (!r.json.has_more) {
      const uniq = [...new Set(lines)].sort(), u = uniq.filter((l) => l.endsWith(":u")).length;
      return { eligible: [...new Set(ids)].sort(),
        evidence: { audienceIdSha256: hex(o.audienceId), total: uniq.length, unsubscribed: u, eligible: uniq.length - u, contactsSha256: hex(uniq.join("\n") + "\n") } };
    }
    if (!r.json.data.length) return null;
  }
  return null;
}

/** The evidence document (Ops' f6_evidence.mjs shape); its sha256 is what CP records as suppressionSyncSha (Addendum 1: DB only, no file). */
export const f6EvidenceJson = (at: string, e: F6Evidence) => JSON.stringify({ kind: F6_EVIDENCE_KIND, at, ...e }, null, 2) + "\n";
