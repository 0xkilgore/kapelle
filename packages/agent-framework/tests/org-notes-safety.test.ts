// Director review of the review UI: the private draft must never reach members by one click. The runtime refuses the
// unedited private draft outright, and refuses private markers (private heading, QUESTION:, ideas, offers, tentative or
// unapproved items, money) unless the reviewer's passkey-bound body carries an explicit confirmation.
import { it, expect } from "vitest";
import { mkdtempSync, chmodSync, realpathSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../src/content.js";
import { writeApprovedNotes, notesDigest, privateMarkersIn, type NotesApproval } from "../src/org/notes.js";

const PRIVATE_DRAFT = "# Draft notes (reviewers-private)\n\n- Confirmed: cleanup Oct 31.\n- QUESTION: start time 9am or 10am?\n- Offer (tentative): Sam, supplies.\n- Idea (not approved): $200 supplies.\n";
const authorize = (body: NotesApproval) => ({ memberId: "m-1", action: "notes.approve", bodyHash: digest(body), artifactDigest: notesDigest(body.markdown), operationId: "op-notes-0001", replayed: false });
const folder = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "notes-"))); chmodSync(d, 0o700); return d; };

it("refuses the private draft as-is, refuses private markers without confirmation, accepts edited member notes", () => {
  const f = folder();
  const asIs = { meeting: "2026-10-08", reportId: "00000000-0000-4000-8000-000000000001", markdown: PRIVATE_DRAFT };
  expect(() => writeApprovedNotes(f, authorize(asIs) as never, asIs, PRIVATE_DRAFT)).toThrow("notes_unedited_private_draft");
  // Even with the confirmation ticked, the unchanged private draft never passes.
  const asIsAck = { ...asIs, acknowledgedPrivateTerms: true };
  expect(() => writeApprovedNotes(f, authorize(asIsAck) as never, asIsAck, PRIVATE_DRAFT)).toThrow("notes_unedited_private_draft");
  // Lightly edited but still carrying private labels: refused without the explicit confirmation.
  for (const md of [PRIVATE_DRAFT.replace("Draft notes", "Notes"), "# Notes\nThe cleanup is Oct 31.\n- QUESTION: 9 or 10?\n", "# Notes\nWe may spend $200.\n",
    "# Notes\n- Idea: a bake sale.\n", "# Notes\nSam (tentative) brings supplies.\n", "# Notes\nREVIEWERS-ONLY: Pat was upset.\n"]) {
    expect(privateMarkersIn(md).length, md).toBeGreaterThan(0);
    const b = { ...asIs, markdown: md };
    expect(() => writeApprovedNotes(f, authorize(b) as never, b, PRIVATE_DRAFT), md).toThrow("notes_private_terms_unconfirmed");
  }
  // An explicit, passkey-bound confirmation lets a reviewer keep a deliberate item (e.g. an approved amount).
  const kept = { ...asIs, markdown: "# Notes\nThe board approved $200 for supplies.\n", acknowledgedPrivateTerms: true };
  expect(writeApprovedNotes(f, authorize(kept) as never, kept, PRIVATE_DRAFT)).toMatchObject({ version: 1 });
  // The confirmation is part of the approved body: dropping it after approval breaks the binding.
  const stripped = { ...kept }; delete (stripped as Partial<typeof kept>).acknowledgedPrivateTerms;
  expect(() => writeApprovedNotes(f, authorize(kept) as never, stripped, PRIVATE_DRAFT)).toThrow("notes_approval_mismatch");
  // Clean member notes pass without any confirmation.
  const clean = { ...asIs, markdown: "# October meeting — member notes\nThe neighborhood cleanup is on Saturday Oct 31.\nThe start time is being confirmed.\n" };
  expect(writeApprovedNotes(f, authorize(clean) as never, clean, PRIVATE_DRAFT)).toMatchObject({ version: 2 });
  expect(readdirSync(join(f, "members", "notes")).sort()).toEqual(["2026-10-08.v1.md", "2026-10-08.v2.md"]);
});
