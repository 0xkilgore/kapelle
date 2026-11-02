// Website pack v0, W-1 (PLAN §2-§3; Fable R-6/R-8): the runtime-held GitHub connector driven against the FAKE GitHub REST
// emulator (no network), the website-pr effect ledger, the website config + render flags, and the labels in CODES.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { githubPort, readGithubPat, WebsiteError, WEBSITE_FAILURE_REASONS } from "../src/org/website/github.js";
import { FakeGithub } from "../src/org/website/fake-github.js";
import { WebsitePrLedger } from "../src/org/website/ledger.js";
import { render } from "../deploy/kapelle-admin.js";
import { orgRuntimeConfigSchema } from "../src/org/org-runtime.js";
import { failureLabel, persistedReason } from "../src/task-delegation/failure-labels.js";
import { transcriptionWorld } from "./transcription-world.js";

const PAT = "github_pat_SYNTHETIC0123456789abcdefghijklmnopqrstuvwxyz";
const EVENTS = JSON.stringify({ events: [{ id: "block-party-2026", title: "Block Party", date: "2026-10-18" }] }, null, 2) + "\n";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kgh-"))), patFile = join(dir, "pat");
  writeFileSync(patFile, PAT + "\n", { mode: 0o600 });
  const gh = new FakeGithub("0xkilgore/example-org-website", { "src/data/events.json": EVENTS, "public/images/events/fall.jpg": Buffer.from([1, 2, 3]) });
  return { dir, patFile, gh, port: githubPort({ repo: gh.repo, patFile, fetch: gh.fetch as never }) };
}
const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { expect(e).toBeInstanceOf(WebsiteError); return { label: (e as WebsiteError).label, sent: (e as WebsiteError).sent }; } };

