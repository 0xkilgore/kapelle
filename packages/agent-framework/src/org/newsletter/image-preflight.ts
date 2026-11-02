// Package E (Fable e9cdd63c E-1/E-2): the image preflight for newsletter v3, which hot-links CP's own public images exactly
// as every CP issue since April does. Kapelle never stores or serves them; it checks they are live and binds their bytes.
//
// OSS lift: CP site image preflight (owner's private repo, lift permitted) — example-org-website
//   src/lib/newsletter-image-preflight.ts (sha256 f29083c0b0d3eb04…): HEAD, then a 1-byte ranged GET on 403/405; 10 s
//   timeout; https only; an image/* content type.
// Adapt notes: (1) the allowlist check (imageUrl, E-1) runs BEFORE any network call, so a host can never come from content;
//   (2) redirects are not followed (`redirect: "manual"`; any 3xx refuses); (3) one bounded content GET per image
//   (<= 5 MiB, byte-counted, aborted over the cap, its own timeout) whose sha256 goes into the release package; (4) fixed
//   labels: newsletter_images_unserved (gone / not an image / unreachable), newsletter_image_changed (bytes differ from prepare).
import { createHash } from "node:crypto";
import { driveUrlSha, imageUrl } from "./render-cp.js";

export const IMAGE_PREFLIGHT = { timeoutMs: 10_000, contentTimeoutMs: 20_000, maxBytes: 5 * 1024 * 1024 } as const;
export type PreflightFetch = (url: string, init: RequestInit) => Promise<Response>;
export type ImageRef = { url: string; sha256: string };
export class ImagePreflightError extends Error { constructor(readonly label: "newsletter_images_unserved" | "newsletter_image_changed", readonly url: string) { super(label); } }

async function timed(f: PreflightFetch, url: string, init: RequestInit, ms: number) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { return await f(url, { ...init, redirect: "manual", signal: c.signal }); } finally { clearTimeout(t); }
}
const isImage = (r: Response) => r.status >= 200 && r.status < 300 && (r.headers.get("content-type") ?? "").toLowerCase().startsWith("image/");

/** The lifted liveness check, then the bounded content hash. Throws ImagePreflightError (never a provider's text). */
async function checkOne(f: PreflightFetch, raw: string): Promise<ImageRef> {
  const url = imageUrl(raw); // E-2: the allowlist precedes any network call
  if (!url) throw new ImagePreflightError("newsletter_images_unserved", raw);
  try {
    let r = await timed(f, url, { method: "HEAD" }, IMAGE_PREFLIGHT.timeoutMs);
    if (r.status === 403 || r.status === 405) r = await timed(f, url, { method: "GET", headers: { Range: "bytes=0-0" } }, IMAGE_PREFLIGHT.timeoutMs);
    if (!isImage(r)) throw new ImagePreflightError("newsletter_images_unserved", url);
    const g = await timed(f, url, { method: "GET" }, IMAGE_PREFLIGHT.contentTimeoutMs);
    if (!isImage(g) || !g.body) throw new ImagePreflightError("newsletter_images_unserved", url);
    const h = createHash("sha256"), reader = g.body.getReader(); let n = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      n += value.length; if (n > IMAGE_PREFLIGHT.maxBytes) { await reader.cancel(); throw new ImagePreflightError("newsletter_images_unserved", url); }
      h.update(value);
    }
    const hex = h.digest("hex"), named = driveUrlSha(url);
    // LIBRARY L2 (Fable L-7): a shared-drive URL is self-verifying: the bytes served must be exactly the hash it names.
    if (named && named.sha256 !== hex) throw new ImagePreflightError("newsletter_image_changed", url);
    return { url, sha256: "sha256:" + hex };
  } catch (e) { if (e instanceof ImagePreflightError) throw e; throw new ImagePreflightError("newsletter_images_unserved", url); }
}
/** Prepare: every referenced image, live and hashed (in order; one at a time, as the lift does). */
export async function hashImages(f: PreflightFetch, urls: readonly string[]): Promise<ImageRef[]> {
  const out: ImageRef[] = [];
  for (const u of urls) out.push(await checkOne(f, u));
  return out;
}
/** Test and send: re-run and COMPARE with the prepared bytes; the first failure, by fixed label. */
export async function recheckImages(f: PreflightFetch, prepared: readonly ImageRef[]): Promise<{ ok: true } | { ok: false; label: ImagePreflightError["label"]; url: string }> {
  for (const p of prepared) {
    try { const now = await checkOne(f, p.url); if (now.sha256 !== p.sha256) return { ok: false, label: "newsletter_image_changed", url: p.url }; }
    catch (e) { return { ok: false, label: e instanceof ImagePreflightError ? e.label : "newsletter_images_unserved", url: p.url }; }
  }
  return { ok: true };
}
