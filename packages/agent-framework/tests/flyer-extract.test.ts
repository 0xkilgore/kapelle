// IMAGES-V1 I2a (design of record §2): the flyer-reading profile (a NEW pinned profile beside the untouched text profile), its
// one-request transport (one inline JPEG, no tools, pinned routing), the fixed rules over the model's proposal (no inferred
// year/address; text in the flyer is data), and the runtime path (owner-only, the org's hosted ledger, caps, unknown outcomes
// held unsettled, member-checked values). A FAKE provider only; no network.
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { transcriptionWorld } from "./transcription-world.js";
import { INTERACTIVE_PROFILES, IMAGE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";
import { interactiveProfileHash } from "../src/agent-kit/interactive/profile.js";
import { imageExtractComplete, imageProfileFromHosted, imageProfileHash, imageRequestBody } from "../src/agent-kit/interactive/image.js";
import { FLYER_RULES_HASH, FLYER_SYSTEM, applyFlyerRules, parseFlyerAnswer } from "../src/agent-kit/interactive/flyer.js";
import { OPENROUTER_PROFILES } from "../src/agent-kit/hosted/openrouter.js";
import { HostedTransportError } from "../src/agent-kit/hosted/transport.js";
import { failureLabel, persistedReason } from "../src/task-delegation/failure-labels.js";
import { IMAGE_REASONS } from "../src/org/images/labels.js";
import { FlyerExtractor } from "../src/org/images/extract.js";

const DECODER = new URL("../decoder/decode.mjs", import.meta.url).pathname;
const hasDecoder = existsSync(new URL("../decoder/node_modules/sharp/package.json", import.meta.url));
const sharp = hasDecoder ? createRequire(new URL("../decoder/package.json", import.meta.url))("sharp") : null;
const P = IMAGE_PROFILES.sonnet, MODEL = P.runtime.model;
const ANSWER = { fields: { title: { raw: "block party", value: "Block Party" }, date: { raw: "Saturday Nov 8", value: "2026-11-08" }, time: { raw: "2-5 PM", value: "2:00 PM - 5:00 PM" },
  location: { raw: "Community Center", value: "Community Center" }, address: { raw: null, value: "1 Main St" }, description: { raw: "Games, food, music", value: "Games, food and music for neighbors." } },
  notes: "Year not printed." };
const reply = (content: string | null, o: { finish?: string; tool_calls?: unknown[]; usage?: unknown; provider?: string } = {}) => new Response(JSON.stringify({ id: "gen-1", model: MODEL,
  provider: o.provider ?? "Amazon Bedrock", choices: [{ finish_reason: o.finish ?? "stop", message: { role: "assistant", content, ...(o.tool_calls ? { tool_calls: o.tool_calls } : {}) } }],
  usage: o.usage === undefined ? { prompt_tokens: 2100, completion_tokens: 180, total_tokens: 2280, cost: 0.0091, prompt_tokens_details: { image_tokens: 1600 } } : o.usage }),
  { status: 200, headers: { "content-type": "application/json" } });
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);

it.skip("profile: a NEW pinned flyer profile from the qualified text pins; the text profile's hash is unchanged; the rules are its identity; qualified (I2c)", () => {
  // Package F (Fable condition (2)): the CHAT profile moved (56a25c88 -> 4960ec96: catalog + rules); PACKAGE P moved it again
  // (-> d2623809: the catalog); the flyer profile below did not (a7d5d834).
  expect(interactiveProfileHash(INTERACTIVE_PROFILES.sonnet)).toBe("sha256:d26238099aba1a2b9a9460b1b286ec6eb05c4085c018a510b9dc59b6762450dd");
  const t = INTERACTIVE_PROFILES.sonnet.runtime;
  expect(P).toMatchObject({ id: "or-sonnet-4-6-us-flyer", contract: "kapelle.image-extraction/v1", qualificationRef: "sha256:9c6a0b704f6a195209ae11564b619e42b1b0e3cc499b1221f745e7b9567f8742",
    runtime: { model: t.model, origin: t.origin, providers: t.providers, dataPolicy: t.dataPolicy, rulesHash: FLYER_RULES_HASH,
      image: { input: "jpeg-inline-base64", maxImageBytes: 1048576, maxLongEdge: 1600, maxRequestBytes: 2097152 } } });
  expect(imageProfileHash(imageProfileFromHosted("or-sonnet-4-6-us-flyer", OPENROUTER_PROFILES.sonnet, "sha256:" + "0".repeat(64)))).not.toBe(imageProfileHash(P));
  expect(imageProfileHash({ ...P, qualificationRef: "sha256:" + "1".repeat(64) })).toBe(imageProfileHash(P)); // F-8: the ref is not identity
  for (const l of IMAGE_REASONS) { expect(failureLabel(new Error(l)), l).toBe(l); expect(persistedReason(l)).toBe(l); }
});

