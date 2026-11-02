// B3: the real Resend Receiving API client behind ResendContentPort (resend-inbound.ts). Contract verified 2026-10-16 on
// resend.com/docs: GET https://api.resend.com/emails/receiving/{id} (the email: subject, text, html, headers, ...) and
// GET .../{id}/attachments ({object:"list", has_more, data:[{id, filename, size, content_type, download_url, expires_at}]}).
// The bearer key (an owner-only file) goes ONLY to api.resend.com; an attachment's signed, expiring download_url is fetched
// WITHOUT it, and only from the pinned CDN host. Every request: GET, redirects refused, a deadline, a bounded body. Failures are
// fixed IntakeError labels (resend_http_<status>, resend_response_*, resend_transport_failed, resend_download_*); never the
// provider's text. A refusal leaves no intake record, so Resend's webhook retry re-runs the fetch later.
import { closeSync, fstatSync, lstatSync, openSync, readSync, constants } from "node:fs";
import { IntakeError } from "./intake.js";
import type { ResendAttachment, ResendContentPort, ResendReceivedEmail } from "./resend-inbound.js";

export const RESEND_API = "https://api.resend.com";
/** Fable B3 F-1: a content fetch that may succeed later. No intake record was written, so the only way the email ever arrives is
 *  the provider's redelivery: these answer 503 (retry), everything else stays a definite 4xx (stop). Operator-fixable
 *  misconfiguration (key file, proxy) is retryable too, so mail is not lost while Ops repairs it. */
export const isRetryableIntakeLabel = (label: string) =>
  /^resend_(transport_failed|http_(5\d\d|429|408)|http_unexpected|response_too_large|response_malformed|ambient_proxy_refused|key_(not_regular_file|not_private|invalid))$/.test(label);
/** The documented download host (resend.com/docs example). A different live host is refused until it is re-pinned. */
export const RESEND_DOWNLOAD_HOSTS = ["inbound-cdn.resend.com"] as const;
export type ResendFetch = (url: string, init: { method: "GET"; headers: Record<string, string>; redirect: "error"; signal: AbortSignal }) => Promise<Response>;
const fail = (label: string): never => { throw new IntakeError(label); };

/** Owner-only regular file (not a link), <= 4 KiB, one Resend key (re_...). Refusals name no content. */
export function readResendKey(path: string) {
  const ls = lstatSync(path);
  if (!ls.isFile() || ls.isSymbolicLink()) fail("resend_key_not_regular_file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if ((st.mode & 0o077) !== 0) fail("resend_key_not_private");
    if (st.size < 8 || st.size > 4096) fail("resend_key_invalid");
    const buf = Buffer.alloc(st.size); readSync(fd, buf, 0, st.size, 0);
    const key = buf.toString("utf8").trim();
    if (!/^re_[A-Za-z0-9_]{8,200}$/.test(key)) fail("resend_key_invalid");
    return key;
  } finally { closeSync(fd); }
}

async function bounded(res: Response, limit: number) {
  const r = res.body?.getReader(); if (!r) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const p = await r.read(); if (p.done) break; size += p.value.length; if (size > limit) { await r.cancel().catch(() => {}); fail("resend_response_too_large"); } chunks.push(p.value); }
  return Buffer.concat(chunks);
}

export function resendContentPort(o: { apiKeyFile: string; fetch?: ResendFetch; timeoutMs?: number }): ResendContentPort {
  const doFetch = o.fetch ?? (fetch as unknown as ResendFetch), timeout = o.timeoutMs ?? 20_000;
  const get = async (url: string, headers: Record<string, string>, limit: number) => {
    if (process.env.NODE_USE_ENV_PROXY) fail("resend_ambient_proxy_refused");
    let res: Response;
    try { res = await doFetch(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(timeout) }); }
    catch { return fail("resend_transport_failed"); }
    if (res.status !== 200) { await res.body?.cancel().catch(() => {}); fail(res.status >= 400 && res.status < 600 ? `resend_http_${res.status}` : "resend_http_unexpected"); }
    return bounded(res, limit);
  };
  const api = async (path: string) => {
    const buf = await get(RESEND_API + path, { authorization: "Bearer " + readResendKey(o.apiKeyFile), accept: "application/json" }, 2 * 1024 * 1024);
    try { return JSON.parse(buf.toString("utf8")); } catch { return fail("resend_response_malformed"); }
  };
  const id = (v: string) => { if (!/^[A-Za-z0-9-]{8,64}$/.test(v)) fail("resend_id_invalid"); return v; };
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
  return {
    async getReceived(emailId): Promise<ResendReceivedEmail> {
      const e = await api(`/emails/receiving/${id(emailId)}`);
      if (!e || typeof e !== "object" || typeof e.id !== "string") fail("resend_response_malformed");
      const headers: Record<string, string> = {};
      if (e.headers && typeof e.headers === "object")
        for (const [k, v] of Object.entries(e.headers).slice(0, 200)) headers[String(k).toLowerCase().slice(0, 200)] = (Array.isArray(v) ? v.join(", ") : String(v)).slice(0, 998);
      return { id: e.id, message_id: str(e.message_id, 998), subject: str(e.subject, 998), text: str(e.text, 1024 * 1024), html: str(e.html, 1024 * 1024), headers };
    },
    async listAttachments(emailId): Promise<ResendAttachment[]> {
      const l = await api(`/emails/receiving/${id(emailId)}/attachments`);
      if (!l || !Array.isArray(l.data)) fail("resend_response_malformed");
      return l.data.slice(0, 50).filter((a: any) => a && typeof a.id === "string" && typeof a.download_url === "string").map((a: any) => ({
        id: a.id, filename: String(a.filename ?? "attachment").slice(0, 255), size: Number.isFinite(a.size) ? a.size : Number.MAX_SAFE_INTEGER,
        content_type: String(a.content_type ?? "application/octet-stream").slice(0, 255), download_url: a.download_url, expires_at: String(a.expires_at ?? "") }));
    },
    async download(url, maxBytes) {
      let u: URL;
      try { u = new URL(url); } catch { return fail("resend_download_url_invalid"); }
      if (u.protocol !== "https:" || u.username || u.password || u.port || !(RESEND_DOWNLOAD_HOSTS as readonly string[]).includes(u.hostname)) fail("resend_download_host_not_admitted");
      return get(u.toString(), {}, maxBytes); // signed URL: NO Authorization header goes to the CDN
    },
  };
}
