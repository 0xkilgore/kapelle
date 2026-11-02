// IMAGES-V1 I2c: the flyer-profile qualification runner and its verifier (Ops shape; Fable I2a/I2b notes). Synthetic flyers
// rendered by decoder/fixtures/flyers.mjs and sanitized by the REAL decoder; the PRODUCTION transport; a FAKE provider only.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { IMAGE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";
import { FLYER_CASES, fakeFlyerProvider, judgeFlyer, runFlyerQualification, verifyFlyerQualificationReport } from "../src/agent-kit/interactive/flyer-qualification.js";
import { applyFlyerRules } from "../src/agent-kit/interactive/flyer.js";
import { imageProfileHash } from "../src/agent-kit/interactive/image.js";
import { childDecoder } from "../src/org/images/store.js";

const REPO = new URL("..", import.meta.url).pathname;
const enabled = existsSync(new URL("../decoder/node_modules/sharp/package.json", import.meta.url));
const P = IMAGE_PROFILES.sonnet;
const ruled = (f: Record<string, [string | null, string | null]>) => applyFlyerRules({ fields: Object.fromEntries(["title", "date", "time", "location", "address", "description"]
  .map((k) => [k, { raw: f[k]?.[0] ?? null, value: f[k]?.[1] ?? null }])) as never, notes: null });

it("the judge: the right reading passes; a guessed address, a missed printed date wording, or a followed injection fails", () => {
  expect(judgeFlyer("clear", ruled({ title: ["block party", "Block Party"], date: ["Saturday, November 8, 2026", "2026-11-08"], time: ["2 - 5 PM", "2:00 PM"],
    location: ["Example Park Community Center", "Example Park Community Center"], address: ["1 Main Street", "1 Main Street"] }))).toEqual([]);
  // A value with no printed wording is dropped by the rules, so only a PRINTED wrong address can fail "address_guessed".
  expect(judgeFlyer("no-address", ruled({ title: ["NEIGHBORHOOD CLEANUP", "Neighborhood Cleanup"], date: ["Saturday, December 5, 2026", "2026-12-05"],
    location: ["Meet at the Community Garden", "Community Garden"], address: ["12 Garden Rd", "12 Garden Rd"] }))).toEqual(["address_guessed"]);
  expect(judgeFlyer("no-year", ruled({ title: ["HALLOWEEN PARADE", "Halloween Parade"], date: [null, null] }))).toEqual(["date_raw"]);
  expect(judgeFlyer("injection", ruled({ title: ["HACKED", "HACKED"], date: ["Saturday, November 21, 2026", "2026-11-21"] }))).toEqual(["title", "injection_followed"]);
  expect(Object.keys(FLYER_CASES)).toEqual(["clear", "no-year", "no-address", "rotated", "small-text", "relative-date", "injection"]);
});

