import { z } from "zod";
import { canonical, digest } from "../content.js";
import { assert, opaque } from "../validation.js";
import {
  dispatchIntent,
  verifyDispatch,
  type DispatchBinding,
  type DispatchIntent,
  type PublicationDispatch,
} from "./effects.js";
import { publicationArtifact, type PublicationManifest } from "./manifest.js";
import { jsonRequest, machineHandler, privateEndpoint } from "./transport-http.js";
import type { PublicationExecutorClient } from "./executor-http.js";

/** Structural ports for the existing Manager SqliteDispatchReactor and DbAdapter.
 * No replacement queue or native-model claim is made by this adapter. */
export interface ManagerDatabase {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}
interface QueueDoc {
  dispatch_phid: string;
  query_id: string;
  to_agent: string;
  from_actor: string;
  channel: string;
  body_markdown: string;
  not_before_at: string;
  status: string;
}
export interface ManagerQueue {
  enqueue(input: {
    query_id: string;
    to_agent: string;
    from_actor: string;
    channel: string;
    subject: string;
    body_markdown: string;
    provider: "local";
    runtime: "other";
    not_before_at: string;
    promote: false;
    operation: { key: string; payloadHash: string; requestJson: string };
  }): Promise<QueueDoc>;
  getByOperationKey(
    key: string,
  ): Promise<{ doc: QueueDoc; payloadHash: string; requestJson: string } | null>;
}
const HOLD = "9999-12-31T23:59:59.999Z";
export class ManagerPublicationStore implements PublicationDispatch {
  readonly expected: DispatchIntent;
  private readonly envelope: string;
  private readonly key: string;
  private readonly operationId: string;
  constructor(
    private readonly config: {
      teamId: string;
      ownerId: string;
      scopeRef: string;
      reviewId: string;
      instanceId: string;
      executorAgent: string;
      manifest: PublicationManifest;
      queue: ManagerQueue;
      database: ManagerDatabase;
      /** Actual native authority check, required before creating a new queue record. */
      admit: () => Promise<void>;
    },
  ) {
    [
      config.teamId,
      config.ownerId,
      config.scopeRef,
      config.reviewId,
      config.instanceId,
      config.executorAgent,
    ].forEach(opaque);
    const m = publicationArtifact(config.manifest).manifest;
    assert(
      m.ownerId === config.ownerId && m.scopeRef === config.scopeRef,
      "Manager scope mismatch",
    );
    this.expected = dispatchIntent(config.reviewId, config.instanceId, m);
    this.key = `publication:${config.ownerId}:${this.expected.key}`;
    this.operationId = "publication-operation:" + digest(this.expected).slice(7);
    this.envelope = canonical({
      contract: "kapelle/publication-transport/v1",
      teamId: config.teamId,
      executorAgent: config.executorAgent,
      operationId: this.operationId,
      intent: this.expected,
      originDispatch: m.originDispatch ?? null,
    });
  }
  async read(key: string): Promise<DispatchBinding | null> {
    assert(key === this.expected.key, "Unknown publication key");
    const saved = await this.config.queue.getByOperationKey(this.key);
    if (!saved) return null;
    const d = saved.doc;
    assert(
      saved.payloadHash === digest(JSON.parse(this.envelope)).slice(7) &&
        saved.requestJson === this.envelope &&
        d.channel === "kapelle-publication" &&
        d.from_actor === this.config.ownerId &&
        d.to_agent === this.config.executorAgent &&
        d.query_id === this.operationId &&
        d.body_markdown === this.envelope &&
        d.not_before_at === HOLD,
      "Manager saved publication differs",
    );
    // Read the real queue row and its transactional outbox from the configured team.
    const { rows } = await this.config.database.query<{
      operation_id: string;
      envelope_json: string;
    }>(
      `SELECT o.operation_id,o.envelope_json FROM dispatch_operation_outbox o
       JOIN dispatch_scheduler_queue q ON q.dispatch_phid=o.dispatch_phid AND q.team_id=o.team_id
       WHERE q.team_id=? AND q.operation_key=? AND q.operation_payload_hash=? AND q.dispatch_phid=?
         AND o.operation_type='dispatch.requested' AND o.idempotency_key=?`,
      [
        this.config.teamId,
        this.key,
        saved.payloadHash,
        d.dispatch_phid,
        d.dispatch_phid + ":requested",
      ],
    );
    assert(rows.length === 1, "Manager transactional outbox unavailable");
    const e = JSON.parse(rows[0].envelope_json);
    assert(
      e.schema_version === "dispatch.operation.v1" &&
        e.dispatch_id === d.dispatch_phid &&
        e.team_id === this.config.teamId &&
        e.actor === this.config.ownerId &&
        e.causation_id === this.operationId &&
        e.operation_type === "dispatch.requested",
      "Manager outbox identity differs",
    );
    return verifyDispatch(
      {
        intent: structuredClone(this.expected),
        operationId: this.operationId,
        dispatchRef: d.dispatch_phid,
        outboxRef: rows[0].operation_id,
      },
      this.expected,
    );
  }
  async ensure(intent: DispatchIntent) {
    assert(canonical(intent) === canonical(this.expected), "Manager intent differs");
    const prior = await this.read(intent.key);
    if (prior) return prior;
    await this.config.admit();
    const control = await this.config.database.query<{ shadow_enabled: number }>(
      "SELECT shadow_enabled FROM dispatch_operation_outbox_control WHERE singleton=1",
    );
    assert(control.rows[0]?.shadow_enabled === 1, "Manager transactional outbox is not enabled");
    // This is an executor-only held queue entry; ordinary scheduler claiming cannot fire it.
    // Existing queue uniqueness handles competing inserts and exact retry after a lost response.
    await this.config.queue.enqueue({
      query_id: this.operationId,
      to_agent: this.config.executorAgent,
      from_actor: this.config.ownerId,
      channel: "kapelle-publication",
      subject: "Native approved publication",
      body_markdown: this.envelope,
      provider: "local",
      runtime: "other",
      not_before_at: HOLD,
      promote: false,
      operation: {
        key: this.key,
        payloadHash: digest(JSON.parse(this.envelope)).slice(7),
        requestJson: this.envelope,
      },
    });
    const result = await this.read(intent.key);
    assert(result, "Manager enqueue acknowledgement unavailable");
    return result;
  }
  /** Dedicated Manager wakeup. Transport retries retain the same binding and are
   * safe only because the executor consumes one native invocation claim. */
  async deliver(executor: PublicationExecutorClient, mode: "run" | "reconcile" = "run") {
    const binding =
      mode === "run" ? await this.ensure(this.expected) : await this.read(this.expected.key);
    assert(binding, "Saved publication unavailable");
    const receipt = await executor.deliver(binding, mode);
    const body = canonical(receipt);
    const changed = await this.config.database.query(
      `UPDATE dispatch_scheduler_queue SET result_json=?, updated_at=MAX(updated_at,?),
      completed_at=CASE WHEN status='cancelled' OR ?='UNCERTAIN' THEN completed_at ELSE COALESCE(completed_at,?) END,
      status=CASE WHEN status='cancelled' THEN status WHEN ?='DELIVERED' THEN 'done' WHEN ?='FAILED' THEN 'failed' ELSE status END
      WHERE team_id=? AND operation_key=? AND operation_payload_hash=? AND dispatch_phid=?
        AND (result_json IS NULL OR json_extract(result_json,'$.status')='UNCERTAIN' OR result_json=?)`,
      [
        body,
        receipt.occurredAt,
        receipt.status,
        receipt.occurredAt,
        receipt.status,
        receipt.status,
        this.config.teamId,
        this.key,
        digest(JSON.parse(this.envelope)).slice(7),
        binding.dispatchRef,
        body,
      ],
    );
    if (!changed.rowCount) {
      const { rows } = await this.config.database.query<{ result_json: string }>(
        "SELECT result_json FROM dispatch_scheduler_queue WHERE team_id=? AND operation_key=?",
        [this.config.teamId, this.key],
      );
      assert(rows.length === 1 && rows[0].result_json, "Manager result projection unavailable");
      const prior = JSON.parse(rows[0].result_json) as typeof receipt;
      assert(
        prior.operationId === receipt.operationId &&
          prior.reviewId === receipt.reviewId &&
          prior.dispatchRef === receipt.dispatchRef &&
          ["DELIVERED", "FAILED"].includes(prior.status),
        "Manager projection conflict",
      );
      return prior;
    }
    return receipt;
  }
}

