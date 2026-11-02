// F6-S (BRIEF-F6S 135b3752; Fable ruling 83a20aeb): the F-6 suppression sync on CP. (a) parity: the evidence walk's eligible set is
// readAudience's for the same pages, and its contactsSha256 is Ops' f6_evidence.mjs F6_FAKE recipe on the same 250 contacts;
// (b) the cache takes its eligible set from the evidence walk (one walk per refresh); Addendum 1 (a496290c): the evidence lives in the
// DB only (newsletter_meta + the ops-audit row {at, evidenceSha256, total, unsubscribed, eligible, source}; no file under stateRoot),
// /ops/status newsletter.suppressionSync is the read-back line; (e) the Mac route stays. A null walk records nothing (F-6 fails
// closed). Fake Resend only, never the network.
import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { readAudience } from "../src/org/newsletter/resend-broadcast.js";
import { readAudienceEvidence, f6EvidenceJson, F6_EVIDENCE_KIND } from "../src/org/newsletter/f6-evidence.js";
import { FakeResend } from "../src/org/newsletter/fake-resend.js";
import { transcriptionWorld } from "./transcription-world.js";
import { canonical } from "../src/content.js";

const keyFile = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "knf6-"))), f = join(d, "release.key"); writeFileSync(f, "re_" + "F".repeat(30), { mode: 0o600 }); chmodSync(f, 0o600); return f; };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Ops' F6_FAKE audience (f6_evidence.mjs 4fff4f6f): 250 contacts c0000..c0249, every 50th unsubscribed, pages of 100. */
const opsFake = () => {
  const all = Array.from({ length: 250 }, (_, i) => ({ id: "c" + String(i).padStart(4, "0"), unsubscribed: i % 50 === 0 }));
  let calls = 0;
  const fetch = (async (url: string) => { calls++; const u = new URL(url), after = u.searchParams.get("after"); const i = after ? all.findIndex((x) => x.id === after) + 1 : 0;
    return json(200, { data: all.slice(i, i + 100), has_more: i + 100 < all.length }); }) as never;
  return { fetch, calls: () => calls };
};
const AUD = "8f489685-0000-4000-8000-000000000000";

it("(a) parity: same eligible set as readAudience, same request count, and Ops' F6_FAKE contactsSha256 on the same 250 contacts", async () => {
  const f = keyFile(), a = opsFake(), b = opsFake();
  const ev = await readAudienceEvidence({ keyFile: f, audienceId: AUD, fetch: a.fetch });
  const ids = await readAudience({ keyFile: f, audienceId: AUD, fetch: b.fetch });
  expect(ev!.eligible).toEqual(ids);
  expect([a.calls(), b.calls()]).toEqual([3, 3]);
  // node f6_evidence.mjs with F6_FAKE=1 and this audience id printed these (Ops' recipe, run 2026-10-29).
  expect(ev!.evidence).toEqual({ audienceIdSha256: "4d58b0a248dcb7c8c7856c0451568079d284bc46bf37e85e68c87e2d36d6ef28", total: 250, unsubscribed: 5, eligible: 245,
    contactsSha256: "d83c3d92a8ad30a3087abb4333c78585f5f71173c77daf903c248f09998e9745" });
  const doc = JSON.parse(f6EvidenceJson("2026-10-29T21:00:00.000Z", ev!.evidence));
  expect(Object.keys(doc)).toEqual(["kind", "at", "audienceIdSha256", "total", "unsubscribed", "eligible", "contactsSha256"]);
  expect(doc.kind).toBe(F6_EVIDENCE_KIND);
  expect(JSON.stringify(doc)).not.toMatch(/\bc0\d{3}\b|@/); // no contact id, no address
});

it("a walk that is not complete is null (429 exhausted, malformed id, empty page with has_more, the page cap, a non-200)", async () => {
  const f = keyFile();
  const always429 = (async () => new Response("{}", { status: 429, headers: { "retry-after": "0.01" } })) as never;
  expect(await readAudienceEvidence({ keyFile: f, audienceId: AUD, fetch: always429 })).toBeNull();
  expect(await readAudienceEvidence({ keyFile: f, audienceId: AUD, fetch: (async () => json(200, { has_more: false, data: [{ id: "bad id!" }] })) as never })).toBeNull();
  expect(await readAudienceEvidence({ keyFile: f, audienceId: AUD, fetch: (async () => json(200, { has_more: true, data: [] })) as never })).toBeNull();
  expect(await readAudienceEvidence({ keyFile: f, audienceId: AUD, fetch: opsFake().fetch, maxPages: 2 })).toBeNull();
  expect(await readAudienceEvidence({ keyFile: f, audienceId: AUD, fetch: (async () => json(503, {})) as never })).toBeNull();
  expect(await readAudienceEvidence({ keyFile: "/nonexistent/key", audienceId: AUD, fetch: opsFake().fetch })).toBeNull();
});

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;

