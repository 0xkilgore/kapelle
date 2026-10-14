import { writeFileSync } from "node:fs";
import { managerPublicationFixture } from "../manager-publication-fixture.js";
import { publicationFixture } from "../publication-fixtures.js";
import { PublicationExecutorClient } from "../../src/publication/executor-http.js";
const [root, directory, output, phase] = process.argv.slice(2);
const f = await managerPublicationFixture(root, publicationFixture().m, "review", "publisher", async () => {}, directory);
try {
  const binding = phase === "enqueue" ? await f.store.ensure(f.store.expected) : await f.store.read(f.store.expected.key);
  if (!binding) throw Error("Retained binding missing");
  let contacts = 0;
  if (phase === "settle") await f.store.deliver(new PublicationExecutorClient("http://127.0.0.1:1", () => "synthetic-executor-token-0123456789abcdef", async () => {
    contacts++;
    return Response.json({ reviewId: binding.intent.reviewId, operationId: binding.operationId, dispatchRef: binding.dispatchRef,
      status: "DELIVERED", evidenceId: "native-synthetic-delivery", occurredAt: "2026-09-11T11:01:00.000Z" });
  }), "reconcile");
  writeFileSync(output, JSON.stringify({ binding, contacts, driver: f.driverIdentity,
    queue: (await f.database.query("SELECT status,result_json FROM dispatch_scheduler_queue")).rows,
    outbox: (await f.database.query("SELECT operation_type FROM dispatch_operation_outbox")).rows }), { flag: "wx" });
} finally { f.close(); }