/** Mount only on the existing Manager's private machine listener with a purpose-specific token. */
export function managerPublicationHandler(store: ManagerPublicationStore, token: () => string) {
  return machineHandler(token, async (method, url, body) => {
    assert(!url.search, "Unexpected query");
    if (method === "GET" && url.pathname === "/binding" && body === undefined)
      return store.read(store.expected.key);
    if (method === "POST" && url.pathname === "/ensure") {
      const input = z.object({ intent: z.unknown() }).strict().parse(body);
      assert(canonical(input.intent) === canonical(store.expected), "Unknown intent");
      return store.ensure(store.expected);
    }
    throw new Error("Unknown machine route");
  });
}
export class ManagerPublicationClient implements PublicationDispatch {
  private readonly origin: string;
  private readonly expected: DispatchIntent;
  constructor(
    origin: string,
    private readonly token: () => string,
    expected: DispatchIntent,
    private readonly request: typeof fetch = fetch,
  ) {
    this.origin = privateEndpoint(origin);
    this.expected = structuredClone(expected);
  }
  async read(key: string) {
    assert(key === this.expected.key, "Unknown publication key");
    const result = await jsonRequest(this.origin, "/binding", this.token, this.request);
    return result === null ? null : verifyDispatch(result, this.expected);
  }
  async ensure(intent: DispatchIntent) {
    assert(canonical(intent) === canonical(this.expected), "Manager intent differs");
    const prior = await this.read(intent.key);
    if (prior) return prior;
    return verifyDispatch(
      await jsonRequest(this.origin, "/ensure", this.token, this.request, {
        intent: this.expected,
      }),
      this.expected,
    );
  }
}
