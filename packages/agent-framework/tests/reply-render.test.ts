// Step-5 reply-bytes fix (Fable): the member-facing reply is rendered server-side: the sender name is the one PINNED in the
// passkey-approved policy (never the org id, never model text) and machine citation markers become plain source lines.
import { it, expect } from "vitest";
import { renderReply, replyBody, notesSourceName, replyPolicySchema, guardCitations } from "../src/org/member-reply.js";

it("citation markers are stripped server-side and become plain source lines", () => {
  expect(replyBody("The cleanup is on Oct 31. [2026-10-08.v1.md#L2]", [{ path: "2026-10-08.v1.md" }]))
    .toBe("The cleanup is on Oct 31.\n\nSource: Oct 8, 2026 meeting notes");
  expect(replyBody("Confirmed [2026-10-08.v2.md#L3-L4]. Ask Robin [2026-11-03.v1.md#L2-5].", [{ path: "2026-10-08.v2.md" }, { path: "2026-11-03.v1.md" }, { path: "2026-10-08.v2.md" }]))
    .toBe("Confirmed. Ask Robin.\n\nSource: Oct 8, 2026 meeting notes (version 2); Nov 3, 2026 meeting notes");
  expect(replyBody("The member notes do not say.", [])).toBe("The member notes do not say.");
  // Live attempt 3 (Fable read-back b03502d2): an abstention that cited the title line gets NO Source line.
  for (const t of ["The member notes do not say. I can't answer that from the approved notes. [2026-10-08.v1.md#L1]", "I cannot answer that from the notes [2026-10-08.v1.md#L1].",
    "I'm unable to answer that from the approved notes. [2026-10-08.v1.md#L1]", "I can\u2019t answer that from the approved notes [2026-10-08.v1.md#L1]."])
    expect(replyBody(t, [{ path: "2026-10-08.v1.md" }])).not.toMatch(/Source:/);
  expect(replyBody("The cleanup is on Oct 31 [2026-10-08.v1.md#L2]; the notes don't say who brings supplies.", [{ path: "2026-10-08.v1.md" }])).toMatch(/\n\nSource: Oct 8, 2026 meeting notes$/);
  // F-6: a Source line only when a citation supports a stated fact (each marker belongs to the clause before it). Mixed
  // answers keep it in either order, Fable's own case included; citations attached to an abstaining clause don't count.
  for (const t of ["The cleanup is on Saturday Oct 31. [2026-10-08.v1.md#L2] I can't answer who brings the supplies from the approved notes.",
    "The cleanup is on Saturday Oct 31 [2026-10-08.v1.md#L2]. The notes don't say who brings supplies.",
    "Saturday Oct 31 [2026-10-08.v1.md#L2]! I\u2019m unable to answer the start time.",
    "I can't answer who brings supplies, but the cleanup is on Oct 31 [2026-10-08.v1.md#L2].",
    "The notes don't say who brings supplies; the cleanup is on Oct 31. [2026-10-08.v1.md#L2]"])
    expect(replyBody(t, [{ path: "2026-10-08.v1.md" }]), t).toMatch(/\n\nSource: Oct 8, 2026 meeting notes$/);
  for (const t of ["The approved notes don't mention Sam. [2026-10-08.v1.md#L1] The cleanup is Oct 31.", "Notes do not say. [2026-10-08.v1.md#L1]",
    "I can't answer that, but I can't answer the cost either [2026-10-08.v1.md#L1].", "Sorry. I cannot answer that from the notes [2026-10-08.v1.md#L1]"])
    expect(replyBody(t, [{ path: "2026-10-08.v1.md" }]), t).not.toMatch(/Source:/);
  expect(notesSourceName("notes/odd.md")).toBe("the approved notes");
  expect(notesSourceName("2026-13-01.v1.md")).toBe("the approved notes");
});

