// Hosted spend ledger (CP agent launch, Fable review §2 "caps"). Before any send, the worst-case cost (pinned rate x margin) is
// RESERVED against the per-run and monthly caps; after the response it is SETTLED on the provider's returned cost, never on the
// estimate. A sent request whose cost is not confirmed (abort/deadline/transport/5xx/missing usage) stays UNSETTLED: it keeps
// counting against the cap and blocks a blind repeat until Ops reconciles it. A request refused before send is released. One
// owner-only JSON file per month, written atomically; a crash leaves reserved/sent entries, which recover as unsettled.
// Unsettled entries are CARRIED into every later month's commitment (a month rollover never forgets them) until Ops
// reconciles each one against the provider's records; status() is the read-only view Ops reads (GET /agents/spend).
import {closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assert} from '../../validation.js';

const entrySchema = z.object({sessionId: z.string().uuid(), profileId: z.string(), reservedUsd: z.number().nonnegative(), state: z.enum(['reserved', 'sent', 'settled', 'released', 'unsettled']),
  costUsd: z.number().nonnegative().nullable(), reason: z.string().nullable(), at: z.string()}).strict();
const monthSchema = z.object({contract: z.literal('kapelle.hosted-spend/v1'), month: z.string().regex(/^\d{4}-\d{2}$/), entries: z.array(entrySchema).max(100_000)}).strict();
export type SpendEntry = z.infer<typeof entrySchema>;
/** What the hosted adapter needs from a spend ledger: the per-host JSON ledger below, or the per-org SQLite outbox. */
export type SpendLedger = Pick<HostedLedger, 'reserve' | 'markSent' | 'settle' | 'release' | 'markUnsettled' | 'entry'>;

