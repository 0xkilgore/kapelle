// Newsletter slice 2, S2-a (PLAN-NEWSLETTER-SLICE2; Fable conflicts 1-2, answer 3, R-1..R-5, R-10): a release frozen from a
// reviewed chat draft, the content vs release digest, "Send me a test" by the ORG RUNTIME (its own key copy, never the hub)
// to the member's own verified address, cooldown and caps, preview vs release path, and the approval attestation.
// No network: a fake fetch stands in for https://api.resend.com/emails.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { transcriptionWorld } from "./transcription-world.js";
import { ChatTools } from "../src/org/chat/tools.js";
import { contentDigest, releaseDigest, UNSUB_TOKEN, UNSUB_ANCHOR, PREVIEW_UNSUB, type ReleasePackage } from "../src/org/newsletter/release.js";
import { RESEND_SEND_URL } from "../src/mail/resend-send.js";
import { render } from "../deploy/kapelle-admin.js";
import { FakeResend } from "../src/org/newsletter/fake-resend.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const PKG = { slug: "2026-11-04-november", subject: "November", testSubject: "[TEST] November", from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org",
  html: "<p>Hi</p>", text: "Hi", renderer: "kapelle.newsletter-renderer/v2", images: [], listId: "aud-1" };

it("answer 3: the content digest ignores the recipient snapshot; the release digest does not", () => {
  const a: ReleasePackage = { ...PKG, recipientsSha: "sha256:" + "1".repeat(64), recipientCount: 3, recipientsKnown: true };
  const b: ReleasePackage = { ...PKG, recipientsSha: "sha256:" + "2".repeat(64), recipientCount: 4, recipientsKnown: true };
  expect(contentDigest(a)).toBe(contentDigest(b));
  expect(releaseDigest(a)).not.toBe(releaseDigest(b));
  expect(contentDigest({ ...a, subject: "December" })).not.toBe(contentDigest(a));
});

