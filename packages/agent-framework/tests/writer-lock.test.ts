// Writer lock: single-writer guarantee that heals itself after a crash or a
// reboot instead of crash-looping under a restarting process supervisor.
//
// Production history (2026-10-01 .. 2026-10-06): both Framework stores kept a
// bare-pid `writer.lock` (pid 907) after the owning process died; the machine
// later rebooted; every KeepAlive start then failed with EEXIST (10,764 times)
// until an administrator ran an offline recovery. These tests pin the repaired
// contract:
//   - a lock whose owner is PROVABLY gone is reclaimed automatically and its
//     bytes are quarantined next to it (never silently deleted);
//   - a lock whose owner may be alive is still refused;
//   - a lock file that is not ours / not private is refused, not reclaimed.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, chmodSync, utimesSync, symlinkSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { acquireWriterLock, releaseWriterLock, recoverDeadWriterLock, readWriterLock, currentBootId, currentBootTimeSec } from "../src/worker/writer-lock.js";

function root() {
  const r = realpathSync(mkdtempSync(join(tmpdir(), "writer-lock-")));
  chmodSync(r, 0o700);
  return r;
}
function staleEntries(r: string) {
  return readdirSync(r).filter((n) => n.startsWith("writer.lock.stale-"));
}
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid!;
  await once(child, "exit");
  return pid;
}
const alive = () => true;
const dead = () => false;