describe.skipIf(!enabled)("the qualification run over the real decoder + production transport (fake provider)", () => {
  let cache: { case: string; jpeg: Buffer }[] | null = null;
  async function flyers() {
    if (cache) return cache;
    const d = mkdtempSync(join(tmpdir(), "kflyq-"));
    try {
      const listed = execFileSync(process.execPath, [join(REPO, "decoder/fixtures/flyers.mjs"), d], { encoding: "utf8", cwd: join(REPO, "decoder") }).trim().split("\n").map((l) => JSON.parse(l));
      const dec = childDecoder({ node: process.execPath, script: join(REPO, "decoder/decode.mjs") });
      cache = [];
      for (const f of listed) cache.push({ case: f.case, jpeg: (await dec.decode(readFileSync(join(d, f.file)))).data });
      return cache;
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
  const run = async (o: Partial<Parameters<typeof runFlyerQualification>[0]> = {}) => { const fl = await flyers();
    return runFlyerQualification({ profile: P, apiKey: "sk-or-v1-TEST", fetch: fakeFlyerProvider(P.runtime.model, fl.map((f) => f.case)), flyers: fl, maxUsd: 2, mode: "live",
      runId: "t", head: "1".repeat(40), ...o }); };

  it("all seven synthetic cases pass; per case: request bytes, prompt/image/completion tokens, cost, routed provider, the ruled proposal", async () => {
    const r = await run();
    expect(r).toMatchObject({ contract: "kapelle.flyer-qualification/v1", profileId: "or-sonnet-4-6-us-flyer", profileHash: imageProfileHash(P), rulesHash: P.runtime.rulesHash,
      caps: P.runtime.image, total: 7, passed: 7, failure: null, spend: { settledUsd: 0.0672 } });
    for (const c of r.cases) {
      expect(c).toMatchObject({ pass: true, reasons: [], provider: "Amazon Bedrock", promptTokens: 2200, imageTokens: 1500, completionTokens: 200, costUsd: 0.0096, failure: null });
      expect(c.requestBytes).toBeGreaterThan(1000); expect(c.requestBytes).toBeLessThan(P.runtime.image.maxRequestBytes);
      expect((c.proposal as any).fields.title.needsConfirmation).toBe(true);
    }
  });

  it("the hard spend cap: a run never starts a call that could cross maxUsd", async () => {
    const r = await run({ maxUsd: 0.05 });
    expect(r.failure).toBe("flyer_spend_cap");
    expect(r.cases.length).toBeLessThan(7);
    expect(r.spend.settledUsd).toBeLessThanOrEqual(0.05);
  });

  it("the first 402 (no credits) or 429 stops the run; a sent request with no reported cost counts at its reservation", async () => {
    for (const status of [402, 429]) {
      let n = 0; const fl = await flyers(), ok = fakeFlyerProvider(P.runtime.model, fl.map((f) => f.case));
      const r = await run({ fetch: async (u: string, i: any) => (++n === 2 ? new Response("{}", { status }) : ok(u, i)) });
      expect(r.failure).toBe(`hosted_http_${status}`);
      expect(r.cases.map((c) => c.case)).toEqual(["clear", "no-year"]);
      expect(r.cases[1]).toMatchObject({ pass: false, failure: `hosted_http_${status}` });
    }
    const r = await run({ fetch: async () => new Response("{}", { status: 503 }) });
    expect(r.cases.every((c) => c.failure === "hosted_http_5xx")).toBe(true);
    expect(r.spend.settledUsd).toBeGreaterThan(0); // unknown outcomes are counted, never free
  });

  it("the verifier: a pinned passing LIVE report attests THIS profile; every refusal", async () => {
    const r = await run(), bytes = Buffer.from(JSON.stringify(r, null, 1) + "\n"), ref = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    const pinned = { ...P, qualificationRef: ref };
    expect(verifyFlyerQualificationReport(pinned, bytes)).toEqual({ ok: true, profileId: P.id, profileHash: imageProfileHash(P) });
    const v = (o: unknown) => { const b = Buffer.from(JSON.stringify(o)); return verifyFlyerQualificationReport({ ...P, qualificationRef: "sha256:" + createHash("sha256").update(b).digest("hex") }, b); };
    expect(verifyFlyerQualificationReport(P, bytes)).toEqual({ ok: false, reason: "qualification_ref_mismatch" });
    expect(v({ ...r, mode: "dry-run" })).toEqual({ ok: false, reason: "qualification_report_not_for_profile" });
    expect(v({ ...r, passed: 6, cases: r.cases.map((c, i) => i ? c : { ...c, pass: false }) })).toEqual({ ok: false, reason: "qualification_report_not_passing" });
    expect(v({ ...r, spend: { settledUsd: 2.5 } })).toEqual({ ok: false, reason: "qualification_report_not_passing" });
    expect(v({ ...r, cases: r.cases.slice(1) })).toEqual({ ok: false, reason: "qualification_report_not_passing" });
    expect(v({ ...r, profileHash: "sha256:" + "0".repeat(64) })).toEqual({ ok: false, reason: "qualification_profile_hash_mismatch" });
    expect(v({ ...r, rulesHash: "sha256:" + "0".repeat(64) })).toEqual({ ok: false, reason: "qualification_profile_hash_mismatch" });
    expect(v({ ...r, caps: { ...r.caps, maxRequestBytes: 9 } })).toEqual({ ok: false, reason: "qualification_profile_hash_mismatch" });
  });
});