export class HostedLedger {
  constructor(readonly dir: string, readonly caps: {monthlyUsd: number}, private readonly now: () => string = () => new Date().toISOString()) {
    mkdirSync(dir, {recursive: true, mode: 0o700});
    const s = lstatSync(dir);
    assert(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o077) === 0, 'hosted_ledger_not_private');
    assert(caps.monthlyUsd > 0 && caps.monthlyUsd <= 10_000, 'hosted_ledger_cap_invalid');
  }
  private file(month: string) { return join(this.dir, `spend-${month}.json`); }
  private month() { return this.now().slice(0, 7); }
  private load(month = this.month()) {
    const f = this.file(month);
    return existsSync(f) ? monthSchema.parse(JSON.parse(readFileSync(f, 'utf8'))) : {contract: 'kapelle.hosted-spend/v1' as const, month, entries: [] as SpendEntry[]};
  }
  private save(m: z.infer<typeof monthSchema>) {
    const f = this.file(m.month), tmp = f + '.' + randomUUID() + '.tmp', fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify(monthSchema.parse(m))); } finally { closeSync(fd); }
    renameSync(tmp, f);
  }
  private months() { return readdirSync(this.dir).map(n => /^spend-(\d{4}-\d{2})\.json$/.exec(n)?.[1]).filter((m): m is string => !!m).sort(); }
  /** Every entry still unsettled, in any month (oldest first). */
  unsettled() { return this.months().flatMap(month => this.load(month).entries.filter(e => e.state === 'unsettled').map(e => ({month, ...e}))); }
  /** Unsettled reservations from months before `month`, still held against the cap. */
  carriedUnsettledUsd(month = this.month()) { return this.unsettled().filter(e => e.month < month).reduce((a, e) => a + e.reservedUsd, 0); }
  /** Committed spend: this month's settled cost + open or unsettled reservations, plus unsettled reservations carried from
   *  earlier months (an unknown outcome is assumed spent until reconciled). */
  committedUsd(month = this.month()) {
    return this.load(month).entries.reduce((a, e) => a + (e.state === 'settled' ? e.costUsd! : e.state === 'released' ? 0 : e.reservedUsd), 0) + this.carriedUnsettledUsd(month);
  }
  /** Ops-readable spend view (no prompts, answers or keys are ever in the ledger). */
  status() {
    const month = this.month(), entries = this.load(month).entries, sum = (f: (e: SpendEntry) => number) => entries.reduce((a, e) => a + f(e), 0);
    return {contract: 'kapelle.hosted-spend-status/v1' as const, month, monthlyCapUsd: this.caps.monthlyUsd,
      settledUsd: sum(e => e.state === 'settled' ? e.costUsd! : 0), openUsd: sum(e => e.state === 'reserved' || e.state === 'sent' ? e.reservedUsd : 0),
      carriedUnsettledUsd: this.carriedUnsettledUsd(month), committedUsd: this.committedUsd(month),
      unsettled: this.unsettled().map(e => ({month: e.month, sessionId: e.sessionId, profileId: e.profileId, reservedUsd: e.reservedUsd, reason: e.reason, at: e.at}))};
  }
  /** Ops reconciliation of ONE unsettled entry against the provider's records (its actual cost; 0 if never billed). */
  reconcile(month: string, sessionId: string, costUsd: number) {
    assert(/^\d{4}-\d{2}$/.test(month) && Number.isFinite(costUsd) && costUsd >= 0 && costUsd <= 1000, 'hosted_reconcile_invalid');
    const m = this.load(month), e = m.entries.find(x => x.sessionId === sessionId);
    assert(e && e.state === 'unsettled', 'hosted_reconcile_not_unsettled');
    e!.state = 'settled'; e!.costUsd = costUsd; e!.reason = 'reconciled:' + (e!.reason ?? 'unknown'); e!.at = this.now(); this.save(m);
  }
  /** Reserve before send; refuses (sending nothing) if the run cap or the monthly cap would be exceeded. */
  reserve(sessionId: string, profileId: string, usd: number, runCapUsd: number) {
    assert(usd <= runCapUsd, 'hosted_run_cap_exceeded');
    const m = this.load();
    assert(!m.entries.some(e => e.sessionId === sessionId) && !this.unsettled().some(e => e.sessionId === sessionId), 'hosted_session_reused');
    assert(this.committedUsd(m.month) + usd <= this.caps.monthlyUsd, 'hosted_monthly_cap_exceeded');
    m.entries.push({sessionId, profileId, reservedUsd: usd, state: 'reserved', costUsd: null, reason: null, at: this.now()}); this.save(m);
  }
  /** The entry's own month file (a request reserved before midnight on the last day settles after it). */
  private update(sessionId: string, f: (e: SpendEntry) => void) {
    const month = [this.month(), ...this.months().reverse()].find(mo => this.load(mo).entries.some(x => x.sessionId === sessionId)) ?? this.month();
    const m = this.load(month), e = m.entries.find(x => x.sessionId === sessionId);
    assert(e, 'hosted_reservation_missing'); f(e!); e!.at = this.now(); this.save(m);
  }
  markSent(sessionId: string) { this.update(sessionId, e => { assert(e.state === 'reserved', 'hosted_reservation_state'); e.state = 'sent'; }); }
  /** Settle on the PROVIDER-RETURNED cost (may exceed the reservation; it is recorded as charged, and the cap sees it). A
   *  definite rejection that reported a cost is settled too, with its rejection reason recorded. */
  settle(sessionId: string, costUsd: number, reason: string | null = null) { this.update(sessionId, e => { assert(e.state === 'sent', 'hosted_reservation_state'); e.state = 'settled'; e.costUsd = costUsd; e.reason = reason; }); }
  release(sessionId: string, reason: string | null = null) { this.update(sessionId, e => { assert(e.state === 'reserved' || e.state === 'sent', 'hosted_reservation_state'); e.state = 'released'; if (reason) e.reason = reason; }); }
  markUnsettled(sessionId: string, reason: string) { this.update(sessionId, e => { if (e.state === 'reserved' || e.state === 'sent') { e.state = 'unsettled'; e.reason = reason; } }); }
  /** At start-up: 'sent' (markSent is durable BEFORE the request leaves) may have been billed, so it is held unsettled; 'reserved'
   *  never left the host and is released. */
  recoverAtStart() {
    for (const month of this.months()) {
      const m = this.load(month); let changed = false;
      for (const e of m.entries) {
        if (e.state === 'sent') { e.state = 'unsettled'; e.reason = 'hosted_outcome_unknown_after_restart'; changed = true; }
        else if (e.state === 'reserved') { e.state = 'released'; e.reason = 'hosted_not_sent_before_restart'; changed = true; }
      }
      if (changed) this.save(m);
    }
  }
  entries(month = this.month()) { return this.load(month).entries; }
  /** One entry by session, in whichever month holds it. */
  entry(sessionId: string) { for (const mo of [this.month(), ...this.months().reverse()]) { const e = this.load(mo).entries.find(x => x.sessionId === sessionId); if (e) return e; } return undefined; }
}
