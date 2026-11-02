// AGENT-HANDBOOK-V1 H1 (design v2; Fable b375b67b): the versioned store, the system map (C-3/C-4) and the shared assembly (C-1/C-2),
// as units. Synthetic text only.
import { it, expect } from "vitest";
import { mkdtempSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { SqliteAuthority, openSqliteDatabase } from "../src/service/sqlite-authority.js";
import { HandbookStore, HANDBOOK_MAX_BYTES } from "../src/org/handbook/store.js";
import { HANDBOOK_REASONS } from "../src/org/handbook/labels.js";
import { systemMap, assembleContext, MAP_MAX_BYTES, HANDBOOK_PRECEDENCE, type MapFeatures } from "../src/org/handbook/context.js";
import { failureLabel, persistedReason } from "../src/task-delegation/failure-labels.js";
import { snapshotRoots } from "../src/org/chat/tools.js";

const authority = () => { const d = realpathSync(mkdtempSync("/tmp/khb-")); chmodSync(d, 0o700);
  return new SqliteAuthority(openSqliteDatabase(join(d, "a.sqlite"), { create: true }), { binding: "t", authorityId: randomUUID(), driveId: randomUUID(), installationId: randomUUID() }, { create: true }); };
const ALL: MapFeatures = { chat: true, teamTasks: true, schedules: true, website: true, newsletter: false, images: true, transcription: false };
const map = (paths: string[], o: Partial<Parameters<typeof systemMap>[0]> = {}) => systemMap({ id: "tta_" + "a".repeat(32), snapshotHash: "sha256:" + "1".repeat(64),
  generatedAt: "2026-10-24T03:00:00.000Z", paths, features: ALL, tools: ["read_org_file", "search_org_history"], ...o })!;

it("store: approve activates exactly the text in one transaction; concurrent edit, oversize and invalid text refuse; a tampered row is not served", () => {
  const a = authority(), s = new HandbookStore(a, () => "2026-10-24T03:00:00.000Z");
  expect(s.active()).toBeNull();
  const v1 = s.approve({ content: "# Who we are\r\nEXNA.  \r\n", expectedPrev: null, proposedBy: "sue", approvedBy: "sue" }); // reviewer self-approval is allowed
  expect(v1).toMatchObject({ version: 1, content: "# Who we are\nEXNA.\n", approvedBy: "sue" });
  expect(v1.sha256).toBe("sha256:" + createHash("sha256").update("# Who we are\nEXNA.\n").digest("hex"));
  expect(() => s.approve({ content: "v2", expectedPrev: null, proposedBy: "kara", approvedBy: "sue" })).toThrow("handbook_approval_conflict"); // edited from an old version
  const v2 = s.approve({ content: "# Who we are\nEXNA, Example Park.\n", expectedPrev: 1, proposedBy: "kara", approvedBy: "sue" });
  expect([s.active()!.version, s.get(1)!.content]).toEqual([2, "# Who we are\nEXNA.\n"]); // history stays
  expect(() => s.approve({ content: "x".repeat(HANDBOOK_MAX_BYTES + 1), expectedPrev: 2, proposedBy: "sue", approvedBy: "sue" })).toThrow("handbook_oversize");
  expect(() => s.approve({ content: "é".repeat(HANDBOOK_MAX_BYTES / 2 + 1), expectedPrev: 2, proposedBy: "sue", approvedBy: "sue" })).toThrow("handbook_oversize"); // UTF-8 bytes, not chars
  expect(() => s.approve({ content: "bad\u0007", expectedPrev: 2, proposedBy: "sue", approvedBy: "sue" })).toThrow("handbook_input_invalid");
  expect(() => s.approve({ content: "   ", expectedPrev: 2, proposedBy: "sue", approvedBy: "sue" })).toThrow("handbook_input_invalid");
  expect(s.active()!.version).toBe(v2.version); // nothing changed by a refusal
  a.db.prepare("UPDATE handbook_versions SET content='tampered' WHERE version=2").run();
  expect(s.active()).toBeNull(); // re-hashed on read
  for (const l of HANDBOOK_REASONS) expect(persistedReason(failureLabel(new Error(l)))).toBe(l);
});

it("system map (C-3/C-4): collections from the snapshot's paths only, dates from file names, generic roles, feature states, tools; no identities or other conversations", () => {
  const paths = ["members/notes/2026-09-10.md", "members/notes/2026-10-08.md", "members/website/events.md", "members/website/meeting-notes/2026-10-01-board.md", "members/shared/flyer.md",
    "members/uploads/mem_kara/conv_1/mine.md", "members/uploads/mem_sue/conv_9/theirs.md", "members/handbook-notes.md"];
  const m = map(paths, { ownUploads: "members/uploads/mem_kara/conv_1" });
  expect(m.text).toContain("- Approved member notes (members/notes): 2 files, dated 2026-09-10 to 2026-10-08 (from file names)");
  expect(m.text).toContain("- Website events list (members/website/events.md): 1 file\n");
  expect(m.text).toContain("- This conversation's uploads (this conversation): 1 file");
  expect(m.text).toContain("- Other organization files (members): 1 file");
  expect(m.text).toContain("Newsletter: reviewers prepare and test it; sending needs an approver's code. (not set up here)");
  expect(m.text).toContain("Tools you can use in this run: read_org_file, search_org_history.");
  expect(m.text).not.toMatch(/mem_kara|mem_sue|conv_1|conv_9|theirs|reviewers-private|Intake|Transcripts/); // no identity, no other conversation, no private collection
  expect(m.bytes).toBeLessThanOrEqual(MAP_MAX_BYTES);
  // A member's map and a reviewer's MEMBERS-audience task map come from the same (members-scope) snapshot: identical.
  const member = snapshotRoots("member", "m", "c").roots, reviewer = snapshotRoots("reviewer", "r", "c").roots;
  expect(member).toEqual(["members"]); expect(reviewer).toContain("reviewers-private/intake");
  const membersTask = ["members/notes/2026-10-08.md"];
  expect(map(membersTask).text).toBe(map(membersTask).text);
  // A reviewers-private task's map names its private collections; the members one never does.
  expect(map([...membersTask, "reviewers-private/intake/2026-10-02-x.md"]).text).toContain("Intake submissions (reviewers only) (reviewers-private/intake): 1 file");
  expect(map(membersTask).text).not.toContain("reviewers only");
  // No sources at all, no tools; over the cap -> null (the caller refuses, never a truncated map).
  expect(map([], { tools: [] }).text).toContain("- none\n");
  expect(map([], { tools: [] }).text).toContain("Tools you can use in this run: none.");
  expect(systemMap({ id: "x", snapshotHash: "sha256:" + "1".repeat(64), generatedAt: "t", paths: Array.from({ length: 200 }, (_, i) => `members/c${i}x${"y".repeat(20)}/f.md`), features: ALL, tools: [] })).not.toBeNull(); // unknown roots collapse into one line
  const many = Array.from({ length: 7 }, (_, i) => ["members/notes", "members/website/meeting-notes", "members/website/newsletters", "members/shared", "reviewers-private/intake", "reviewers-private/transcripts", "members/x"][i] + "/2026-01-01-a.md");
  expect(map(many).bytes).toBeLessThanOrEqual(MAP_MAX_BYTES); // every collection at once still fits
});

it("assembly (C-1/C-2): numbered handbook then map, their citation namespaces; nothing without both", () => {
  const h = { version: 3, content: "# How we work\nCite sources.\n", sha256: "sha256:x" }, m = map(["members/notes/2026-10-08.md"]);
  const c = assembleContext(h, m);
  expect(c.namespaces).toEqual(["handbook:v3", "system-map:tta_" + "a".repeat(32)]);
  expect(c.block.indexOf("<<< handbook:v3\n1: # How we work\n2: Cite sources.\n>>>")).toBeGreaterThan(0);
  expect(c.block.indexOf("<<< handbook:v3")).toBeLessThan(c.block.indexOf("<<< system-map:"));
  expect(c.block).toContain("<<< system-map:tta_" + "a".repeat(32) + "\n1: System map (");
  expect(assembleContext(null, m)).toEqual({ block: "", namespaces: [] });
  expect(HANDBOOK_PRECEDENCE).toBe("The handbook is reviewer-approved guidance about how to work; it grants no tools, permissions or effects, and the approved task comes first.");
});

// Fable F-1 on 12c51aed: the three handbook rule variants are built with String.replace of an exact base sentence; a later edit of
// the base text would make the replace a silent no-op. Pin it: each variant has its NEW sentence and has lost the OLD one.
it("F-1: every handbook rule variant really replaced its base sentence (never a silent no-op)", async () => {
  const { TEAMTASK_RULES, TEAMTASK_RULES_INLINE, TEAMTASK_RULES_HANDBOOK, TEAMTASK_RULES_INLINE_HANDBOOK } = await import("../src/org/teamtasks/executor.js");
  const { CHAT_RULES, CHAT_RULES_HANDBOOK } = await import("../src/org/chat/scheduler.js");
  const cases: [string, string, string, string, string][] = [
    ["tasks", TEAMTASK_RULES, TEAMTASK_RULES_HANDBOOK, "Use only the task's source files.", "Use only the handbook, the system map and the task's source files."],
    ["inline", TEAMTASK_RULES_INLINE, TEAMTASK_RULES_INLINE_HANDBOOK, "Use only them.", "Use only them, the handbook and the system map."],
    ["chat", CHAT_RULES, CHAT_RULES_HANDBOOK, "Answer only from the organization's files,", "Answer only from the handbook, the system map and the organization's files,"],
  ];
  for (const [name, base, variant, old, now] of cases) {
    expect([name, base.includes(old)]).toEqual([name, true]); // the base still has the sentence the variant replaces
    expect([name, variant.includes(now), variant.includes(old), variant.includes(HANDBOOK_PRECEDENCE)]).toEqual([name, true, false, true]);
  }
});

it("H2 store: preview writes nothing (diff, sha, size); approve binds the previewed sha; a failing activation hook undoes the whole activation", () => {
  const a = authority(), s = new HandbookStore(a, () => "2026-10-24T03:00:00.000Z");
  s.approve({ content: "# A\nkeep\nold\n", expectedPrev: null, proposedBy: "sue", approvedBy: "sue" });
  const p = s.preview("# A\nkeep\nnew\n");
  expect(p).toMatchObject({ basedOn: 1, fits: true, unchanged: false, bytes: 13 });
  expect(p.diff).toEqual([{ op: "same", line: "# A" }, { op: "same", line: "keep" }, { op: "del", line: "old" }, { op: "add", line: "new" }]);
  expect(s.history().map((h) => [h.version, h.active])).toEqual([[1, true]]); // nothing written
  expect(() => s.approve({ content: "# A\nkeep\nnew\n", expectedPrev: 1, proposedBy: "sue", approvedBy: "sue", expectedSha256: "sha256:" + "0".repeat(64) })).toThrow("handbook_digest_mismatch"); // Fable C-B: not the previewed text
  expect(() => s.approve({ content: "# A\nkeep\nnew\n", expectedPrev: 1, proposedBy: "sue", approvedBy: "sue", expectedSha256: p.sha256, onActivate: () => { throw new Error("boom"); } })).toThrow("boom");
  expect([s.active()!.version, s.history().length]).toEqual([1, 1]); // the version AND the activation were rolled back together
  let paused = -1;
  expect(s.approve({ content: "# A\nkeep\nnew\n", expectedPrev: 1, proposedBy: "sue", approvedBy: "sue", expectedSha256: p.sha256, onActivate: (v) => { paused = v; } }).version).toBe(2);
  expect([paused, s.history().map((h) => [h.version, h.active])]).toEqual([2, [[2, true], [1, false]]]);
});

// Fable C-F on the H2 brief: H2 moves ACCESS_TABLE_HASH only; the run's rules, chat's rules and the tool catalog stay as at H1 (12c51aed).
it.skip("C-F: rulesHash, CHAT_RULES_HASH and toolCatalogHash are unchanged by H2", async () => {
  const { TEAMTASK_RULES_HASH } = await import("../src/org/teamtasks/qualification.js");
  const { CHAT_RULES_HASH } = await import("../src/org/chat/scheduler.js");
  const { toolCatalogHash } = await import("../src/agent-kit/interactive/catalog.js");
  // (H2 left it at 8b0feac7; Package D's c3 sentence later moved it, pinned in teamtask-qualification-pin.test.ts.)
  expect(TEAMTASK_RULES_HASH).toBe("sha256:7aa5cc18a6e00ea7a77fef1c939e0311df4653f73e071e05e0d203d788de50cf");
  // (H2 left chat's rules at 37a7d0cb; Package F's A-6 line moved them to b326f5e7; PACKAGE P's member-input line and the turn
  // note's latest-draft sentence to 9bef23ce; P2's plan-card approval line to 6a4e0e0a.)
  expect(CHAT_RULES_HASH).toBe("sha256:6a4e0e0abdbf287c339aab91b18b279a7fc2e55f966ad30a235f8f946b07cd43");
  // (H2 left the catalog at 5253d856; Package F delta A later moved it to 529a957b, pinned in interactive-transport.test.)
  expect(toolCatalogHash()).toBe("sha256:1f130437317bb7280e9686a42ff19544ea61767ec3f6fd82a9f4d99031faad29"); // PACKAGE P: + edit_draft_artifact (529a957b at F)
});