describe.skipIf(!enabled)("F6-S in the org runtime", () => {
  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "knf6-w-")), kf = join(dir, "totp.key"), rk = join(dir, "resend-release.key");
    writeFileSync(kf, randomBytes(32).toString("base64"), { mode: 0o600 }); chmodSync(kf, 0o600);
    writeFileSync(rk, "re_" + "C".repeat(30), { mode: 0o600 }); chmodSync(rk, 0o600);
    const resend = new FakeResend(); resend.setContacts(5, [2]);
    const w = await transcriptionWorld({ newsletterProviderFetch: resend.fetch, newsletterAudienceMaxAgeMs: 1, newsletter: { totpKeyFile: kf, approvers: ["robin@exna.test"],
      from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org", releaseKeyFile: rk, listId: "aud_exna" } });
    const f6 = join(w.cfg.stateRoot, "newsletter", "f6"), db = () => w.org.sqlite.db;
    const meta = (k: string) => (db().prepare("SELECT value FROM newsletter_meta WHERE key=?").get(k) as { value: string } | undefined)?.value ?? null;
    const audit = () => db().prepare("SELECT event, record_sha256 FROM newsletter_ops_audit ORDER BY rowid").all() as { event: string; record_sha256: string }[];
    return { w, resend, f6, meta, audit, close: async () => { await w.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it("(b) + Addendum 1: a complete walk records the sync in the DB (source server, counts), one walk per refresh, no file; a failed walk records nothing", async () => {
    const s = await setup();
    try {
      expect(s.meta("suppressionSyncAt")).toBeNull();
      const before = Date.now();
      const ids = await s.w.org.newsletterRun!.audience.refresh();
      expect(ids).toEqual(["ct_1", "ct_3", "ct_4", "ct_5"]);
      expect(s.resend.log.filter((l) => l === "GET /audiences/{id}/contacts")).toHaveLength(3); // pageSize 2: ONE walk, no second
      expect(existsSync(s.f6)).toBe(false); // nothing new under stateRoot (the backup set is unchanged)
      const at = s.meta("suppressionSyncAt")!;
      expect(Date.parse(at)).toBeGreaterThanOrEqual(before - 1);
      // The recorded sha is the evidence document's: kind, at, the audience id's hash, the counts and the contacts hash.
      const lines = s.resend.contacts.map((c) => c.id + ":" + (c.unsubscribed ? "u" : "s")).sort();
      const ev = { audienceIdSha256: createHash("sha256").update("aud_exna").digest("hex"), total: 5, unsubscribed: 1, eligible: 4,
        contactsSha256: createHash("sha256").update(lines.join("\n") + "\n").digest("hex") };
      const sha = "sha256:" + createHash("sha256").update(f6EvidenceJson(at, ev)).digest("hex");
      expect([s.meta("suppressionSyncSha"), s.meta("suppressionSyncSource")]).toEqual([sha, "server"]);
      const rec = { at, evidenceSha256: sha, total: 5, unsubscribed: 1, eligible: 4, source: "server" };
      expect(s.audit()).toEqual([{ event: "suppression_sync", record_sha256: "sha256:" + createHash("sha256").update(canonical(rec)).digest("hex") }]);
      // A4: the read-back line (counts and a sha; no ids, no addresses).
      const st = (await s.w.ops("/ops/status", {})) as any;
      expect(st.newsletter.suppressionSync).toEqual({ at, sha, total: 5, unsubscribed: 1, eligible: 4, source: "server" });
      expect(JSON.stringify(st.newsletter)).not.toMatch(/ct_|example\.org/);
      // A failed walk (503 on the listing): nothing recorded, the time does not move.
      s.resend.fault("GET", /^\/audiences\//, 503);
      await new Promise((r) => setTimeout(r, 5));
      expect(await s.w.org.newsletterRun!.audience.refresh()).toBeNull();
      expect([s.meta("suppressionSyncAt"), s.audit().length]).toEqual([at, 1]);
      // (e) The Mac route stays: accepted, audited with source mac and no counts.
      const macAt = new Date().toISOString();
      expect((await s.w.ops("/ops/newsletter/suppression-sync", { at: macAt, evidenceSha256: "sha256:" + "a".repeat(64) })).ok).toBe(true);
      expect([s.meta("suppressionSyncAt"), s.meta("suppressionSyncSource"), s.audit().length]).toEqual([macAt, "mac", 2]);
      expect(((await s.w.ops("/ops/status", {})) as any).newsletter.suppressionSync).toEqual({ at: macAt, sha: "sha256:" + "a".repeat(64), source: "mac" });
    } finally { await s.close(); }
  });
});
