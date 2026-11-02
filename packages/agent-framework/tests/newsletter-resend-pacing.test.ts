// S3 live run 2026-10-29 (the executor's POST /send got 429 after four calls in ~1 s; q3's listing got 429 on its first page): the
// connector paces every request through ONE process-wide slot (starts >= paceMs apart, one in flight), and a 429 ("rate limited,
// not processed") is retried after Retry-After, at most RESEND_429_RETRIES times, then answered as the refusal it is (never sent).
import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { resendBroadcastPort, readAudience, retryAfterMs, RESEND_PACE_MS, RESEND_429_RETRIES, RESEND_RETRY_AFTER_MAX_MS } from "../src/org/newsletter/resend-broadcast.js";
import { ProviderError } from "../src/org/newsletter/release.js";

const keyFile = () => { const d = realpathSync(mkdtempSync("/tmp/knlp-")), f = join(d, "release.key"); writeFileSync(f, "re_" + "P".repeat(30), { mode: 0o600 }); chmodSync(f, 0o600); return f; };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

it("pacing: request starts are >= paceMs apart, one at a time, across concurrent callers; an injected fetch without paceMs is unpaced", async () => {
  expect([RESEND_PACE_MS, RESEND_429_RETRIES, RESEND_RETRY_AFTER_MAX_MS]).toEqual([600, 2, 5000]); // under Resend's documented 2/s per team
  const f = keyFile(), starts: number[] = [];
  const fetch = (async () => { starts.push(Date.now()); return json(200, { id: "b1", name: "n", status: "draft", subject: "s", html: "<p>x</p>" }); }) as never;
  const paced = resendBroadcastPort({ keyFile: f, listId: "aud_x", listField: "segment_id", fetch, paceMs: 80 });
  await Promise.all([paced.getBroadcast("b1"), paced.getBroadcast("b1"), paced.getBroadcast("b1")]); // concurrent callers still queue
  expect(starts).toHaveLength(3);
  for (let k = 1; k < 3; k++) expect(starts[k] - starts[k - 1]).toBeGreaterThanOrEqual(75);
  starts.length = 0;
  const free = resendBroadcastPort({ keyFile: f, listId: "aud_x", listField: "segment_id", fetch });
  const t0 = Date.now(); await Promise.all([free.getBroadcast("b1"), free.getBroadcast("b1")]); expect(Date.now() - t0).toBeLessThan(60);
});

it("429 = not processed: retried after Retry-After (capped), at most twice; a third 429 is a refusal that never took effect", async () => {
  expect([retryAfterMs("0.05"), retryAfterMs("2"), retryAfterMs("999"), retryAfterMs(null), retryAfterMs("x")]).toEqual([50, 2000, 5000, 1000, 1000]);
  const f = keyFile();
  // The send: 429 then 200 -> accepted after one retry.
  let n = 0;
  const once = (async () => (++n === 1 ? json(429, { name: "rate_limit_exceeded" }, { "retry-after": "0.05" }) : json(200, { id: "b1" }))) as never;
  expect(await resendBroadcastPort({ keyFile: f, listId: "aud_x", listField: "segment_id", fetch: once }).send("b1")).toEqual({ accepted: true });
  expect(n).toBe(2);
  // Three 429s: two retries, then the refusal (sent = false: the executor holds, never assumes it went out).
  let m = 0;
  const always = (async () => { m++; return json(429, { name: "rate_limit_exceeded" }, { "retry-after": "0.02" }); }) as never;
  const e = await resendBroadcastPort({ keyFile: f, listId: "aud_x", listField: "segment_id", fetch: always }).send("b1").catch((x) => x);
  expect([e instanceof ProviderError, (e as ProviderError).label, (e as ProviderError).sent, m]).toEqual([true, "newsletter_provider_refused", false, 3]);
  // The listing (q3's failure): a 429 on the first page is retried; the walk then completes.
  let p = 0;
  const list = (async (url: string) => { p++; if (p === 1) return json(429, {}, { "retry-after": "0.02" });
    return json(200, { has_more: false, data: [{ id: "b1", name: "kapelle:op1" }, { id: "b2", name: "kapelle:op2" }] }); }) as never;
  expect(await resendBroadcastPort({ keyFile: f, listId: "aud_x", listField: "segment_id", fetch: list }).listBroadcasts()).toEqual({ complete: true, items: [{ id: "b1", name: "kapelle:op1" }, { id: "b2", name: "kapelle:op2" }] });
  // The audience reader too.
  let a = 0;
  const aud = (async () => (++a === 1 ? json(429, {}, { "retry-after": "0.02" }) : json(200, { has_more: false, data: [{ id: "ct_1", unsubscribed: false }] }))) as never;
  expect(await readAudience({ keyFile: f, audienceId: "aud_x", fetch: aud })).toEqual(["ct_1"]);
});
