import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonical, digest } from "../content.js";
import { assert, opaque } from "../validation.js";
import type { DispatchBinding } from "./effects.js";

type Run = { token: string; host_id: string; pid: number };
export type PublicationSettlement = {
  contract: "kapelle/publication-settlement/v1";
  operationId: string; bindingHash: string; teamId: string; projectId: string;
  deploymentId: string; outcome: "COMPLETED" | "NO_CONTACT";
  proofRef: string; proofHash: string;
};

/** Local admission metadata, never an approval, invocation right or provider receipt.
 * One durable hold per project; no timeout or delivery observation can release it.
 * Runs serialize asynchronous work without holding a SQLite transaction across awaits.
 * The journal must stay on one trusted host with a stable, unique installation ID.
 */
export class PublicationProjectHold {
  private readonly context = new AsyncLocalStorage<string>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly hostId: string,
    private readonly target: { teamId: string; projectId: string; deploymentId: string },
  ) {
    opaque(hostId);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS publication_hold_installation(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), host_id TEXT NOT NULL, version INTEGER NOT NULL);`);
      const installed = db.prepare("SELECT * FROM publication_hold_installation").get();
      if (installed) {
        assert(installed.host_id === hostId && installed.version === 1, "Publication hold installation differs");
      } else {
        // Old `settled=1` meant observed delivery, not settlement of the HTTP request.
        // Old claims may also predate contact metadata. Neither can be adopted safely.
        const exists = (name: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
        assert(!exists("publication_provider_contacts") ||
          !db.prepare("SELECT 1 FROM publication_provider_contacts LIMIT 1").get(),
        "Legacy publication contacts require separate recovery qualification");
        if (exists("commands"))
          for (const row of db.prepare("SELECT body FROM commands").all())
            assert(JSON.parse(String(row.body)).command?.type !== "CLAIM_EXECUTION",
              "Legacy execution claims require separate recovery qualification");
        db.prepare("INSERT INTO publication_hold_installation VALUES (1,?,1)").run(hostId);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS publication_project_holds(
        operation_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, project_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL, binding_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(team_id,project_id));
        CREATE TABLE IF NOT EXISTS publication_project_runs(
        token TEXT PRIMARY KEY, operation_id TEXT NOT NULL, team_id TEXT NOT NULL, project_id TEXT NOT NULL,
        host_id TEXT NOT NULL, pid INTEGER NOT NULL, state TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS publication_active_run
        ON publication_project_runs(team_id,project_id) WHERE state='ACTIVE';
        CREATE TABLE IF NOT EXISTS publication_delivery_observations(
        operation_id TEXT NOT NULL, evidence_id TEXT NOT NULL, observed_at TEXT NOT NULL,
        PRIMARY KEY(operation_id,evidence_id));`);
      db.exec(`CREATE TABLE IF NOT EXISTS publication_settled_holds(
        operation_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL, hold_json TEXT NOT NULL,
        proof_json TEXT NOT NULL, evidence_id TEXT NOT NULL, settled_at TEXT NOT NULL);`);
    });
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private saved(binding: DispatchBinding) {
    const row = this.db.prepare("SELECT * FROM publication_project_holds WHERE team_id=? AND project_id=?")
      .get(this.target.teamId, this.target.projectId);
    if (row) assert(row.operation_id === binding.operationId && row.binding_json === canonical(binding) &&
      row.deployment_id === this.target.deploymentId, "Project held by a different saved operation");
    return row;
  }
  async withOperation<T>(binding: DispatchBinding, fn: () => Promise<T>): Promise<T> {
    const token = this.transaction(() => {
      assert(!this.settled(binding), "Publication request is settled; receipt-only access required");
      if (!this.saved(binding)) this.db.prepare(`INSERT INTO publication_project_holds VALUES (?,?,?,?,?,?)`)
        .run(binding.operationId, this.target.teamId, this.target.projectId, this.target.deploymentId,
          canonical(binding), new Date().toISOString());
      const active = this.db.prepare("SELECT token,host_id,pid FROM publication_project_runs WHERE team_id=? AND project_id=? AND state='ACTIVE'")
        .get(this.target.teamId, this.target.projectId) as Run | undefined;
      if (active) {
        assert(active.host_id === this.hostId, "Publication active run belongs to another host");
        let exited = false;
        try { process.kill(active.pid, 0); } catch (error) {
          exited = (error as NodeJS.ErrnoException).code === "ESRCH";
        }
        assert(exited, "Publication project operation is busy");
        // Proven local process exit retires only the run. It never clears the hold,
        // provider contact, or native claim; a delayed remote request remains possible.
        this.db.prepare("UPDATE publication_project_runs SET state='PROCESS_EXITED',finished_at=? WHERE token=?")
          .run(new Date().toISOString(), active.token);
      }
      const token = randomUUID();
      this.db.prepare("INSERT INTO publication_project_runs VALUES (?,?,?,?,?,?,'ACTIVE',?,NULL)")
        .run(token, binding.operationId, this.target.teamId, this.target.projectId, this.hostId,
          process.pid, new Date().toISOString());
      return token;
    });
    return this.context.run(token, async () => {
      try { return await fn(); }
      finally {
        this.db.prepare("UPDATE publication_project_runs SET state='FINISHED',finished_at=? WHERE token=? AND state='ACTIVE'")
          .run(new Date().toISOString(), token);
      }
    });
  }
  assertOwned(binding: DispatchBinding) {
    assert(this.saved(binding), "Publication project hold unavailable");
    const token = this.context.getStore();
    assert(token && this.db.prepare("SELECT 1 FROM publication_project_runs WHERE token=? AND operation_id=? AND state='ACTIVE'")
      .get(token, binding.operationId), "Publication operation guard required");
  }
  observe(binding: DispatchBinding, evidenceId: string) {
    this.assertOwned(binding);
    opaque(evidenceId);
    this.db.prepare("INSERT OR IGNORE INTO publication_delivery_observations VALUES (?,?,?)")
      .run(binding.operationId, evidenceId, new Date().toISOString());
  }
  status(binding: DispatchBinding) {
    const settled = this.settled(binding);
    if (settled) return { held: false, requestSettlement: settled.outcome,
      observations: this.observations(binding), proofRef: settled.proofRef };
    const held = Boolean(this.saved(binding));
    return { held, requestSettlement: "UNPROVEN" as const,
      observations: held ? this.observations(binding) : [] };
  }
  private observations(binding: DispatchBinding) {
    return this.db.prepare("SELECT evidence_id FROM publication_delivery_observations WHERE operation_id=? ORDER BY evidence_id")
      .all(binding.operationId).map((row) => String(row.evidence_id));
  }
  private settled(binding: DispatchBinding): PublicationSettlement | null {
    const row = this.db.prepare("SELECT * FROM publication_settled_holds WHERE operation_id=?").get(binding.operationId);
    if (!row) return null;
    assert(row.binding_json === canonical(binding), "Settled publication binding differs");
    const proof = JSON.parse(String(row.proof_json)) as PublicationSettlement;
    assert(proof.teamId === this.target.teamId && proof.projectId === this.target.projectId &&
      proof.deploymentId === this.target.deploymentId, "Settled publication target differs");
    return proof;
  }
  /** Trusted provider proof only, never an HTTP caller/owner assertion. Keep the
   * complete old hold and proof as a permanent replay tombstone. Native delivery
   * alone is insufficient; the provider must prove its exact request is terminal. */
  settle(binding: DispatchBinding, proof: PublicationSettlement, evidenceId: string, commitContact: () => void) {
    this.assertOwned(binding);
    assert(proof.contract === "kapelle/publication-settlement/v1" &&
      proof.operationId === binding.operationId && proof.bindingHash === digest(binding) &&
      proof.teamId === this.target.teamId && proof.projectId === this.target.projectId &&
      proof.deploymentId === this.target.deploymentId &&
      ["COMPLETED", "NO_CONTACT"].includes(proof.outcome) && /^sha256:[a-f0-9]{64}$/.test(proof.proofHash),
    "Request settlement proof differs");
    opaque(proof.proofRef);
    assert(this.observations(binding).includes(evidenceId), "Native delivery observation required");
    this.transaction(() => {
      this.assertOwned(binding);
      const row = this.saved(binding);
      commitContact();
      this.db.prepare("INSERT INTO publication_settled_holds VALUES (?,?,?,?,?,?)")
        .run(binding.operationId, canonical(binding), canonical(row), canonical(proof), evidenceId, new Date().toISOString());
      this.db.prepare("DELETE FROM publication_project_holds WHERE operation_id=?").run(binding.operationId);
    });
  }
}
