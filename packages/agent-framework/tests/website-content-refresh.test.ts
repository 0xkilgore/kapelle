// Chat content v1, WC-2 (PLAN-CHAT-CONTENT-V1; Fable R-8, WC-1 N-1/N-2): the website copy refreshes at start (never
// delaying the listeners), every 6 h and on a reviewer's refresh (12 per org per 24 h); an unchanged base commit costs one
// refSha GET; one 60 s wall deadline per sync; /ops/status and the Files page show its state. Real org runtime + hub, the
// FAKE GitHub, synthetic site content.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { transcriptionWorld } from "./transcription-world.js";
import { FakeGithub } from "../src/org/website/fake-github.js";
import { ACCESS_ACTIONS, ACCESS_TABLE_HASH, STEP_UP, stepUpOf } from "../src/access/org-access.js";
import { canonical } from "../src/command-boundary.js";
import { CONTENT_LIMITS } from "../src/org/website/content.js";
import { hosted } from "./org-meeting-kit.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const SITE = { "src/data/meeting-notes.json": JSON.stringify({ meetings: [{ date: "2026-10-08", slug: "october-2026", title: "October", sections: [{ heading: "Safety", body: "Report." }] }] }),
  "src/data/events.json": JSON.stringify({ events: [{ title: "Block Party", date: "2026-11-08", address: "1 Main St" }], pastEvents: [] }) };
const until = async (f: () => boolean, ms = 3000) => { for (const t = Date.now(); !f(); ) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };

it("access: website.content.refresh is a session-tier routine action and is part of the access table hash", () => {
  expect(stepUpOf("website.content.refresh")).toBe("session");
  expect(ACCESS_ACTIONS.routine).toContain("website.content.refresh");
  const without = { actions: { ...ACCESS_ACTIONS, routine: ACCESS_ACTIONS.routine.filter((a) => a !== "website.content.refresh") },
    stepUp: { ...STEP_UP, session: STEP_UP.session.filter((a) => a !== "website.content.refresh") } };
  expect(ACCESS_TABLE_HASH).not.toBe("sha256:" + createHash("sha256").update(canonical(without)).digest("hex"));
});

