// Website pack v0, W-3 (PLAN §1 steps 5-8, §2; Fable R-1, R-2, R-5, R-6, R-7): an approved proposal becomes a DRAFT PR through
// the runtime connector against the FAKE GitHub (no network): digest binding, intent before writes, read-first resume after an
// answer lost mid-write (never a duplicate branch or PR), main moving, restart, preview polling with the host allowlist, merge
// state. Real org runtime + hub; scripted hosted model; synthetic data.
import { describe, it, expect } from "vitest";
import { transcriptionWorld } from "./transcription-world.js";
import { FakeGithub } from "../src/org/website/fake-github.js";
import { hosted } from "./org-meeting-kit.js";
import { previewHostAllowed } from "../src/org/website/apply.js";
import { githubPort } from "../src/org/website/github.js";
import { failureLabel, persistedReason } from "../src/task-delegation/failure-labels.js";
import { WEBSITE_APPLY_REASONS } from "../src/org/website/labels.js";
import { stepUpOf, audienceOf } from "../src/access/org-access.js";
import { render } from "../deploy/kapelle-admin.js";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const EVENTS = JSON.stringify({ events: [{ id: "block-party-2026", title: "Block Party", date: "2026-10-18", time: "11:00 AM", location: "Example Park", address: "Springfield, TN",
  description: "Thanks.", type: "community" }] }, null, 2) + "\n";
const MEETINGS = JSON.stringify({ meetings: [] }, null, 2) + "\n";
const TREE = { id: "tree-planting-nov-2026", title: "Tree planting", date: "2026-11-08", time: "9:00 AM", location: "Riverside Park", address: "Riverside Park, Springfield, TN",
  description: "Gloves provided.", type: "community" };
const answer = JSON.stringify({ ops: [{ op: "upsert_event", event: TREE }] });
const modelFetch = async () => new Response(JSON.stringify({ id: "g", model: hosted.runtime.responseModels?.at(-1) ?? hosted.runtime.model, provider: (hosted.runtime.providerNames ?? hosted.runtime.providers)[0],
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: answer } }], usage: { prompt_tokens: 9000, completion_tokens: 200, total_tokens: 9200, cost: 0.03 } }),
  { status: 200, headers: { "content-type": "application/json" } });

async function world(o: { dailyApply?: number; poll?: { everyMs: number; maxMs: number } } = {}) {
  const gh = new FakeGithub(undefined, { "src/data/events.json": EVENTS, "src/data/meeting-notes.json": MEETINGS });
  const w = await transcriptionWorld({ website: { dailyApply: o.dailyApply ?? 5 }, githubFetch: gh.fetch, fetch: modelFetch as never, websitePoll: o.poll ?? { everyMs: 20, maxMs: 400 } });
  const api = (path: string, body: unknown, cookie = w.robin) => w.post(`/o/exna/api/${path}`, body, cookie);
  const propose = async (text = "Add the tree planting Nov 8") => { const id = (await api("website/request", { text })).result.requestId; await w.org.website!.idle();
    return (await api("website/read", { requestId: id })).result; };
  const settle = async () => { await w.org.websiteApply!.idle(); };
  return { gh, w, api, propose, settle };
}

