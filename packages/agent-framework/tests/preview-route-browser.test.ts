// Package E (Fable E-11, 0a932cf2): the draft preview is loaded from its own hub GET, whose response carries its own CSP (a srcdoc
// frame inherits the page's style-src 'self'). In REAL Chromium under the production CSP: a hostile STORED artifact (script,
// onerror, form, outside link, an off-allowlist image) stays inert and the off-allowlist image is never requested; the response
// headers are byte-exact; no session, cross-site and another member are JSON refusals, never HTML.
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { transcriptionWorld } from "./transcription-world.js";
import { ChatTools } from "../src/org/chat/tools.js";
import { Hub } from "../src/hub/hub.js";
import { CP_HOSTS } from "../src/org/newsletter/render-cp.js";
import { ACCESS_TABLE_HASH } from "../src/access/org-access.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && existsSync(PLAYWRIGHT);
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src https://www.example.org https://example.org; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";

describe.skipIf(!enabled)("the draft preview GET (E-11)", () => {
  it("hostile stored HTML is inert, an off-allowlist image is never requested, headers are exact, refusals are JSON", async () => {
    let hits = 0;
    const counter = createServer((_q, r) => { hits++; r.writeHead(200, { "content-type": "image/png" }); r.end(); });
    await new Promise<void>((ok) => counter.listen(0, "127.0.0.1", () => ok()));
    const port = (counter.address() as any).port;
    const w = await transcriptionWorld({ chat: {} });
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    try {
      // One CP-allowlist source of truth for the header; ACCESS_TABLE_HASH unchanged (no new action).
      expect(Hub.PREVIEW_CSP).toBe(CSP);
      expect(CSP).toContain("img-src " + CP_HOSTS.map((h) => "https://" + h).join(" ") + ";");
      expect(ACCESS_TABLE_HASH.slice(7, 15)).toBe("0c125e32"); // LIBRARY L1+L2 moved it (was a8ad1844), then J2 chat.draft.share; this CSP is unchanged
      expect(readFileSync(new URL("../src/hub/ui/app.js", import.meta.url), "utf8")).not.toContain("srcdoc"); // E-11.4: the srcdoc path is gone
      const api = (p: string, b: unknown, c = w.robin) => w.post(`/o/exna/api/${p}`, b, c);
      const conv = (await api("chat/conversation/create", {})).result.conversationId;
      const tools = new ChatTools(w.org.sqlite, { folder: w.cfg.folder, stateRoot: w.cfg.stateRoot, envelopeFor: () => ({ envelopeId: "env_" + "a".repeat(32), snapshotHash: "x" }) });
      const ctx = { turnId: "turn_" + randomUUID().replaceAll("-", ""), conversationId: conv, memberId: "m", scope: "member" as const };
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true }); writeFileSync(join(w.cfg.folder, "members/notes/n.md"), "# N\nx\n");
      await tools.begin(ctx);
      const v = JSON.parse(((await tools.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content: { title: "T", sections: [{ heading: "H", body: "B" }], sources: [{ path: "members/notes/n.md", line: 2 }] } }), ctx)) as any).content);
      await tools.call("render_newsletter_preview", JSON.stringify({ artifactId: v.artifactId, version: 1 }), ctx);
      // Plant a HOSTILE stored rendering (as if a renderer bug let markup through): the response's CSP must still neuter it.
      const hostile = `<!doctype html><html><head><title>t</title></head><body><h2 style="color:rgb(1, 2, 3)">Hi</h2>` +
        `<script>document.title="pwned"; parent.document.title="pwned"</script><img src="x" onerror="parent.document.title='pwned'">` +
        `<img src="http://127.0.0.1:${port}/off.png"><form action="http://127.0.0.1:${port}/f" method="post"><input name="a" value="1"><button id="go">go</button></form>` +
        `<a id="out" href="http://127.0.0.1:${port}/out" target="_top">out</a></body></html>`;
      const hsha = createHash("sha256").update(hostile).digest("hex");
      writeFileSync(join(w.cfg.stateRoot, "chat", "artifacts", conv, v.artifactId, `v1.${hsha}.html`), hostile);
      w.org.sqlite.write(() => w.org.sqlite.db.prepare("UPDATE chat_artifact_versions SET html_sha256=? WHERE artifact_id=? AND version=1").run(hsha, v.artifactId));
      const url = `${w.url}/o/exna/preview?conversationId=${conv}&artifactId=${v.artifactId}&version=1`;
      // d. byte-exact headers on the GET (with the member's session)
      const get = (cookie: string | null, extra: Record<string, string> = {}) => fetch(url, { headers: { ...(cookie ? { cookie } : {}), ...extra }, redirect: "manual" });
      const ok = await get(w.robin);
      expect(ok.status).toBe(200);
      expect([ok.headers.get("content-type"), ok.headers.get("content-security-policy"), ok.headers.get("x-content-type-options"), ok.headers.get("cache-control"), ok.headers.get("referrer-policy")])
        .toEqual(["text/html; charset=utf-8", CSP, "nosniff", "private, no-store", "no-referrer"]);
      expect(ok.headers.get("access-control-allow-origin")).toBeNull();
      expect(await ok.text()).toBe(hostile);
      // e. refusals are JSON, never HTML
      for (const [r, status, error] of [[await get(null), 401, "hub_no_session"], [await get(w.robin, { "sec-fetch-site": "cross-site" }), 403, "hub_cross_site_refused"],
        [await get(w.alex), 404, null]] as const) {
        expect([r.status === status || (error === null && r.status >= 400), (r.headers.get("content-type") ?? "").includes("text/html")]).toEqual([true, false]);
        const j = await r.json(); expect(j.ok).toBe(false); if (error) expect(j.error).toBe(error);
      }
      expect((await fetch(`${w.url}/o/exna/preview?conversationId=${conv}&artifactId=${v.artifactId}`, { headers: { cookie: w.robin } })).status).toBe(400); // required params
      // b/c. in the real browser: styled, inert, the off-allowlist image never requested, no navigation, no submission
      const c = await browser.newContext({ viewport: { width: 1200, height: 900 } }), page = await c.newPage(), [name, value] = w.robin.split("=");
      await c.addCookies([{ name, value, url: w.url }]);
      const errors: string[] = []; page.on("console", (x: any) => { if (x.type() === "error") errors.push(x.text()); });
      await page.goto(`${w.url}/o/exna/#chat`);
      await page.evaluate((u: string) => { const f = document.createElement("iframe"); f.setAttribute("sandbox", ""); f.setAttribute("referrerpolicy", "no-referrer"); f.className = "preview"; f.src = u; document.body.append(f); }, url.slice(w.url.length));
      const inner = page.frameLocator("iframe.preview");
      await inner.getByText("Hi").waitFor();
      expect(await inner.locator("h2").evaluate((e: any) => getComputedStyle(e).color)).toBe("rgb(1, 2, 3)"); // inline style applied
      await inner.locator("#go").click({ timeout: 2000 }).catch(() => {}); await inner.locator("#out").click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(500);
      expect(await page.title()).not.toMatch(/pwned/);
      expect(page.url()).toBe(`${w.url}/o/exna/#chat`); // no top navigation
      expect(hits).toBe(0); // the off-allowlist image, the form and the link reached nothing
      // (CSP violations here are the hostile content being refused, as intended; the styled v3 run has zero: chat-browser.test.)
    } finally { await browser.close(); await w.close(); counter.close(); }
  }, 120_000);
});
