import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { describe, it, expect } from "vitest";
import {
  ManagerPublicationClient,
  managerPublicationHandler,
} from "../src/publication/manager-transport.js";
import { publicationFixture } from "./publication-fixtures.js";
import { managerPublicationFixture } from "./manager-publication-fixture.js";
import { PublicationExecutorClient } from "../src/publication/executor-http.js";
const managerRoot = process.env.KAPELLE_PUBLICATION_MANAGER_ROOT;
export async function listen(handler: RequestListener) {
  const s = createServer(handler);
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  return {
    url: `http://127.0.0.1:${(s.address() as any).port}`,
    async close() {
      await new Promise<void>((r) => s.close(() => r()));
    },
  };
}
describe.skipIf(!managerRoot)("Existing Manager queue publication bridge", () => {
  it.each([false, true])(
    "projects native receipt time without reversing terminal or cancelled state (cancelled=%s)",
    async (cancelled) => {
      const f = await managerPublicationFixture(managerRoot!, publicationFixture().m);
      const binding = await f.store.ensure(f.store.expected);
      let receipt = {
        reviewId: binding.intent.reviewId,
        operationId: binding.operationId,
        dispatchRef: binding.dispatchRef,
        status: "UNCERTAIN",
        evidenceId: "native-unknown",
        occurredAt: "2026-09-11T11:00:00.000Z",
      };
      const client = new PublicationExecutorClient(
        "http://127.0.0.1:1",
        () => "synthetic-executor-token-0123456789abcdef",
        async () => Response.json(receipt),
      );
      try {
        if (cancelled)
          await f.database.query(
            "UPDATE dispatch_scheduler_queue SET status='cancelled',completed_at='2026-09-11T10:30:00.000Z'",
          );
        await f.store.deliver(client);
        const delayed = { ...receipt };
        receipt = {
          ...receipt,
          status: "DELIVERED",
          evidenceId: "native-delivered",
          occurredAt: "2026-09-11T11:01:00.000Z",
        };
        const delivered = await f.store.deliver(client, "reconcile");
        receipt = delayed;
        expect(await f.store.deliver(client, "reconcile")).toEqual(delivered);
        const { rows } = await f.database.query<any>(
          "SELECT status,completed_at,updated_at,result_json FROM dispatch_scheduler_queue",
        );
        expect(rows[0].status).toBe(cancelled ? "cancelled" : "done");
        expect(rows[0].completed_at).toBe(
          cancelled ? "2026-09-11T10:30:00.000Z" : delivered.occurredAt,
        );
        expect(rows[0].updated_at).toBe(delivered.occurredAt);
        expect(JSON.parse(rows[0].result_json)).toEqual(delivered);
      } finally {
        f.close();
      }
    },
  );
  it("atomically retains one exact enqueue/outbox across competing requests, lost acknowledgement and restart; generic claiming cannot fire it", async () => {
    const f = await managerPublicationFixture(managerRoot!, publicationFixture().m);
    try {
      const [a, b] = await Promise.all([
        f.store.ensure(f.store.expected),
        f.store.ensure(f.store.expected),
      ]);
      expect(a).toEqual(b);
      expect((await f.database.query("SELECT * FROM dispatch_scheduler_queue")).rows).toHaveLength(
        1,
      );
      expect((await f.database.query("SELECT * FROM dispatch_operation_outbox")).rows).toHaveLength(
        1,
      );
      expect(
        (await f.queue.claim({ limit: 10, max_in_flight: 10, now: "2026-09-11T11:00:00.000Z" }))
          .claimed,
      ).toEqual([]);
      await f.restart();
      expect(await f.store.ensure(f.store.expected)).toEqual(a);
      await expect(
        f.store.ensure({ ...f.store.expected, proposalHash: "changed" }),
      ).rejects.toThrow(/intent/);
    } finally {
      f.close();
    }
  });
  it("recovers an enqueue whose durable insert succeeded but response was lost", async () => {
    const f = await managerPublicationFixture(managerRoot!, publicationFixture().m);
    try {
      const original = f.queue.enqueue.bind(f.queue);
      f.queue.enqueue = async (i) => {
        await original(i);
        throw Error("Lost synthetic acknowledgement");
      };
      await expect(f.store.ensure(f.store.expected)).rejects.toThrow(/Lost/);
      await f.restart();
      const b = await f.store.ensure(f.store.expected);
      expect(b.dispatchRef).toMatch(/^phid:/);
      expect((await f.database.query("SELECT * FROM dispatch_scheduler_queue")).rows).toHaveLength(
        1,
      );
    } finally {
      f.close();
    }
  });
  it.each(["admission", "outbox-off", "team", "payload", "outbox"])(
    "fails closed for %s",
    async (fault) => {
      const f = await managerPublicationFixture(
        managerRoot!,
        publicationFixture().m,
        "review",
        "publisher",
        async () => {
          if (fault === "admission") throw Error("Not approved");
        },
      );
      try {
        if (fault === "outbox-off")
          await f.database.query("UPDATE dispatch_operation_outbox_control SET shadow_enabled=0");
        if (["admission", "outbox-off"].includes(fault)) {
          await expect(f.store.ensure(f.store.expected)).rejects.toThrow();
          expect(
            (await f.database.query("SELECT * FROM dispatch_scheduler_queue")).rows,
          ).toHaveLength(0);
          return;
        }
        await f.store.ensure(f.store.expected);
        if (fault === "team")
          await f.database.query("UPDATE dispatch_operation_outbox SET team_id='other'");
        if (fault === "payload")
          await f.database.query("UPDATE dispatch_scheduler_queue SET operation_request_json='{}'");
        if (fault === "outbox") await f.database.query("DELETE FROM dispatch_operation_outbox");
        await expect(f.store.read(f.store.expected.key)).rejects.toThrow();
      } finally {
        f.close();
      }
    },
  );
  it("uses the private credential-bound HTTP transport and recovers a lost HTTP response without another queue entry", async () => {
    const f = await managerPublicationFixture(managerRoot!, publicationFixture().m),
      token = "synthetic-manager-token-0123456789abcdef";
    const server = await listen(managerPublicationHandler(f.store, () => token));
    try {
      let dropped = false;
      const client = new ManagerPublicationClient(
        server.url,
        () => token,
        f.store.expected,
        async (...args) => {
          const r = await fetch(...args);
          if (args[1]?.method === "POST" && !dropped) {
            dropped = true;
            await r.body?.cancel();
            throw Error("synthetic secret transport loss");
          }
          return r;
        },
      );
      await expect(client.ensure(f.store.expected)).rejects.toThrow(/acknowledgement unavailable/);
      expect(await client.ensure(f.store.expected)).toEqual(
        await f.store.read(f.store.expected.key),
      );
      expect((await f.database.query("SELECT * FROM dispatch_scheduler_queue")).rows).toHaveLength(
        1,
      );
      expect((await fetch(server.url + "/binding")).status).toBe(403);
      expect(
        (
          await fetch(server.url + "/ensure", {
            method: "POST",
            headers: { authorization: "Bearer " + token, "content-type": "application/json" },
            body: JSON.stringify({ intent: f.store.expected, actorId: "owner" }),
          })
        ).status,
      ).toBe(409);
    } finally {
      await server.close();
      f.close();
    }
  });
});