it("R-10 render: --newsletter-test-from adds the test key to secretsExpected (only then); the sender facts land in the config", () => {
  const root = mkdtempSync(join(tmpdir(), "knl-render-"));
  try {
    const base = { org: "exna", label: "Example Park", domain: "agent.example.org", monthlyUsd: 15, root, intake: "none" as const };
    expect(render({ ...base, newsletter: { enable: "on" } }).secretsExpected.some((p) => p.endsWith("resend-test.key"))).toBe(false);
    const r = render({ ...base, newsletter: { enable: "on", from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org", testFrom: "Example Park agent <agent@example.org>" } });
    expect(r.secretsExpected.map((p) => p.replace(root, ""))).toContain("/etc/kapelle/secrets/exna/resend-test.key");
    expect(JSON.parse(readFileSync(r.orgConfig, "utf8")).newsletter).toMatchObject({ from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org",
      testFrom: "Example Park agent <agent@example.org>", testKeyFile: root + "/etc/kapelle/secrets/exna/resend-test.key" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe.skipIf(!enabled)("release from a draft + Send me a test (S2-a)", () => {
  async function setup(o: { configured?: boolean; perMember?: number; perOrg?: number; release?: boolean; imageFetch?: unknown; testFrom?: string; noList?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "knl-t-")), kf = join(dir, "resend-test.key"), rk = join(dir, "resend-release.key");
    writeFileSync(kf, "re_" + "A".repeat(30), { mode: 0o600 }); chmodSync(kf, 0o600);
    writeFileSync(rk, "re_" + "C".repeat(30), { mode: 0o600 }); chmodSync(rk, 0o600);
    const sent: { url: string; headers: Record<string, string>; body: any }[] = [];
    let reply: (() => Promise<Response>) | null = null;
    const fetch = async (url: string, init: any) => { sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return reply ? reply() : new Response(JSON.stringify({ id: "rs-" + sent.length }), { status: 200, headers: { "content-type": "application/json" } }); };
    // S3-c: a release configuration starts the executor and reads the audience: a FAKE Resend behind both (never the network).
    const resend = new FakeResend(); resend.setContacts(3);
    const w = await transcriptionWorld({ chat: {}, newsletterProviderFetch: resend.fetch, newsletter: { totpKeyFile: "/nonexistent/totp.key", approvers: ["robin@exna.test"],
      ...(o.configured === false ? {} : { from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org", testFrom: o.testFrom ?? "Example Park agent <agent@example.org>", testKeyFile: kf }),
      ...(o.release ? { releaseKeyFile: rk, ...(o.noList ? {} : { listId: "aud_exna" }) } : {}),
      testsPerMemberPerDay: o.perMember ?? 6, testsPerDay: o.perOrg ?? 12 }, newsletterTestFetch: fetch, ...(o.imageFetch ? { newsletterImageFetch: o.imageFetch } : {}) });
    const api = (p: string, b: unknown, c = w.robin) => w.post(`/o/exna/api/${p}`, b, c);
    // A reviewed newsletter version with a rendered preview in ROBIN's conversation (the chat tools, as a draft turn does).
    mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
    writeFileSync(join(w.cfg.folder, "members/notes/2026-10-08.v1.md"), "# October\nBlock Party drew over 300 neighbors.\n");
    const conv = (await api("chat/conversation/create", {})).result.conversationId;
    const tools = new ChatTools(w.org.sqlite, { folder: w.cfg.folder, stateRoot: w.cfg.stateRoot, envelopeFor: () => ({ envelopeId: "env_" + "a".repeat(32), snapshotHash: "x" }) });
    const ctx = { turnId: "turn_" + randomUUID().replaceAll("-", ""), conversationId: conv, memberId: "m", scope: "member" as const };
    await tools.begin(ctx);
    const v = JSON.parse(((await tools.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content: { title: "November in Example Park",
      sections: [{ heading: "Block Party", body: "Over 300 neighbors came out." }], sources: [{ path: "members/notes/2026-10-08.v1.md", line: 2 }] } }), ctx)) as any).content);
    return { w, api, conv, tools, ctx, v, sent, resend, rk, setReply: (f: (() => Promise<Response>) | null) => { reply = f; }, close: async () => { await w.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it("prepare from a draft (R-4): needs the rendered preview and read access; frozen content with the unsubscribe placeholder; idempotent", async () => {
    const s = await setup();
    try {
      const { api, conv, v } = s;
      expect((await api("newsletter/release/prepare", { conversationId: conv, artifactId: v.artifactId, version: v.version })).error).toBe("newsletter_draft_unavailable"); // no preview yet
      await s.tools.call("render_newsletter_preview", JSON.stringify({ artifactId: v.artifactId, version: v.version }), s.ctx);
      expect((await api("newsletter/release/prepare", { conversationId: conv, artifactId: v.artifactId, version: v.version }, s.w.alex)).error).toBe("access_role_not_permitted"); // N-2
      expect((await api("newsletter/release/prepare", { conversationId: conv, artifactId: v.artifactId, version: v.version }, s.w.admin)).error).toBe("chat_conversation_unknown"); // not readable
      const r = (await api("newsletter/release/prepare", { conversationId: conv, artifactId: v.artifactId, version: v.version })).result;
      expect(r).toMatchObject({ releaseId: expect.stringMatching(/^nr_/), recipientCount: 0, recipientsKnown: false });
      const pkg = JSON.parse((s.w.org.sqlite.db.prepare("SELECT package FROM newsletter_releases WHERE id=?").get(r.releaseId) as any).package);
      expect(pkg).toMatchObject({ subject: "November in Example Park", testSubject: "[TEST] November in Example Park", from: "EXNA <newsletter@example.org>",
        slug: expect.stringMatching(/^\d{4}-\d{2}-\d{2}-november-in-example-org$/), renderer: "kapelle.newsletter-renderer/v3;images=2;ol=1;links=3", links: [] });
      // Package E (Fable E-2): every image the v3 HTML references (the site emblem + the 4-photo strip) is bound by its bytes.
      expect(pkg.images.map((i: any) => i.url)).toEqual(["https://www.example.org/images/brand/example-org-emblem.png",
        ...["ice-cream-social-header", "neighborhood-4822-header", "neighborhood-5829-header", "pickleball-courts-open-newsletter"].map((n) => `https://www.example.org/newsletter/2026-09/${n}.jpg`)]);
      for (const i of pkg.images) expect(i.sha256).toBe("sha256:" + createHash("sha256").update("IMG:" + i.url).digest("hex"));
      expect(pkg.html).toContain(UNSUB_ANCHOR); // v3: the template's own footer carries the placeholder (once)
      expect(pkg.html.split(UNSUB_TOKEN).length).toBe(2);
      expect(pkg.text).toContain("Block Party\n\nOver 300 neighbors came out.");
      expect(pkg.text.endsWith(`Unsubscribe: ${UNSUB_TOKEN}\n`)).toBe(true);
      expect(r.contentDigest).toBe(contentDigest(pkg));
      expect((await api("newsletter/release/prepare", { conversationId: conv, artifactId: v.artifactId, version: v.version })).result.releaseId).toBe(r.releaseId);
    } finally { await s.close(); }
  });

  // Package E (Fable E-2): a test re-runs the image preflight and compares with the bytes prepare bound. A replaced header photo
  // refuses with newsletter_image_changed (distinct from "unserved") and records the failed preflight; a gone one is "unserved".
  it("test-time image re-check: replaced -> newsletter_image_changed, gone -> newsletter_images_unserved; nothing is sent", async () => {
    let mode: "same" | "replaced" | "gone" = "same";
    const imageFetch = async (url: string, init: RequestInit) => mode === "gone" ? new Response(null, { status: 404 })
      : new Response(init.method === "HEAD" ? null : Buffer.from((mode === "replaced" && url.endsWith("neighborhood-4822-header.jpg") ? "NEW:" : "IMG:") + url), { status: 200, headers: { "content-type": "image/jpeg" } });
    const s = await setup({ imageFetch });
    try {
      await s.tools.call("render_newsletter_preview", JSON.stringify({ artifactId: s.v.artifactId, version: s.v.version }), s.ctx);
      const r = (await s.api("newsletter/release/prepare", { conversationId: s.conv, artifactId: s.v.artifactId, version: s.v.version })).result;
      mode = "replaced";
      expect((await s.api("newsletter/test", { releaseId: r.releaseId })).error).toBe("newsletter_image_changed");
      expect(s.sent).toEqual([]);
      expect((s.w.org.sqlite.db.prepare("SELECT ok FROM newsletter_preflights WHERE digest=?").get(r.contentDigest) as any).ok).toBe(0);
      mode = "gone";
      expect((await s.api("newsletter/test", { releaseId: r.releaseId })).error).toBe("newsletter_images_unserved");
      mode = "same";
      expect((await s.api("newsletter/test", { releaseId: r.releaseId })).result).toMatchObject({ state: "sent" });
      expect((s.w.org.sqlite.db.prepare("SELECT ok, images FROM newsletter_preflights WHERE digest=?").get(r.contentDigest) as any).ok).toBe(1);
    } finally { await s.close(); }
  });

  // Fable F-1 / E-6': prepare refuses a v3 rendering whose footer is not exactly one triple-brace anchor href (nothing is stored).
  it("F-1: prepare refuses a v3 html with no unsubscribe anchor, or with the double-brace form, as newsletter_unsubscribe_invalid", async () => {
    const s = await setup();
    try {
      const before = (s.w.org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM newsletter_releases").get() as any).n;
      for (const html of ["<!doctype html><html><body><p>Hi</p></body></html>", '<!doctype html><html><body><p>Hi</p><a href="{{RESEND_UNSUBSCRIBE_URL}}">Unsubscribe</a></body></html>'])
        await expect(s.w.org.newsletter!.prepareDraft({ title: "Hi", html, text: "Hi", renderer: "kapelle.newsletter-renderer/v3" })).rejects.toMatchObject({ message: "newsletter_unsubscribe_invalid" });
      expect((s.w.org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM newsletter_releases").get() as any).n).toBe(before);
    } finally { await s.close(); }
  });

  it("Send me a test (R-1..R-3): own address only, [TEST] subject, inert unsubscribe sentence, Idempotency-Key = test id, preview path; the hub sends nothing", async () => {
    const s = await setup();
    try {
      const { api, conv, v, sent } = s;
      await s.tools.call("render_newsletter_preview", JSON.stringify({ artifactId: v.artifactId, version: v.version }), s.ctx);
      const r = (await api("newsletter/release/prepare", { conversationId: conv, artifactId: v.artifactId, version: v.version })).result;
      expect((await api("newsletter/test", { releaseId: r.releaseId }, s.w.alex)).error).toBe("access_role_not_permitted");
      // Package E (Ops, 24 Oct): the flag follows the role newsletter.test admits; a contributor is never offered the button.
      const me = async (cookie: string) => (await s.w.post("/o/exna/api/member/me", {}, cookie)).result;
      expect([(await me(s.w.admin)).newsletterTest, (await me(s.w.robin)).newsletterTest, (await me(s.w.alex)).newsletterTest]).toEqual([true, true, false]);
      const t = (await api("newsletter/test", { releaseId: r.releaseId, to: "someone-else@example.org" })).result; // an address in the body is ignored
      expect(t).toMatchObject({ testId: expect.stringMatching(/^nt_/), state: "sent", path: "preview", to: "robin@exna.test", contentDigest: r.contentDigest });
      expect(sent).toHaveLength(1);
      expect(sent[0].url).toBe(RESEND_SEND_URL);
      expect(sent[0].headers["idempotency-key"]).toBe(t.testId);
      expect(sent[0].body).toMatchObject({ from: "Example Park agent <agent@example.org>", to: ["robin@exna.test"], subject: "[TEST] November in Example Park" });
      expect(sent[0].body.reply_to).toBeUndefined(); // a preview carries no release Reply-To
      expect(sent[0].body.html).toContain(PREVIEW_UNSUB); // the whole unsubscribe anchor became the inert sentence (R-3)
      expect(sent[0].body.html).not.toContain(">Unsubscribe</a>");
      expect(sent[0].body.html).not.toContain(UNSUB_TOKEN);
      expect(sent[0].body.text).toContain(PREVIEW_UNSUB);
      expect(s.w.mail.filter((m: any) => JSON.stringify(m).includes("[TEST]"))).toEqual([]); // B2: the hub's mail port never carries it
      // (A preview never unlocks a release: asserted with a real authenticator in newsletter-release.test.ts.)
      // Cooldown: a second test inside five minutes is refused; nothing is sent.
      expect((await api("newsletter/test", { releaseId: r.releaseId })).error).toBe("newsletter_test_cooldown");
      expect(sent).toHaveLength(1);
    } finally { await s.close(); }
  });

  // Fable E-10 ruling (574d8b5d) (b): tests ALWAYS use the sending-only TEST key; the path is "release" iff the test ADDRESS
  // equals the release From's address (the one E-9 extraction; CP's real strings: a bare testFrom vs a display-name From) and the
  // list is configured; the email then carries the release From verbatim. The full-access release key is never read by a test.
  it("E-10 (b): the release path with CP's two strings, signed by the TEST key, the release From verbatim; the release key file is never read; F-4 unchanged", async () => {
    const s = await setup({ release: true, testFrom: "newsletter@example.org" });
    try {
      const { api, conv, v, sent, w } = s;
      await s.tools.call("render_newsletter_preview", JSON.stringify({ artifactId: v.artifactId, version: v.version }), s.ctx);
      const r = (await api("newsletter/release/prepare", { conversationId: conv, artifactId: v.artifactId, version: v.version })).result;
      expect(r).toMatchObject({ recipientCount: 3, recipientsKnown: true }); // S3-c: prepare read the audience fresh
      w.org.sqlite.write(() => w.org.sqlite.db.prepare("INSERT INTO newsletter_tests(id,digest,to_email,received_at,path,state) VALUES ('nt_old','x','robin@exna.test','2026-01-01T00:00:00.000Z','preview','sent')").run());
      chmodSync(s.rk, 0o000); // (prepare reads the audience with the release key; the TEST SEND must not need it at all)
      const t = (await api("newsletter/test", { releaseId: r.releaseId })).result;
      expect(t).toMatchObject({ path: "release", state: "sent", to: "robin@exna.test" });
      expect(sent[0].body.from).toBe("EXNA <newsletter@example.org>"); // the release From verbatim (display name + address)
      expect(sent[0].headers.authorization).toBe("Bearer re_" + "A".repeat(30)); // the TEST key, never the release key
      expect(sent[0].body.reply_to).toBe("hello@example.org");
      expect(sent[0].body.html).toContain(PREVIEW_UNSUB);
      expect(sent[0].body.html).not.toContain(UNSUB_TOKEN);
      expect((w.org.sqlite.db.prepare("SELECT path FROM newsletter_tests WHERE id='nt_old'").get() as any).path).toBe("preview");
      expect((await api("newsletter/release/view", { releaseId: r.releaseId })).result).toMatchObject({ testPath: "release", test: { path: "release" } });
    } finally { chmodSync(s.rk, 0o600); await s.close(); }
  });
  it("E-10 (b): a different address on the same domain, or no list configured, is a PREVIEW test (it can never unlock a release)", async () => {
    for (const o of [{ release: true, testFrom: "Example Park agent <agent@example.org>" }, { testFrom: "newsletter@example.org" }]) { // the 2nd: no list (and so no release key)
      const s = await setup(o);
      try {
        await s.tools.call("render_newsletter_preview", JSON.stringify({ artifactId: s.v.artifactId, version: s.v.version }), s.ctx);
        const r = (await s.api("newsletter/release/prepare", { conversationId: s.conv, artifactId: s.v.artifactId, version: s.v.version })).result;
        const t = (await s.api("newsletter/test", { releaseId: r.releaseId })).result;
        expect([o, t.path, s.sent[0].body.from, s.sent[0].headers.authorization]).toEqual([o, "preview", o.testFrom, "Bearer re_" + "A".repeat(30)]);
      } finally { await s.close(); }
    }
  });

  it("caps per member and per org survive as rows; a definite refusal keeps the allowance, an unknown outcome counts; not configured refuses", async () => {
    const s = await setup({ perMember: 2, perOrg: 3 });
    try {
      const { api, conv, v, w } = s;
      await s.tools.call("render_newsletter_preview", JSON.stringify({ artifactId: v.artifactId, version: v.version }), s.ctx);
      const r = (await api("newsletter/release/prepare", { conversationId: conv, artifactId: v.artifactId, version: v.version })).result;
      const unCool = () => w.org.sqlite.db.prepare("UPDATE newsletter_tests SET received_at=?").run(new Date(Date.now() - 10 * 60_000).toISOString());
      s.setReply(async () => new Response(JSON.stringify({ name: "validation_error" }), { status: 422 }));
      expect((await api("newsletter/test", { releaseId: r.releaseId })).error).toBe("newsletter_test_refused"); // provably not sent: no allowance used
      s.setReply(null); unCool();
      expect((await api("newsletter/test", { releaseId: r.releaseId })).ok).toBe(true); unCool();
      s.setReply(async () => { throw new TypeError("socket hang up"); });
      expect((await api("newsletter/test", { releaseId: r.releaseId })).result).toMatchObject({ state: "unknown" }); unCool(); // counts
      s.setReply(null);
      expect((await api("newsletter/test", { releaseId: r.releaseId })).error).toBe("newsletter_test_cap"); // robin: 2 of 2 (sent + unknown)
      expect((w.org.sqlite.db.prepare("SELECT state FROM newsletter_tests ORDER BY received_at").all() as any[]).map((x) => x.state).sort()).toEqual(["refused", "sent", "unknown"]);
      // N-1: a test interrupted mid-POST ("sending" at a restart) becomes unknown and keeps counting.
      w.org.sqlite.write(() => w.org.sqlite.db.prepare("UPDATE newsletter_tests SET state='sending' WHERE state='sent'").run());
      await w.restart();
      expect(w.org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM newsletter_tests WHERE state='sending'").get()).toEqual({ n: 0 });
      expect(w.org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM newsletter_tests WHERE state='unknown' AND label='newsletter_test_unknown'").get()).toEqual({ n: 1 }); // the interrupted one
      expect((await api("newsletter/test", { releaseId: r.releaseId })).error).toBe("newsletter_test_cap"); // rows survive the restart
    } finally { await s.close(); }
    const s2 = await setup({ configured: false });
    try { expect((await s2.api("newsletter/test", { releaseId: "nr_" + "1".repeat(32) })).error).toBe("newsletter_test_not_configured");
      await s2.tools.call("render_newsletter_preview", JSON.stringify({ artifactId: s2.v.artifactId, version: s2.v.version }), s2.ctx);
      expect((await s2.api("newsletter/release/prepare", { conversationId: s2.conv, artifactId: s2.v.artifactId, version: s2.v.version })).error).toBe("newsletter_sender_not_configured");
    } finally { await s2.close(); }
  });
});

// Package E N1 (Fable e9cdd63c E-5): "also send tests to" (org.json newsletter.testAlsoTo, member ids), resolved at SEND time to
// active admins; anyone else is skipped with a fixed label; one /emails call, key and row per recipient; caps for ALL recipients
// checked before any send. And E-9: a test sender on another domain than the release From is refused at load.
describe.skipIf(!enabled)("tests also to the owner (N1) and the sender-domain rule (E-9)", () => {
  const ids = (w: any) => Object.fromEntries((w.org.sqlite.db.prepare("SELECT email, member_id FROM access_members").all() as any[]).map((r) => [r.email, r.member_id]));
  async function world(perMember = 6) {
    const kf = join(mkdtempSync(join(tmpdir(), "knl-n1-")), "k"); writeFileSync(kf, "re_" + "A".repeat(30), { mode: 0o600 });
    const sent: any[] = [];
    const fetch = async (url: string, init: any) => { sent.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ id: "rs-" + sent.length }), { status: 200, headers: { "content-type": "application/json" } }); };
    const w = await transcriptionWorld({ chat: {}, newsletter: { totpKeyFile: "/nonexistent/totp.key", approvers: ["robin@exna.test"], from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org",
      testFrom: "EXNA <newsletter@example.org>", testKeyFile: kf, testsPerMemberPerDay: perMember, testsPerDay: 12 }, newsletterTestFetch: fetch });
    const m = ids(w), admin = Object.keys(m).find((e) => !/robin|alex/.test(e))!;
    (w.cfg as any).newsletter.testAlsoTo = [m[admin], m["alex@exna.test"], m["robin@exna.test"]]; // an admin, a contributor (skipped), the sender (dropped)
    await w.restart();
    mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
    writeFileSync(join(w.cfg.folder, "members/notes/2026-10-08.v1.md"), "# October\nBlock Party drew over 300 neighbors.\n");
    const api = (p: string, b: unknown, c = w.robin) => w.post(`/o/exna/api/${p}`, b, c);
    const conv = (await api("chat/conversation/create", {})).result.conversationId;
    const tools = new ChatTools(w.org.sqlite, { folder: w.cfg.folder, stateRoot: w.cfg.stateRoot, envelopeFor: () => ({ envelopeId: "env_" + "a".repeat(32), snapshotHash: "x" }) });
    const ctx = { turnId: "turn_" + randomUUID().replaceAll("-", ""), conversationId: conv, memberId: "m", scope: "member" as const };
    await tools.begin(ctx);
    const v = JSON.parse(((await tools.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content: { title: "November in Example Park",
      sections: [{ heading: "Block Party", body: "Over 300 neighbors came out." }], sources: [{ path: "members/notes/2026-10-08.v1.md", line: 2 }] } }), ctx)) as any).content);
    await tools.call("render_newsletter_preview", JSON.stringify({ artifactId: v.artifactId, version: v.version }), ctx);
    const r = (await api("newsletter/release/prepare", { conversationId: conv, artifactId: v.artifactId, version: v.version })).result;
    return { w, api, r, sent, admin };
  }
  it("the sender + each active admin get their own call, key and row; a non-admin is skipped with a label; nobody else is named", async () => {
    const s = await world();
    try {
      const t = (await s.api("newsletter/test", { releaseId: s.r.releaseId })).result;
      expect(t).toMatchObject({ state: "sent", to: "robin@exna.test", also: { sent: 1, notSent: 0, skipped: 1 } });
      expect(JSON.stringify(t)).not.toContain(s.admin); // content-free about the others
      expect(s.sent.map((x) => x.body.to)).toEqual([["robin@exna.test"], [s.admin]]);
      expect(new Set(s.sent.map((x) => x.headers["idempotency-key"])).size).toBe(2);
      expect(s.sent[0].headers["idempotency-key"]).toBe(t.testId);
      const rows = s.w.org.sqlite.db.prepare("SELECT to_email, state, label FROM newsletter_tests ORDER BY rowid").all() as any[];
      expect(rows.map((x) => [x.to_email, x.state, x.label])).toEqual([["robin@exna.test", "sent", null], [s.admin, "sent", null], ["", "skipped", "newsletter_test_recipient_skipped"]]);
    } finally { await s.w.close(); }
  });
  it("caps count every recipient and refuse BEFORE any send (never a partial fan-out)", async () => {
    const s = await world(1);
    try {
      expect((await s.api("newsletter/test", { releaseId: s.r.releaseId })).error).toBe("newsletter_test_cap");
      expect(s.sent).toEqual([]);
    } finally { await s.w.close(); }
  });
  it("E-9: testFrom on another domain than from is refused at load with newsletter_sender_invalid", async () => {
    const { orgRuntimeConfigSchema } = await import("../src/org/org-runtime.js");
    const w = await transcriptionWorld({ chat: {} });
    try {
      const cfg = (n: Record<string, unknown>) => ({ ...structuredClone(w.cfg), newsletter: { totpKeyFile: "/nonexistent/totp.key", from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org", ...n } });
      const issue = (n: Record<string, unknown>) => { const p = orgRuntimeConfigSchema.safeParse(cfg(n)); return p.success ? null : p.error.issues.map((i) => i.message).join(","); };
      expect(issue({ testFrom: "newsletter@example.org" })).toBeNull();
      expect(issue({ testFrom: "Agent <AGENT@example.org>" })).toBeNull();
      for (const bad of ["agent@send.example.org", "agent@example.org.evil.net", "a@b@example.org", "agent@caneyfork.example"])
        expect([bad, issue({ testFrom: bad })]).toEqual([bad, "newsletter_sender_invalid"]);
      // Fable ruling (a) + Ops (24 Oct): linkHosts stays ACCEPTED for one deprecation release (validated, ignored); a bad value still refuses.
      expect(issue({ linkHosts: ["www.change.org", "www.zeffy.com"] })).toBeNull();
      for (const bad of [["*.evil.test"], ["Www.Zeffy.com"], ["nodot"], Array.from({ length: 11 }, (_, i) => `h${i}.example.org`)])
        expect([bad, issue({ linkHosts: bad })]).toEqual([bad, expect.stringMatching(/newsletter_link_hosts_invalid|10/)]);
    } finally { await w.close(); }
  });
});


// Package E addendum 2 (Fable E-12d, E-13): the link list the reviewer approves. A draft with a link whose URL is in the frozen
// notes (live, source = the notes path) and one nobody gave (inert, no_source): the package carries the list (in the content
// digest) and the release card shows text + host + source for the live one, text + reason for the other. No ids, no addresses.
describe.skipIf(!enabled)("the release card's link list (E-12d)", () => {
  it("live links carry their host and snapshot source; unsourced links are inert with a reason; the list is in the digest", async () => {
    const kf = join(mkdtempSync(join(tmpdir(), "knl-lk-")), "k"); writeFileSync(kf, "re_" + "A".repeat(30), { mode: 0o600 });
    const w = await transcriptionWorld({ chat: {}, newsletter: { totpKeyFile: "/nonexistent/totp.key", approvers: ["robin@exna.test"], from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org",
      testFrom: "EXNA <newsletter@example.org>", testKeyFile: kf }, newsletterTestFetch: (async () => new Response("{}")) as never });
    try {
      mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
      writeFileSync(join(w.cfg.folder, "members/notes/2026-10-08.v1.md"), "# October\nVolunteer: https://www.zeffy.com/en-US/ticketing/example-event\n");
      const api = (p: string, b: unknown, c = w.robin) => w.post(`/o/exna/api/${p}`, b, c);
      const conv = (await api("chat/conversation/create", {})).result.conversationId;
      const tools = new ChatTools(w.org.sqlite, { folder: w.cfg.folder, stateRoot: w.cfg.stateRoot, envelopeFor: () => ({ envelopeId: "env_" + "a".repeat(32), snapshotHash: "x" }) });
      const ctx = { turnId: "turn_" + randomUUID().replaceAll("-", ""), conversationId: conv, memberId: "m", scope: "member" as const };
      await tools.begin(ctx);
      const v = JSON.parse(((await tools.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content: { title: "October", sections: [{ heading: "Cleanup",
        body: "Please [sign up](https://www.zeffy.com/en-US/ticketing/example-event). Or [win a prize](https://evil.test/win)." }], sources: [{ path: "members/notes/2026-10-08.v1.md", line: 2 }] } }), ctx)) as any).content);
      const p = JSON.parse(((await tools.call("render_newsletter_preview", JSON.stringify({ artifactId: v.artifactId, version: v.version }), ctx)) as any).content);
      expect(p.links).toEqual({ live: 1, inert: 1 });
      const r = (await api("newsletter/release/prepare", { conversationId: conv, artifactId: v.artifactId, version: v.version })).result;
      const pkg = JSON.parse((w.org.sqlite.db.prepare("SELECT package FROM newsletter_releases WHERE id=?").get(r.releaseId) as any).package);
      expect(pkg.links).toEqual([
        { text: "sign up", url: "https://www.zeffy.com/en-US/ticketing/example-event", live: true, href: "https://www.zeffy.com/en-US/ticketing/example-event", host: "www.zeffy.com", source: "members/notes/2026-10-08.v1.md" },
        { text: "win a prize", url: "https://evil.test/win", live: false, reason: "no_source" }]);
      expect(pkg.html).toContain('<a href="https://www.zeffy.com/en-US/ticketing/example-event"'); expect(pkg.html).not.toContain('href="https://evil.test');
      expect(r.contentDigest).toBe(contentDigest(pkg)); // the list is in the content the reviewer approves
      const card = (await api("newsletter/release/view", { releaseId: r.releaseId })).result;
      expect(card.links).toEqual([{ text: "sign up", host: "www.zeffy.com", source: "members/notes/2026-10-08.v1.md", live: true }, { text: "win a prize", url: "https://evil.test/win", live: false, reason: "no_source" }]);
      expect(pkg.html).toContain("Or win a prize."); // the email: the inert link's text only
    } finally { await w.close(); }
  });
});