describe.skipIf(!enabled)("website apply -> draft PR", () => {
  it("approve exactly the card -> branch, commit (identity + trailer), DRAFT PR from the approved summary; receipts to the actor and admins; preview link", async () => {
    const { gh, w, api, propose, settle } = await world();
    try {
      expect([stepUpOf("website.apply"), audienceOf("website.apply")]).toEqual(["session-fresh", "consequential"]);
      const p = await propose();
      expect(p.card).toMatchObject({ contract: "kapelle.website-pr-card/v1", repo: "0xkilgore/example-org-website", baseCommit: gh.refs.get("main"), branch: expect.stringMatching(/^kapelle\/wr-[a-f0-9]{12}$/),
        files: [{ path: "src/data/events.json", baseBlobSha: expect.any(String), newSha256: expect.stringMatching(/^sha256:/) }], summarySha256: p.summarySha256, opsSha256: p.opsSha256 });
      expect((await w.act(w.robin, "website.apply", { requestId: p.requestId }, "sha256:" + "0".repeat(64))).error).toBe("website_apply_digest_mismatch");
      expect((await w.act(w.alex, "website.apply", { requestId: p.requestId }, p.card.digest)).error).toBe("access_role_not_permitted");
      const ok = await w.act(w.robin, "website.apply", { requestId: p.requestId }, p.card.digest);
      expect(ok).toMatchObject({ ok: true, authorization: { action: "website.apply", authn: "email-session", artifactDigest: p.card.digest } });
      await settle();
      const r = (await api("website/read", { requestId: p.requestId })).result;
      expect(r.pr).toMatchObject({ state: "done", branch: p.card.branch, number: 1, url: "https://github.com/0xkilgore/example-org-website/pull/1", label: null });
      // What landed on GitHub: one branch from the bound base, one commit with the approved bytes, one DRAFT PR.
      const commit = gh.refs.get(p.card.branch)!;
      expect(gh.commits.get(commit)).toMatchObject({ parents: [p.baseCommit], author: { name: "Alex Fixture", email: "alex@users.noreply.github.com" } });
      expect(gh.commits.get(commit)!.message).toBe(`Website: event "Tree planting" (2026-11-08)\n\n- event "Tree planting" (2026-11-08)\n\nKapelle-Agent: website-pack v0; requested-by: reviewer\nCo-authored-by: Kapelle agent <agent@example.org>`);
      expect(JSON.parse(gh.fileAt(commit, "src/data/events.json")!).events.at(-1)).toEqual(TREE);
      expect(gh.fileAt(commit, "src/data/meeting-notes.json")).toBe(MEETINGS);
      expect(gh.pulls).toHaveLength(1);
      expect(gh.pulls[0]).toMatchObject({ draft: true, base: "main", head: p.card.branch, title: p.summary.title });
      expect(gh.pulls[0].body).toContain(`approved in Kapelle (record ${ok.authorization.operationId})`);
      expect(gh.pulls[0].body + gh.commits.get(commit)!.message).not.toMatch(/@exna\.test/); // no member email
      expect(gh.calls.some((c) => /merge/.test(c.path))).toBe(false);
      // Receipts: the actor and every admin.
      for (let i = 0; i < 50 && w.mail.filter((m) => m.kind === "receipt" && m.receipt?.action === "website.apply").length < 2; i++) await new Promise((x) => setTimeout(x, 20));
      expect(w.mail.filter((m) => m.kind === "receipt" && m.receipt?.action === "website.apply").map((m) => m.to).sort()).toEqual(["admin@exna.test", "robin@exna.test"]);
      // v0.1: while Vercel builds, the card says "building" and has no preview link.
      expect((await api("website/read", { requestId: p.requestId })).result.pr).toMatchObject({ previewUrl: null, previewPageUrl: null, previewBuilding: true });
      expect(p.summary.previewPath).toBe("/events/tree-planting-nov-2026");
      expect(p.summary.changes).toEqual([expect.objectContaining({ kind: "event", action: "added", path: "/events/tree-planting-nov-2026" })]);
      // Preview: only an https URL on an allowlisted host, from a Vercel status, is shown.
      gh.setStatus(commit, { context: "Vercel", state: "pending", target_url: "https://example-org-website-git-building.vercel.app" }); // not ready: ignored
      gh.setStatus(commit, { context: "Vercel", state: "success", target_url: "https://evil.example/x" });
      gh.setStatus(commit, { context: "Vercel – Preview", state: "success", target_url: "https://example-org-website-git-kapelle.vercel.app" });
      for (let i = 0; i < 100 && !(await api("website/read", { requestId: p.requestId })).result.pr.previewUrl; i++) await new Promise((x) => setTimeout(x, 20));
      expect((await api("website/read", { requestId: p.requestId })).result.pr.previewUrl).toBe("https://example-org-website-git-kapelle.vercel.app");
      // v0.1: the link opens the CHANGED page on the same preview host; building is over.
      expect((await api("website/read", { requestId: p.requestId })).result.pr).toMatchObject({ previewBuilding: false,
        previewPageUrl: "https://example-org-website-git-kapelle.vercel.app/events/tree-planting-nov-2026" });
      // A second approval of the same proposal is refused; merge state is read from GitHub.
      expect((await w.act(w.robin, "website.apply", { requestId: p.requestId }, p.card.digest)).error).toBe("website_already_applied");
      gh.merge(1);
      expect((await api("website/read", { requestId: p.requestId })).result.pr.prState).toEqual({ state: "closed", merged: true });
      expect((await w.ops("/ops/status")).website.prs).toEqual({ byState: { done: 1 }, unsettled: [] });
    } finally { await w.close(); }
  }, 120_000);

  it("discard (owner, Oct 23): a never-approved proposal leaves the list and can no longer be approved; an approved one cannot be discarded", async () => {
    const { gh, w, api, propose, settle } = await world();
    try {
      expect([stepUpOf("website.discard"), audienceOf("website.discard")]).toEqual(["session", "routine"]);
      const a = await propose(), b = await propose("Add the tree planting Nov 8, again");
      expect((await api("website/discard", { requestId: a.requestId }, w.alex)).error).toBe("access_role_not_permitted"); // reviewers only
      expect((await api("website/discard", { requestId: "wr_" + "0".repeat(32) })).error).toBe("website_request_unknown");
      expect((await api("website/discard", { requestId: a.requestId })).result).toEqual({ discarded: true });
      expect((await api("website/discard", { requestId: a.requestId })).result).toEqual({ discarded: true }); // idempotent
      expect((await api("website/list", {})).result.requests.map((r: any) => r.requestId)).toEqual([b.requestId]);
      expect((await w.act(w.robin, "website.apply", { requestId: a.requestId }, a.card.digest)).error).toBe("website_request_discarded");
      expect(gh.pulls).toHaveLength(0);
      // Approved: never discarded.
      expect((await w.act(w.robin, "website.apply", { requestId: b.requestId }, b.card.digest)).ok).toBe(true);
      await settle();
      expect((await api("website/discard", { requestId: b.requestId })).error).toBe("website_already_applied");
      // Owner (Oct 23): a new proposal for the SAME event as b's open draft PR says so; an unrelated one does not.
      const c = await propose("Add the tree planting Nov 8 with the address");
      expect(c.overlaps).toEqual([{ number: 1, url: "https://github.com/0xkilgore/example-org-website/pull/1" }]);
      expect(b.overlaps).toEqual([]);
      expect((await api("website/list", {})).result.requests.map((r: any) => r.requestId)).toEqual([c.requestId, b.requestId]);
    } finally { await w.close(); }
  }, 120_000);

  // Update the open draft (Fable ACCEPT e483c8dd, design 9a0f71b4, C-1..C-6): a later proposal for the SAME page as ONE open
  // Kapelle draft PR on the same base adds a commit to THAT PR (fast-forward only) instead of opening a second one.
  const listed = async (api: (p: string, b: unknown) => Promise<any>, id: string) => (await api("website/list", {})).result.requests.find((r: any) => r.requestId === id);
  it("update: the card binds {pr, branch, expectedHead}; approving adds ONE fast-forward commit to the same PR; the target shows it (C-6); it counts toward the daily cap", async () => {
    const { gh, w, api, propose, settle } = await world({ dailyApply: 2 });
    try {
      const p1 = await propose();
      await w.act(w.robin, "website.apply", { requestId: p1.requestId }, p1.card.digest); await settle();
      const c1 = gh.refs.get(p1.card.branch)!;
      const p2 = await propose("Add the tree planting Nov 8, with the address");
      const v = await listed(api, p2.requestId); // the list reads the PR's open state from GitHub
      expect(v.update).toEqual({ pr: 1, url: "https://github.com/0xkilgore/example-org-website/pull/1" });
      expect(v.card).toMatchObject({ branch: p1.card.branch, update: { pr: 1, branch: p1.card.branch, expectedHead: c1 } });
      expect(v.updateBlocked).toBeNull();
      const ok = await w.act(w.robin, "website.apply", { requestId: p2.requestId }, v.card.digest);
      expect(ok.ok).toBe(true); await settle();
      expect(gh.pulls).toHaveLength(1); // one PR, never a second
      const c2 = gh.refs.get(p1.card.branch)!;
      expect(c2).not.toBe(c1);
      expect(gh.commits.get(c2)!.parents).toEqual([c1]); // a fast-forward on the bound head
      expect(gh.commits.get(c2)!.message).toContain("updates #1");
      expect(gh.calls.filter((c) => c.method === "PATCH")).toEqual([expect.objectContaining({ path: `/git/refs/heads/${p1.card.branch}`, body: { sha: c2, force: false } })]);
      expect(gh.pulls[0].headSha).toBe(c2);
      expect((await api("website/read", { requestId: p2.requestId })).result.pr).toMatchObject({ state: "done", number: 1, branch: p1.card.branch, commitSha: c2 });
      const t = await listed(api, p1.requestId); // C-6: the target reflects the branch at the new commit
      expect(t).toMatchObject({ updatedBy: { at: expect.any(String) }, pr: { number: 1, commitSha: c2 } });
      expect((await w.act(w.robin, "website.apply", { requestId: p1.requestId }, t.card.digest)).error).toBe("website_already_applied"); // no second Approve
      for (let i = 0; i < 50 && w.mail.filter((m) => m.kind === "receipt" && m.receipt?.action === "website.apply" && m.to === "admin@exna.test").length < 2; i++) await new Promise((x) => setTimeout(x, 20));
      expect(w.mail.filter((m) => m.kind === "receipt" && m.receipt?.action === "website.apply" && m.to === "admin@exna.test")).toHaveLength(2);
      // C-4: an update counts toward the daily apply cap (2 here).
      const p3 = await propose("And the parking note");
      const v3 = await listed(api, p3.requestId);
      expect((await w.act(w.robin, "website.apply", { requestId: p3.requestId }, v3.card.digest)).error).toBe("website_daily_apply_cap");
    } finally { await w.close(); }
  }, 120_000);

  it("update refusals before any write land nothing: PR closed (website_pr_closed), branch moved before, branch moved between the re-read and the PATCH (FF refused); main moved and two PRs fall back", async () => {
    const { gh, w, api, propose, settle } = await world({ dailyApply: 9 });
    try {
      const p1 = await propose();
      await w.act(w.robin, "website.apply", { requestId: p1.requestId }, p1.card.digest); await settle();
      const br = p1.card.branch, c1 = gh.refs.get(br)!;
      // The card is shown (update offered), THEN GitHub changes, then the reviewer approves.
      const approveListed = async (text: string, meanwhile: () => void = () => {}) => { const p = await propose(text); const v = await listed(api, p.requestId);
        expect(v.card.update?.pr).toBe(1); meanwhile(); await w.act(w.robin, "website.apply", { requestId: p.requestId }, v.card.digest); await settle();
        return (await api("website/read", { requestId: p.requestId })).result.pr; };
      // The PR closed on GitHub after the card was shown.
      expect(await approveListed("closed one", () => gh.close(1))).toMatchObject({ state: "failed", label: "website_pr_closed" });
      // Fable N-2 (516491d0): a PR GitHub reported closed is no longer named on a new card (no update, no second-PR notice).
      const pc = await propose("after the close");
      expect(await listed(api, pc.requestId)).toMatchObject({ overlaps: [], update: null, updateBlocked: null });
      await api("website/discard", { requestId: pc.requestId });
      gh.pulls[0].state = "open"; // reopened
      (w.org.websiteApply as any).prOpen.clear(); // the next list reads GitHub again
      // Someone pushed to the branch after the card was shown.
      const other = gh.commitFiles({ "README.md": "maintainer edit" }, [c1], "maintainer");
      expect(await approveListed("moved before", () => { gh.refs.set(br, other); gh.pulls[0].headSha = other; })).toMatchObject({ state: "failed", label: "website_branch_moved" });
      gh.refs.set(br, c1); gh.pulls[0].headSha = c1;
      // Moved between our re-read and our PATCH: the fast-forward check refuses it; nothing landed.
      gh.before("PATCH", /^\/git\/refs\/heads\//, () => { const x = gh.commitFiles({ "README.md": "race" }, [c1], "race"); gh.refs.set(br, x); });
      expect(await approveListed("moved during")).toMatchObject({ state: "failed", label: "website_branch_moved" });
      expect(gh.commits.get(gh.refs.get(br)!)!.message).toBe("race"); // our commit was never referenced
      expect(gh.pulls).toHaveLength(1);
      expect((await w.ops("/ops/status")).website.prs.unsettled).toEqual([]);
      // Main moved since #1 was prepared (Q2): no update; the card says why; approving opens a second PR.
      gh.refs.set(br, c1);
      gh.advanceMain({ "README.md": "main moved" });
      const p5 = await propose("on the new main");
      const v5 = await listed(api, p5.requestId);
      expect([v5.update, v5.updateBlocked, v5.card.update, v5.overlaps.map((o: any) => o.number)]).toEqual([null, "base_moved", undefined, [1]]);
      await w.act(w.robin, "website.apply", { requestId: p5.requestId }, v5.card.digest); await settle();
      expect(gh.pulls).toHaveLength(2);
      // Two open PRs change the page: ineligible ("several"), today's path.
      const p6 = await propose("third time");
      expect((await listed(api, p6.requestId))).toMatchObject({ update: null, updateBlocked: "several" });
    } finally { await w.close(); }
  }, 120_000);

  it("update: an answer lost after the PATCH is unsettled; the read-first resume finds our commit and finishes with no second commit or write (C-3)", async () => {
    const { gh, w, api, propose, settle } = await world();
    try {
      const p1 = await propose();
      await w.act(w.robin, "website.apply", { requestId: p1.requestId }, p1.card.digest); await settle();
      const p2 = await propose("with the address"), v = await listed(api, p2.requestId);
      gh.fault("PATCH", /^\/git\/refs\/heads\//, "throw-after");
      const a = await w.act(w.robin, "website.apply", { requestId: p2.requestId }, v.card.digest); await settle();
      const pr = (await api("website/read", { requestId: p2.requestId })).result.pr;
      expect(pr).toMatchObject({ state: "unsettled", label: "website_transport_failed" });
      const commits = gh.commits.size;
      // Fable N-1: Ops' unsettled listing names the real branch the update moves.
      expect((await w.ops("/ops/status")).website.prs.unsettled).toEqual([{ operation_id: a.authorization.operationId, branch: p1.card.branch, label: "website_transport_failed" }]);
      expect(gh.refs.get(p1.card.branch)).toBe(pr.commitSha); // it landed
      await w.ops("/ops/website/resume", { operationId: a.authorization.operationId }); await settle();
      expect((await api("website/read", { requestId: p2.requestId })).result.pr).toMatchObject({ state: "done", number: 1, commitSha: pr.commitSha });
      expect(gh.commits.size).toBe(commits);
      expect(gh.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
      expect(gh.pulls).toHaveLength(1);
    } finally { await w.close(); }
  }, 120_000);

  it("refreshTargets reads at most PR_READS_PER_LIST PRs from GitHub per list (Fable N-3)", async () => {
    const { gh, w, api, propose } = await world();
    try {
      await propose(); // one ready, unapproved proposal
      const a = w.org.websiteApply as any;
      a.overlapRows = () => Array.from({ length: 8 }, (_, i) => ({ operation_id: "op" + i, request_id: "wr_x", pr_number: i + 1, pr_url: "https://github.com/x/pull/" + (i + 1) }));
      const before = gh.calls.filter((c) => /^\/pulls\/\d+$/.test(c.path)).length;
      await api("website/list", {});
      expect(gh.calls.filter((c) => /^\/pulls\/\d+$/.test(c.path)).length - before).toBe(5);
    } finally { await w.close(); }
  });

  it("the port's updateRef: only a kapelle/wr-* branch, fast-forward only; labels persist (C-1)", async () => {
    const gh = new FakeGithub(undefined, { "src/data/events.json": EVENTS });
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kghu-"))), patFile = join(dir, "pat");
    writeFileSync(patFile, "github_pat_SYNTHETIC0123456789abcdefghijklmnopqrstuvwxyz\n", { mode: 0o600 });
    const port = githubPort({ repo: gh.repo, patFile, fetch: gh.fetch as never }), main = gh.refs.get("main")!;
    for (const b of ["main", "feature/x", "kapelle/wr-ZZZ", "kapelle/wr-0123456789ab/x"]) await expect(port.updateRef(b, main)).rejects.toThrow("website_arg_invalid");
    expect(gh.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    const c1 = gh.commitFiles({ "a.md": "1" }, [main], "c1"), c2 = gh.commitFiles({ "a.md": "2" }, [c1], "c2"), side = gh.commitFiles({ "a.md": "s" }, [main], "side");
    gh.refs.set("kapelle/wr-0123456789ab", c1);
    await expect(port.updateRef("kapelle/wr-0123456789ab", side)).rejects.toThrow("website_branch_moved"); // not a fast-forward
    await port.updateRef("kapelle/wr-0123456789ab", c2);
    expect(gh.refs.get("kapelle/wr-0123456789ab")).toBe(c2);
    for (const l of ["website_pr_closed", "website_branch_moved"]) { expect(WEBSITE_APPLY_REASONS).toContain(l); expect(persistedReason(failureLabel(new Error(l)))).toBe(l); }
  });

  it("main moved: refused before any write; answers lost mid-write: unsettled, then a read-first resume finishes without duplicates", async () => {
    const { gh, w, api, propose, settle } = await world();
    try {
      // Base moved between proposal and approval: nothing is written.
      const p1 = await propose();
      gh.advanceMain({ "README.md": "x" });
      await w.act(w.robin, "website.apply", { requestId: p1.requestId }, p1.card.digest); await settle();
      expect((await api("website/read", { requestId: p1.requestId })).result.pr).toMatchObject({ state: "failed", label: "website_base_moved" });
      expect(gh.refs.has(p1.card.branch)).toBe(false);
      // The ref is created but its answer is lost -> unsettled; resume reads the branch (our bytes) and opens the PR.
      const p2 = await propose("Add it again");
      gh.fault("POST", /^\/git\/refs/, "throw-after");
      const a2 = await w.act(w.robin, "website.apply", { requestId: p2.requestId }, p2.card.digest); await settle();
      expect((await api("website/read", { requestId: p2.requestId })).result.pr).toMatchObject({ state: "unsettled", label: "website_transport_failed" });
      expect(gh.refs.has(p2.card.branch)).toBe(true);
      expect((await w.ops("/ops/status")).website.prs.unsettled).toEqual([{ operation_id: a2.authorization.operationId, branch: p2.card.branch, label: "website_transport_failed" }]);
      expect((await w.ops("/ops/website/resume", { operationId: a2.authorization.operationId })).ok).toBe(true); await settle();
      expect((await api("website/read", { requestId: p2.requestId })).result.pr).toMatchObject({ state: "done", number: 1 });
      // The PR is created but its answer is lost -> unsettled; resume FINDS it (one PR, not two).
      const p3 = await propose("And once more");
      gh.fault("POST", /^\/pulls/, "throw-after");
      const a3 = await w.act(w.robin, "website.apply", { requestId: p3.requestId }, p3.card.digest); await settle();
      expect((await api("website/read", { requestId: p3.requestId })).result.pr.state).toBe("unsettled");
      await w.ops("/ops/website/resume", { operationId: a3.authorization.operationId }); await settle();
      expect((await api("website/read", { requestId: p3.requestId })).result.pr).toMatchObject({ state: "done", number: 2 });
      expect(gh.pulls.map((x) => x.head)).toEqual([p2.card.branch, p3.card.branch]);
      // A definite refusal before anything landed is `failed` (e.g. GitHub 403 on the blob).
      const p4 = await propose("Fourth");
      gh.fault("POST", /^\/git\/blobs/, 403);
      await w.act(w.robin, "website.apply", { requestId: p4.requestId }, p4.card.digest); await settle();
      expect((await api("website/read", { requestId: p4.requestId })).result.pr).toMatchObject({ state: "failed", label: "website_http_403" });
      expect((await w.ops("/ops/website/resume", { operationId: "nope" })).error).toBe("website_pr_not_resumable");
    } finally { await w.close(); }
  }, 120_000);

  it("daily apply cap; restart mid-push is unsettled (never resumed blindly); preview pending then a manual re-check", async () => {
    const { gh, w, api, propose, settle } = await world({ dailyApply: 2, poll: { everyMs: 20, maxMs: 100 } });
    try {
      const p1 = await propose();
      await w.act(w.robin, "website.apply", { requestId: p1.requestId }, p1.card.digest); await settle();
      for (let i = 0; i < 50 && (await api("website/read", { requestId: p1.requestId })).result.pr.label !== "website_preview_pending"; i++) await new Promise((x) => setTimeout(x, 20));
      expect((await api("website/read", { requestId: p1.requestId })).result.pr).toMatchObject({ state: "done", previewUrl: null, label: "website_preview_pending", previewBuilding: false });
      gh.setStatus(gh.refs.get(p1.card.branch)!, { context: "Vercel", state: "success", target_url: "https://cp-git-x.vercel.app" });
      expect((await api("website/preview/check", { requestId: p1.requestId })).result.pr.previewUrl).toBe("https://cp-git-x.vercel.app");
      // Restart while a push is in flight (simulated row in 'sent').
      const p2 = await propose("Second");
      w.org.sqlite.db.prepare("INSERT INTO website_prs(operation_id,request_id,member_id,state,base_commit,branch,files,created_at,updated_at) VALUES ('op-crash', ?, 'm', 'sent', ?, 'kapelle/crash', '[]', ?, ?)")
        .run(p2.requestId, p2.baseCommit, new Date().toISOString(), new Date().toISOString());
      await w.restart();
      expect(w.org.sqlite.db.prepare("SELECT state, label FROM website_prs WHERE operation_id='op-crash'").get()).toEqual({ state: "unsettled", label: "website_outcome_unknown_after_restart" });
      const p3 = await propose("Third");
      expect((await w.act(w.robin, "website.apply", { requestId: p3.requestId }, p3.card.digest)).error).toBe("website_daily_apply_cap");
    } finally { await w.close(); }
  }, 120_000);

  it("preview host allowlist: '*-<label>.<domain>' admits exactly one extra label (Vercel team previews), nothing wider", () => {
    const team = ["*-example-projects.vercel.app"];
    expect(previewHostAllowed("https://example-org-website-a1b2c3d4e-example-projects.vercel.app/", team)).toBe(true);
    expect(previewHostAllowed("https://example-org-website-git-kapelle-wr-0123-example-projects.vercel.app", team)).toBe(true);
    for (const u of ["https://site-x-other.vercel.app", "https://example-projects.vercel.app", "https://-example-projects.vercel.app",
      "https://a.b-example-projects.vercel.app", "https://x-example-projects.vercel.app.evil.com", "https://evil.com/x-example-projects.vercel.app",
      "https://x-example-projects.vercel.app.", "https://x-example-projectsx.vercel.app", "http://x-example-projects.vercel.app", "https://www.example.org",
      "https://x-example-projects.evil.app", "https://x-example-projects.vercel.app:8443", "https://u:p@x-example-projects.vercel.app"])
      expect(previewHostAllowed(u, team), u).toBe(false);
    // The org config schema (through render, as Ops will run it) admits the pattern and refuses malformed ones.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kgh-ph-")));
    const r = (previewHosts: string) => render({ org: "exna", label: "Example Park", domain: "agent.example.org", monthlyUsd: 15, root, intake: "none",
      website: { repo: "0xkilgore/example-org-website", author: "0xkilgore <0xkilgore@example.org>", previewHosts } });
    expect(() => r("*-example-projects.vercel.app")).not.toThrow();
    for (const bad of ["*", "*-.vercel.app", "x*.vercel.app", "*example.vercel.app", "*-a.b*.app"]) expect(() => r(bad), bad).toThrow();
  });

  it("preview host allowlist", () => {
    const h = ["*.vercel.app", "preview.example.org"];
    expect(previewHostAllowed("https://x-git-y.vercel.app", h)).toBe(true);
    expect(previewHostAllowed("https://preview.example.org/x", h)).toBe(true);
    for (const u of ["http://x.vercel.app", "https://vercel.app", "https://evil.com/.vercel.app", "https://x.vercel.app.evil.com", "https://user:pw@x.vercel.app", "https://x.vercel.app:8443", "javascript:alert(1)"])
      expect(previewHostAllowed(u, h), u).toBe(false);
  });
});