describe.skipIf(!enabled)("website copy refresh (WC-2)", () => {
  it("start-up sync; unchanged = one GET; reviewer refresh capped at 12/24 h; contributors refused; /ops/status and Files show the state", async () => {
    const gh = new FakeGithub(undefined, SITE);
    const w = await transcriptionWorld({ chat: {}, website: {}, githubFetch: gh.fetch });
    try {
      const content = () => w.org.websiteContent!, api = (p: string, b: unknown, c = w.robin) => w.post(`/o/exna/api/${p}`, b, c);
      await until(() => content().status().lastOutcome !== null);
      await content().idle();
      expect(content().status()).toMatchObject({ commit: gh.refs.get("main"), files: 2, lastOutcome: "ok", running: false });
      expect(w.org.sqlite.db.prepare("SELECT trigger, outcome FROM website_content_syncs").all()).toEqual([{ trigger: "start", outcome: "ok" }]);
      // Unchanged base commit: exactly one GET (the ref), nothing rewritten.
      const n = gh.calls.length;
      expect((await api("website/content/refresh", {})).result).toMatchObject({ ok: true, unchanged: true, status: { lastOutcome: "unchanged", commit: gh.refs.get("main") } });
      expect(gh.calls.slice(n).map((c) => c.method + " " + c.path)).toEqual([`GET /git/ref/heads/main`]);
      // Contributors cannot refresh; reviewers can; the 13th manual refresh in 24 h is refused (start/timer runs never count).
      expect((await api("website/content/refresh", {}, w.alex)).error).toBe("access_role_not_permitted");
      for (let i = 1; i < CONTENT_LIMITS.refreshPerDay; i++) expect((await api("website/content/refresh", {})).ok, String(i)).toBe(true);
      expect((await api("website/content/refresh", {}, w.admin)).error).toBe("website_content_refresh_cap");
      // A changed base commit is copied again on the next sync.
      gh.advanceMain({ "src/data/events.json": JSON.stringify({ events: [], pastEvents: [] }) });
      expect(await content().sync("timer")).toEqual({ ok: true });
      expect(content().status()).toMatchObject({ commit: gh.refs.get("main"), files: 2 });
      // /ops/status and the Files page carry the state.
      expect((await w.ops("/ops/status", {})).websiteContent).toMatchObject({ commit: gh.refs.get("main"), files: 2, lastOutcome: "ok", running: false, fetchedAt: expect.any(String) });
      expect((await api("files/list", {}, w.alex)).result.website).toMatchObject({ commit: gh.refs.get("main"), files: 2 });
    } finally { await w.close(); }
  });

  it("the 6 h timer copies a new base commit; a hung GitHub never delays the start and the sync ends at its wall deadline", async () => {
    const gh = new FakeGithub(undefined, SITE);
    const w = await transcriptionWorld({ chat: {}, website: {}, githubFetch: gh.fetch, websiteContent: { start: false, everyMs: 40 } });
    try {
      const content = () => w.org.websiteContent!;
      await until(() => content().status().commit === gh.refs.get("main"));
      const next = gh.advanceMain({ "src/data/events.json": JSON.stringify({ events: [], pastEvents: [] }) });
      await until(() => content().status().commit === next);
      expect((w.org.sqlite.db.prepare("SELECT DISTINCT trigger FROM website_content_syncs").all() as any[]).map((r) => r.trigger)).toEqual(["timer"]);
    } finally { await w.close(); }
    // A GitHub that never answers: the runtime opens (the start-up sync is in the background) and the sync fails at its deadline.
    let hang = true;
    const hung = new FakeGithub(undefined, SITE);
    const fetch = (u: string, i: any) => hang && u.includes("/git/ref/") ? new Promise<Response>(() => {}) : hung.fetch(u, i);
    const t0 = Date.now();
    const w2 = await transcriptionWorld({ chat: {}, website: {}, githubFetch: fetch, websiteContent: { deadlineMs: 150 } });
    try {
      expect((await w2.ops("/ops/status", {})).ok).toBe(true);
      await until(() => w2.org.websiteContent!.status().lastOutcome !== null);
      expect(w2.org.websiteContent!.status()).toMatchObject({ commit: null, files: 0, lastOutcome: "website_content_deadline", running: false });
      expect(Date.now() - t0).toBeLessThan(15_000);
      hang = false;
      expect(await w2.org.websiteContent!.sync()).toEqual({ ok: true }); // the slot is free again
    } finally { await w2.close(); }
  });

  it("WC-1 N-1: the website proposal store and the intake archive moves refuse a target that resolves into members/website", async () => {
    // The website pack's own fixture shapes (tests/website-request.test.ts): pretty-printed, one event.
    const gh = new FakeGithub(undefined, { "src/data/events.json": JSON.stringify({ events: [{ id: "block-party-2026", title: "Block Party", date: "2026-10-18", time: "11:00 AM", location: "Example Park",
      address: "Springfield, TN", description: "Thanks, neighbors.", type: "community" }], pastEvents: [] }, null, 2) + "\n",
      "src/data/meeting-notes.json": JSON.stringify({ meetings: [{ id: "2026-10", date: "2026-10-08", title: "October", slug: "october-2026", sections: [{ heading: "Safety", body: "Report." }] }] }, null, 2) + "\n" });
    const answer = JSON.stringify({ ops: [{ op: "upsert_event", event: { id: "tree-2026", title: "Tree planting", date: "2026-11-08", time: "9:00 AM", location: "Park", address: "1 Main St", description: "Bring gloves.", type: "community" } }] });
    const modelFetch = async () => new Response(JSON.stringify({ id: "gen-1", model: hosted.runtime.responseModels?.at(-1) ?? hosted.runtime.model, provider: (hosted.runtime.providerNames ?? hosted.runtime.providers)[0],
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: answer } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.001 } }), { status: 200, headers: { "content-type": "application/json" } });
    const w = await transcriptionWorld({ website: {}, githubFetch: gh.fetch, fetch: modelFetch as never });
    try {
      await until(() => w.org.websiteContent!.status().lastOutcome !== null); await w.org.websiteContent!.idle();
      const site = join(w.cfg.folder, "members", "website"), n0 = readdirSync(site, { recursive: true }).length;
      // Proposal store: stateRoot/website -> the website copy.
      rmSync(join(w.cfg.stateRoot, "website"), { recursive: true, force: true });
      symlinkSync(site, join(w.cfg.stateRoot, "website"));
      const q = (await w.post("/o/exna/api/website/request", { text: "Add the tree planting Nov 8" }, w.robin)).result;
      await w.org.website!.idle();
      expect((await w.post("/o/exna/api/website/read", { requestId: q.requestId }, w.robin)).result).toMatchObject({ state: "failed", label: "website_content_path_reserved" });
      // Intake archive: reviewers-private/archive/intake -> the website copy; an old web submission is due for archiving.
      const sub = (await w.post("/o/exna/api/intake/upload", { clientRequestId: "req-wc2-0001", title: "T", text: "Old notes." }, w.robin)).result;
      w.org.sqlite.db.prepare("UPDATE intake_records SET received_at=? WHERE intake_id=?").run("2020-01-01T00:00:00.000Z", sub.intakeId);
      const arch = join(w.cfg.folder, "reviewers-private", "archive", "intake");
      mkdirSync(join(arch, ".."), { recursive: true }); rmSync(arch, { recursive: true, force: true });
      symlinkSync(site, arch);
      expect(await w.ops("/ops/intake/archive", { afterDays: 1 })).toEqual({ ok: false, error: "website_content_path_reserved" });
      expect(existsSync(join(w.cfg.folder, "reviewers-private", "intake", sub.intakeId))).toBe(true);
      expect(readdirSync(site, { recursive: true }).length).toBe(n0);
    } finally { await w.close(); }
  });
});