describe("the one-request flyer transport", () => {
  const go = (fetch: any, jpeg = JPEG) => imageExtractComplete({ profile: P, apiKey: "sk-or-v1-TEST", system: FLYER_SYSTEM, text: "read", jpeg },
    { fetch, signal: AbortSignal.timeout(5000), deadlineMs: 5000 });
  const label = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof HostedTransportError ? `${e.reason}|sent=${e.sent}` : String(e); } };

  it("sends ONE inline JPEG with the pinned routing and NO tools; returns text, cost and image-token evidence", async () => {
    const seen: any[] = [];
    const r = await go(async (u: string, i: any) => { seen.push({ u, b: JSON.parse(i.body), redirect: i.redirect }); return reply(JSON.stringify(ANSWER)); });
    expect(seen).toHaveLength(1);
    const b = seen[0].b;
    expect(seen[0].u).toBe(P.runtime.origin + "/chat/completions"); expect(seen[0].redirect).toBe("error");
    expect(b).toMatchObject({ model: MODEL, stream: false, temperature: 0, max_tokens: 1500, provider: { order: P.runtime.providers, allow_fallbacks: false, require_parameters: true, data_collection: "deny" } });
    expect(b.tools).toBeUndefined(); expect(b.tool_choice).toBeUndefined();
    expect(b.messages).toHaveLength(2);
    expect(b.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + JPEG.toString("base64") } });
    expect(r).toMatchObject({ routedProvider: "Amazon Bedrock", costUsd: 0.0091, usage: { promptTokens: 2100, completionTokens: 180, imageTokens: 1600 } });
  });

  it("refuses: not a JPEG / over 1 MiB / request over 2 MiB (nothing sent); tool calls; truncation; reasoning; wrong provider; missing usage", async () => {
    const never = async () => { throw new Error("must not send"); };
    expect(await label(go(never, Buffer.from("GIF89a")))).toBe("image_request_invalid|sent=false");
    expect(await label(go(never, Buffer.concat([JPEG, Buffer.alloc(1024 * 1024)])))).toBe("image_request_invalid|sent=false");
    expect(await label(go(async () => reply(null, { finish: "tool_calls", tool_calls: [{ id: "c1", type: "function", function: { name: "read_org_file", arguments: "{}" } }] }))))
      .toBe("image_tool_calls_refused|sent=true");
    expect(await label(go(async () => reply("{}", { finish: "length" })))).toBe("chat_output_truncated|sent=true");
    expect(await label(go(async () => new Response(JSON.stringify({ model: MODEL, provider: "Amazon Bedrock", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "x", reasoning: "thinking" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }), { status: 200, headers: { "content-type": "application/json" } })))).toBe("hosted_reasoning_refused|sent=true");
    expect(await label(go(async () => reply("{}", { provider: "SomeOtherHost" })))).toBe("hosted_provider_not_allowed|sent=true");
    expect(await label(go(async () => reply("{}", { usage: null })))).toBe("hosted_usage_missing|sent=true");
    expect(await label(go(async () => new Response("{}", { status: 503 })))).toBe("hosted_http_5xx|sent=true");
    expect(Buffer.byteLength(JSON.stringify(imageRequestBody(P, FLYER_SYSTEM, "read", Buffer.alloc(1024 * 1024))))).toBeLessThan(P.runtime.image.maxRequestBytes); // a full 1 MiB fits
  });
});