it.skipIf(!managerRoot || !process.env.KAPELLE_WORKER_HOST_TSX)("preserves installed-driver queue/outbox and terminal identity across three actual processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "manager-driver-process-"));
  const run = promisify(execFile);
  try {
    const receipts = [];
    for (const phase of ["enqueue", "settle", "read"]) {
      const output = join(root, phase + ".json");
      await run(process.execPath, ["--import", process.env.KAPELLE_WORKER_HOST_TSX!,
        join(import.meta.dirname, "fixtures/manager-publication-restart.ts"), managerRoot!, join(root, "storage"), output, phase],
        { timeout: 45000, maxBuffer: 64000 });
      receipts.push(JSON.parse(readFileSync(output, "utf8")));
    }
    const [first, settled, reopened] = receipts;
    expect(settled.binding).toEqual(first.binding);
    expect(reopened.binding).toEqual(first.binding);
    expect(receipts.map(r => r.contacts)).toEqual([0, 1, 0]);
    expect(receipts.every(r => r.queue.length === 1)).toBe(true);
    expect(first.outbox.map((r: any) => r.operation_type)).toEqual(["dispatch.requested"]);
    expect(reopened.outbox.map((r: any) => r.operation_type).sort()).toEqual(["dispatch.completed", "dispatch.requested"]);
    expect(reopened.queue[0]).toEqual(settled.queue[0]);
    expect(reopened.queue[0].status).toBe("done");
    expect(receipts.every(r => r.driver.adapterSha256 === first.driver.adapterSha256)).toBe(true);
    expect(first.driver.adapterPath).toBe(join(managerRoot!, "dist/db/sqlite-adapter.js"));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 150000);
