// Newsletter slice 2, S2-c (Fable R-8, R-9): the release card in REAL Chromium under the hub's production CSP, with fake data:
// a reviewer with an authenticator prepares a release from a previewed chat draft, sends a (preview) test to herself, and the
// approval is refused in words because a preview cannot unlock a release. The code field is cleared after use. Also the Ops
// history import (validated, counts only) and the card view's role gate. Renders with NEWSLETTER_SHOTS. Runs with Playwright.
import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { transcriptionWorld } from "./transcription-world.js";
import { ChatTools } from "../src/org/chat/tools.js";
import { base32Decode, hotp, totpStep } from "../src/access/totp.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && existsSync(PLAYWRIGHT);

describe.skipIf(!enabled)("newsletter release card in a real browser (S2-c)", () => {
  it("prepare -> card -> Send me a test (preview) -> approve refused in words; history import; view role gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "knl-card-")), kf = join(dir, "totp.key"), tk = join(dir, "resend-test.key");
    writeFileSync(kf, randomBytes(32).toString("base64"), { mode: 0o600 }); chmodSync(kf, 0o600);
    writeFileSync(tk, "re_" + "B".repeat(30), { mode: 0o600 }); chmodSync(tk, 0o600);
    const sent: any[] = [];
    const fetch = async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: "rs-" + sent.length }), { status: 200 }); };
    const w = await transcriptionWorld({ label: "Example Park", chat: {}, newsletterTestFetch: fetch, newsletter: { totpKeyFile: kf, approvers: ["robin@exna.test"],
      from: "Example Park Neighborhood Association <newsletter@example.org>", replyTo: "hello@example.org", testFrom: "Example Park agent <agent@example.org>", testKeyFile: tk } });
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.NEWSLETTER_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    try {
      // R-9: the Ops history import: validated, explicit `complete`, counts only.
      expect((await w.ops("/ops/newsletter/history/import", { entries: [{ digest: "x", slug: "2026-10-07-october", source: "historical" }], complete: true })).error).toBe("newsletter_history_import_invalid");
      expect((await w.ops("/ops/newsletter/history/import", { entries: [] })).error).toBe("newsletter_history_import_invalid");
      expect((await w.ops("/ops/newsletter/history/import", { entries: [{ digest: "sha256:" + "b".repeat(64), slug: "2026-10-07-october", source: "historical", to: "x" }], complete: true })).error)
        .toBe("newsletter_history_import_invalid");
      expect(await w.ops("/ops/newsletter/history/import", { entries: [{ digest: "sha256:" + "b".repeat(64), slug: "2026-10-07-october", source: "historical" }], complete: true }))
        .toEqual({ ok: true, received: 1, added: 1, total: 1, complete: true });
      w.org.newsletter!.recordTransfer({ installationId: w.org.sqlite.identity.installationId, frozenAt: new Date().toISOString(), attestedBy: "owner" });
      // F6-S: a server-side read records the sync (synthetic evidence here; newsletter-f6-evidence covers the walk).
      w.org.newsletter!.recordServerSuppressionSync({ audienceIdSha256: "a".repeat(64), total: 3, unsubscribed: 0, eligible: 3, contactsSha256: "b".repeat(64) }, (at) => "evidence " + at);
      // Robin enrolls an authenticator.
      const link = (await w.ops("/ops/totp/enroll", { email: "robin@exna.test" })).link as string, token = new URLSearchParams(link.split("#totp?")[1]).get("token");
      const s = (await w.post("/o/exna/api/totp/enroll/start", { token }, w.robin)).result, seed = base32Decode(s.secret.replaceAll(" ", "")), c = totpStep(Date.now());
      expect((await w.post("/o/exna/api/totp/enroll/confirm", { code1: hotp(seed, c - 1), code2: hotp(seed, c) }, w.robin)).ok).toBe(true);
      // A previewed newsletter version in Robin's chat.
      mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
      writeFileSync(join(w.cfg.folder, "members/notes/2026-10-08.v1.md"), "# October\nBlock Party drew over 300 neighbors.\n");
      const conv = (await w.post("/o/exna/api/chat/conversation/create", {}, w.robin)).result.conversationId;
      const tools = new ChatTools(w.org.sqlite, { folder: w.cfg.folder, stateRoot: w.cfg.stateRoot, envelopeFor: () => ({ envelopeId: "env_" + "c".repeat(32), snapshotHash: "x" }) });
      const ctx = { turnId: "turn_" + randomUUID().replaceAll("-", ""), conversationId: conv, memberId: "m", scope: "member" as const };
      await tools.begin(ctx);
      const v = JSON.parse(((await tools.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content: { title: "November in Example Park",
        sections: [{ heading: "Block Party", body: "Over 300 neighbors came out." }], sources: [{ path: "members/notes/2026-10-08.v1.md", line: 2 }] } }), ctx)) as any).content);
      await tools.call("render_newsletter_preview", JSON.stringify({ artifactId: v.artifactId, version: v.version }), ctx);
      // The card view is for reviewers/admins.
      expect((await w.post("/o/exna/api/newsletter/release/view", { releaseId: "nr_" + "1".repeat(32) }, w.alex)).error).toBe("access_role_not_permitted");

      const bctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await bctx.newPage(), [name, value] = w.robin.split("=");
      await bctx.addCookies([{ name, value, url: w.url }]);
      const errors: string[] = []; page.on("console", (x: any) => { if (x.type() === "error") errors.push(x.text()); });
      await page.goto(`${w.url}/o/exna/#chat`);
      // USABILITY v1: with a test sender configured the draft card offers "Send me a test" (prepares the release and sends the
      // test in one step); the release card follows with the test recorded.
      expect(await page.locator(".card.artifact").getByRole("button", { name: "Prepare release" }).count()).toBe(0);
      await page.locator(".card.artifact").getByRole("button", { name: "Send me a test" }).click();
      await page.getByRole("heading", { name: "Release" }).waitFor();
      await page.getByText("Test sent to robin@exna.test. Check your inbox.").waitFor();
      await page.getByText("Subscriber list not connected yet").waitFor();
      expect(await page.locator(".release dd.release-f6").textContent()).toMatch(/^Synced .+ \(on CP\)$/); // F6S-2
      await page.getByText("preview only: it can't unlock a release", { exact: false }).waitFor();
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toEqual(["robin@exna.test"]);
      // Without the attestation: refused in words, nothing minted.
      await page.getByRole("textbox", { name: "Authenticator code" }).fill(hotp(seed, c + 1));
      await page.getByRole("button", { name: "Approve and send" }).click();
      await page.getByText("Confirm you received and checked the latest test.").waitFor();
      expect(await page.getByRole("textbox", { name: "Authenticator code" }).inputValue()).toBe(""); // cleared, never kept
      expect(w.org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM access_challenges WHERE action='newsletter.send'").get()).toEqual({ n: 0 });
      // With it: the runtime refuses because the test was a preview (it never unlocks a release).
      const attest = page.getByRole("checkbox");
      await attest.check();
      expect(await page.locator(".release label.attest").textContent()).toMatch(/^ I received the latest test of this exact newsletter and checked it\. \(content [a-f0-9]{12}\)$/);
      await page.getByRole("textbox", { name: "Authenticator code" }).fill(hotp(seed, c + 1));
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "release-card-1440.png"), fullPage: true });
      await page.getByRole("button", { name: "Approve and send" }).click();
      await page.getByText("That test was a preview. A release needs a test sent the release way.").waitFor();
      expect(await page.getByRole("textbox", { name: "Authenticator code" }).inputValue()).toBe("");
      expect(w.org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM newsletter_effects").get()).toEqual({ n: 0 });
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "release-card-refused-1440.png"), fullPage: true });
      expect(errors.filter((e) => /Content Security Policy|Refused/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
