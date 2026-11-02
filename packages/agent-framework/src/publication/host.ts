import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import type { FrameworkAuthority } from "../service/authority.js";
import { canonical, digest } from "../content.js";
import { assert } from "../validation.js";
import { publicationArtifact, publicationProposal, type PublicationManifest } from "./manifest.js";
import { publicationDecisionHandler } from "./decision-http.js";
import { publicationExecutorAdapters } from "./executor-adapters.js";
import { approvedPublication, PublicationExecutorClient } from "./executor-http.js";
import { ManagerPublicationStore, managerPublicationHandler, type ManagerDatabase, type ManagerQueue } from "./manager-transport.js";

type ExecutorConfig = Parameters<typeof publicationExecutorAdapters>[1];
export type PublicationHostConfig = Omit<ExecutorConfig, "managerOrigin"> & {
  managerTeamId: string; managerAuthorityId: string; executorAgent: string;
  managerDatabase: ManagerDatabase; managerQueue: ManagerQueue;
  /** Called before any listener/wakeup, so native facts use these exact ports. */
  bindEffects: (adapters: ReturnType<typeof publicationExecutorAdapters>) => void;
  /** Explicitly opt into one bounded wakeup after a decision and at host startup. */
  wakeOnDecision: boolean;
  taskResultContext?: import("./task-result-context.js").TaskResultContextReader;
};

/** Explicit retained-host composition. Opens numeric-loopback ephemeral private
 * listeners only when called. It neither provisions grants/reviews nor changes
 * production config. The caller owns the single locked native runtime/journal. */
