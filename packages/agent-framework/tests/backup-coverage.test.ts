// B1 (Ops BACKUP-COVERAGE-FINDING.md 9e9ba859; brief BRIEF-BACKUP-COVERAGE-B1.md f13f4a58): every directory the runtime writes
// under stateRoot is either backed up or excluded with a reason, and a restore brings the backed-up files back byte-identical
// and readable: a team-task result and a chat image are read from the RESTORED root. Synthetic data.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { BACKED_UP_STATE_DIRS, EXCLUDED_STATE_DIRS, restoreOrgBackup, verifyOrgBackup } from "../src/org/org-backup.js";
import { openOrgRuntime } from "../src/org/org-runtime.js";
import { transcriptionWorld } from "./transcription-world.js";
import type { TeamTaskRun } from "../src/org/teamtasks/store.js";

const decided = (p: string) => (BACKED_UP_STATE_DIRS as readonly string[]).includes(p) || p in EXCLUDED_STATE_DIRS;
const covered = (rel: string) => [...BACKED_UP_STATE_DIRS, ...Object.keys(EXCLUDED_STATE_DIRS)].some((d) => rel === d || rel.startsWith(d + "/"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const files = (dir: string): string[] => !existsSync(dir) ? [] : readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split("\\").join("/"));

it("B1 guard: every state dir the source writes (join(…stateRoot, \"x\"[, \"y\"])) is backed up or excluded with a reason", () => {
  const src = new URL("../src/", import.meta.url).pathname, seen = new Set<string>();
  for (const f of files(src).filter((f) => f.endsWith(".ts"))) {
    for (const m of readFileSync(join(src, f), "utf8").matchAll(/join\(\s*[\w.!]*stateRoot\s*,\s*"([a-z0-9_-]+)"(?:\s*,\s*"([a-z0-9_-]+)")?/g)) {
      const two = m[2] ? `${m[1]}/${m[2]}` : null;
      seen.add(two && decided(two) ? two : m[1]);
    }
  }
  expect([...seen].filter((d) => !decided(d))).toEqual([]);
  for (const d of ["teamtasks", "website", "media/images", "authority", "workers", "newsletter", "media"]) expect(seen.has(d)).toBe(true); // the guard sees them
  for (const r of Object.values(EXCLUDED_STATE_DIRS)) expect(r.length).toBeGreaterThan(10);
});

const DECODER = new URL("../decoder/decode.mjs", import.meta.url).pathname;
const decoderOk = existsSync(new URL("../decoder/node_modules/sharp/package.json", import.meta.url));
const enabled = decoderOk && !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;

describe.skipIf(!enabled)("B1 restore rehearsal", () => {
  it("task result + chat image + website request files: backed up, restored byte-identical, and read from the restored root; excluded dirs stay out", async () => {
    const sharp = createRequire(new URL("../decoder/package.json", import.meta.url))("sharp");
    const w = await transcriptionWorld({ chat: {}, backup: true, teamTasks: true, images: { decoder: { mode: "child", node: process.execPath, script: DECODER, unisolated: true } },
      teamTaskExecutor: { id: "fake-v1", async run(r: TeamTaskRun) { r.writeResult("# Result\nThe cleanup is on Oct 31.\n"); } } });
    let restored: Awaited<ReturnType<typeof openOrgRuntime>> | null = null;
    try {
      const api = (p: string, b: unknown, c = w.alex) => w.post(`/o/exna/api/${p}`, b, c);
      // A team task to Result ready.
      const t = (await api("teamtask/create", { clientRequestId: "req-" + randomUUID().slice(0, 8), title: "Backup rehearsal" })).result;
      const p = (await api("teamtask/propose", { taskId: t.taskId, expectedRevision: 1 })).result;
      expect((await w.act(w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest)).ok).toBe(true);
      let a: any;
      for (let i = 0; i < 400; i++) { a = (await api("teamtask/read", { taskId: t.taskId })).result.attempts[0]; if (a.state === "result_ready") break; await new Promise((r) => setTimeout(r, 25)); }
      expect(a.state).toBe("result_ready");
      const resultId = (await api("teamtask/read", { taskId: t.taskId })).result.attempts[0].report.resultId;
      // A chat image.
      const conv = (await api("chat/conversation/create", {})).result.conversationId;
      const jpg = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 40, g: 120, b: 200 } } }).jpeg().toBuffer();
      const up = (await api("image/upload", { conversationId: conv, size: jpg.length, contentType: "image/jpeg" })).result;
      const s = w.org.sqlite.db.prepare("SELECT member_id, session_ref FROM image_uploads WHERE upload_id=?").get(up.uploadId) as any;
      const im = { memberId: s.member_id, role: "contributor", sessionRef: s.session_ref };
      const img = await w.org.images!.put(up.uploadId, im, Readable.from([jpg]), { size: jpg.length, contentType: "image/jpeg" });
      // LIBRARY L1: the same image saved to the shared drive (stateRoot/library), backed up from day one.
      const drv = (await api("image/drive/save", { imageId: img.imageId, name: "Rehearsal" })).result;
      // A pending website request's files (format-agnostic: the dir is what is backed up), and the excluded dirs' kinds of files.
      const st = w.cfg.stateRoot;
      for (const [d, f] of [["website/wr_rehearsal", "flyer-source.jpg"], ["media/images/quarantine", "in-flight.bin"], ["media/job_rehearsal", "audio.webm"], ["workers/run_x", "journal.json"], ["newsletter", "sent.json"]]) {
        mkdirSync(join(st, d), { recursive: true }); writeFileSync(join(st, d, f), "synthetic " + d);
      }
      // Every file the runtime holds now is in a decided dir.
      expect(files(st).filter((f) => !covered(f))).toEqual([]);
      const r = await w.ops("/ops/backup/now");
      expect(r.ok).toBe(true);
      const setName = readdirSync(join(w.base, "backups")).filter((n) => n.startsWith("exna-")).sort().at(-1)!, setDir = join(w.base, "backups", setName);
      const set = JSON.parse(readFileSync(join(setDir, "set.json"), "utf8"));
      const paths: string[] = set.files.map((f: any) => f.path);
      for (const d of ["teamtasks", "website", "media/images", "library"]) expect(paths.some((x) => x.startsWith(`state/${d}/`))).toBe(true);
      expect(paths.filter((x) => /^state\/(media\/images\/quarantine|media\/job_|workers|authority)\//.test(x))).toEqual([]);
      expect(paths).toContain("state/newsletter/sent.json"); // backed up, not derived (Fable B1 note (b))
      // Note (a): transcription audio is excluded because its product, the transcript, lands in the (backed-up) folder.
      expect(w.org.transcription.jobs!.dir.startsWith(w.cfg.folder + "/")).toBe(true);
      // B-4: verify re-hashes the set in place, with files per directory.
      const v = verifyOrgBackup(setDir, "exna");
      expect(v.perDir).toMatchObject({ teamtasks: expect.any(Number), "media/images": 1, website: 1, newsletter: 1 });
      expect(v.perDir.teamtasks).toBeGreaterThan(0);
      // B-5: the Ops status coverage line: live == in the newest set per dir right after the backup; nothing unclassified.
      const cov = (await w.ops("/ops/status")).backup.coverage;
      expect(cov).toMatchObject({ latestSet: setName, unclassified: [] });
      for (const d of cov.dirs) expect([d.dir, d.live]).toEqual([d.dir, d.inSet]);
      expect(cov.dirs.map((d: any) => d.dir).sort()).toEqual([...BACKED_UP_STATE_DIRS, "folder"].sort());
      // A file written after the set shows as live > inSet; an unclassified dir is named.
      mkdirSync(join(st, "zz_new_feature")); writeFileSync(join(st, "website/wr_rehearsal/later.txt"), "later");
      const cov2 = (await w.ops("/ops/status")).backup.coverage;
      expect(cov2.unclassified).toEqual(["zz_new_feature"]);
      expect(cov2.dirs.find((d: any) => d.dir === "website")).toEqual({ dir: "website", live: 2, inSet: 1 });
      rmSync(join(st, "zz_new_feature"), { recursive: true }); rmSync(join(st, "website/wr_rehearsal/later.txt"));
      // Every live file under a backed-up dir is in the set, with the same bytes (nothing was written during the walk).
      const live = files(st).filter((f) => BACKED_UP_STATE_DIRS.some((d) => f.startsWith(d + "/")) && !f.startsWith("media/images/quarantine/"));
      expect(paths.filter((x) => x.startsWith("state/")).map((x) => x.slice(6)).sort()).toEqual(live.sort());
      // Restore into a scratch root: byte-identical, and the restored runtime reads the task result and the image.
      const newRoot = join(w.base, "restored"), rr = restoreOrgBackup(setDir, newRoot, "exna");
      for (const f of set.files) expect(sha(readFileSync(join(newRoot, f.path)))).toBe(f.sha256);
      for (const f of live) expect(sha(readFileSync(join(rr.stateRoot, f)))).toBe(sha(readFileSync(join(st, f))));
      const { backup: _b, ...rest } = w.cfg as any;
      restored = await openOrgRuntime({ ...rest, stateRoot: rr.stateRoot, folder: rr.folder, accessSocket: rr.accessSocket, opsSocket: rr.opsSocket });
      const creator = restored.sqlite.db.prepare("SELECT member_id FROM image_uploads WHERE upload_id=?").get(up.uploadId) as any;
      expect(creator.member_id).toBe(im.memberId);
      expect(restored.teamTasks!.result({ memberId: im.memberId, role: "contributor" }, { taskId: t.taskId, resultId })).toMatchObject({ text: "# Result\nThe cleanup is on Oct 31.\n" });
      expect(restored.images!.read(im, { imageId: img.imageId }).sha256).toBe(img.sha256);
      expect(readFileSync(join(rr.stateRoot, "library", drv.sha256 + ".jpg")).equals(readFileSync(join(st, "library", drv.sha256 + ".jpg")))).toBe(true);
    } finally { await restored?.close(); await w.close(); }
  }, 120_000);
});
