// LIBRARY files host (Director, named owners): the Caddyfile template's OPTIONAL {{FILES_HOST}} site block. Product owns the template;
// Ops' install.sh caddy-render substitutes {{FILES_HOST}} from hub-config filesHost, or deletes the block when it is absent with
// `sed '/^# FILES-HOST-BEGIN/,/^# FILES-HOST-END$/d'`. Without a files host the result is byte-identical to the template live at
// 361b5128 (3e1b7067); with one, the block proxies that host to the hub (which serves only published drive images there).
// CADDY_BIN (opt-in, the host's caddy) also runs `caddy validate` on both renders.
import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FILES_HOST } from "../src/org/newsletter/render-cp.js";

const TPL = new URL("../deploy/caddy/Caddyfile.template", import.meta.url).pathname;
const LIVE_SHA = "3e1b7067f1d51a476f956c3758e0bd0a5b56edd9ccf1872bbf009f2f03a14447"; // deploy/caddy/Caddyfile.template at 361b5128
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
/** Ops' drop recipe, run as the shell runs it (BSD and GNU sed agree on this range form). */
const dropBlock = (file: string) => execFileSync("sed", ["/^# FILES-HOST-BEGIN/,/^# FILES-HOST-END$/d", file]);
const render = (t: string, files?: string) => (files ? t.replaceAll("{{FILES_HOST}}", files) : t)
  .replaceAll("{{DOMAIN}}", "agent.example.org").replaceAll("{{ACME_EMAIL}}", "ops@example.org");

it("without a files host: the block is deleted and the template is byte-identical to the one live at 361b5128", () => {
  const out = dropBlock(TPL);
  expect(sha(out)).toBe(LIVE_SHA);
  expect(out.toString("utf8")).not.toMatch(/FILES_HOST|FILES-HOST/);
});

it("the block is one marked region at the end, and {{FILES_HOST}} appears only inside it", () => {
  const t = readFileSync(TPL, "utf8"), lines = t.split("\n");
  const b = lines.findIndex((l) => l.startsWith("# FILES-HOST-BEGIN")), e = lines.findIndex((l) => l === "# FILES-HOST-END");
  expect([lines.filter((l) => l.startsWith("# FILES-HOST-BEGIN")).length, lines.filter((l) => l === "# FILES-HOST-END").length]).toEqual([1, 1]);
  expect(b).toBeGreaterThan(0); expect(e).toBe(lines.length - 2); expect(t.endsWith("# FILES-HOST-END\n")).toBe(true);
  lines.forEach((l, i) => { if (l.includes("{{FILES_HOST}}")) expect(i > b && i < e).toBe(true); });
  expect(t.slice(0, t.indexOf("# FILES-HOST-BEGIN"))).toBe(dropBlock(TPL).toString("utf8")); // the rest is untouched
});

it("with a files host: the host's own site block (HSTS, a 1 KB body cap, the hub on loopback) and no placeholder left", () => {
  const out = render(readFileSync(TPL, "utf8"), FILES_HOST);
  expect(out).not.toContain("{{");
  const block = out.slice(out.indexOf(`${FILES_HOST} {`), out.indexOf("# FILES-HOST-END"));
  expect(block).toBe(`${FILES_HOST} {\n\theader Strict-Transport-Security "max-age=31536000"\n\trequest_body {\n\t\tmax_size 1KB\n\t}\n\treverse_proxy 127.0.0.1:8700\n}\n`);
  expect(out.startsWith(render(dropBlock(TPL).toString("utf8")))).toBe(true); // the main site is the same with or without it
});

const CADDY = process.env.CADDY_BIN ?? "";
it.skipIf(!CADDY || !existsSync(CADDY))("caddy validate accepts both renders (CADDY_BIN, the host's version)", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kcaddy-tpl-")));
  try {
    for (const [name, conf] of [["without", render(dropBlock(TPL).toString("utf8"))], ["with", render(readFileSync(TPL, "utf8"), FILES_HOST)]] as const) {
      const f = join(dir, `Caddyfile.${name}`); writeFileSync(f, conf);
      execFileSync(CADDY, ["validate", "--adapter", "caddyfile", "--config", f], { env: { PATH: "/usr/bin:/bin", HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "config") }, stdio: "ignore" });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
