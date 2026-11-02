// Lean runtime step 4 (spec §4/§5, Fable non-blocking note): member-facing meeting notes. Only a reviewer's step-up-
// approved rendition (`notes.approve`, artifact digest = sha256 of the exact markdown) is written to the `members`
// audience, as a NEW immutable version file (never an overwrite). Private review material is never auto-downgraded.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../content.js";
import { AccessError, type Authorization } from "../access/org-access.js";
import { refuseWebsiteRoot } from "./website/content-root.js";

export const notesDigest = (markdown: string) => "sha256:" + createHash("sha256").update(markdown, "utf8").digest("hex");
export type NotesApproval = { meeting: string; reportId: string; markdown: string; acknowledgedPrivateTerms?: boolean };
/** Reviewers-private material that must not reach members by accident: the private heading, open questions, ideas,
 *  offers, unapproved/tentative items and money. Present -> approval needs an explicit, approval-bound confirmation. */
export const PRIVATE_MARKERS = [/reviewers-private/i, /REVIEWERS-ONLY/i, /^\s*[-*]?\s*QUESTION:/im, /\(not approved\)/i, /\(tentative/i,
  /^\s*[-*]?\s*(Idea|Offer|Proposed follow-up)\b/im, /\$\s?\d/];
export const privateMarkersIn = (md: string) => PRIVATE_MARKERS.filter((r) => r.test(md)).map((r) => r.source);

export function writeApprovedNotes(folder: string, z: Authorization, body: NotesApproval, privateDraft?: string | null) {
  const refuse = (ok: unknown, reason: string) => { if (!ok) throw new AccessError(reason); }; // fixed labels for the UI
  refuse(z.action === "notes.approve" && z.bodyHash === digest(body) && z.artifactDigest === notesDigest(body.markdown), "notes_approval_mismatch");
  // Safety (Director review): the private draft can never be approved unedited, and private markers need an explicit,
  // approval-bound acknowledgement (it is part of the approved body).
  if (privateDraft != null) refuse(body.markdown.trim() !== privateDraft.trim(), "notes_unedited_private_draft");
  if (privateMarkersIn(body.markdown).length) refuse(body.acknowledgedPrivateTerms === true, "notes_private_terms_unconfirmed");
  refuse(/^\d{4}-\d{2}-\d{2}$/.test(body.meeting) && body.markdown.length > 0 && Buffer.byteLength(body.markdown) <= 256 * 1024, "notes_invalid");
  const dir = join(folder, "members", "notes");
  refuseWebsiteRoot(folder, join(dir, "x"), (l) => new AccessError(l)); // Fable R-2
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const versions = readdirSync(dir).filter((f) => f.startsWith(body.meeting + ".v")).length;
  const name = `${body.meeting}.v${versions + 1}.md`, path = join(dir, name);
  refuse(!existsSync(path), "notes_version_exists");
  writeFileSync(path, body.markdown, { mode: 0o600, flag: "wx" });
  return { path: `notes/${name}`, version: versions + 1, sha256: notesDigest(body.markdown) };
}