describe("website GitHub connector (FAKE GitHub)", () => {
  it("reads main, a file, the tree; writes blob -> tree -> commit -> ref -> DRAFT PR; reads PRs and Vercel preview statuses", async () => {
    const { gh, port } = setup();
    const main = (await port.refSha("main"))!;
    expect(main).toMatch(/^[a-f0-9]{40}$/);
    expect(await port.refSha("kapelle/none")).toBeNull();
    const f = (await port.file("src/data/events.json", main))!;
    expect(f.bytes.toString("utf8")).toBe(EVENTS);
    expect(await port.file("src/data/missing.json", main)).toBeNull();
    expect([...(await port.treePaths(main))].sort()).toEqual(["public/images/events/fall.jpg", "src/data/events.json"]);
    const next = Buffer.from(EVENTS.replace("Block Party", "Block Party 2026"));
    const blob = await port.createBlob(next), tree = await port.createTree(await port.commitTree(main), [{ path: "src/data/events.json", blobSha: blob }]);
    const commit = await port.createCommit({ message: "Update events\n\nKapelle-Agent: website-pack v0; requested-by: reviewer", tree, parent: main, author: { name: "Alex", email: "alex@users.noreply.github.com" } });
    await port.createRef("kapelle/abc123", commit);
    expect(await port.refSha("kapelle/abc123")).toBe(commit);
    expect(gh.fileAt(commit, "src/data/events.json")).toBe(next.toString("utf8"));
    expect(gh.commits.get(commit)).toMatchObject({ parents: [main], author: { name: "Alex" } });
    const pr = await port.openDraftPull({ title: "Update events", body: "Summary", head: "kapelle/abc123", base: "main" });
    expect(pr).toMatchObject({ number: 1, draft: true, state: "open", merged: false, url: "https://github.com/0xkilgore/example-org-website/pull/1", head: "kapelle/abc123", headSha: commit });
    expect(await port.findPull("kapelle/abc123")).toMatchObject({ number: 1 });
    expect(await port.findPull("kapelle/none")).toBeNull();
    gh.setStatus(commit, { context: "Vercel – example-org-website", state: "success", target_url: "https://example-org-website-git-kapelle-abc123.vercel.app" });
    gh.setStatus(commit, { context: "ci/other", state: "success", target_url: "https://evil.example" });
    expect(await port.previewUrls(commit)).toEqual([{ state: "success", url: "https://example-org-website-git-kapelle-abc123.vercel.app" }]);
    gh.merge(1);
    expect(await port.pull(1)).toMatchObject({ state: "closed", merged: true });
    // Every request: the pinned origin + repo, the PAT as a bearer header only, never in a URL or body.
    expect(gh.calls.every((c) => c.auth === "Bearer " + PAT)).toBe(true);
    expect(JSON.stringify(gh.calls.map((c) => [c.path, c.body]))).not.toContain(PAT);
    // No merge / delete / workflow call exists on the port. updateRef (Fable ACCEPT e483c8dd): fast-forward only, kapelle/wr-* only.
    expect(Object.keys(port).sort()).toEqual(["commitTree", "createBlob", "createCommit", "createRef", "createTree", "file", "findPull", "openDraftPull", "previewUrls", "pull", "refSha", "treePaths", "updateRef"]);
  });

  it("refusals are fixed labels; `sent` marks a write that may have landed", async () => {
    const { gh, port, patFile, dir } = setup();
    const main = (await port.refSha("main"))!;
    gh.fault("GET", /^\/git\/ref\/heads\/main/, 503);
    expect(await err(port.refSha("main"))).toEqual({ label: "website_http_5xx", sent: false });
    gh.fault("GET", /^\/contents\//, "throw-before");
    expect(await err(port.file("src/data/events.json", main))).toEqual({ label: "website_transport_failed", sent: false });
    gh.fault("POST", /^\/git\/blobs/, 502);
    expect(await err(port.createBlob(Buffer.from("x")))).toEqual({ label: "website_http_5xx", sent: true });
    gh.fault("POST", /^\/git\/refs/, "throw-after");
    expect(await err(port.createRef("kapelle/lost", main))).toEqual({ label: "website_transport_failed", sent: true });
    expect(await port.refSha("kapelle/lost")).toBe(main); // it DID land: reconcile by reading
    expect(await err(port.createRef("kapelle/lost", main))).toEqual({ label: "website_http_422", sent: false });
    gh.fault("POST", /^\/pulls/, 403);
    expect(await err(port.openDraftPull({ title: "t", body: "b", head: "kapelle/lost", base: "main" }))).toEqual({ label: "website_http_403", sent: false });
    for (const bad of ["../x", "a/../b", "/abs"]) expect(await err(port.file(bad, main))).toEqual({ label: "website_arg_invalid", sent: false });
    expect(await err(port.refSha("main/../x"))).toEqual({ label: "website_arg_invalid", sent: false });
    const big = githubPort({ repo: gh.repo, patFile, fetch: gh.fetch as never, maxBytes: 64 });
    expect(await err(big.file("src/data/events.json", main))).toEqual({ label: "website_response_too_large", sent: false });
    process.env.NODE_USE_ENV_PROXY = "1";
    try { expect(await err(port.refSha("main"))).toEqual({ label: "website_ambient_proxy_refused", sent: false }); } finally { delete process.env.NODE_USE_ENV_PROXY; }
    // PAT custody.
    writeFileSync(join(dir, "loose"), PAT, { mode: 0o644 }); chmodSync(join(dir, "loose"), 0o644);
    expect(() => readGithubPat(join(dir, "loose"))).toThrow("website_pat_not_private");
    symlinkSync(patFile, join(dir, "link"));
    expect(() => readGithubPat(join(dir, "link"))).toThrow("website_pat_not_regular_file");
    writeFileSync(join(dir, "classic"), "ghp_classicTokenNotAllowed0123456789", { mode: 0o600 });
    expect(() => readGithubPat(join(dir, "classic"))).toThrow("website_pat_invalid");
    const wrong = githubPort({ repo: gh.repo, patFile: join(dir, "classic"), fetch: gh.fetch as never });
    expect(await err(wrong.refSha("main"))).toEqual({ label: "website_pat_invalid", sent: false });
    expect(() => githubPort({ repo: "not a repo", patFile })).toThrow("website_arg_invalid");
    for (const l of WEBSITE_FAILURE_REASONS) { expect(failureLabel(new Error(l)), l).toBe(l); expect(persistedReason(l)).toBe(l); }
  });

  it("render --website-*: the website block passes the schema; the PAT is an expected secret; identities are checked", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kgh-render-")));
    const r = render({ org: "exna", label: "Example Park", domain: "agent.example.org", monthlyUsd: 15, root, intake: "none",
      website: { repo: "0xkilgore/example-org-website", author: "Alex Owner <1234+owner@users.noreply.github.com>", previewHosts: "*.vercel.app, preview.example.org" } });
    const cfg = orgRuntimeConfigSchema.parse(JSON.parse(readFileSync(r.orgConfig, "utf8")));
    expect(cfg.website).toEqual({ repo: "0xkilgore/example-org-website", baseBranch: "main", author: { name: "Alex Owner", email: "1234+owner@users.noreply.github.com" },
      coAuthor: { name: "Kapelle agent", email: "agent@example.org" }, patFile: join(root, "/etc/kapelle/secrets/exna/github-website.pat"),
      previewHosts: ["*.vercel.app", "preview.example.org"], dailyApply: 5, dailyRequest: 20 });
    expect(r.secretsExpected).toContain(join(root, "/etc/kapelle/secrets/exna/github-website.pat"));
    expect(() => render({ org: "exna", label: "x", domain: "agent.example.org", monthlyUsd: 15, root, intake: "none", website: { repo: "0xkilgore/x", author: "no email", previewHosts: "*.vercel.app" } }))
      .toThrow("render_website_identity_invalid");
    const off = render({ org: "exna", label: "x", domain: "agent.example.org", monthlyUsd: 15, root, intake: "none" });
    expect(orgRuntimeConfigSchema.parse(JSON.parse(readFileSync(off.orgConfig, "utf8"))).website).toBeUndefined();
  });
});

