// Chat content v1, WC-1 (PLAN-CHAT-CONTENT-V1; Fable R-1..R-7, R-12): the read-only website content copy under
// members/website/. Pure parts (HTML to text, names, the root guard) run everywhere; the sync runs through the real org
// runtime against the FAKE GitHub (GET only), with synthetic site content. No network beyond loopback.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { htmlToText, decodeEntities, slugOf, renderContent, CONTENT_LIMITS } from "../src/org/website/content.js";
import { inWebsiteRoot, WEBSITE_CONTENT_REASONS } from "../src/org/website/content-root.js";
import { FakeGithub } from "../src/org/website/fake-github.js";
import { failureLabel, persistedReason } from "../src/task-delegation/failure-labels.js";
import { takeSnapshot, ChatTools, SNAPSHOT_LIMITS } from "../src/org/chat/tools.js";
import { writeApprovedNotes, notesDigest } from "../src/org/notes.js";
import { digest } from "../src/content.js";
import { fakeTranscriptionBackend } from "../src/org/transcription/adapter.js";
import { transcriptionWorld, policyFor } from "./transcription-world.js";
import * as F from "./media-fixtures.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;

it("R-5 htmlToText: head/script/style dropped with content; on*= and javascript: never survive; https/mailto links as text (url); entities once; 512 KiB refused", () => {
  const html = `<!DOCTYPE html><html><head><title>T</title><style>.x{color:red}</style><meta charset="utf-8"/></head><body>
    <h1>October &amp; more</h1><p>Hello <b>neighbors</b>,<br>see you&nbsp;soon.</p><script>alert("SCRIPT-MARKER")</script>
    <img src="x" onerror="alert('ONERROR-MARKER')" alt="a>b"><p><a href="javascript:alert('JS-MARKER')">click</a> and <a href="https://example.org/a?x=1&amp;y=2">the site</a>
    and <a href='mailto:hello@example.org'>mail</a> and <a href="http://insecure.example">plain</a> <a href="https://example.org/photo"><img src="p.jpg"></a></p><ul><li>One</li><li>Two</li></ul>
    <p>Literal: &amp;lt;b&amp;gt; &#169; &#x2014; &bogus;</p><!-- COMMENT-MARKER --><svg><text>SVG-MARKER</text></svg><SCRIPT type="x">UPPER-MARKER</SCRIPT></body></html>`;
  const t = htmlToText(html);
  for (const m of ["SCRIPT-MARKER", "ONERROR-MARKER", "JS-MARKER", "COMMENT-MARKER", "SVG-MARKER", "UPPER-MARKER", "color:red", "onerror", "javascript:", "<"]) expect(t, m).not.toContain(m);
  expect(t).toContain("October & more");
  expect(t).toContain("Hello neighbors,\nsee you soon.");
  expect(t).toContain("click and the site (https://example.org/a?x=1&y=2)");
  expect(t).toContain("mail (mailto:hello@example.org)");
  expect(t).toContain("and plain");                 // http: link: text only
  expect(t).not.toContain("insecure.example");
  expect(t).not.toContain("example.org/photo");   // an image-only link adds no bare "(url)"
  expect(t).toContain("- One\n- Two");
  expect(t).toContain("Literal: &lt;b&gt; © — &bogus;"); // decoded ONCE
  expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  expect(() => htmlToText("x".repeat(CONTENT_LIMITS.sourceBytes + 1))).toThrow("website_content_too_large");
  expect(htmlToText("a <b unterminated")).toBe("a");
});

it("R-1 names: slugs reduced to [a-z0-9-]{1,80}, bad dates and empty slugs skipped, every path under members/website/", () => {
  expect(slugOf("../../etc/passwd")).toBe("etc-passwd");
  expect(slugOf("a/b\u0000c")).toBe("a-b-c");
  expect(slugOf("\u0000/..")).toBeNull();
  expect(slugOf("x".repeat(200))).toHaveLength(80);
  const src = (path: string, v: unknown) => ({ path, blobSha: "b".repeat(40), text: JSON.stringify(v) });
  const r = renderContent({ repo: "o/r", commit: "c".repeat(40), at: "2026-10-17T00:00:00.000Z", newsletters: [], events: null,
    meetings: src("src/data/meeting-notes.json", { meetings: [
      { date: "2026-10-08", slug: "../../october", title: "Oct", sections: [{ heading: "A", body: "Body" }] },
      { date: "2026-10-08/../../x", slug: "x", title: "Bad date", sections: [] },
      { date: "2026-09-10", slug: "/..", title: "Empty slug", sections: [] },
      { date: "2026-10-08", slug: "october", title: "Duplicate name", sections: [] },
      { date: "2026-08-13", slug: "august", title: "No sections" }] }) });
  expect(r.files.map((f) => f.rel)).toEqual(["members/website/meeting-notes/2026-10-08-october.md"]);
  expect(r.skipped).toBe(4);
  expect(r.files[0].text.split("\n")[0]).toBe("Source: o/r src/data/meeting-notes.json at commit ccccccc, fetched 2026-10-17T00:00:00.000Z.");
});

