// Attribution B3 (Fable step-4 condition (a)): every `ownerId` reference in the authority is classified, and this test fails on
// any new, removed or unclassified one, so a change that lets a member principal through an owner check cannot land silently.
//   scope     the document/task/pilot belongs to THIS runtime's owner+scope (org identity). Unchanged by member attribution.
//   actor     who may act: all three default to or compare with the OWNER; the only member admission is the org Task path
//             (requestIdentity, tested in org-task / the launcher's B4 checks). Review-intent and Dispatch stay owner-only.
//   type      declarations.
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";

const CLASSIFIED: { snippet: string; kind: "scope" | "actor" | "type"; count: number; why: string }[] = [
  { snippet: '"principalId" | "ownerId" | "scopeRef"', kind: "type", count: 1, why: "TrustedContext pick" },
  { snippet: "ownerId: string;", kind: "type", count: 1, why: "options declaration" },
  { snippet: "observePilotNative(this.backend, this.options.ownerId", kind: "scope", count: 1, why: "pilot observation of this owner's native state" },
  { snippet: "principalId: this.options.ownerId,", kind: "actor", count: 1, why: "identity(): the default principal is the owner" },
  { snippet: "      ownerId: this.options.ownerId,", kind: "scope", count: 1, why: "identity(): the scope owner" },
  { snippet: '"Task generation scope differs"', kind: "scope", count: 1, why: "generation request belongs to this scope" },
  { snippet: "task.ownerId === ctx.ownerId && canonical(makeVersion(", kind: "scope", count: 1, why: "proposal source Task belongs to this owner" },
  { snippet: "p.offer && p.ownerId === ctx.ownerId", kind: "scope", count: 1, why: "Dispatch offer belongs to this scope" },
  { snippet: "'pilot_settlement_scope_unknown');", kind: "scope", count: 2, why: "pilot settlement document scope (both settlement paths)" },
  { snippet: "!read.document.state.global.ownerId ||", kind: "scope", count: 1, why: "read admission: document has no owner yet" },
  { snippet: "read.document.state.global.ownerId === this.options.ownerId,", kind: "scope", count: 1, why: "read admission: document belongs to this owner" },
  { snippet: "if (s.ownerId === this.options.ownerId && s.scopeRef === this.options.scopeRef)", kind: "scope", count: 1, why: "listing filter" },
  { snippet: "JSON.stringify([this.options.ownerId, this.options.scopeRef, query.recipient", kind: "scope", count: 1, why: "query binding includes the scope" },
  { snippet: "if (s.ownerId !== this.options.ownerId || s.scopeRef !== this.options.scopeRef) continue;", kind: "scope", count: 2, why: "listing filters" },
  { snippet: '"Task proposal approval scope differs"', kind: "scope", count: 1, why: "approval proposal belongs to this scope" },
  { snippet: '"Task identity or owner differs"', kind: "scope", count: 1, why: "Task belongs to this owner" },
  { snippet: 's.ownerId === this.options.ownerId && s.scopeRef === this.options.scopeRef, "kit_grant_proposal_scope"', kind: "scope", count: 1, why: "kit grant proposal scope" },
  { snippet: "task.ownerId === this.options.ownerId && taskSource(task)", kind: "scope", count: 1, why: "grant Task source belongs to this owner" },
  { snippet: "'pilot_control_owner_changed'", kind: "scope", count: 1, why: "pilot binding owner = runtime owner" },
  { snippet: "'pilot_control_scope_changed'", kind: "scope", count: 1, why: "controlled document = pilot scope" },
  { snippet: "principalId = this.options.ownerId, authorization?", kind: "actor", count: 1, why: "commandLocked: default principal is the owner" },
  { snippet: "principalId===p.ownerId&&", kind: "actor", count: 1, why: "pilot owner-only reduction: the acting principal must be the pilot owner" },
  { snippet: "s.ownerId === this.options.ownerId &&", kind: "scope", count: 2, why: "facts filters (the whole line)" },
  { snippet: "s.ownerId === this.options.ownerId && s.scopeRef === this.options.scopeRef,", kind: "scope", count: 1, why: "settlement scope" },
];

it("every ownerId reference in the authority is classified (22 scope, 3 actor = owner-only, 2 type)", () => {
  const lines = readFileSync(new URL("../src/service/authority.ts", import.meta.url), "utf8").split("\n").filter((l) => l.includes("ownerId"));
  const tally = new Map<string, number>(), unclassified: string[] = [], ambiguous: string[] = [];
  for (const l of lines) {
    // An exact (trimmed) line match wins; otherwise the longest matching snippet; a tie is ambiguous.
    const exact = CLASSIFIED.filter((c) => l.trim() === c.snippet.trim());
    const hits = exact.length ? exact : CLASSIFIED.filter((c) => l.includes(c.snippet)).sort((x, y) => y.snippet.length - x.snippet.length);
    if (hits.length === 0) unclassified.push(l.trim());
    else if (hits.length > 1 && hits[0].snippet.length === hits[1].snippet.length) ambiguous.push(l.trim() + "  <- " + hits.map((h) => h.snippet).join(" | "));
    else tally.set(hits[0].snippet, (tally.get(hits[0].snippet) ?? 0) + 1);
  }
  expect(unclassified).toEqual([]);
  expect(ambiguous).toEqual([]);
  for (const c of CLASSIFIED) expect(tally.get(c.snippet) ?? 0, c.snippet).toBe(c.count);
  expect(lines).toHaveLength(27);
  const by = (k: string) => CLASSIFIED.filter((c) => c.kind === k).reduce((n, c) => n + c.count, 0);
  expect([by("scope"), by("actor"), by("type")]).toEqual([22, 3, 2]);
  // The actor lines only ever default to, or compare with, the OWNER: none admits a member principal.
  for (const l of lines.filter((x) => CLASSIFIED.some((c) => c.kind === "actor" && x.includes(c.snippet)))) expect(l).not.toMatch(/member/);
});
