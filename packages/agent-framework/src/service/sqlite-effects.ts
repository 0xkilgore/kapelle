// Lean runtime step 1 (C-2.4, C-4): the per-org effect outbox / spend ledger on the org's authority.sqlite. The SAME state
// machine and rules as the accepted HostedLedger (2a-2d): reserve the worst case against run + monthly caps BEFORE any send;
// `sent` is durable before the external call; settle on the provider-returned cost (a definite rejection with a cost
// settles with its reason); an unknown outcome stays `unsettled`, keeps counting against the cap in every later month
// (carry) and blocks a blind repeat until Ops reconciles that one entry; never-sent reservations are released.
// Each transition is one synchronous write transaction on the authority connection (no await inside, Fable R-2).
import { assert } from "../validation.js";
import type { SpendEntry } from "../agent-kit/hosted/ledger.js";
import type { SqliteAuthority } from "./sqlite-authority.js";

type Row = { key: string; kind: string; profile_id: string; month: string; reserved_usd: number; state: SpendEntry["state"];
  cost_usd: number | null; reason: string | null; at: string };
const entryOf = (r: Row): SpendEntry => ({ sessionId: r.key, profileId: r.profile_id, reservedUsd: r.reserved_usd, state: r.state, costUsd: r.cost_usd, reason: r.reason, at: r.at });

