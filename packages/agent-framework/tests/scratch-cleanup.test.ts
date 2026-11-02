// The scratch hygiene setup (tests/setup-scratch.ts) records exactly the dirs this file's mkdtemp calls return.
import { it, expect } from "vitest";
import { mkdtempSync, mkdtemp, existsSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scratchCreated } from "./setup-scratch.js";

it("named, callback and promise mkdtemp are all recorded; nothing else is", async () => {
  const before = scratchCreated().length;
  const a = mkdtempSync(join(tmpdir(), "kscratch-"));
  const b = await new Promise<string>((r, j) => mkdtemp(join(tmpdir(), "kscratch-"), (e, p) => (e ? j(e) : r(p))));
  const c = await fsp.mkdtemp(join(tmpdir(), "kscratch-"));
  writeFileSync(join(a, "f"), "x");
  expect(scratchCreated().slice(before)).toEqual([a, b, c]);
  for (const p of [a, b, c]) expect(existsSync(p)).toBe(true); // removed after this file, not during it
});
