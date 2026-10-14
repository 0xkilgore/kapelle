import { reducer, utils } from "document-models/task-authority/v1";
import type { TaskAuthorityDocument } from "document-models/task-authority/v1";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { TaskGatewayApi } from "../src/gateway/api.js";
import { AuthRegistry } from "../src/gateway/auth.js";
import { TaskGatewayCore } from "../src/gateway/core.js";
import { GATEWAY_ROUTES, TASK_GATEWAY_OPENAPI } from "../src/gateway/openapi.js";
import { ReceiptStore } from "../src/gateway/receipt-store.js";
import type { GatewayAction, ReactorOperation, ReactorPort } from "../src/gateway/types.js";
import type { GatewayScope } from "../src/gateway/types.js";

class ApiReactor implements ReactorPort {
  documents = new Map<string, TaskAuthorityDocument>();
  probeError: Error | null = null;

  async probe(_driveId: string) {
    if (this.probeError) throw this.probeError;
  }

  async createDocument(input: { documentType: "kilgore/task"; name: string; driveId: string }) {
    const document = utils.createDocument();
    document.header.name = input.name;
    this.documents.set(document.header.id, document);
    return document.header.id;
  }

  async findDocumentByName(_driveId: string, name: string, _maxCandidates: number) {
    return [...this.documents.values()].find((document) => document.header.name === name)
      ?.header.id ?? null;
  }

  async getDocument(id: string) {
    const document = this.documents.get(id);
    if (!document) throw new Error("not found");
    return structuredClone(document);
  }

  async addActions(id: string, newActions: GatewayAction[]) {
    let document = await this.getDocument(id);
    for (const action of newActions) document = reducer(document, action);
    this.documents.set(id, document);
  }

  async getOperations(id: string, sinceRevision = 0): Promise<ReactorOperation[]> {
    const document = await this.getDocument(id);
    return document.operations.global.slice(sinceRevision).map((operation) => ({
      id: operation.id,
      index: operation.index,
      error: operation.error ?? null,
      action: {
        id: operation.action.id,
        type: operation.action.type,
        input: JSON.parse(JSON.stringify(operation.action.input)) as Record<string, unknown>,
      },
    }));
  }
}

const token = "api-test-token-with-at-least-24-characters";

function harness(scopes: readonly GatewayScope[] = [
  "task.read",
  "task.create",
  "task.update",
  "task.complete",
  "projection.read",
], receiptPath = ":memory:") {
  const receipts = new ReceiptStore(receiptPath);
  const reactor = new ApiReactor();
  let ownsDrive = true;
  const core = new TaskGatewayCore({
    driveId: "synthetic",
    reactor,
    receipts,
    ownsDrive: () => ownsDrive,
    clock: () => "2026-08-13T20:00:00.000Z",
  });
  const auth = new AuthRegistry([{
    clientId: "test-client",
    actorId: "chris",
    token,
    scopes: [...scopes],
    allowedSources: ["HUMAN"],
  }]);
  return {
    api: new TaskGatewayApi(core, auth, () => "2026-08-13T20:00:00.000Z"),
    reactor,
    receipts,
    loseDrive: () => { ownsDrive = false; },
    close: () => receipts.close(),
  };
}