it("the runtime's rules over a proposal: no year that isn't printed, no value without printed wording, a fence is tolerated, extra keys refused", () => {
  const p = applyFlyerRules(parseFlyerAnswer("```json\n" + JSON.stringify(ANSWER) + "\n```")!);
  expect(p.fields.date).toEqual({ raw: "Saturday Nov 8", value: null, needsConfirmation: true, source: "flyer" }); // year not printed
  expect(p.fields.address.value).toBeNull(); // not printed: the model's "1 Main St" is a guess
  expect(p.fields.title).toMatchObject({ raw: "block party", value: "Block Party" });
  expect(p.fields.description.value).toBe("Games, food and music for neighbors.");
  const withYear = applyFlyerRules(parseFlyerAnswer(JSON.stringify({ ...ANSWER, fields: { ...ANSWER.fields, date: { raw: "Sat Nov 8, 2026", value: "2026-11-08" } } }))!);
  expect(withYear.fields.date.value).toBe("2026-11-08");
  expect(applyFlyerRules(parseFlyerAnswer(JSON.stringify({ ...ANSWER, fields: { ...ANSWER.fields, date: { raw: "Nov 8, 2025", value: "2026-11-08" } } }))!).fields.date.value).toBeNull();
  expect(parseFlyerAnswer(JSON.stringify({ ...ANSWER, tool: "send_email" }))).toBeNull();
  expect(parseFlyerAnswer("Sure! Here are the details: ...")).toBeNull();
  expect(parseFlyerAnswer(JSON.stringify({ ...ANSWER, fields: { ...ANSWER.fields, date: { raw: "x", value: "Nov 8" } } }))).toBeNull();
});

