// local-mlx: the durable RUNTIME-WIDE generation reservation (LOCAL-MLX-ADAPTER-SPEC "Abort and capacity").
// One file per host model service, shared by every instance and surviving Framework restarts:
//   reserved  -> taken, nothing sent yet (only one generation at a time)
//   sent      -> persisted immediately BEFORE the request leaves; a crash here means "uncertain" on the next start
//   uncertain -> the server may still be generating: the runtime is unavailable until controlled service recovery shows a NEW
//                admitted service generation (a health/models answer or elapsed time is not settlement evidence)
// A validated terminal response (or a refusal before send) releases it. The adapter never stops the shared service or
// signals a guessed PID.
import {mkdirSync, lstatSync, openSync, writeSync, closeSync, linkSync, unlinkSync, renameSync, readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';

const recordSchema = z.object({
  contract: z.literal('kapelle.local-runtime-reservation/v1'),
  service: z.string(), serviceGeneration: z.string(), sessionId: z.string().uuid(),
  state: z.enum(['reserved', 'sent', 'uncertain']), at: z.iso.datetime(), reason: z.string().max(100).nullable(),
}).strict();
export type ReservationRecord = z.infer<typeof recordSchema>;

export class RuntimeReservation {
  private readonly file: string;
  constructor(private readonly dir: string, readonly service: string, private readonly now: () => Date = () => new Date()) {
    if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(service)) throw Error('local_reservation_service_invalid');
    mkdirSync(dir, {recursive: true, mode: 0o700});
    const s = lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 || dir.includes('/Dropbox/')) throw Error('local_reservation_dir_not_private');
    this.file = join(dir, service + '.reservation.json');
  }
  read(): ReservationRecord | null {
    if (!existsSync(this.file)) return null;
    return recordSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
  }
  private tmp(record: ReservationRecord) {
    const tmp = this.file + '.' + process.pid + '.' + record.sessionId + '.tmp', fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify(recordSchema.parse(record))); } finally { closeSync(fd); }
    return tmp;
  }
  private record(sessionId: string, serviceGeneration: string, state: ReservationRecord['state'], reason: string | null): ReservationRecord {
    return {contract: 'kapelle.local-runtime-reservation/v1', service: this.service, serviceGeneration, sessionId, state, at: this.now().toISOString(), reason};
  }
  /** Create-only take. Busy (someone else's reserved/sent) and unsettled (uncertain) are distinct refusals; nothing is sent. */
  acquire(sessionId: string, serviceGeneration: string): void {
    const tmp = this.tmp(this.record(sessionId, serviceGeneration, 'reserved', null));
    try { linkSync(tmp, this.file); }
    catch { const held = this.read(); throw Error(held?.state === 'uncertain' ? 'local_runtime_unsettled' : 'local_runtime_busy'); }
    finally { unlinkSync(tmp); }
  }
  private replace(sessionId: string, state: ReservationRecord['state'], reason: string | null) {
    const held = this.read();
    if (!held || held.sessionId !== sessionId) throw Error('local_reservation_not_held');
    renameSync(this.tmp(this.record(sessionId, held.serviceGeneration, state, reason)), this.file);
  }
  /** Immediately before the one request leaves. */
  markSent(sessionId: string) { this.replace(sessionId, 'sent', null); }
  markUncertain(sessionId: string, reason: string) { this.replace(sessionId, 'uncertain', reason); }
  /** Validated terminal response, or a refusal before send. Only the holder releases. */
  release(sessionId: string) {
    const held = this.read();
    if (!held || held.sessionId !== sessionId) throw Error('local_reservation_not_held');
    if (held.state === 'uncertain') throw Error('local_runtime_unsettled');
    unlinkSync(this.file);
  }
  /** Framework start: a request that may have been sent by a previous process is uncertain; one never sent is cleared. */
  recoverAtStart(): ReservationRecord | null {
    const held = this.read();
    if (!held) return null;
    if (held.state === 'reserved') { unlinkSync(this.file); return null; }
    if (held.state === 'sent') this.replace(held.sessionId, 'uncertain', 'restart_after_send');
    return this.read();
  }
  /** Controlled service recovery: settlement is established only by a NEW admitted service generation (the service was
   *  replaced/restarted under host control). The same generation, a health check or elapsed time never clears it. */
  settleByServiceRecovery(sessionId: string, admittedServiceGeneration: string) {
    const held = this.read();
    if (!held || held.sessionId !== sessionId || held.state !== 'uncertain') throw Error('local_reservation_not_uncertain');
    if (admittedServiceGeneration === held.serviceGeneration) throw Error('local_service_recovery_unproven');
    unlinkSync(this.file);
  }
}