it("R-2 guard: a target that resolves into members/website (directly, by a symlink, or a dangling one) is reserved", () => {
  const f = mkdtempSync(join(tmpdir(), "kwc-guard-"));
  try {
    mkdirSync(join(f, "members", "website"), { recursive: true });
    expect(inWebsiteRoot(f, join(f, "members", "website", "a.md"))).toBe(true);
    expect(inWebsiteRoot(f, join(f, "members", ".website-next", "a.md"))).toBe(true);
    expect(inWebsiteRoot(f, join(f, "members", "websites", "a.md"))).toBe(false);
    expect(inWebsiteRoot(f, join(f, "members", "shared", "a.md"))).toBe(false);
    symlinkSync(join(f, "members", "website"), join(f, "members", "shared"));
    expect(inWebsiteRoot(f, join(f, "members", "shared", "a.md"))).toBe(true);
    symlinkSync(join(f, "members", "website", "nope"), join(f, "members", "notes")); // dangling
    expect(inWebsiteRoot(f, join(f, "members", "notes", "x.md"))).toBe(true);
    for (const l of WEBSITE_CONTENT_REASONS) { expect(failureLabel(new Error(l)), l).toBe(l); expect(persistedReason(l)).toBe(l); }
  } finally { rmSync(f, { recursive: true, force: true }); }
});

const MEETINGS = JSON.stringify({ meetings: [
  { id: "2026-10", date: "2026-10-08", title: "Monthly Meeting Notes — October 8, 2026", slug: "october-2026", sections: [{ heading: "Public Safety Report", body: "Year to date: **71 offenses**.\n\n- Larceny: 40" }] },
  { id: "x", date: "2026-07-09", title: "Evil", slug: "../../../reviewers-private/x", sections: [{ heading: "H", body: "MALICIOUS-SLUG-BODY" }] }] });
const EVENTS = JSON.stringify({ events: [{ id: "e1", title: "Block Party", date: "2026-11-08", time: "2:00 PM", location: "Community Center", address: "1 Main St",
  description: "Games and food.", type: "social", image: "/images/x.jpg", contact: { name: "Sam", email: "sam@example.org" } }], meetingOverrides: {}, pastEvents: [], galleryPhotos: [] });
const SENT = JSON.stringify({ sent: [
  { slug: "2026-10-07-october", checksum: "sha256:" + "1".repeat(64), broadcast_id: "BROADCAST-SECRET-ID", sent_at: "2026-10-07T19:40:34.857Z" },
  { slug: "2026-09-04-september", checksum: "sha256:" + "2".repeat(64), broadcast_id: "BROADCAST-SECRET-ID-2", sent_at: "2026-09-04T15:43:06.060Z" },
  { slug: "../secrets", sent_at: "2026-01-01T00:00:00.000Z" }, { slug: "a/b", sent_at: "2026-01-01T00:00:00.000Z" }, { slug: "sample", sent_at: "2026-01-01T00:00:00.000Z" },
  { slug: "2026-05-21-missing", sent_at: "2026-05-21T00:00:00.000Z" }] }); // the site's real shape
const OCT = `---\ntitle: "October"\nsubject_line: "October in Example Park"\nformat: raw_html\npreview_text: "Meeting, happy hour + Halloween"\n---\n\n<!DOCTYPE html><html><head><style>p{}</style></head>` +
  `<body><h1>October</h1><p>The meeting is <b>Oct 8</b>.</p><script>SCRIPT-MARKER</script><a href="https://example.org/events">Events</a></body></html>`;
const SEP = `---\ntitle: "September"\nsubject_line: "September newsletter"\n---\n\nHey neighbors,\n\n**Cleanup** on Sept 20.\n`;
const SITE = { "src/data/meeting-notes.json": MEETINGS, "src/data/events.json": EVENTS, "content/newsletter/.sent.json": SENT,
  "content/newsletter/2026-10-07-october.md": OCT, "content/newsletter/2026-09-04-september.md": SEP,
  "content/newsletter/2026-06-23-unsent-draft.md": "---\ntitle: UNSENT-DRAFT\n---\nUNSENT-DRAFT-BODY", "content/newsletter/sample.md": "SAMPLE-BODY",
  "content/newsletter/secrets.md": "SECRETS-BODY", "src/data/private.json": "PRIVATE-REPO-FILE" };

