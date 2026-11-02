const chicago = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function parts(instant: Date) {
  return Object.fromEntries(chicago.formatToParts(instant).map((part) => [part.type, part.value]));
}

export function chicagoTaskDate(now = new Date()): string {
  const value = parts(now);
  return `${value.year}-${value.month}-${value.day}`;
}

export function chicagoTaskTime(instant: string | null): string {
  if (!instant) return "09:00";
  const date = new Date(instant);
  const value = parts(date);
  const seconds = date.getUTCSeconds();
  const milliseconds = date.getUTCMilliseconds();
  return `${value.hour}:${value.minute}${seconds || milliseconds ? `:${value.second}${milliseconds ? `.${String(milliseconds).padStart(3, "0")}` : ""}` : ""}`;
}

/** Move the chosen wall-clock time with the Chicago date, including DST changes. */
export function taskInstantForChicagoDateTime(date: string, time: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/u.test(time)) throw new Error("Choose a valid date and time.");
  const [hour, minute, second = "00"] = time.split(":");
  const normalizedTime = `${hour}:${minute}:${second.includes(".") ? second.padEnd(6, "0") : `${second}.000`}`;
  const wall = new Date(`${date}T${normalizedTime}Z`);
  if (!Number.isFinite(wall.getTime()) || wall.toISOString().slice(0, 10) !== date) throw new Error("Choose a valid date and time.");
  const offsets = new Set([-24, 0, 24].map((hours) => {
    const sample = new Date(wall.getTime() + hours * 3600000);
    const value = parts(sample);
    return Date.parse(`${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}Z`) - Math.floor(sample.getTime() / 1000) * 1000;
  }));
  const candidates = [...offsets].map((offset) => new Date(wall.getTime() - offset)).filter((candidate) => {
    const value = parts(candidate);
    return chicagoTaskDate(candidate) === date && `${value.hour}:${value.minute}:${value.second}` === normalizedTime.slice(0, 8);
  }).sort((left, right) => left.getTime() - right.getTime());
  if (!candidates.length) throw new Error("That time does not exist in Chicago on this date. Choose a later time.");
  // On the fall-back date, choose the first occurrence. The UI shows its zone.
  return candidates[0].toISOString();
}
