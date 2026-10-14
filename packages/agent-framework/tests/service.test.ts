import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFrameworkRuntime } from "../src/service/runtime.js";
import { frameworkHandler } from "../src/service/http.js";
import { context, release, policy } from "./fixtures.js";
import type { Facts } from "../src/service/authority.js";
import type { NativeDocument, ModelType } from "../src/command-boundary.js";
const reactorRoot = process.env.KAPELLE_SCOPED_REACTOR_ROOT;
async function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), "kapelle-native-framework-"));
  const ctx = context();
  let facts: Facts = { ...ctx };
  const options = {
    stateRoot,
    reactorRoot: reactorRoot!,
    ownerId: "owner",
    scopeRef: "synthetic-league",
    facts: async () => facts,
    now: () => ctx.occurredAt,
  };
  let runtime = await openFrameworkRuntime(options),
    token = "synthetic-owner-credential-0123456789";
  let server = createServer(frameworkHandler(runtime.authority, () => token));
  async function listen() {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  let url = await listen();
  async function http(
    path: string,
    body?: unknown,
    credential = token,
    headers: Record<string, string> = {},
  ) {
    const r = await fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + credential,
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as any };
  }
  let op = 0;
  async function allocate(type: ModelType) {
    const r = await http("/allocate", {
      operationId: `allocation-${op++}`,
      documentType: type,
      name: "Synthetic native qualification",
    });
    expect(r.status).toBe(200);
    return r.body.documentId as string;
  }
  async function read(id: string, type: ModelType) {
    const r = await http(`/documents/${id}?type=${encodeURIComponent(type)}`);
    expect(r.status).toBe(200);
    return r.body.document as NativeDocument;
  }
  async function command(
    id: string,
    type: ModelType,
    action: string,
    input: Record<string, unknown>,
    operationId = `command-${op++}`,
  ) {
    const d = await read(id, type);
    const request = {
      operationId,
      documentId: id,
      documentType: type,
      expectedRevision: d.state.global.revision,
      type: action,
      input,
    };
    return { ...(await http("/commands", request)), request };
  }
  async function provision() {
    const definition = await allocate("kapelle/agent-definition");
    expect(
      (
        await command(definition, "kapelle/agent-definition", "PUBLISH_DEFINITION", {
          release: release(),
        })
      ).body.result.disposition,
    ).toBe("ACCEPTED");
    expect((await read(definition, "kapelle/agent-definition")).state.global).toMatchObject({
      release: release(),
    });
    const instance = await allocate("kapelle/agent-instance");
    const r = release();
    expect(
      (
        await command(instance, "kapelle/agent-instance", "CREATE_INSTANCE", {
          instanceId: instance,
          scopeRef: ctx.scopeRef,
          definitionRef: {
            id: r.definitionId,
            version: r.packageVersion,
            contentHash: r.contentHash,
          },
          name: "Synthetic scoped reviewer",
          responsibilities: ["Review supplied document"],
          operatingPolicy: "Read only",
          modelPolicy: policy,
        })
      ).body.result.disposition,
    ).toBe("ACCEPTED");
    expect(
      (
        await command(instance, "kapelle/agent-instance", "SET_RUNTIME_BINDING", {
          runtimeBindingRef: "local-adapter",
        })
      ).body.result.disposition,
    ).toBe("ACCEPTED");
    expect(
      (
        await command(instance, "kapelle/agent-instance", "GRANT_CAPABILITY", {
          grant: {
            id: "read-source",
            principalId: instance,
            resourceRef: "contracts",
            actions: ["read"],
            expiresAt: "2026-09-11T12:00:00.000Z",
            reviewPolicy: "ALWAYS",
          },
        })
      ).body.result.disposition,
    ).toBe("ACCEPTED");
    expect(
      (await command(instance, "kapelle/agent-instance", "REQUEST_RESUME", {})).body.result
        .disposition,
    ).toBe("ACCEPTED");
    return instance;
  }
  return {
    http,
    allocate,
    read,
    command,
    provision,
    ctx,
    get url() {
      return url;
    },
    get token() {
      return token;
    },
    get runtime() {
      return runtime;
    },
    setFacts(f: Facts) {
      facts = f;
    },
    rotate() {
      token = "synthetic-rotated-credential-0123456789";
    },
    async restart() {
      await new Promise<void>((r) => server.close(() => r()));
      await runtime.close();
      runtime = await openFrameworkRuntime(options);
      server = createServer(frameworkHandler(runtime.authority, () => token));
      url = await listen();
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await runtime.close();
      rmSync(stateRoot, { recursive: true, force: true });
    },
  };
}
describe.skipIf(!reactorRoot)(
  "Authenticated scoped native authority with real Reactor storage",
  () => {
    it("provisions a pinned native instance, checks read grants, and blocks paused or revoked work", async () => {
      const f = await fixture();
      try {
        expect((await f.http("/instances", undefined, "wrong")).status).toBe(403);
        const id = await f.provision(),
          source = {
            instanceId: id,
            documentId: "contracts",
            revision: 7,
            contentHash: f.ctx.resources[0].contentHash,
          };
        expect((await f.http("/admission", source)).body.admission.instanceId).toBe(id);
        await f.command(id, "kapelle/agent-instance", "REQUEST_PAUSE", {});
        expect((await f.http("/admission", source)).status).toBe(409);
        await f.command(id, "kapelle/agent-instance", "REQUEST_RESUME", {});
        await f.command(id, "kapelle/agent-instance", "REVOKE_CAPABILITY", {
          grantId: "read-source",
        });
        expect((await f.http("/admission", source)).body.error).toContain("grant");
        expect((await f.http("/instances")).body.items).toHaveLength(1);
      } finally {
        await f.close();
      }
    }, 30000);
    it("recovers exact native receipt after commit succeeds but its response is lost, then survives full database restart", async () => {
      const f = await fixture();
      try {
        const id = await f.provision();
        const original = f.runtime.authority.backend.commit.bind(f.runtime.authority.backend);
        let lose = true;
        f.runtime.authority.backend.commit = async (...args) => {
          const r = await original(...args);
          if (lose) {
            lose = false;
            throw Error("synthetic lost response");
          }
          return r;
        };
        const attempt = await f.command(
          id,
          "kapelle/agent-instance",
          "REQUEST_PAUSE",
          {},
          "lost-ack",
        );
        expect(attempt.status).toBe(503);
        const recovered = await f.http("/commands", attempt.request);
        expect(recovered.body.result.disposition).toBe("ACCEPTED");
        const before = await f.read(id, "kapelle/agent-instance");
        await f.restart();
        expect((await f.http("/commands", attempt.request)).body.result).toEqual(
          recovered.body.result,
        );
        expect((await f.read(id, "kapelle/agent-instance")).state.global).toEqual(
          before.state.global,
        );
        expect(
          (await f.http("/commands", { ...attempt.request, input: { changed: true } })).status,
        ).toBe(409);
        expect((await f.http("/operations/lost-ack")).body.result.disposition).toBe("ACCEPTED");
      } finally {
        await f.close();
      }
    }, 30000);
    it("denies identity spoofing, stale sources, token rotation and unactivated effects", async () => {
      const f = await fixture();
      try {
        const id = await f.provision();
        expect(
          (await f.http("/instances", undefined, undefined, { "x-id-owner": "owner" })).status,
        ).toBe(403);
        const r = await f.command(id, "kapelle/agent-instance", "REQUEST_PAUSE", {
          actorId: "owner",
        });
        expect(r.status).toBe(409);
        expect(
          (
            await f.http("/admission", {
              instanceId: id,
              documentId: "contracts",
              revision: 8,
              contentHash: f.ctx.resources[0].contentHash,
            })
          ).status,
        ).toBe(409);
        const old = "synthetic-owner-credential-0123456789";
        f.rotate();
        expect((await f.http("/instances", undefined, old)).status).toBe(403);
        expect((await f.http("/instances")).status).toBe(200);
        const effect = await f.command(id, "kapelle/agent-instance", "RESERVE_EFFECT", {});
        expect(effect.status).toBe(403);
        expect(effect.body.error).toBe("execution_credential_required");
      } finally {
        await f.close();
      }
    }, 30000);
    it("serializes competing revisions and replays allocation identity without duplicate native documents", async () => {
      const f = await fixture();
      try {
        const allocate = {
          operationId: "same-allocation",
          documentType: "kapelle/agent-instance",
          name: "Same request",
        };
        const [a, b] = await Promise.all([
          f.http("/allocate", allocate),
          f.http("/allocate", allocate),
        ]);
        expect(a.body.documentId).toBe(b.body.documentId);
        const id = await f.provision(),
          d = await f.read(id, "kapelle/agent-instance");
        const c = {
          documentId: id,
          documentType: "kapelle/agent-instance",
          expectedRevision: d.state.global.revision,
          type: "REQUEST_PAUSE",
          input: {},
        };
        const results = await Promise.all([
          f.http("/commands", { ...c, operationId: "race-a" }),
          f.http("/commands", { ...c, operationId: "race-b" }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      } finally {
        await f.close();
      }
    }, 30000);
  },
);

describe.skipIf(!reactorRoot || !process.env.KAPELLE_MANAGER_INTEGRATION_ROOT)(
  "Combined manager contract",
  () => {
    it("exercises the real manager router, SQLite Dispatch and transport against this native authority", async () => {
      const f = await fixture();
      try {
        const id = await f.provision(),
          sourceId = "10000000-0000-4000-8000-000000000003";
        f.setFacts({
          ...f.ctx,
          resources: [
            ...f.ctx.resources,
            {
              id: sourceId,
              resourceType: "contracts",
              revision: 1,
              contentHash:
                "sha256:" + createHash("sha256").update("synthetic source").digest("hex"),
              allowedActions: ["read"],
            },
          ],
        });
        expect(
          (
            await f.command(id, "kapelle/agent-instance", "GRANT_CAPABILITY", {
              grant: {
                id: "combined-read",
                principalId: id,
                resourceRef: sourceId,
                actions: ["read"],
                expiresAt: "2026-09-11T12:00:00.000Z",
                reviewPolicy: "ALWAYS",
              },
            })
          ).body.result.disposition,
        ).toBe("ACCEPTED");
        const manager = process.env.KAPELLE_MANAGER_INTEGRATION_ROOT;
        if (!manager) throw Error("KAPELLE_MANAGER_INTEGRATION_ROOT required for combined proof");
        let output = "";
        const code = await new Promise<number | null>((resolve, reject) => {
          const child = spawn(
            process.env.KAPELLE_MANAGER_NODE ?? process.execPath,
            [
              "node_modules/vitest/vitest.mjs",
              "run",
              "tests/integration/framework-native-authority.test.ts",
            ],
            {
              cwd: manager,
              env: {
                ...process.env,
                KAPELLE_FRAMEWORK_TEST_URL: f.url,
                KAPELLE_FRAMEWORK_TEST_TOKEN: f.token,
                KAPELLE_FRAMEWORK_TEST_INSTANCE: id,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          child.stdout.on("data", (d) => (output += d));
          child.stderr.on("data", (d) => (output += d));
          child.once("error", reject);
          child.once("close", resolve);
        });
        if (process.env.KAPELLE_COMBINED_EVIDENCE)
          writeFileSync(process.env.KAPELLE_COMBINED_EVIDENCE, output);
        expect(code, output).toBe(0);
      } finally {
        await f.close();
      }
    }, 30000);
  },
);