export class SqliteSpendLedger {
  constructor(private readonly a: SqliteAuthority, readonly caps: { monthlyUsd: number }, private readonly now: () => string = () => new Date().toISOString(),
    readonly kind = "hosted-inference") {
    assert(caps.monthlyUsd > 0 && caps.monthlyUsd <= 10_000, "hosted_ledger_cap_invalid");
  }
  private month() { return this.now().slice(0, 7); }
  private row(sessionId: string) { return this.a.db.prepare("SELECT * FROM effects WHERE key=? AND kind=?").get(sessionId, this.kind) as Row | undefined; }
  private committedIn(month: string) {
    const rows = this.a.db.prepare("SELECT * FROM effects WHERE kind=? AND (month=? OR (month<? AND state='unsettled'))").all(this.kind, month, month) as Row[];
    return rows.reduce((n, r) => n + (r.state === "settled" ? r.cost_usd! : r.state === "released" ? 0 : r.reserved_usd), 0);
  }
  committedUsd(month = this.month()) { return this.a.read(() => this.committedIn(month)); }
  carriedUnsettledUsd(month = this.month()) {
    return this.a.read(() => (this.a.db.prepare("SELECT COALESCE(SUM(reserved_usd),0) AS n FROM effects WHERE kind=? AND month<? AND state='unsettled'").get(this.kind, month) as { n: number }).n);
  }
  reserve(sessionId: string, profileId: string, usd: number, runCapUsd: number) {
    assert(usd <= runCapUsd, "hosted_run_cap_exceeded");
    this.a.write(() => {
      assert(!this.a.db.prepare("SELECT 1 FROM effects WHERE key=?").get(sessionId), "hosted_session_reused");
      const month = this.month();
      assert(this.committedIn(month) + usd <= this.caps.monthlyUsd, "hosted_monthly_cap_exceeded");
      this.a.db.prepare("INSERT INTO effects(key,kind,profile_id,month,reserved_usd,state,cost_usd,reason,at) VALUES (?,?,?,?,?,'reserved',NULL,NULL,?)")
        .run(sessionId, this.kind, profileId, month, usd, this.now());
    });
  }
  private move(sessionId: string, from: SpendEntry["state"][], to: SpendEntry["state"], extra: { cost?: number; reason?: string | null } = {}, alsoInTx?: () => void) {
    this.a.write(() => {
      const r = this.row(sessionId);
      assert(r, "hosted_reservation_missing");
      assert(from.includes(r!.state), "hosted_reservation_state");
      this.a.db.prepare("UPDATE effects SET state=?, cost_usd=COALESCE(?,cost_usd), reason=?, at=? WHERE key=?")
        .run(to, extra.cost ?? null, extra.reason === undefined ? r!.reason : extra.reason, this.now(), sessionId);
      alsoInTx?.();
    });
  }
  /** Durable BEFORE the external call: from here the outcome may be billed. `alsoInTx` (synchronous, same connection) commits
   *  with it, e.g. the caller's own "sending" state (transcription F-2: no crash window between the two). */
  markSent(sessionId: string, alsoInTx?: () => void) { this.move(sessionId, ["reserved"], "sent", {}, alsoInTx); }
  settle(sessionId: string, costUsd: number, reason: string | null = null) { this.move(sessionId, ["sent"], "settled", { cost: costUsd, reason }); }
  release(sessionId: string, reason: string | null = null) { this.move(sessionId, ["reserved", "sent"], "released", reason ? { reason } : {}); }
  markUnsettled(sessionId: string, reason: string) {
    this.a.write(() => {
      const r = this.row(sessionId);
      assert(r, "hosted_reservation_missing");
      if (r!.state === "reserved" || r!.state === "sent")
        this.a.db.prepare("UPDATE effects SET state='unsettled', reason=?, at=? WHERE key=?").run(reason, this.now(), sessionId);
    });
  }
  /** Start-up: `sent` may have been billed -> unsettled; `reserved` never left -> released. */
  recoverAtStart() {
    this.a.write(() => {
      this.a.db.prepare("UPDATE effects SET state='unsettled', reason='hosted_outcome_unknown_after_restart', at=? WHERE kind=? AND state='sent'").run(this.now(), this.kind);
      this.a.db.prepare("UPDATE effects SET state='released', reason='hosted_not_sent_before_restart', at=? WHERE kind=? AND state='reserved'").run(this.now(), this.kind);
    });
  }
  /** Ops reconciliation of ONE unsettled entry against the provider's records. */
  reconcile(month: string, sessionId: string, costUsd: number) {
    assert(/^\d{4}-\d{2}$/.test(month) && Number.isFinite(costUsd) && costUsd >= 0 && costUsd <= 1000, "hosted_reconcile_invalid");
    this.a.write(() => {
      const r = this.row(sessionId);
      assert(r && r.month === month && r.state === "unsettled", "hosted_reconcile_not_unsettled");
      this.a.db.prepare("UPDATE effects SET state='settled', cost_usd=?, reason=?, at=? WHERE key=?").run(costUsd, "reconciled:" + (r!.reason ?? "unknown"), this.now(), sessionId);
    });
  }
  entry(sessionId: string) { return this.a.read(() => { const r = this.row(sessionId); return r ? entryOf(r) : undefined; }); }
  entries(month = this.month()) { return this.a.read(() => (this.a.db.prepare("SELECT * FROM effects WHERE kind=? AND month=? ORDER BY rowid").all(this.kind, month) as Row[]).map(entryOf)); }
  unsettled() {
    return this.a.read(() => (this.a.db.prepare("SELECT * FROM effects WHERE kind=? AND state='unsettled' ORDER BY month, rowid").all(this.kind) as Row[])
      .map((r) => ({ month: r.month, ...entryOf(r) })));
  }
  status() {
    const month = this.month(), entries = this.entries(month), sum = (f: (e: SpendEntry) => number) => entries.reduce((n, e) => n + f(e), 0);
    return { contract: "kapelle.hosted-spend-status/v1" as const, month, monthlyCapUsd: this.caps.monthlyUsd,
      settledUsd: sum((e) => (e.state === "settled" ? e.costUsd! : 0)), openUsd: sum((e) => (e.state === "reserved" || e.state === "sent" ? e.reservedUsd : 0)),
      carriedUnsettledUsd: this.carriedUnsettledUsd(month), committedUsd: this.committedUsd(month),
      unsettled: this.unsettled().map((e) => ({ month: e.month, sessionId: e.sessionId, profileId: e.profileId, reservedUsd: e.reservedUsd, reason: e.reason, at: e.at })) };
  }
}
