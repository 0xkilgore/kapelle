import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { PublicationProjectHold } from "../src/publication/project-hold.js";
import { dispatchIntent } from "../src/publication/effects.js";
import { publicationFixture } from "./publication-fixtures.js";
import {digest} from "../src/content.js";

const target = { teamId: "team_synthetic", projectId: "prj_synthetic", deploymentId: "dpl_new" };
const binding = { intent: dispatchIntent("review", "publisher", publicationFixture("dpl_new").m),
  operationId: "operation", dispatchRef: "dispatch", outboxRef: "outbox" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "publication-hold-")), path = join(root, "journal.sqlite");
  const a = new DatabaseSync(path), b = new DatabaseSync(path);
  return { path, a, b, hold: new PublicationProjectHold(a, "host", target),
    other: new PublicationProjectHold(b, "host", target),
    close() { a.close(); b.close(); rmSync(root, { recursive: true, force: true }); } };
}
describe("Durable publication project admission", () => {
  it("releases only with exact settlement and native observation, preserves tombstones and admits a new operation",async()=>{
    const f=fixture();
    const proof={contract:"kapelle/publication-settlement/v1" as const,operationId:binding.operationId,
      bindingHash:digest(binding),...target,outcome:"COMPLETED" as const,proofRef:"terminal:one",proofHash:digest("immutable terminal request proof")};
    try{
      await f.hold.withOperation(binding,async()=>{
        expect(()=>f.hold.settle(binding,proof,"native",()=>{})).toThrow(/observation/);
        f.hold.observe(binding,"native");
        for(const bad of [{...proof,operationId:"other"},{...proof,bindingHash:digest("other")},{...proof,deploymentId:"other"},{...proof,proofHash:"bytes matched"}])
          expect(()=>f.hold.settle(binding,bad,"native",()=>{})).toThrow(/proof differs/);
        expect(()=>f.hold.settle(binding,proof,"native",()=>{throw Error("atomic failure");})).toThrow(/atomic failure/);
        expect(f.hold.status(binding).held).toBe(true);
        f.hold.settle(binding,proof,"native",()=>{});
      });
      expect(f.other.status(binding)).toMatchObject({held:false,requestSettlement:"COMPLETED",proofRef:"terminal:one"});
      await expect(f.other.withOperation(binding,async()=>{})).rejects.toThrow(/settled/);
      const next={...binding,operationId:"next",dispatchRef:"dispatch-next",outboxRef:"outbox-next"};
      await f.other.withOperation(next,async()=>f.other.assertOwned(next));
      expect(f.other.status(next).held).toBe(true);
      expect(f.hold.status(binding).held).toBe(false);
      expect(f.a.prepare("SELECT hold_json,proof_json FROM publication_settled_holds").all()).toHaveLength(1);
    }finally{f.close();}
  });
  it("serializes independent connections and rejects borrowed invocation context", async () => {
    const f = fixture();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => entered = resolve);
    const stop = new Promise<void>((resolve) => release = resolve);
    const running = f.hold.withOperation(binding, async () => {
      f.hold.assertOwned(binding); entered(); await stop;
    });
    try {
      await ready;
      expect(() => f.hold.assertOwned(binding)).toThrow(/guard required/);
      await expect(f.other.withOperation(binding, async () => {})).rejects.toThrow(/busy/);
      await expect(f.other.withOperation({ ...binding, operationId: "other" }, async () => {}))
        .rejects.toThrow(/Project held/);
      release(); await running;
      await f.other.withOperation(binding, async () => f.other.observe(binding, "evidence"));
      expect(f.other.status(binding)).toEqual({ held: true, requestSettlement: "UNPROVEN", observations: ["evidence"] });
      await expect(f.other.withOperation({ ...binding, operationId: "other" }, async () => {}))
        .rejects.toThrow(/Project held/);
      expect(f.a.prepare("SELECT state FROM publication_project_runs").all().map(r => r.state))
        .toEqual(["FINISHED", "FINISHED"]);
    } finally { release(); await running; f.close(); }
  });
  it("retains holds on exceptions, across restart, without age-based release or cross-host adoption", async () => {
    const f = fixture();
    try {
      await expect(f.hold.withOperation(binding, async () => { throw Error("interrupted"); }))
        .rejects.toThrow(/interrupted/);
      f.a.prepare("UPDATE publication_project_holds SET created_at='2000-01-01T00:00:00.000Z'").run();
      const restarted = new PublicationProjectHold(f.b, "host", target);
      expect(restarted.status(binding).held).toBe(true);
      await expect(restarted.withOperation({ ...binding, operationId: "new" }, async () => {}))
        .rejects.toThrow(/Project held/);
      expect(() => new PublicationProjectHold(f.b, "different-host", target)).toThrow(/installation differs/);
    } finally { f.close(); }
  });
  it.each(["unsettled-contact", "observed-contact", "precontact-claim"])(
    "refuses automatic adoption of a legacy %s journal", (kind) => {
      const db = new DatabaseSync(":memory:");
      try {
        if (kind === "precontact-claim") {
          db.exec("CREATE TABLE commands(id TEXT,body TEXT)");
          db.prepare("INSERT INTO commands VALUES (?,?)")
            .run("claim", JSON.stringify({ command: { type: "CLAIM_EXECUTION" } }));
        } else {
          db.exec("CREATE TABLE publication_provider_contacts(settled INTEGER)");
          db.prepare("INSERT INTO publication_provider_contacts VALUES (?)").run(kind === "observed-contact" ? 1 : 0);
        }
        expect(() => new PublicationProjectHold(db, "host", target)).toThrow(/Legacy/);
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name='publication_hold_installation'").get()).toBeUndefined();
      } finally { db.close(); }
    },
  );
  it("blocks a live independent process, then recovers only its run after SIGKILL, retaining the project hold", async () => {
    const f = fixture();
    // Execute actual hold code in a separate OS process. No mocked PID or clock.
    const compiled = join(dirname(f.path), "project-hold.mjs");
    writeFileSync(compiled, buildSync({
      entryPoints: [join(process.cwd(), "src/publication/project-hold.ts")],
      bundle: true, platform: "node", format: "esm", write: false,
    }).outputFiles[0].text);
    const source = pathToFileURL(compiled).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from 'node:sqlite';
      import { PublicationProjectHold } from ${JSON.stringify(source)};
      const db = new DatabaseSync(${JSON.stringify(f.path)});
      const hold = new PublicationProjectHold(db, 'host', ${JSON.stringify(target)});
      await hold.withOperation(${JSON.stringify(binding)}, async () => {
        process.stdout.write('HELD\\n');
        await new Promise(() => setInterval(() => {}, 1000));
      });
    `], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => stderr += chunk);
    try {
      const signal = await Promise.race([
        once(child.stdout, "data").then(([chunk]) => String(chunk)),
        once(child, "exit").then(() => { throw Error("Child exited: " + stderr); }),
      ]);
      expect(signal).toContain("HELD");
      await expect(f.other.withOperation(binding, async () => {})).rejects.toThrow(/busy/);
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      await expect(f.other.withOperation({ ...binding, operationId: "other" }, async () => {}))
        .rejects.toThrow(/Project held/);
      await f.other.withOperation(binding, async () => f.other.assertOwned(binding));
      expect(f.other.status(binding).held).toBe(true);
      expect(f.a.prepare("SELECT state FROM publication_project_runs ORDER BY started_at").all().map(r => r.state))
        .toEqual(["PROCESS_EXITED", "FINISHED"]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      }
      f.close();
    }
  }, 20_000);
});