describe("acquireWriterLock", () => {
  it("writes pid and boot id, and release removes the file", () => {
    const r = root();
    try {
      const lock = acquireWriterLock(r);
      const parsed = readWriterLock(join(r, "writer.lock"));
      expect(parsed).toEqual({ pid: process.pid, bootId: currentBootId(), legacy: false });
      expect(statSync(lock.path).mode & 0o077).toBe(0);
      releaseWriterLock(lock);
      expect(existsSync(lock.path)).toBe(false);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it("refuses a lock whose owner is alive in this boot and leaves it untouched", () => {
    const r = root();
    try {
      const first = acquireWriterLock(r);
      const bytes = readFileSync(first.path);
      expect(() => acquireWriterLock(r)).toThrow("worker_lock_held");
      expect(readFileSync(first.path)).toEqual(bytes);
      expect(staleEntries(r)).toEqual([]);
      releaseWriterLock(first);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it("reclaims a same-boot lock whose pid no longer exists and quarantines the stale bytes", async () => {
    const r = root();
    try {
      const pid = await deadPid();
      const stale = `${pid}\n${currentBootId()}\n`;
      writeFileSync(join(r, "writer.lock"), stale, { mode: 0o600 });
      const lock = acquireWriterLock(r);
      expect(readWriterLock(lock.path).pid).toBe(process.pid);
      const q = staleEntries(r);
      expect(q).toHaveLength(1);
      expect(readFileSync(join(r, q[0]), "utf8")).toBe(stale);
      releaseWriterLock(lock);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it("reclaims a lock written in a different boot even if that pid is alive now (pid reuse across reboot)", () => {
    const r = root();
    try {
      writeFileSync(join(r, "writer.lock"), `${process.pid}\nboot-from-a-previous-life\n`, { mode: 0o600 });
      const lock = acquireWriterLock(r, { isAlive: alive });
      expect(readWriterLock(lock.path).bootId).toBe(currentBootId());
      expect(staleEntries(r)).toHaveLength(1);
      releaseWriterLock(lock);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it("reclaims a legacy bare-pid lock whose mtime predates the current boot, regardless of pid liveness", () => {
    const r = root();
    try {
      const path = join(r, "writer.lock");
      writeFileSync(path, "907", { mode: 0o600 });
      const before = 1_000_000; // seconds; injected boot time is later
      utimesSync(path, before, before);
      const lock = acquireWriterLock(r, { isAlive: alive, bootTimeSec: () => before + 5000 });
      expect(readWriterLock(lock.path).legacy).toBe(false);
      const q = staleEntries(r);
      expect(q).toHaveLength(1);
      expect(readFileSync(join(r, q[0]), "utf8")).toBe("907");
      releaseWriterLock(lock);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it("refuses a legacy bare-pid lock from this boot while that pid is alive", () => {
    const r = root();
    try {
      const path = join(r, "writer.lock");
      writeFileSync(path, String(process.pid), { mode: 0o600 });
      expect(() => acquireWriterLock(r, { bootTimeSec: () => 0 })).toThrow("worker_lock_held");
      expect(readFileSync(path, "utf8")).toBe(String(process.pid));
      expect(staleEntries(r)).toEqual([]);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it("reclaims a legacy bare-pid lock from this boot once that pid is gone", async () => {
    const r = root();
    try {
      const pid = await deadPid();
      writeFileSync(join(r, "writer.lock"), String(pid), { mode: 0o600 });
      const lock = acquireWriterLock(r, { bootTimeSec: () => 0 });
      expect(readWriterLock(lock.path).pid).toBe(process.pid);
      releaseWriterLock(lock);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it("never reclaims a lock that is not a private regular file owned by us", () => {
    const r = root();
    try {
      const path = join(r, "writer.lock");
      writeFileSync(path, "1\nother-boot\n", { mode: 0o644 });
      // writeFileSync mode is masked by the inherited umask (077 yields 0600); set it explicitly.
      chmodSync(path, 0o644);
      expect(statSync(path).mode & 0o777).toBe(0o644);
      expect(() => acquireWriterLock(r, { isAlive: dead })).toThrow("worker_lock_unsafe");
      expect(existsSync(path)).toBe(true);
      rmSync(path);
      writeFileSync(join(r, "target"), "1\nother-boot\n", { mode: 0o600 });
      symlinkSync(join(r, "target"), path);
      expect(() => acquireWriterLock(r, { isAlive: dead })).toThrow("worker_lock_unsafe");
      expect(staleEntries(r)).toEqual([]);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it("refuses unparseable lock contents instead of guessing", () => {
    const r = root();
    try {
      writeFileSync(join(r, "writer.lock"), "not-a-pid", { mode: 0o600 });
      expect(() => acquireWriterLock(r, { isAlive: dead })).toThrow("worker_lock_unreadable");
      expect(staleEntries(r)).toEqual([]);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it("still defers to an explicit recovery in progress", () => {
    const r = root();
    try {
      writeFileSync(join(r, "recovery.lock"), String(process.pid), { mode: 0o600 });
      expect(() => acquireWriterLock(r)).toThrow("worker_lock_recovery_in_progress");
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it("after one process reclaims a stale lock, a second acquirer is refused (no double writer)", async () => {
    const r = root();
    try {
      writeFileSync(join(r, "writer.lock"), `${await deadPid()}\n${currentBootId()}\n`, { mode: 0o600 });
      const winner = acquireWriterLock(r);
      expect(() => acquireWriterLock(r)).toThrow("worker_lock_held");
      expect(staleEntries(r)).toHaveLength(1);
      releaseWriterLock(winner);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });

  it("the boot identity helpers return stable non-empty values on this platform", () => {
    expect(currentBootId()).toBe(currentBootId());
    expect(currentBootId().length).toBeGreaterThan(0);
    const t = currentBootTimeSec();
    expect(t === null || (Number.isFinite(t) && t > 0)).toBe(true);
  });
});

describe("recoverDeadWriterLock (explicit path kept for operators)", () => {
  it("accepts the two-line lock format for a dead pid and still refuses a live one", async () => {
    const r = root();
    try {
      const pid = await deadPid();
      writeFileSync(join(r, "writer.lock"), `${pid}\n${currentBootId()}\n`, { mode: 0o600 });
      expect(() => recoverDeadWriterLock(r, pid + 1)).toThrow("worker_recovery_lock_mismatch");
      recoverDeadWriterLock(r, pid);
      expect(existsSync(join(r, "writer.lock"))).toBe(false);
      const mine = acquireWriterLock(r);
      expect(() => recoverDeadWriterLock(r, process.pid)).toThrow("worker_writer_not_proven_dead");
      releaseWriterLock(mine);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });
});

describe("nested state roots", () => {
  it("works for a root created with restrictive mode by the caller", () => {
    const r = root();
    try {
      const nested = join(r, "native");
      mkdirSync(nested, { mode: 0o700 });
      const lock = acquireWriterLock(nested);
      releaseWriterLock(lock);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });
});

it('serializes competing reclaimers in the stale-observation window',()=>{
 const r=root();let competitor:any;let blocked=false;
 try{
  writeFileSync(join(r,'writer.lock'),'424242\n'+currentBootId()+'\n',{mode:0o600});
  const winner=acquireWriterLock(r,{isAlive:()=>{
   try {competitor=acquireWriterLock(r,{isAlive:()=>false});}
   catch(error){expect(String(error)).toContain('worker_lock_recovery_in_progress');blocked=true;}
   return false;
  }});
  expect(blocked).toBe(true);expect(competitor).toBeUndefined();
  expect(readWriterLock(winner.path).pid).toBe(process.pid);
  expect(staleEntries(r)).toHaveLength(1);
  expect(()=>acquireWriterLock(r)).toThrow('worker_lock_held');releaseWriterLock(winner);
 }finally{rmSync(r,{recursive:true,force:true});}
});
it('fails closed on an orphan acquisition guard',()=>{
 const r=root();try{
  writeFileSync(join(r,'recovery.lock'),'424242',{mode:0o600});
  expect(()=>acquireWriterLock(r,{isAlive:()=>false})).toThrow('worker_lock_recovery_in_progress');
  expect(readFileSync(join(r,'recovery.lock'),'utf8')).toBe('424242');
 }finally{rmSync(r,{recursive:true,force:true});}
});

it('a separate process cannot enter reclaim while the first process has observed the stale owner',()=>{
 const r=root();try{
  writeFileSync(join(r,'writer.lock'),'424242\n'+currentBootId()+'\n',{mode:0o600});
  let result='';const winner=acquireWriterLock(r,{isAlive:()=>{
   const code=`const m=await import(process.argv[1]);try{const l=m.acquireWriterLock(process.argv[2],{isAlive:()=>false});console.log('ACQUIRED');m.releaseWriterLock(l);}catch(e){console.log(e.message);}`;
   result=execFileSync(process.execPath,['--import',process.env.KAPELLE_WORKER_HOST_TSX!,'--input-type=module','-e',code,new URL('../src/worker/writer-lock.ts',import.meta.url).href,r],{encoding:'utf8',timeout:10000}).trim();
   return false;
  }});
  expect(result).toBe('worker_lock_recovery_in_progress');expect(staleEntries(r)).toHaveLength(1);
  releaseWriterLock(winner);
 }finally{rmSync(r,{recursive:true,force:true});}
});