describe.skipIf(!hasDecoder || !process.env.KAPELLE_SCOPED_REACTOR_ROOT)("Read this flyer in the org runtime (I2a)", () => {
  async function setup(answer: () => Promise<Response>) {
    const calls: any[] = [];
    const fetch = async (u: string, i: any) => { const b = JSON.parse(i.body); calls.push(b);
      return Array.isArray(b.messages?.[1]?.content) ? answer() : new Response("{}", { status: 503 }); };
    const w = await transcriptionWorld({ chat: {}, fetch: fetch as never, images: { decoder: { mode: "child", node: process.execPath, script: DECODER, unisolated: true }, extract: true } });
    const api = (p: string, b: unknown, c = w.alex) => w.post(`/o/exna/api/${p}`, b, c);
    const conv = (await api("chat/conversation/create", {})).result.conversationId;
    const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#c33" } }).png().toBuffer();
    const t = (await api("image/upload", { conversationId: conv, size: png.length, contentType: "image/png" })).result;
    const row = w.org.sqlite.db.prepare("SELECT member_id, session_ref FROM image_uploads WHERE upload_id=?").get(t.uploadId) as any;
    const img = await w.org.images!.put(t.uploadId, { memberId: row.member_id, role: "contributor", sessionRef: row.session_ref }, Readable.from([png]), { size: png.length, contentType: "image/png" });
    const ledger = () => w.org.sqlite.db.prepare("SELECT key AS session_id, state, cost_usd, reason FROM effects WHERE key LIKE 'image:%' ORDER BY rowid").all() as any[];
    return { w, api, conv, img, calls, ledger, close: () => w.close() };
  }

  it("proposal: one request with the member's sanitized JPEG; settled on the org ledger; rules applied; the member saves checked values", async () => {
    const s = await setup(async () => reply(JSON.stringify(ANSWER)));
    try {
      expect((await s.api("member/me", {})).result).toMatchObject({ images: true, imageExtract: true });
      const r = await s.api("image/extract", { imageId: s.img.imageId });
      expect(r.result).toMatchObject({ state: "proposed", label: null, imageSha256: s.img.sha256, profileId: "or-sonnet-4-6-us-flyer", costUsd: 0.0091,
        proposed: { fields: { title: { value: "Block Party", needsConfirmation: true, source: "flyer" }, date: { value: null }, address: { value: null } } } });
      const sent = s.calls.filter((b) => Array.isArray(b.messages?.[1]?.content));
      expect(sent).toHaveLength(1);
      expect(Buffer.from(sent[0].messages[1].content[1].image_url.url.split(",")[1], "base64").equals(s.w.org.images!.read({ memberId: (s.w.org.sqlite.db.prepare("SELECT member_id FROM chat_images").get() as any).member_id, role: "x", sessionRef: "x" }, { imageId: s.img.imageId }).data)).toBe(true);
      expect(s.ledger()).toEqual([expect.objectContaining({ session_id: `image:${r.result.proposalId}`, state: "settled", cost_usd: 0.0091 })]);
      // The conversation view lists it; the member saves CHECKED values.
      expect((await s.api("chat/conversation/read", { conversationId: s.conv })).result.flyers).toEqual([expect.objectContaining({ proposalId: r.result.proposalId, state: "proposed" })]);
      expect((await s.api("image/proposal/save", { proposalId: r.result.proposalId, fields: { title: "Block Party", date: "Nov 8" } })).error).toBe("image_proposal_invalid");
      expect((await s.api("image/proposal/save", { proposalId: r.result.proposalId, fields: { title: "Block Party", tool: "x" } })).error).toBe("image_proposal_invalid");
      const saved = await s.api("image/proposal/save", { proposalId: r.result.proposalId, fields: { title: "Block Party", date: "2026-11-08", time: "2:00 PM", location: "Community Center",
        address: "", description: "Games, food and music." } });
      expect(saved.result).toMatchObject({ checked: { title: "Block Party", date: "2026-11-08", address: null }, checkedAt: expect.any(String) });
      // Another member: not their image, not their proposal.
      expect((await s.api("image/extract", { imageId: s.img.imageId }, s.w.robin)).error).toBe("image_unknown");
      expect((await s.api("image/proposal/save", { proposalId: r.result.proposalId, fields: {} }, s.w.robin)).error).toBe("image_proposal_unknown");
    } finally { await s.close(); }
  });

  it("an unreadable answer fails (cost settled); an unknown outcome is held unsettled and never resent; the daily cap holds", async () => {
    let mode = "prose";
    const s = await setup(async () => mode === "prose" ? reply("I see a flyer for a party!") : new Response("{}", { status: 503 }));
    try {
      expect((await s.api("image/extract", { imageId: s.img.imageId })).result).toMatchObject({ state: "failed", label: "image_extract_unreadable", costUsd: 0.0091 });
      mode = "5xx";
      expect((await s.api("image/extract", { imageId: s.img.imageId })).result).toMatchObject({ state: "unsettled", label: "hosted_http_5xx" });
      expect(s.ledger().map((x) => x.state)).toEqual(["settled", "unsettled"]);
      mode = "prose";
      for (let i = 2; i < 10; i++) expect((await s.api("image/extract", { imageId: s.img.imageId })).ok).toBe(true);
      expect((await s.api("image/extract", { imageId: s.img.imageId })).error).toBe("image_extract_cap");
    } finally { await s.close(); }
  });

  it("a pending profile makes no request in production (no injected provider)", async () => {
    const s = await setup(async () => reply(JSON.stringify(ANSWER)));
    try {
      const prod = new FlyerExtractor(s.w.org.sqlite, { images: s.w.org.images!, profile: { ...P, qualificationRef: "pending:or-sonnet-4-6-us-flyer" }, ledger: null as never, secretFile: "/nonexistent" });
      expect(prod.qualified).toBe(false);
      const m = s.w.org.sqlite.db.prepare("SELECT member_id FROM chat_images").get() as any;
      await expect(prod.extract({ memberId: m.member_id, role: "contributor", sessionRef: "x" }, { imageId: s.img.imageId })).rejects.toThrow("image_profile_not_qualified");
      expect(s.calls.filter((b) => Array.isArray(b.messages?.[1]?.content))).toHaveLength(0);
    } finally { await s.close(); }
  });
});
