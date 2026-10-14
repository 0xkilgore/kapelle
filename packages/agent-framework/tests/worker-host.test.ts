import { it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, unlinkSync, cpSync, rmSync, readdirSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const reactorRoot = process.env.KAPELLE_SCOPED_REACTOR_ROOT;
const loader = process.env.KAPELLE_WORKER_HOST_TSX;
const credential = "synthetic-host-test-credential-0123456789";
const auth = { authorization: `Bearer ${credential}`, "content-type": "application/json" };
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

it.skipIf(!reactorRoot || !loader)("host entry point preserves native identity through stop, crash and offline restore", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "framework-host-test-")));
  const state = join(root, "state"), backup = join(root, "backup"), restored = join(root, "restored");
  const profile = join(root, "profile.json"), tokenFile = join(root, "token.txt");
  writeFileSync(profile, JSON.stringify({ ownerId: "synthetic-owner", scopeRef: "synthetic-scope", expiresAt: "2099-01-01T00:00:00.000Z", documentIds: [], releases: [], bindings: [] }), { mode: 0o600 });
  writeFileSync(tokenFile, credential, { mode: 0o600 });
  const authorityPort = await freePort();
  let workerPort = await freePort();
  while (workerPort === authorityPort) workerPort = await freePort();
  const origin = `http://127.0.0.1:${authorityPort}`;
  const children: ChildProcess[] = [];
  const outputs = new Map<ChildProcess, string>();
  const exits = new Map<ChildProcess, Promise<unknown>>();
  function start(stateRoot = state) {
    const child = spawn(process.execPath, ["--import", loader!, fileURLToPath(new URL("../src/worker/serve.ts", import.meta.url))], {
      env: {
        PATH: process.env.PATH, TMPDIR: tmpdir(),
        KAPELLE_FRAMEWORK_OWNER: "synthetic-owner", KAPELLE_FRAMEWORK_SCOPE: "synthetic-scope",
        KAPELLE_FRAMEWORK_STATE_ROOT: stateRoot, KAPELLE_FRAMEWORK_PROFILE: profile,
        KAPELLE_SCOPED_REACTOR_ROOT: reactorRoot,
        KAPELLE_FRAMEWORK_SOURCE_URL: "http://127.0.0.1:1",
        KAPELLE_FRAMEWORK_SOURCE_TOKEN_FILE: tokenFile,
        KAPELLE_FRAMEWORK_AUTHORITY_TOKEN_FILE: tokenFile,
        KAPELLE_FRAMEWORK_WORKER_TOKEN_FILE: tokenFile,
        KAPELLE_FRAMEWORK_AUTHORITY_PORT: String(authorityPort), KAPELLE_FRAMEWORK_WORKER_PORT: String(workerPort),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child); outputs.set(child, "");
    exits.set(child, once(child, "exit"));
    for (const stream of [child.stdout!, child.stderr!]) stream.on("data", data => outputs.set(child, (outputs.get(child)! + data).slice(-4000)));
    return child;
  }
  async function ready(child: ChildProcess) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw Error(`Host exited: ${outputs.get(child)}`);
      try {
        const response = await fetch(`${origin}/health`, { headers: auth, signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch { /* Starting the synthetic host. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(`Host did not start: ${outputs.get(child)}`);
  }
  async function stop(child: ChildProcess, signal: NodeJS.Signals) {
    child.kill(signal);
    await Promise.race([exits.get(child), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("Host did not stop")), 10000); timer.unref(); })]);
  }
  const allocation = { operationId: "synthetic-allocation", documentType: "kapelle/agent-instance", name: "Synthetic paused allocation" };
  function offlineCopy(source: string, target: string) {
    cpSync(source, target, { recursive: true });
    // Node's recursive copy creates directories using the process umask.
    // Restore the original private modes before opening the copied authority.
    function restoreModes(from: string, to: string) {
      chmodSync(to, statSync(from).mode & 0o777);
      for (const entry of readdirSync(from, { withFileTypes: true }))
        if (entry.isDirectory()) restoreModes(join(from, entry.name), join(to, entry.name));
    }
    restoreModes(source, target);
  }
  async function allocate(operationId = allocation.operationId) {
    const response = await fetch(`${origin}/allocate`, { method: "POST", headers: auth, body: JSON.stringify({ ...allocation, operationId }) });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ documentId: string }>;
  }
  try {
    let host = start(); await ready(host);
    expect((await fetch(`${origin}/health`)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${workerPort}/status`, { headers: auth })).status).toBe(200);
    const first = await allocate();
    expect(first.documentId).toBeTruthy();
    const duplicate = start();
    await Promise.race([exits.get(duplicate), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("Duplicate writer was not rejected")), 10000); timer.unref(); })]);
    expect(duplicate.exitCode).not.toBe(0);
    expect(readFileSync(join(state, "native/writer.lock"), "utf8").split("\n")[0]).toBe(String(host.pid));
    await stop(host, "SIGTERM");
    expect(host.exitCode).toBe(0);
    expect(existsSync(join(state, "native/writer.lock"))).toBe(false);
    expect(existsSync(join(state, "worker/writer.lock"))).toBe(false);
    offlineCopy(state, backup);
    host = start(); await ready(host);
    expect((await allocate()).documentId).toBe(first.documentId);
    const beforeCrash = await allocate("accepted-before-crash");
    await stop(host, "SIGKILL");
    expect(host.signalCode).toBe("SIGKILL");
    // Contract change (2026-10-07): the killed owner's locks stay on disk with its pid, the owner is
    // provably gone, and the next start reclaims them on its own (quarantining the stale bytes)
    // instead of crash-looping under a process supervisor. A live owner is still refused (duplicate case above).
    const crashed = host.pid!;
    expect(() => process.kill(crashed, 0)).toThrow();
    for (const name of ["native", "worker"])
      expect(readFileSync(join(state, name, "writer.lock"), "utf8").split("\n")[0]).toBe(String(crashed));
    host = start(); await ready(host);
    for (const name of ["native", "worker"]) {
      const quarantined = readdirSync(join(state, name)).filter((n) => n.startsWith("writer.lock.stale-"));
      expect(quarantined).toHaveLength(1);
      expect(readFileSync(join(state, name, quarantined[0]), "utf8").split("\n")[0]).toBe(String(crashed));
      expect(readFileSync(join(state, name, "writer.lock"), "utf8").split("\n")[0]).toBe(String(host.pid));
    }
    expect((await allocate()).documentId).toBe(first.documentId);
    expect((await allocate("accepted-before-crash")).documentId).toBe(beforeCrash.documentId);
    await stop(host, "SIGTERM");
    offlineCopy(backup, restored);
    host = start(restored); await ready(host);
    expect((await allocate()).documentId).toBe(first.documentId);
    await stop(host, "SIGTERM");
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await stop(child, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);
