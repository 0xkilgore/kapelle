// SCHEDULED-TASKS-V1 S1 (design 8cf4853f §3; Fable C-7): one weekly weekday + local HH:MM + IANA timezone, nothing else.
// Node's own Intl timezone data only (no new dependency); the Node/ICU/tzdata versions are recorded with each schedule.
// DST rule: a local time that does not exist (spring-forward gap) runs at the first valid local time afterwards (the instant
// the clocks jump, e.g. 03:00); a local time that occurs twice (fall-back fold) runs at its FIRST occurrence only.
// Never "168 hours later": every occurrence is computed from its own local date.

export type LocalDate = string; // YYYY-MM-DD in the schedule's zone
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/, TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const fmt = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = fmt.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); fmt.set(tz, f); }
  return f;
}
/** Is `tz` an IANA zone Node knows? (A bad zone throws a RangeError in Intl.) */
export function validZone(tz: string) { try { formatter(tz); return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$|^UTC$/.test(tz); } catch { return false; } }
/** The wall clock in `tz` at instant `ms`. */
export function wallAt(tz: string, ms: number) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, seconds: Number(p.second) };
}
/** The zone's UTC offset at instant `ms`, in minutes (local = UTC + offset). */
export function offsetAt(tz: string, ms: number) {
  const w = wallAt(tz, ms), [y, m, d] = w.date.split("-").map(Number), [hh, mm] = w.time.split(":").map(Number);
  return Math.round((Date.UTC(y, m - 1, d, hh, mm, w.seconds) - Math.floor(ms / 1000) * 1000) / 60_000);
}
/** ISO weekday (1 = Monday ... 7 = Sunday) of a calendar date. */
export function isoWeekday(date: LocalDate) { const [y, m, d] = parse(date); const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return w === 0 ? 7 : w; }
export function addDays(date: LocalDate, n: number): LocalDate { const [y, m, d] = parse(date); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function parse(date: LocalDate) { const x = DATE.exec(date); if (!x) throw new Error("schedule_date_invalid"); return [Number(x[1]), Number(x[2]), Number(x[3])]; }

/** The UTC instant of local `date` `time` in `tz`, with the DST rule above. `adjust` says which rule applied. */
export function localToUtc(date: LocalDate, time: string, tz: string): { at: number; adjust: "exact" | "gap" | "fold" } {
  const [y, m, d] = parse(date), t = TIME.exec(time); if (!t) throw new Error("schedule_time_invalid");
  const naive = Date.UTC(y, m - 1, d, Number(t[1]), Number(t[2]));
  const offs = [...new Set([offsetAt(tz, naive - 36 * 3_600_000), offsetAt(tz, naive), offsetAt(tz, naive + 36 * 3_600_000)])];
  const hits = offs.map((o) => naive - o * 60_000).filter((ms) => { const w = wallAt(tz, ms); return w.date === date && w.time === time; }).sort((a, b) => a - b);
  const uniq = [...new Set(hits)];
  if (uniq.length) return { at: uniq[0], adjust: uniq.length > 1 ? "fold" : "exact" };
  // Gap: the first instant after the local time would have been (binary search for the offset change, to the minute).
  let lo = naive - 36 * 3_600_000, hi = naive + 36 * 3_600_000; const after = offsetAt(tz, hi);
  while (hi - lo > 60_000) { const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000; if (offsetAt(tz, mid) === after) hi = mid; else lo = mid; }
  return { at: hi, adjust: "gap" };
}
/** The latest due occurrence at or before `nowMs` for a weekly (weekday, time, tz) rule: its local date and UTC instant. */
export function latestDue(rule: { weekday: number; time: string; timezone: string }, nowMs: number) {
  let date = wallAt(rule.timezone, nowMs).date;
  while (isoWeekday(date) !== rule.weekday) date = addDays(date, -1);
  let due = localToUtc(date, rule.time, rule.timezone).at;
  if (due > nowMs) { date = addDays(date, -7); due = localToUtc(date, rule.time, rule.timezone).at; }
  return { localDate: date, dueMs: due };
}
/** The next `n` due occurrences strictly after `fromMs` (for the approval preview). */
export function nextDue(rule: { weekday: number; time: string; timezone: string }, fromMs: number, n: number) {
  const out: { localDate: LocalDate; dueMs: number; adjust: string }[] = [];
  let date = wallAt(rule.timezone, fromMs).date;
  while (isoWeekday(date) !== rule.weekday) date = addDays(date, 1);
  for (let i = 0; out.length < n && i < n + 2; i++, date = addDays(date, 7)) {
    const r = localToUtc(date, rule.time, rule.timezone);
    if (r.at > fromMs) out.push({ localDate: date, dueMs: r.at, adjust: r.adjust });
  }
  return out;
}
/** What computed these dates (Fable C-7): recorded with each schedule version. */
export const runtimeTime = () => ({ node: process.versions.node, icu: process.versions.icu ?? "none", tz: process.versions.tz ?? "none" });
