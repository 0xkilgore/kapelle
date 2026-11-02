// Owner bug (live CP, Oct 26): "when is the next EXNA meeting?" with the handbook's "second Thursday": the model called Nov 12,
// 2026 a Wednesday. Weekdays now come from a runtime-computed calendar in every chat turn's system text, in the org's zone.
import { it, expect } from "vitest";
import { calendarBlock, CHAT_RULES, CHAT_RULES_HANDBOOK } from "../src/org/chat/scheduler.js";

it("the calendar block: today in the org's zone, the next 62 days with their weekdays; the rules line points at it", () => {
  const b = calendarBlock(Date.UTC(2026, 9, 26, 15, 0)); // Mon 26 Oct 2026, 10:00 Chicago
  expect(b.startsWith("Calendar (America/Chicago): today is 2026-10-26 Mon. Next days: 2026-10-27 Tue, 2026-10-28 Wed,")).toBe(true);
  expect(b).toContain("2026-11-12 Thu"); // the owner's case: the second Thursday of November 2026
  expect(b).toContain("2026-12-27 Sun");
  expect(b.split(", ").length).toBe(62);
  // Late evening UTC is still the same local day in Chicago (the zone, not UTC, decides "today").
  expect(calendarBlock(Date.UTC(2026, 9, 27, 3, 30))).toContain("today is 2026-10-26 Mon");
  // Across the end of daylight saving (Nov 1, 2026) and a month/year boundary the weekdays stay right.
  expect(calendarBlock(Date.UTC(2026, 11, 30, 18, 0))).toContain("2027-01-01 Fri");
  for (const r of [CHAT_RULES, CHAT_RULES_HANDBOOK]) expect(r).toContain("Use the calendar below for today's date, weekdays and dates; never work out a weekday or a date yourself.");
});
