// Disk hygiene (Director, 2026-10-16: ~19k leftover scratch dirs, ~45 GB). Every temp directory a test file creates with
// fs.mkdtemp / mkdtempSync / promises.mkdtemp in THIS worker is recorded, and removed after that file's tests (the last
// afterAll, after the file's own hooks closed its runtimes). Only the exact paths mkdtemp returned are removed: no globbing,
// no sweep of shared temp, nothing created by another process. KEEP_WORLD=1 keeps everything (debugging a harness world).
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, isAbsolute } from "node:path";
import { afterAll } from "vitest";

const created: string[] = [];
const record = (p: unknown) => { if (typeof p === "string" && isAbsolute(p) && /[A-Za-z0-9]{6}$/.test(basename(p))) created.push(p); return p; };
const sync = fs.mkdtempSync, cb = fs.mkdtemp, pr = fs.promises.mkdtemp;
fs.mkdtempSync = ((...a: Parameters<typeof sync>) => record(sync(...a))) as typeof sync;
fs.mkdtemp = ((prefix: string, ...rest: any[]) => { const done = rest.pop(); return (cb as any)(prefix, ...rest, (e: unknown, p: string) => { if (!e) record(p); done(e, p); }); }) as typeof cb;
fs.promises.mkdtemp = (async (...a: Parameters<typeof pr>) => record(await pr(...a))) as typeof pr;
syncBuiltinESMExports();

export const scratchCreated = () => [...created];
afterAll(() => {
  if (process.env.KEEP_WORLD === "1") return;
  for (const p of created.splice(0).reverse()) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a busy socket dir: best effort */ } }
});
