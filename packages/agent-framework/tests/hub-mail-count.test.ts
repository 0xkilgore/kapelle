// Fable EXNA-PROD mail ruling C-2 (Director GO 2026-10-16): the hub's mail counters reach journald as one content-free
// line, hourly and at shutdown, so Ops can compare them with Resend's dashboard. Fake mail port; no network.
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mailCountLine, startMailCountLog, portMailer } from "../src/hub/hub-launcher.js";
import { MailError } from "../src/hub/auth-mail.js";

it("counts and a fixed label only; never an address, link or token; spool mode logs nothing", async () => {
  let n = 0;
  const pm = portMailer({ async send() { if (++n === 3) throw new MailError("mail_http_422"); } } as never, { exna: "Example Park" });
  for (const to of ["a@example.org", "b@example.org", "c@example.org"])
    await new Promise<void>((r) => pm.mailer({ orgId: "exna", to, kind: "login", link: "https://agent.example.org/o/exna/magic?token=SECRET-TOKEN" } as never, () => r()));
  const line = mailCountLine(pm.stats)!;
  expect(JSON.parse(line)).toEqual({ mail: { sent: 2, failed: 1, lastError: "mail_http_422" } });
  expect(line).not.toMatch(/@|token|https?:|SECRET/i);
  expect(mailCountLine({ sent: 1, failed: 1, lastError: "Bad thing: a@b.test" })).toBe('{"mail":{"sent":1,"failed":1,"lastError":"mail_error"}}');
  expect(mailCountLine(null)).toBeNull();
  const lines: string[] = [];
  const log = startMailCountLog(pm.stats, (l) => lines.push(l), 20);
  await new Promise((r) => setTimeout(r, 70));
  log.stop();
  expect(lines.length).toBeGreaterThanOrEqual(3); // at least two ticks + the shutdown line
  expect(new Set(lines)).toEqual(new Set([line]));
  const quiet: string[] = []; startMailCountLog(null, (l) => quiet.push(l), 5).stop();
  expect(quiet).toEqual([]);
  // The service entrypoint wires it (hourly + at shutdown).
  const serve = readFileSync(new URL("../src/hub/serve.ts", import.meta.url), "utf8");
  expect(serve).toMatch(/startMailCountLog\(h\.mail\)/);
  expect(serve).toMatch(/mailLog\.stop\(\)/);
});
