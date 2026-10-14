import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { publicationArtifact, publicationProposal } from "../src/publication/manifest.js";
import { canonical } from "../src/content.js";

// Full canonical fixtures generated from a fresh archive of Operations 265dd408.
// These freeze historical approval bytes, not the new implementation's expectations.
const baseline = JSON.parse(readFileSync(new URL("./publication-compatibility.json", import.meta.url), "utf8")) as {
  base: string;
  cases: Array<{ name: string; manifest: unknown; artifact: unknown; proposal: unknown }>;
};
describe("Operations v1/v2 approval compatibility", () => {
  it.each(baseline.cases)("preserves complete $name artifact and proposal bytes", (entry) => {
    expect(canonical(publicationArtifact(entry.manifest))).toBe(canonical(entry.artifact));
    expect(canonical(publicationProposal(entry.manifest))).toBe(canonical(entry.proposal));
  });
});