describe.skipIf(!enabled)("website content copy (WC-1)", () => {
  it("sync: GET only; sent newsletters only; text with provenance; Files shows the website; failures keep the last good set; crash between renames recovers", async () => {
    const gh = new FakeGithub(undefined, SITE);
    const w = await transcriptionWorld({ chat: {}, website: {}, githubFetch: gh.fetch, websiteContent: { start: false } });
    try {
      const root = join(w.cfg.folder, "members", "website"), content = () => w.org.websiteContent!;
      expect(existsSync(root)).toBe(false);                       // WC-1 has no trigger: nothing until a sync runs
      expect(await content().sync()).toEqual({ ok: true });
      const list = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? list(join(d, e.name)).map((x) => `${e.name}/${x}`) : [e.name]).sort();
      expect(list(root)).toEqual(["events.md", "meeting-notes/2026-07-09-reviewers-private-x.md", "meeting-notes/2026-10-08-october-2026.md",
        "newsletters/2026-09-04-september.md", "newsletters/2026-10-07-october.md"]);
      const main = gh.refs.get("main")!, read = (rel: string) => readFileSync(join(root, rel), "utf8");
      expect(read("meeting-notes/2026-10-08-october-2026.md")).toBe(`Source: 0xkilgore/example-org-website src/data/meeting-notes.json at commit ${main.slice(0, 7)}, fetched ${content().status().fetchedAt}.\n\n` +
        "# Monthly Meeting Notes — October 8, 2026\n\nDate: 2026-10-08\n\n## Public Safety Report\n\nYear to date: **71 offenses**.\n\n- Larceny: 40\n");
      expect(read("events.md")).toContain("## Block Party\nDate: 2026-11-08\nTime: 2:00 PM\nLocation: Community Center\nAddress: 1 Main St\nContact: Sam (sam@example.org)\nGames and food.");
      expect(read("newsletters/2026-10-07-october.md")).toContain("# October in Example Park\n\nSent: 2026-10-07\n\nSummary: Meeting, happy hour + Halloween\n\nOctober\n\nThe meeting is Oct 8.");
      expect(read("newsletters/2026-10-07-october.md")).toContain("Events (https://example.org/events)");
      expect(read("newsletters/2026-09-04-september.md")).toContain("Hey neighbors,\n\n**Cleanup** on Sept 20.");
      const all = list(root).map(read).join("\n");
      for (const m of ["BROADCAST-SECRET-ID", "checksum", "UNSENT-DRAFT", "SAMPLE-BODY", "SECRETS-BODY", "PRIVATE-REPO-FILE", "SCRIPT-MARKER", "<"]) expect(all, m).not.toContain(m);
      expect(existsSync(join(w.cfg.folder, "reviewers-private", "x"))).toBe(false);
      // R-6: a full sync made GET calls only.
      expect(gh.calls.length).toBeGreaterThan(0);
      expect(gh.calls.filter((c) => c.method !== "GET")).toEqual([]);
      // Provenance rows; the sync row counts what was skipped (../secrets, a/b, sample, the missing one).
      const rows = w.org.sqlite.db.prepare("SELECT path, source_path, commit_sha FROM website_content_files ORDER BY path").all() as any[];
      expect(rows.map((r) => r.path)).toEqual(list(root).map((r) => "members/website/" + r));
      expect(rows.every((r) => r.commit_sha === main)).toBe(true);
      expect(w.org.sqlite.db.prepare("SELECT outcome, files, skipped FROM website_content_syncs").all()).toEqual([{ outcome: "ok", files: 5, skipped: 4 }]);
      // Files page and the snapshot see it, read-only, as the website.
      const files = (await w.post("/o/exna/api/files/list", {}, w.alex)).result.files.filter((f: any) => f.path.startsWith("members/website/"));
      expect(files).toHaveLength(5);
      expect(files.find((f: any) => f.path.endsWith("events.md"))).toMatchObject({ from: `The website (0xkilgore/example-org-website), src/data/events.json at ${main.slice(0, 7)}`, visibleTo: "All members and the agent", addedBy: null });
      const alex = (w.org.sqlite.db.prepare("SELECT member_id FROM access_members WHERE email='alex@exna.test'").get() as any).member_id;
      expect([...takeSnapshot(w.cfg.folder, "member", alex, "conv_x").files.keys()].filter((p) => p.startsWith("members/website/"))).toHaveLength(5);
      // A failing sync (malformed JSON upstream) keeps the last good set and its provenance; the outcome is recorded.
      gh.advanceMain({ "src/data/meeting-notes.json": "{not json" });
      expect(await content().sync()).toEqual({ ok: false, label: "website_content_malformed" });
      expect(list(root)).toHaveLength(5);
      expect(content().status()).toMatchObject({ commit: main, files: 5, lastOutcome: "website_content_malformed" });
      // An upstream HTTP failure is labelled by the connector.
      gh.fault("GET", /^\/git\/ref\//, 503);
      expect(await content().sync()).toEqual({ ok: false, label: "website_http_5xx" });
      // R-4: a crash between the swap's renames leaves only .website-prev: the next start puts it back; a missing root is 0 files.
      renameSync(root, join(w.cfg.folder, "members", ".website-prev"));
      expect([...takeSnapshot(w.cfg.folder, "member", alex, "conv_x").files.keys()].filter((p) => p.startsWith("members/website/"))).toEqual([]);
      await w.restart();
      expect(list(root)).toHaveLength(5);
      expect(existsSync(join(w.cfg.folder, "members", ".website-prev"))).toBe(false);
      // A good upstream again: the set is replaced whole (no .website-next/.website-prev left behind).
      gh.advanceMain({ "src/data/meeting-notes.json": JSON.stringify({ meetings: [] }) });
      expect(await w.org.websiteContent!.sync()).toEqual({ ok: true });
      expect(list(root)).toEqual(["events.md", "newsletters/2026-09-04-september.md", "newsletters/2026-10-07-october.md"]);
      expect(readdirSync(join(w.cfg.folder, "members")).filter((n) => n.startsWith(".website"))).toEqual([]);
    } finally { await w.close(); }
  });

  it("R-3 bounds: a generated file is capped at 200 KiB; a set over 4 MiB, or one that would push a snapshot past its limits, fails and keeps the last good set", async () => {
    const text = (kib: number) => ("Line of newsletter text. ".repeat(40) + "\n").repeat(kib); // ~1 KiB a line
    // n sent newsletters of ~kib KiB each (each source file stays under the 512 KiB source cap).
    const big = (n: number, kib: number) => ({ "content/newsletter/.sent.json": JSON.stringify(Array.from({ length: n }, (_, i) => ({ slug: `n-${i}`, sent_at: "2026-10-01T00:00:00.000Z" }))),
      ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`content/newsletter/n-${i}.md`, `---\ntitle: N${i}\n---\n${text(kib)}`])) });
    const gh = new FakeGithub(undefined, big(1, 300));
    const w = await transcriptionWorld({ chat: {}, website: {}, githubFetch: gh.fetch, websiteContent: { start: false } });
    try {
      const root = join(w.cfg.folder, "members", "website");
      expect(await w.org.websiteContent!.sync()).toEqual({ ok: true });
      const one = readFileSync(join(root, "newsletters/n-0.md"));
      expect(one.length).toBeLessThanOrEqual(CONTENT_LIMITS.fileBytes);
      expect(one.toString().endsWith("\n… (truncated)\n")).toBe(true);
      // 22 files x ~195 KiB > 4 MiB: refused whole.
      gh.advanceMain(big(22, 195));
      expect(await w.org.websiteContent!.sync()).toEqual({ ok: false, label: "website_content_too_large" });
      expect(readdirSync(join(root, "newsletters"))).toEqual(["n-0.md"]);
      // A near-full set (20 x ~195 KiB) fits, and every snapshot over it stays inside SNAPSHOT_LIMITS.
      gh.advanceMain(big(20, 195));
      expect(await w.org.websiteContent!.sync()).toEqual({ ok: true });
      const snap = takeSnapshot(w.cfg.folder, "reviewer", "m-x", "conv_x");
      expect(snap.files.size).toBe(20);
      // Other member files that leave no room: the sync fails (a sync failure, never a chat failure).
      mkdirSync(join(w.cfg.folder, "members", "shared"), { recursive: true });
      for (let i = 0; i < SNAPSHOT_LIMITS.maxFiles - 50 - 10; i++) writeFileSync(join(w.cfg.folder, "members", "shared", `f${i}.md`), "x\n");
      gh.advanceMain({ "README.md": "a new commit (an unchanged one is skipped before any check)" });
      expect(await w.org.websiteContent!.sync()).toEqual({ ok: false, label: "website_content_too_large" });
      expect(readdirSync(join(root, "newsletters"))).toHaveLength(20);
      expect(() => takeSnapshot(w.cfg.folder, "member", "m-x", "conv_x")).not.toThrow();
    } finally { await w.close(); }
  });

  it("R-2 writers: uploads, shares, approved notes, web intake, transcripts and draft artifacts refuse a target that resolves into members/website", async () => {
    const gh = new FakeGithub(undefined, SITE);
    const w = await transcriptionWorld({ chat: {}, website: {}, githubFetch: gh.fetch, websiteContent: { start: false }, backend: fakeTranscriptionBackend({}) });
    try {
      const f = w.cfg.folder, site = join(f, "members", "website"), before = () => readdirSync(site, { recursive: true }).length;
      expect(await w.org.websiteContent!.sync()).toEqual({ ok: true });
      const n0 = before(), api = (p: string, b: unknown, c = w.alex) => w.post(`/o/exna/api/${p}`, b, c);
      // Upload: members/uploads -> the website copy.
      const conv = (await api("chat/conversation/create", {})).result.conversationId;
      rmSync(join(f, "members", "uploads"), { recursive: true, force: true });
      symlinkSync(site, join(f, "members", "uploads"));
      expect((await api("chat/upload", { conversationId: conv, fileName: "a.md", text: "UPLOAD" })).error).toBe("website_content_path_reserved");
      rmSync(join(f, "members", "uploads"));
      // Share: a real upload, then members/shared -> the website copy.
      const up = (await api("chat/upload", { conversationId: conv, fileName: "a.md", text: "UPLOAD" })).result;
      rmSync(join(f, "members", "shared"), { recursive: true, force: true });
      symlinkSync(site, join(f, "members", "shared"));
      expect((await api("chat/upload/share", { uploadId: up.uploadId })).error).toBe("website_content_path_reserved");
      // Approved notes: members/notes -> the website copy.
      rmSync(join(f, "members", "notes"), { recursive: true, force: true });
      symlinkSync(site, join(f, "members", "notes"));
      const body = { meeting: "2026-10-08", reportId: "r1", markdown: "# Notes\nApproved.\n" };
      expect(() => writeApprovedNotes(f, { action: "notes.approve", bodyHash: digest(body), artifactDigest: notesDigest(body.markdown) } as never, body)).toThrow("website_content_path_reserved");
      // Web intake: reviewers-private/intake -> the website copy.
      mkdirSync(join(f, "reviewers-private"), { recursive: true });
      rmSync(join(f, "reviewers-private", "intake"), { recursive: true, force: true });
      symlinkSync(site, join(f, "reviewers-private", "intake"));
      expect((await api("intake/upload", { clientRequestId: "req-wc1-0001", title: "T", text: "INTAKE" }, w.robin)).error).toBe("website_content_path_reserved");
      // Transcripts: reviewers-private/transcripts -> the website copy: the job fails with its fixed write label, nothing lands.
      rmSync(join(f, "reviewers-private", "transcripts"), { recursive: true, force: true });
      symlinkSync(site, join(f, "reviewers-private", "transcripts"));
      expect((await w.ops("/ops/transcription/policy/approve", { policy: policyFor() })).ok).toBe(true);
      const audio = await w.upload(w.robin, F.wav(30));
      expect((await w.start(w.robin, audio)).ok).toBe(true);
      await w.org.transcription.jobs!.idle();
      expect(w.org.sqlite.db.prepare("SELECT state, label FROM transcription_jobs WHERE job_id=?").get(audio.jobId)).toEqual({ state: "failed", label: "transcription_write_interrupted" });
      // Draft artifacts: the artifact store -> the website copy: a fixed tool refusal, nothing written.
      const stateRoot = mkdtempSync(join(tmpdir(), "kwc-state-")); mkdirSync(join(stateRoot, "chat"), { recursive: true });
      symlinkSync(site, join(stateRoot, "chat", "artifacts"));
      const tools = new ChatTools(w.org.sqlite, { folder: f, stateRoot, envelopeFor: () => ({ envelopeId: "env_" + "c".repeat(32), snapshotHash: "x" }) });
      const ctx = { turnId: "turn_" + "9".repeat(32), conversationId: conv, memberId: "m", scope: "member" as const };
      await tools.begin(ctx);
      expect(await tools.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content: { title: "T", sections: [{ heading: "H", body: "B" }],
        sources: [{ path: "members/website/events.md", line: 1 }] } }), ctx)).toEqual({ ok: false, error: "chat_tool_failed" });
      rmSync(stateRoot, { recursive: true, force: true });
      expect(before()).toBe(n0);
    } finally { await w.close(); }
  });
});