describe.skipIf(!enabled)("website-pr ledger", () => {
  it("intent is durable and idempotent per approval; facts recorded; Ops status lists unsettled by id and label only", async () => {
    const w = await transcriptionWorld({ members: false });
    try {
      const l = new WebsitePrLedger(w.org.sqlite);
      const i = l.intent({ operationId: "op-1", requestId: "wr_1", memberId: "m-1", baseCommit: "a".repeat(40), branch: "kapelle/op1", files: [{ path: "src/data/events.json" }] });
      expect(i).toMatchObject({ state: "intent", baseCommit: "a".repeat(40), branch: "kapelle/op1", commitSha: null });
      expect(l.intent({ operationId: "op-1", requestId: "wr_other", memberId: "m-2", baseCommit: "b".repeat(40), branch: "kapelle/x", files: [] })).toMatchObject({ requestId: "wr_1", baseCommit: "a".repeat(40) });
      expect(l.update("op-1", "sent", { commitSha: "c".repeat(40) })).toMatchObject({ state: "sent", commitSha: "c".repeat(40) });
      expect(l.update("op-1", "unsettled", { label: "website_transport_failed" })).toMatchObject({ state: "unsettled", label: "website_transport_failed" });
      expect(l.status()).toEqual({ byState: { unsettled: 1 }, unsettled: [{ operation_id: "op-1", branch: "kapelle/op1", label: "website_transport_failed" }] });
      expect(() => l.intent({ operationId: "op-2", requestId: "wr_2", memberId: "m-1", baseCommit: "a".repeat(40), branch: "kapelle/op1", files: [] })).toThrow(); // one branch, one approval
    } finally { await w.close(); }
  }, 120_000);
});