export async function openPublicationHost(authority: FrameworkAuthority, config: PublicationHostConfig) {
  const manifest: PublicationManifest = publicationArtifact(config.manifest).manifest;
  const credential = (kind: "manager" | "executor" | "owner") => () => {
    const values = [config.managerToken(), config.executorToken(), config.ownerDecisionToken()];
    assert(values.every(value => value.length >= 32) && new Set(values).size === 3,
      "Distinct Manager, executor and owner decision credentials required");
    return values[{ manager: 0, executor: 1, owner: 2 }[kind]];
  };
  credential("owner")();
  const identity = canonical({
    contract: "kapelle/publication-host/v1", hostId: config.brokerHostId,
    ownerId: manifest.ownerId, scopeRef: manifest.scopeRef, manifestHash: digest(manifest),
    reviewId: config.reviewId, instanceId: config.instanceId, managerTeamId: config.managerTeamId,
    managerAuthorityId: config.managerAuthorityId, executorAgent: config.executorAgent,
    ...(config.taskResultContext ? {taskResultContext: config.taskResultContext.binding} : {})
  });
  authority.journal.db.exec(`CREATE TABLE IF NOT EXISTS publication_host_bindings(
    review_id TEXT PRIMARY KEY, identity_json TEXT NOT NULL);`);
  authority.journal.db.prepare("INSERT OR IGNORE INTO publication_host_bindings VALUES (?,?)").run(config.reviewId, identity);
  assert(authority.journal.db.prepare("SELECT identity_json FROM publication_host_bindings WHERE review_id=?")
    .get(config.reviewId)?.identity_json === identity, "Retained publication host binding differs");
  const servers: ReturnType<typeof createServer>[] = [];
  const listen = async (handler: RequestListener) => {
    const server = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch(() => {
        if (!res.headersSent) res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "publication_host_unavailable" }));
      });
    });
    server.requestTimeout = 20000; server.headersTimeout = 10000;
    servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  let pending: Promise<unknown> | null = null, closed = false, wakeError = false;
  const close = async () => {
    closed = true; await pending?.catch(() => { });
    for (const server of servers.reverse()) await new Promise<void>(resolve => server.close(() => resolve()));
  };
  try {
    const store = new ManagerPublicationStore({
      teamId: config.managerTeamId, ownerId: manifest.ownerId,
      scopeRef: manifest.scopeRef, reviewId: config.reviewId, instanceId: config.instanceId,
      executorAgent: config.executorAgent, manifest, queue: config.managerQueue, database: config.managerDatabase,
      admit: () => approvedPublication(authority, manifest, config.reviewId, config.instanceId).then(() => { })
    });
    const managerOrigin = await listen(managerPublicationHandler(store, credential("manager")));
    const adapters = publicationExecutorAdapters(authority, {
      ...config, managerOrigin,
      managerToken: credential("manager"), executorToken: credential("executor"), ownerDecisionToken: credential("owner")
    });
    config.bindEffects(adapters);
    const executorOrigin = await listen(adapters.handler);
    const executor = new PublicationExecutorClient(executorOrigin, credential("executor"));
    const readStatus = async () => {
      const doc = await authority.read(config.reviewId, "kapelle/review-intent"), state = doc.state.global;
      assert("proposal" in state && state.ownerId === manifest.ownerId && state.scopeRef === manifest.scopeRef &&
        state.instanceId === config.instanceId && canonical(state.proposal) === canonical(publicationProposal(manifest)), "Publication status binding differs");
      const binding = await store.read(store.expected.key);
      if (state.effect) assert(binding && state.effect.operationId === binding.operationId &&
        state.effect.dispatchRef === binding.dispatchRef && state.effect.outboxRef === binding.outboxRef,
        "Native effect and Manager binding differ");
      const hold = binding ? adapters.provider.holdStatus(binding) : null;
      const after = await authority.read(config.reviewId, "kapelle/review-intent");
      assert(after.state.global.revision === state.revision, "Publication status changed during read");
      return {
        contract: "kapelle/publication-status/v1", reviewId: config.reviewId,
        instanceId: config.instanceId, nativeRevision: state.revision, observedAt: new Date().toISOString(),
        automaticWakeup: config.wakeOnDecision, executorAvailable: !closed,
        proposalHash: store.expected.proposalHash, decision: state.status,
        operationId: binding?.operationId ?? null, dispatchRef: binding?.dispatchRef ?? null, outboxRef: binding?.outboxRef ?? null,
        invocationClaimed: Boolean("execution" in state && state.execution), delivery: state.delivery.at(-1) ?? null,
        hold,
        wakeup: pending ? "RUNNING" : wakeError ? "RECOVERY_REQUIRED" : "IDLE"
      };
    };
    const wake = () => {
      assert(!closed, "Publication host closed");
      if (pending) return pending;
      pending = (async () => {
        try {
          credential("owner")();
          const doc = await authority.read(config.reviewId, "kapelle/review-intent"), state = doc.state.global;
          assert("proposal" in state, "Publication review unavailable");
          if (state.status !== "APPROVED") return;
          await store.deliver(executor, "execution" in state && state.execution ? "reconcile" : "run");
          wakeError = false;
        } catch (error) { wakeError = true; throw error; }
        finally { pending = null; }
      })();
      return pending;
    };
    const ownerOrigin = await listen(publicationDecisionHandler(authority, {
      manifest, reviewDocumentId: config.reviewId, instanceId: config.instanceId, token: credential("owner"),
      taskResultContext: config.taskResultContext, readPublicationStatus: readStatus, decisionRecorded: () => {
        if (config.wakeOnDecision) void wake().catch(() => { });
      }
    }));
    if (config.wakeOnDecision) void wake().catch(() => { });
    return {
      ownerOrigin, managerOrigin, executorOrigin, store, adapters, readStatus, wake, close,
      async recoverNoContact() {
        assert(!closed, "Publication host closed");
        await pending?.catch(() => { });
        const binding = await store.read(store.expected.key); assert(binding, "Saved publication unavailable");
        await adapters.provider.sealNoContact(binding);
        return store.deliver(executor, "reconcile");
      }
    };
  } catch (error) { await close(); throw error; }
}
