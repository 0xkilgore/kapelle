// Package F (Fable FABLE-REVIEW-PACKAGE-F-PLAN.md + delta A carried conditions; Ops' pre-switch check): `kapelle-admin validate-config`
// (read-only, the runtime's own schema) and `render --out` (the production files into a scratch dir), spawned as Ops runs them.
// Also ruling (a): a CP-shaped org.json WITH the nine newsletter.linkHosts loads; a bad linkHosts value refuses.
import { it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { render } from "../deploy/kapelle-admin.js";

const CP_LINK_HOSTS = ["community-centre.example.org", "maps-short.example.net", "maps.google.com", "photos.example.net", "vendor-one.example",
  "video.example.net", "www.example-commons.org", "www.instagram.com", "www.zeffy.com"];
const CP = { org: "exna", label: "Example Park", domain: "agent.example.org", monthlyUsd: 25, installationId: "11111111-2222-4333-8444-555555555555",
  chat: { enable: "on" }, teamTasks: { enable: "on", run: "on" },
  newsletter: { enable: "on", approvers: "owner@example.org", from: "Example Park <newsletter@example.org>", replyTo: "hello@example.org", testFrom: "agent@example.org" },
  website: { repo: "0xkilgore/example-org-website", author: "Kapelle agent <agent@example.org>", previewHosts: "preview.example.net" } };

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "kpf-")));
const run = async (...a: string[]) => {
  const tsx = process.env.KAPELLE_TEST_TSX_CLI!;
  const { execFile } = await import("node:child_process");
  return new Promise<{ code: number; out: any }>((res) => execFile(process.execPath, [tsx, fileURLToPath(new URL("../deploy/kapelle-admin.ts", import.meta.url)), ...a], { timeout: 60_000 },
    (e: any, out) => res({ code: e?.code ?? 0, out: JSON.parse(String(out)) })));
};

it.skipIf(!process.env.KAPELLE_TEST_TSX_CLI)("render --out: the production files (paths inside unprefixed) into a scratch dir; equal to a --root render with the prefix stripped", async () => {
  const out = scratch(), root = scratch(), etc = existsSync("/etc/kapelle") ? readdirSync("/etc/kapelle").sort() : null;
  const r = await run("render", "--org", "exna", "--label", "Example Park", "--domain", CP.domain, "--monthly-usd", "25", "--installation-id", CP.installationId,
    "--chat-enable", "on", "--newsletter-enable", "on", "--newsletter-from", CP.newsletter.from, "--newsletter-reply-to", CP.newsletter.replyTo, "--out", out);
  expect(r).toMatchObject({ code: 0, out: { ok: true, out, orgConfig: join(out, "orgs", "exna.json"), catalog: join(out, "catalog.json"), hubConfig: join(out, "hub-config.json") } });
  expect(readdirSync(out).sort()).toEqual(["catalog.json", "hub-config.json", "orgs"]);
  const o = JSON.parse(readFileSync(join(out, "orgs", "exna.json"), "utf8"));
  expect([o.catalogPath, o.stateRoot, o.hosted.secretFile]).toEqual(["/etc/kapelle/catalog.json", "/var/lib/kapelle/exna/state", "/etc/kapelle/secrets/exna/openrouter.key"]);
  const viaRoot = render({ org: "exna", label: "Example Park", domain: CP.domain, monthlyUsd: 25, installationId: CP.installationId, chat: { enable: "on" },
    newsletter: { enable: "on", from: CP.newsletter.from, replyTo: CP.newsletter.replyTo }, root });
  for (const [a, b] of [[join(out, "catalog.json"), viaRoot.catalog], [join(out, "orgs", "exna.json"), viaRoot.orgConfig], [join(out, "hub-config.json"), viaRoot.hubConfig!]])
    expect(readFileSync(a, "utf8")).toBe(readFileSync(b, "utf8").split(root).join(""));
  expect(existsSync("/etc/kapelle") ? readdirSync("/etc/kapelle").sort() : null).toEqual(etc); // --out touched nothing under /etc
  for (const bad of [["--out", "relative/dir"], ["--out", "/etc/kapelle"], ["--out", out, "--root", root]])
    expect((await run("render", "--org", "exna", "--label", "L", "--domain", CP.domain, "--monthly-usd", "25", ...bad)).code).not.toBe(0);
}, 120_000);

it.skipIf(!process.env.KAPELLE_TEST_TSX_CLI)("validate-config: read-only; a CP-shaped org.json WITH the nine linkHosts loads; unknown key, bad value, bad linkHosts refuse with the path", async () => {
  const out = scratch();
  render({ ...CP, out });
  const file = join(out, "orgs", "exna.json"), base = JSON.parse(readFileSync(file, "utf8"));
  const put = (name: string, v: unknown) => { const f = join(out, name); writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v, null, 1)); return f; };
  const withHosts = put("cp-live.json", { ...base, newsletter: { ...base.newsletter, linkHosts: CP_LINK_HOSTS } });
  const before = statSync(withHosts).mtimeMs, files = readdirSync(out).sort();
  expect(await run("validate-config", withHosts)).toEqual({ code: 0, out: { ok: true } });
  expect([statSync(withHosts).mtimeMs, readdirSync(out).sort()]).toEqual([before, files]); // read-only: nothing written
  expect(await run("validate-config", file)).toEqual({ code: 0, out: { ok: true } });
  const bad = async (v: unknown) => (await run("validate-config", put("bad.json", v))).out;
  expect(await bad({ ...base, surprise: 1 })).toMatchObject({ ok: false, reason: "org_config_invalid", issues: [expect.objectContaining({ path: "" })] });
  expect(await bad({ ...base, newsletter: { ...base.newsletter, testFrom: "agent@elsewhere.example" } }))
    .toEqual({ ok: false, reason: "org_config_invalid", issues: [{ path: "newsletter", message: "newsletter_sender_invalid" }] });
  expect(await bad({ ...base, newsletter: { ...base.newsletter, linkHosts: ["*.evil.test"] } }))
    .toEqual({ ok: false, reason: "org_config_invalid", issues: [{ path: "newsletter", message: "newsletter_link_hosts_invalid" }] });
  expect((await run("validate-config", put("garbage.json", "{not json"))).out).toEqual({ ok: false, reason: "org_config_malformed" });
  expect(await run("validate-config", join(out, "absent.json"))).toEqual({ code: 1, out: { ok: false, reason: "org_config_unreadable" } });
  expect(await run("validate-config")).toEqual({ code: 2, out: { ok: false, reason: "validate_config_usage" } });
  // The secret files the config names are never read: none exist in this scratch render, and it loads.
}, 120_000);