function request(method: string, path: string, value?: unknown, bearer = token) {
  return new Request(`http://127.0.0.1:4260${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(value == null ? {} : { "content-type": "application/json" }),
    },
    body: value == null ? undefined : JSON.stringify(value),
  });
}

describe("TaskGatewayApi", () => {
  it("serves content-free liveness and dependency-backed readiness without authentication", async () => {
    const { api, reactor, loseDrive, close } = harness();
    try {
      const health = await api.handle(new Request("http://127.0.0.1:4260/health"));
      expect(health.status).toBe(200);
      expect(health.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await health.text()).toBe('{"status":"ok"}');

      const ready = await api.handle(new Request("http://127.0.0.1:4260/ready"));
      expect(ready.status).toBe(200);
      expect(ready.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await ready.text()).toBe('{"status":"ready"}');

      reactor.probeError = new Error("private upstream detail");
      const unavailable = await api.handle(new Request("http://127.0.0.1:4260/ready"));
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const unavailableBody = await unavailable.text();
      expect(unavailableBody).toBe('{"status":"not_ready"}');
      expect(JSON.parse(unavailableBody)).toEqual({ status: "not_ready" });
      expect(unavailableBody).not.toContain("private upstream detail");

      reactor.probeError = null;
      loseDrive();
      const lockLost = await api.handle(new Request("http://127.0.0.1:4260/ready"));
      expect(lockLost.status).toBe(503);
      expect(await lockLost.json()).toEqual({ status: "not_ready" });
    } finally {
      close();
    }
  });

  it("fails readiness closed when the receipt store is closed", async () => {
    const { api, receipts } = harness();
    receipts.close();
    const unavailable = await api.handle(new Request("http://127.0.0.1:4260/ready"));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: "not_ready" });
  });

  it("fails readiness closed when the receipt schema disappears", async () => {
    const directory = mkdtempSync(join(tmpdir(), "task-gateway-api-"));
    const path = join(directory, "receipts.sqlite");
    const { api, close } = harness(undefined, path);
    const mutator = new DatabaseSync(path);
    try {
      mutator.exec("DROP TABLE mutation_receipts");
      const unavailable = await api.handle(new Request("http://127.0.0.1:4260/ready"));
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ status: "not_ready" });
    } finally {
      mutator.close();
      close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("supports HEAD and rejects other methods on operational endpoints", async () => {
    const { api, close } = harness();
    try {
      for (const path of ["/health", "/ready"]) {
        const response = await api.handle(new Request(`http://127.0.0.1:4260${path}`, {
          method: "HEAD",
        }));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("");

        const rejected = await api.handle(new Request(`http://127.0.0.1:4260${path}`, {
          method: "POST",
        }));
        expect(rejected.status).toBe(405);
        expect(rejected.headers.get("allow")).toBe("GET, HEAD");
      }
    } finally {
      close();
    }
  });

  it("supports create, get, patch, complete, bounded list, and Today", async () => {
    const { api, close } = harness();
    try {
      const createdResponse = await api.handle(request("POST", "/v1/tasks", {
        operationId: "api-create",
        expectedRevision: 0,
        title: "API synthetic task",
        dueAt: "2026-08-13T21:00:00.000Z",
      }));
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as any;
      const id = created.task.id as string;

      const fetched = await api.handle(request("GET", `/v1/tasks/${id}`));
      expect(await fetched.json()).toMatchObject({ id, title: "API synthetic task", revision: 1 });

      const patched = await api.handle(request("PATCH", `/v1/tasks/${id}`, {
        operationId: "api-patch",
        expectedRevision: 1,
        patch: { title: "API revised", priority: "HIGH" },
      }));
      expect(await patched.json()).toMatchObject({
        task: { id, title: "API revised", priority: "HIGH", revision: 3 },
      });

      const list = await api.handle(request("GET", "/v1/tasks?limit=1"));
      expect(await list.json()).toMatchObject({ rows: [{ id }], nextCursor: null });

      const today = await api.handle(request(
        "GET",
        "/v1/projections/today?timeZone=America%2FChicago&limit=5",
      ));
      expect(await today.json()).toMatchObject({
        kind: "task-authority.today.v1",
        rows: [{ id, title: "API revised" }],
      });

      const digest = await api.handle(request(
        "GET",
        "/v1/projections/morning-digest?timeZone=America%2FChicago",
      ));
      expect(await digest.json()).toMatchObject({
        kind: "task-authority.morning-digest.v1",
        state: "fresh",
        ownerId: "chris",
        localDate: "2026-08-13",
        generatedAt: "2026-08-13T20:00:00.000Z",
        focus: { rows: [{ id, title: "API revised" }], totalCount: 1, hasMore: false },
        counts: { overdue: 0, dueThisWeek: 0, completedPreviousLocalDay: 0 },
      });

      const completed = await api.handle(request("POST", `/v1/tasks/${id}/complete`, {
        operationId: "api-complete",
        expectedRevision: 3,
      }));
      expect(await completed.json()).toMatchObject({ task: { status: "DONE", revision: 4 } });
    } finally {
      close();
    }
  });

  it("requires authentication and the route-specific scope", async () => {
    const { api, close } = harness(["task.read"]);
    try {
      const unauthenticated = await api.handle(new Request("http://127.0.0.1:4260/v1/tasks"));
      expect(unauthenticated.status).toBe(401);

      const forbidden = await api.handle(request("POST", "/v1/tasks", {
        operationId: "forbidden",
        expectedRevision: 0,
        title: "No",
      }));
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    } finally {
      close();
    }
  });

  it("rejects invalid projection query parameters as caller errors", async () => {
    const { api, close } = harness();
    try {
      for (const path of [
        "/v1/projections/today?limit=0",
        "/v1/projections/morning-digest?focusLimit=101",
        "/v1/projections/morning-digest?timeZone=Not%2FAZone",
      ]) {
        const response = await api.handle(request("GET", path));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      }
    } finally {
      close();
    }
  });

  it("rejects unknown patch fields and prohibited routes", async () => {
    const { api, close } = harness();
    try {
      const missing = await api.handle(request("POST", "/v1/tasks/bulk", {}));
      expect(missing.status).toBe(404);

      const created = await api.handle(request("POST", "/v1/tasks", {
        operationId: "patch-guard-create",
        expectedRevision: 0,
        title: "Guard",
      }));
      const id = ((await created.json()) as any).task.id;
      const rejected = await api.handle(request("PATCH", `/v1/tasks/${id}`, {
        operationId: "patch-guard",
        expectedRevision: 1,
        patch: { directory: "/tmp" },
      }));
      expect(rejected.status).toBe(400);
    } finally {
      close();
    }
  });

  it("rejects a caller-supplied task id before allocating a document", async () => {
    const { api, close } = harness();
    try {
      const response = await api.handle(request("POST", "/v1/tasks", {
        operationId: "caller-id-create",
        expectedRevision: 0,
        id: "caller-owned-id",
        title: "No allocation",
      }));

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "INVALID_REQUEST", message: "CREATE_TASK.id is server-managed" },
      });
    } finally {
      close();
    }
  });

  it("supports unsnooze and unblock without creating lifecycle dead ends", async () => {
    const { api, close } = harness();
    try {
      const created = await api.handle(request("POST", "/v1/tasks", {
        operationId: "lifecycle-create",
        expectedRevision: 0,
        title: "Lifecycle task",
      }));
      const id = ((await created.json()) as any).task.id;

      const snoozed = await api.handle(request("POST", `/v1/tasks/${id}/snooze`, {
        operationId: "lifecycle-snooze",
        expectedRevision: 1,
        snoozedUntil: "2026-08-14T20:00:00.000Z",
      }));
      expect(await snoozed.json()).toMatchObject({ task: { status: "SNOOZED", revision: 2 } });

      const unsnoozed = await api.handle(request("POST", `/v1/tasks/${id}/unsnooze`, {
        operationId: "lifecycle-unsnooze",
        expectedRevision: 2,
      }));
      expect(await unsnoozed.json()).toMatchObject({ task: { status: "OPEN", revision: 3 } });

      const blocked = await api.handle(request("POST", `/v1/tasks/${id}/block`, {
        operationId: "lifecycle-block",
        expectedRevision: 3,
        reason: "Waiting for review",
      }));
      expect(await blocked.json()).toMatchObject({ task: { status: "BLOCKED", revision: 4 } });

      const unblocked = await api.handle(request("POST", `/v1/tasks/${id}/unblock`, {
        operationId: "lifecycle-unblock",
        expectedRevision: 4,
        resolution: "Reviewed",
      }));
      expect(await unblocked.json()).toMatchObject({ task: { status: "OPEN", revision: 5 } });

      const invalidUnsnooze = await api.handle(request("POST", `/v1/tasks/${id}/unsnooze`, {
        operationId: "lifecycle-invalid-unsnooze",
        expectedRevision: 5,
      }));
      expect(invalidUnsnooze.status).toBe(422);

      const invalidUnblock = await api.handle(request("POST", `/v1/tasks/${id}/unblock`, {
        operationId: "lifecycle-invalid-unblock",
        expectedRevision: 5,
      }));
      expect(invalidUnblock.status).toBe(422);
    } finally {
      close();
    }
  });
});

describe("gateway contract", () => {
  it("contains only the approved single-object surface", () => {
    const serialized = JSON.stringify(TASK_GATEWAY_OPENAPI).toLowerCase();
    for (const term of ["import", "migrate", "migration", "bulk", "batch", "directory", "delete-all", "purge", "restore"]) {
      expect(serialized).not.toContain(term);
    }
    expect(GATEWAY_ROUTES).toHaveLength(16);
    expect(GATEWAY_ROUTES).toContain("GET /openapi.json");
    expect(TASK_GATEWAY_OPENAPI.paths["/ready"].get.responses).toHaveProperty("503");
    expect(TASK_GATEWAY_OPENAPI.paths["/health"].get.responses).toHaveProperty("200");
    expect(TASK_GATEWAY_OPENAPI.paths).toHaveProperty("/v1/projections/morning-digest");
  });
});
