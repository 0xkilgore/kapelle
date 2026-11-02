// IMAGES-V1 I3 (design of record §3; Fable N-1): a reviewer's OWN checked flyer becomes a website event with its image, in ONE
// draft PR. The runtime (never the model) names public/images/events/<slug<=80>-<16-hex>.jpg and sets the one upserted event's
// image; the card/approval binds event, attachment, full hash, size, path and policy; website_image_missing sees the
// prospective tree; blobs + one tree/commit; the commit's exact image bytes and the JSON reference are read back before success.
// Real org runtime + hub + decoder; FAKE GitHub; scripted models; synthetic images only.
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { transcriptionWorld } from "./transcription-world.js";
import { hosted } from "./org-meeting-kit.js";
import { FakeGithub } from "../src/org/website/fake-github.js";
import { githubPort } from "../src/org/website/github.js";
import { IMAGE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";
import { eventImagePath, WEBSITE_IMAGE_POLICY } from "../src/org/website/data.js";
import { failureLabel, persistedReason } from "../src/task-delegation/failure-labels.js";
import { WEBSITE_REQUEST_REASONS, WEBSITE_APPLY_REASONS } from "../src/org/website/labels.js";

const DECODER = new URL("../decoder/decode.mjs", import.meta.url).pathname;
const hasDecoder = existsSync(new URL("../decoder/node_modules/sharp/package.json", import.meta.url));
const sharp = hasDecoder ? createRequire(new URL("../decoder/package.json", import.meta.url))("sharp") : null;
const sha = (b: Buffer) => "sha256:" + createHash("sha256").update(b).digest("hex");
const EVENTS = JSON.stringify({ events: [{ id: "block-party-2026", title: "Block Party", date: "2026-10-18", time: "11:00 AM", location: "Example Park", address: "Springfield, TN",
  description: "Thanks.", type: "community" }] }, null, 2) + "\n";
const MEETINGS = JSON.stringify({ meetings: [] }, null, 2) + "\n";
const EVENT = { id: "block-party-2026-11", title: "Block Party", date: "2026-11-08", time: "2:00 PM", location: "Community Center", address: "", description: "Games, food and music.", type: "community" };
const FLYER = { fields: { title: { raw: "block party", value: "Block Party" }, date: { raw: "Saturday, November 8, 2026", value: "2026-11-08" }, time: { raw: "2-5 PM", value: "2:00 PM" },
  location: { raw: "Community Center", value: "Community Center" }, address: { raw: null, value: null }, description: { raw: "Games", value: "Games, food and music." } }, notes: null };
const reply = (content: string, o: { model: string; provider: string; usage: unknown }) => new Response(JSON.stringify({ id: "g", model: o.model, provider: o.provider,
  choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: o.usage }), { status: 200, headers: { "content-type": "application/json" } });

it("the asset name: runtime slug <= 80 + 16-hex prefix; the public path fits the pack's image rule (<= 116 chars); labels persist", () => {
  const h = "sha256:" + "ab".repeat(32);
  expect(eventImagePath("block-party-2026", h)).toBe("public/images/events/block-party-2026-abababababababab.jpg");
  const long = eventImagePath("x".repeat(120), h).slice("public".length);
  expect(long.length).toBeLessThanOrEqual(116);
  expect(long).toMatch(/^\/images\/events\/x{80}-[a-f0-9]{16}\.jpg$/);
  expect(eventImagePath("Odd ID__2026", h)).toBe("public/images/events/odd-id-2026-abababababababab.jpg");
  expect(() => eventImagePath("e", "nope")).toThrow("website_image_changed");
  for (const l of ["website_image_changed", "website_image_target_ambiguous", "website_image_conflict", "website_image_too_large", "website_image_readback_failed"]) {
    expect([...WEBSITE_REQUEST_REASONS, ...WEBSITE_APPLY_REASONS]).toContain(l); expect(persistedReason(failureLabel(new Error(l)))).toBe(l);
  }
});

it("the connector reads a file over the contents API's 1 MB inline limit by its blob (a sanitized flyer can be up to 1 MiB)", async () => {
  const big = Buffer.alloc(1_040_000, 9), gh = new FakeGithub(undefined, { "public/images/events/big.jpg": big, "src/data/events.json": EVENTS });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kghi-"))), patFile = join(dir, "pat");
  writeFileSync(patFile, "github_pat_SYNTHETIC0123456789abcdefghijklmnopqrstuvwxyz\n", { mode: 0o600 });
  const port = githubPort({ repo: gh.repo, patFile, fetch: gh.fetch as never });
  expect((await port.file("public/images/events/big.jpg", gh.refs.get("main")!))!.bytes.equals(big)).toBe(true);
  expect(gh.calls.some((c) => /^\/git\/blobs\//.test(c.path))).toBe(true);
});

describe.skipIf(!hasDecoder || !process.env.KAPELLE_SCOPED_REACTOR_ROOT || !process.env.KAPELLE_PLATFORM_MODELS_ROOT)("flyer -> website event (I3)", () => {
  async function setup(o: { files?: Record<string, string | Buffer> } = {}) {
    const gh = new FakeGithub(undefined, { "src/data/events.json": EVENTS, "src/data/meeting-notes.json": MEETINGS, ...(o.files ?? {}) });
    const state = { ops: [{ op: "upsert_event", event: EVENT }] as unknown[], websiteUsers: [] as string[] };
    const fetch = async (_u: string, i: any) => {
      const b = JSON.parse(i.body);
      if (Array.isArray(b.messages?.[1]?.content)) return reply(JSON.stringify(FLYER), { model: IMAGE_PROFILES.sonnet.runtime.model, provider: "Amazon Bedrock",
        usage: { prompt_tokens: 2100, completion_tokens: 180, total_tokens: 2280, cost: 0.0091, prompt_tokens_details: { image_tokens: 1600 } } });
      state.websiteUsers.push(String(b.messages?.at(-1)?.content ?? ""));
      return reply(JSON.stringify({ ops: state.ops }), { model: hosted.runtime.responseModels?.at(-1) ?? hosted.runtime.model, provider: (hosted.runtime.providerNames ?? hosted.runtime.providers)[0],
        usage: { prompt_tokens: 9000, completion_tokens: 200, total_tokens: 9200, cost: 0.03 } });
    };
    const w = await transcriptionWorld({ chat: {}, fetch: fetch as never, githubFetch: gh.fetch, website: { dailyApply: 5 }, websitePoll: { everyMs: 20, maxMs: 200 },
      images: { decoder: { mode: "child", node: process.execPath, script: DECODER, unisolated: true }, extract: true } });
    const api = (p: string, b: unknown, c = w.robin) => w.post(`/o/exna/api/${p}`, b, c);
    /** A member's own flyer: upload (sanitized by the real decoder), read, and (optionally) checked. */
    const flyer = async (cookie: string, check = true) => {
      const conv = (await api("chat/conversation/create", {}, cookie)).result.conversationId;
      const png = await sharp({ create: { width: 800, height: 1000, channels: 3, background: "#2a6" } }).png().toBuffer();
      const t = (await api("image/upload", { conversationId: conv, size: png.length, contentType: "image/png" }, cookie)).result;
      const row = w.org.sqlite.db.prepare("SELECT member_id, session_ref FROM image_uploads WHERE upload_id=?").get(t.uploadId) as any;
      const img = await w.org.images!.put(t.uploadId, { memberId: row.member_id, role: "x", sessionRef: row.session_ref }, Readable.from([png]), { size: png.length, contentType: "image/png" });
      const p = (await api("image/extract", { imageId: img.imageId }, cookie)).result;
      if (check) await api("image/proposal/save", { proposalId: p.proposalId, fields: { title: "Block Party", date: "2026-11-08", time: "2:00 PM", location: "Community Center", description: "Games, food and music." } }, cookie);
      const bytes = w.org.images!.read({ memberId: row.member_id, role: "x", sessionRef: "x" }, { imageId: img.imageId }).data;
      return { conv, imageId: img.imageId as string, sha256: img.sha256 as string, bytes, proposalId: p.proposalId as string };
    };
    const propose = async (flyerProposalId: string, cookie = w.robin) => {
      const r = await api("website/request", { text: "Add Block Party on Nov 8 at the Community Center, 2 PM.", flyerProposalId }, cookie);
      if (!r.ok) return r;
      await w.org.website!.idle();
      return (await api("website/read", { requestId: r.result.requestId })).result;
    };
    return { gh, w, api, flyer, propose, state, close: () => w.close() };
  }

  it("a reviewer's own checked flyer -> event + image in ONE draft PR; the card binds the image; read back before success; other reviewers see the bound image", async () => {
    const s = await setup();
    try {
      const f = await s.flyer(s.w.robin), path = eventImagePath(EVENT.id, f.sha256);
      const p = await s.propose(f.proposalId);
      expect(p).toMatchObject({ state: "ready", label: null, image: { op: "event.image.attach", policy: WEBSITE_IMAGE_POLICY, eventId: EVENT.id, attachmentId: f.imageId,
        proposalId: f.proposalId, sha256: f.sha256, bytes: f.bytes.length, path } });
      expect(path).toMatch(/^public\/images\/events\/block-party-2026-11-[a-f0-9]{16}\.jpg$/);
      // The card (the approval's artifact digest) binds the image: event, attachment, full hash, size, path, policy; and the new blob as a changed file.
      expect(p.card).toMatchObject({ image: { op: "event.image.attach", policy: WEBSITE_IMAGE_POLICY, eventId: EVENT.id, attachmentId: f.imageId, sha256: f.sha256, bytes: f.bytes.length, path },
        files: [{ path: "src/data/events.json" }, { path, baseBlobSha: null, newSha256: f.sha256 }] });
      expect(p.summary.changes[0].fields).toContainEqual(expect.objectContaining({ field: "Image", after: path.slice(6) }));
      expect(p.diff).toContain(`+++ ${path}\n(new image: JPEG, ${f.bytes.length} bytes, ${f.sha256})`);
      // The model was told the runtime attaches the image; it never names a path.
      expect(s.state.websiteUsers.at(-1)).toContain("the runtime attaches it to the ONE event");
      // Another reviewer (admin) can see the bound image for the card; a contributor cannot.
      const get = (c: string) => fetch(`${s.w.url}/o/exna/image/${f.imageId}`, { headers: { cookie: c } });
      const seen = await get(s.w.admin);
      expect(seen.status).toBe(200); expect(Buffer.from(await seen.arrayBuffer()).equals(f.bytes)).toBe(true);
      expect((await get(s.w.alex)).status).not.toBe(200);
      // Approve exactly this card -> blobs + one tree/commit -> ref -> draft PR; the commit shows the exact image and the reference.
      const ok = await s.w.act(s.w.robin, "website.apply", { requestId: p.requestId }, p.card.digest);
      expect(ok.ok).toBe(true);
      await s.w.org.websiteApply!.idle();
      const r = (await s.api("website/read", { requestId: p.requestId })).result;
      expect(r.pr).toMatchObject({ state: "done", number: 1, label: null });
      const commit = s.gh.refs.get(p.card.branch)!;
      expect(s.gh.commits.get(commit)!.parents).toEqual([p.baseCommit]);
      expect(s.gh.bytesAt(commit, path)!.equals(f.bytes)).toBe(true);
      expect(JSON.parse(s.gh.fileAt(commit, "src/data/events.json")!).events.at(-1)).toEqual({ ...EVENT, image: path.slice(6) });
      expect(s.gh.pulls).toHaveLength(1); expect(s.gh.pulls[0].draft).toBe(true);
      expect(s.gh.pulls[0].body).toContain(`- image ${path.slice(6)} (from a checked flyer; becomes public on merge)`);
      expect(s.gh.calls.filter((c) => c.method === "POST" && c.path === "/git/commits")).toHaveLength(1);
      expect(s.gh.calls.some((c) => c.method === "GET" && c.path.startsWith(`/contents/${path}?ref=${commit}`))).toBe(true); // the read-back
      expect(s.gh.refs.get("main")).toBe(p.baseCommit); // a draft only: nothing published until a maintainer merges
      // Fable I3 note: abandoned snapshots go (failed now; prepared-never-approved after 7 days); an approved request keeps its copy.
      s.state.ops = [{ op: "upsert_event", event: EVENT }, { op: "upsert_event", event: { ...EVENT, id: "other-event" } }];
      const failed = await s.propose(f.proposalId);
      expect(failed.state).toBe("failed");
      s.state.ops = [{ op: "upsert_event", event: EVENT }];
      const idle = await s.propose(f.proposalId);
      const src = (id: string) => existsSync(join(s.w.cfg.stateRoot, "website", id, "flyer-source.jpg"));
      expect([src(p.requestId), src(failed.requestId), src(idle.requestId)]).toEqual([true, true, true]);
      expect(s.w.org.website!.sweepImages()).toEqual({ removed: 1 });
      expect([src(p.requestId), src(failed.requestId), src(idle.requestId)]).toEqual([true, false, true]);
      expect(s.w.org.website!.sweepImages(0).removed).toBe(2); // the idle request: its snapshot and its named copy
      expect([src(p.requestId), src(idle.requestId)]).toEqual([true, false]);
    } finally { await s.close(); }
  });

  it("refusals: not checked / not your proposal / contributor; ambiguous target; a same-name file with other bytes; same bytes reuse the file", async () => {
    const s = await setup();
    try {
      const unchecked = await s.flyer(s.w.robin, false);
      expect((await s.propose(unchecked.proposalId)).error).toBe("image_proposal_not_checked");
      const alexFlyer = await s.flyer(s.w.alex);
      expect((await s.propose(alexFlyer.proposalId)).error).toBe("image_proposal_not_checked"); // another member's proposal: never promoted
      expect((await s.propose(alexFlyer.proposalId, s.w.alex)).error).toBe("access_role_not_permitted");
      expect((await s.propose("ip_" + "0".repeat(32))).error).toBe("image_proposal_not_checked");
      const f = await s.flyer(s.w.robin);
      s.state.ops = [{ op: "upsert_event", event: EVENT }, { op: "upsert_event", event: { ...EVENT, id: "other-event" } }];
      expect(await s.propose(f.proposalId)).toMatchObject({ state: "failed", label: "website_image_target_ambiguous" });
      s.state.ops = [{ op: "upsert_meeting", meeting: { id: "2026-11", date: "2026-11-08", title: "Notes", slug: "notes-2026-11", sections: [{ heading: "A", body: "B" }] } }];
      expect(await s.propose(f.proposalId)).toMatchObject({ state: "failed", label: "website_image_target_ambiguous" });
      // The model cannot pick the image: whatever it says, the runtime's path is used.
      s.state.ops = [{ op: "upsert_event", event: { ...EVENT, image: "/images/events/elsewhere.jpg" } }];
      expect(await s.propose(f.proposalId)).toMatchObject({ state: "ready", image: { path: eventImagePath(EVENT.id, f.sha256) } });
    } finally { await s.close(); }
    // A file already at that name: other bytes refuse; the exact bytes are reused (no new blob; the card still binds the image).
    const probe = await setup();
    let f: Awaited<ReturnType<typeof probe.flyer>>;
    try { f = await probe.flyer(probe.w.robin); } finally { await probe.close(); }
    const path = eventImagePath(EVENT.id, f.sha256);
    const wrong = await setup({ files: { [path]: Buffer.from("not the same bytes") } });
    try {
      const g = await wrong.flyer(wrong.w.robin);
      expect(g.sha256).toBe(f.sha256); // the decoder is deterministic for the same input
      expect(await wrong.propose(g.proposalId)).toMatchObject({ state: "failed", label: "website_image_conflict" });
    } finally { await wrong.close(); }
    const same = await setup({ files: { [path]: f.bytes } });
    try {
      const g = await same.flyer(same.w.robin), p = await same.propose(g.proposalId);
      expect(p).toMatchObject({ state: "ready", card: { image: { path, sha256: g.sha256 }, files: [{ path: "src/data/events.json" }] } });
      expect(p.card.files).toHaveLength(1);
      expect((await same.w.act(same.w.robin, "website.apply", { requestId: p.requestId }, p.card.digest)).ok).toBe(true);
      await same.w.org.websiteApply!.idle();
      expect((await same.api("website/read", { requestId: p.requestId })).result.pr).toMatchObject({ state: "done", label: null });
      expect(same.gh.calls.filter((c) => c.method === "POST" && c.path === "/git/blobs")).toHaveLength(1); // events.json only
    } finally { await same.close(); }
  });

  it("image changed after approval -> refused; main moved -> refused; a lost ref reply -> unsettled, then a read-first resume completes with ONE PR", async () => {
    const s = await setup();
    try {
      const f = await s.flyer(s.w.robin);
      // Changed after the card was made: the stored bytes no longer have the approved hash; nothing is written.
      const p2 = await s.propose(f.proposalId), dir2 = join(s.w.cfg.stateRoot, "website", p2.requestId);
      writeFileSync(join(dir2, readdirSync(dir2).find((n) => n.endsWith(".jpg") && n !== "flyer-source.jpg")!), Buffer.concat([f.bytes, Buffer.from([0])]));
      const before = s.gh.calls.filter((c) => c.method === "POST").length;
      expect((await s.w.act(s.w.robin, "website.apply", { requestId: p2.requestId }, p2.card.digest)).ok).toBe(true);
      await s.w.org.websiteApply!.idle();
      expect((await s.api("website/read", { requestId: p2.requestId })).result.pr).toMatchObject({ state: "failed", label: "website_image_changed" });
      expect(s.gh.calls.filter((c) => c.method === "POST").length).toBe(before);
      // Main moved since the proposal: refused, nothing written.
      const p3 = await s.propose(f.proposalId);
      s.gh.advanceMain({ "README.md": "x" });
      expect((await s.w.act(s.w.robin, "website.apply", { requestId: p3.requestId }, p3.card.digest)).ok).toBe(true);
      await s.w.org.websiteApply!.idle();
      expect((await s.api("website/read", { requestId: p3.requestId })).result.pr).toMatchObject({ state: "failed", label: "website_base_moved" });
      // The ref write lands but its answer is lost: unsettled (never failed, never re-created blindly); resume reads first, reads back, opens ONE PR.
      const p4 = await s.propose(f.proposalId);
      s.gh.fault("POST", /^\/git\/refs$/, "throw-after");
      const ok = await s.w.act(s.w.robin, "website.apply", { requestId: p4.requestId }, p4.card.digest);
      await s.w.org.websiteApply!.idle();
      expect((await s.api("website/read", { requestId: p4.requestId })).result.pr).toMatchObject({ state: "unsettled" });
      s.w.org.websiteApply!.resume(ok.authorization.operationId);
      await s.w.org.websiteApply!.idle();
      const done = (await s.api("website/read", { requestId: p4.requestId })).result.pr;
      expect(done).toMatchObject({ state: "done", label: null });
      expect(s.gh.pulls.filter((x) => x.head === p4.card.branch)).toHaveLength(1);
      expect(s.gh.bytesAt(s.gh.refs.get(p4.card.branch)!, p4.image.path)!.equals(f.bytes)).toBe(true);
    } finally { await s.close(); }
  });
});