it("the From name is the policy's pinned senderName, and the policy refuses names that could break a header", () => {
  const bytes = renderReply({ senderName: "EXNA Notes", replyId: "reply_abc", replyDomain: "reply.exna.test", to: "alex@exna.test", subject: "Question",
    inReplyTo: "<m1@mail.test>", text: "On Oct 31. [2026-10-08.v1.md#L2]", citations: [{ path: "2026-10-08.v1.md" }], date: "2026-10-16T00:00:00.000Z" });
  expect(bytes).toMatch(/^From: "EXNA Notes" <agent@reply\.exna\.test>\r\n/);
  expect(bytes.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim()).toBe("On Oct 31.\r\n\r\nSource: Oct 8, 2026 meeting notes");
  expect(bytes).not.toMatch(/\.md#L/);
  const base = { contract: "kapelle.member-reply-policy/v1", version: 1, mode: "shadow", members: [{ memberId: "m-00000000-0000-4000-8000-000000000001" }], sourceAudience: "members",
    catalogProfileHash: "sha256:" + "a".repeat(64), readerPolicyHash: "sha256:" + "b".repeat(64), actionTableHash: "sha256:" + "c".repeat(64),
    caps: { perMemberPerDay: 5, perOrgPerDay: 50, followUps: 1, maxChars: 2000 }, retentionDays: 90 };
  expect(replyPolicySchema.safeParse({ ...base, senderName: "EXNA Notes" }).success).toBe(true);
  for (const bad of [undefined, "", 'EXNA" <evil@x.test>', "EXNA\r\nBcc: x@y.test", "<script>", "x".repeat(81)])
    expect(replyPolicySchema.safeParse({ ...base, senderName: bad }).success, String(bad)).toBe(false);
});

it("G-1: heading citations and citations on abstaining clauses support nothing; the drop is counted with a fixed reason", () => {
  const notes = ["# October meeting — member notes", "The neighborhood cleanup is on Saturday Oct 31.", "The start time is being confirmed (flyer and notes differ).", "Volunteers welcome."];
  const lines = (p: string) => (p === "2026-10-08.v1.md" ? notes : null);
  const c = (startLine: number, endLine = startLine) => ({ path: "2026-10-08.v1.md", startLine, endLine, sha256: "x", valid: true });
  const g = (text: string, cs: ReturnType<typeof c>[]) => { const r = guardCitations(text, cs, lines); return { kept: r.kept.map((k) => [k.startLine, k.endLine]), dropped: r.dropped.map((d) => [d.startLine, d.endLine, d.reason]) }; };
  // Attempt 3: an abstention citing the heading line.
  expect(g("The member notes do not say. I can't answer that from the approved notes. [2026-10-08.v1.md#L1]", [c(1)])).toEqual({ kept: [], dropped: [[1, 1, "heading"]] });
  // Attempt 4 (live): an abstention citing the whole file as evidence of absence.
  expect(g("The approved member notes do not mention Sam or supplies at all. I cannot answer that question based on the available files. [2026-10-08.v1.md#L1-L4]", [c(1, 4)]))
    .toEqual({ kept: [], dropped: [[1, 4, "abstention"]] });
  // A fact citing the heading and its line: the heading goes, the line stays.
  expect(g("The cleanup is on Saturday Oct 31. [2026-10-08.v1.md#L1] [2026-10-08.v1.md#L2]", [c(1), c(2)])).toEqual({ kept: [[2, 2]], dropped: [[1, 1, "heading"]] });
  // F-6 mixed answers keep their fact citations, in either order; the golden shapes are unchanged.
  expect(g("I can't answer who brings supplies, but the cleanup is on Oct 31 [2026-10-08.v1.md#L2].", [c(2)])).toEqual({ kept: [[2, 2]], dropped: [] });
  expect(g("The cleanup is on Oct 31 [2026-10-08.v1.md#L2]. I can't answer who brings supplies [2026-10-08.v1.md#L4].", [c(2), c(4)])).toEqual({ kept: [[2, 2]], dropped: [[4, 4, "abstention"]] });
  expect(g("The neighborhood cleanup is on Saturday Oct 31. [2026-10-08.v1.md#L2] [2026-10-08.v1.md#L3]", [c(2), c(3)])).toEqual({ kept: [[2, 2], [3, 3]], dropped: [] });
  expect(g("The member notes do not say. I can't answer that from the approved notes.", [])).toEqual({ kept: [], dropped: [] });
  // A range that reaches fact lines is not a heading citation; one marker on a fact clause keeps it even if repeated on an abstention.
  expect(g("The notes say Oct 31 [2026-10-08.v1.md#L1-L2]. I can't answer the time [2026-10-08.v1.md#L1-L2].", [c(1, 2)])).toEqual({ kept: [[1, 2]], dropped: [] });
  // Unknown files are never treated as headings (no lines to check).
  expect(guardCitations("Fact [x.md#L1].", [{ path: "x.md", startLine: 1, endLine: 1, valid: true }], lines).kept).toHaveLength(1);
});
