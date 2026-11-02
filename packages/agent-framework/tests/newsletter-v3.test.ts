// Package E (Fable e9cdd63c E-1..E-4, E-6; cbae22b4 E-6', E-9): renderer v3's URL rules, the image preflight with its content
// hash, and the sender-domain rule. Pure units: no world, no network (every fetch is a fake that records its calls).
import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { imageUrl, linkDecision, normalizeLinkHosts, renderNewsletterV3, renderNewsletterV3Full, headerPhotosOf, referencedImages, unsubscribeFormOk, UNSUB_ANCHOR, UNSUB_TOKEN, VIEW_ON_WEB, CP_THEME, RENDERER_V3, DEFAULT_HEADER_PHOTOS } from "../src/org/newsletter/render-cp.js";
import { hashImages, recheckImages, IMAGE_PREFLIGHT } from "../src/org/newsletter/image-preflight.js";
import { senderDomain, senderAddress } from "../src/org/newsletter/release.js";
import { TEAMTASK_RULES_HASH } from "../src/org/teamtasks/qualification.js";
import { CHAT_RULES_HASH } from "../src/org/chat/scheduler.js";
import { toolCatalogHash } from "../src/agent-kit/interactive/catalog.js";
import { ACCESS_TABLE_HASH } from "../src/access/org-access.js";
import { INTERACTIVE_QUAL_FIXTURES } from "../src/agent-kit/interactive/qualification.js";

const S = "https://www.example.org";
it("E-1: an image line is exactly one https URL on CP's own two hosts, under /newsletter/ or /images/, an image extension; nothing else", () => {
  expect(imageUrl(`${S}/newsletter/2026-10/block-party-yard-sign.jpg`)).toBe(`${S}/newsletter/2026-10/block-party-yard-sign.jpg`);
  expect(imageUrl("  https://example.org/images/events/halloween-2026-flyer.PNG ")).toBe("https://example.org/images/events/halloween-2026-flyer.PNG");
  for (const bad of [`http://www.example.org/newsletter/a.jpg`, `${S}/files/a.jpg`, `${S}/newsletter/a.pdf`, `${S}/newsletter/a.jpg?x=1`, `${S}/newsletter/a.jpg#f`,
    "https://user@www.example.org/newsletter/a.jpg", "https://www.example.org:443/newsletter/a.jpg", "https://www.example.org:8443/newsletter/a.jpg",
    "https://cdn.example.org/newsletter/a.jpg", "https://example.org.evil.net/newsletter/a.jpg", "https://cleveIandparktn.com/newsletter/a.jpg",
    "https://WWW.example.org/newsletter/a.jpg", "https://www.example.org./newsletter/a.jpg", "https://xn--exmple-4nf.org/newsletter/a.jpg",
    `see ${S}/newsletter/a.jpg`, `${S}/newsletter/a.jpg and more`, "data:image/png;base64,AAAA", "javascript:alert(1)"]) expect([bad, imageUrl(bad)]).toEqual([bad, null]);
});
// Fable E-12/E-13 (addendum 2): [text](url) to ANY https host with provenance; one rule for body links, links[] and the card.
const SRC = (urls: Record<string, string>) => (u: string) => urls[u] ?? null;
it("E-12/E-13: any https host with a source is live; every refusal is inert with a reason; the href is the re-serialisation", () => {
  const prov = SRC({ "https://www.zeffy.com/en-US/ticketing/example-event": "members/notes/2026-10-08.md", "https://video.example.net/abc-defg-hij": "member message" });
  expect(linkDecision("Get tickets", "https://www.zeffy.com/en-US/ticketing/example-event", prov)).toEqual({ text: "Get tickets", url: "https://www.zeffy.com/en-US/ticketing/example-event", live: true,
    href: "https://www.zeffy.com/en-US/ticketing/example-event", host: "www.zeffy.com", source: "members/notes/2026-10-08.md" });
  expect(linkDecision("Join by video", "https://video.example.net/abc-defg-hij", prov)).toMatchObject({ live: true, source: "member message" });
  expect(linkDecision("Write us", "mailto:hello@example.org", prov)).toMatchObject({ live: true, href: "mailto:hello@example.org" });
  expect(linkDecision("hello@example.org", "mailto:hello@example.org", prov)).toMatchObject({ live: true });
  const R = (t: string, u: string) => linkDecision(t, u, SRC({ [u]: "members/x.md" })).reason ?? null;
  for (const [t, u, why] of [
    ["", "https://www.zeffy.com/x", "malformed_text"], ["  ", "https://www.zeffy.com/x", "malformed_text"], ["a <b> c", "https://www.zeffy.com/x", "malformed_text"], ["a [b]", "https://www.zeffy.com/x", "malformed_text"],
    ["x", "http://www.zeffy.com/x", "not_https"], ["x", "javascript:alert(1)", "not_https"], ["x", "data:text/html,hi", "not_https"], ["x", "tel:+16155550100", "not_https"],
    ["x", "mailto:someone@evil.test", "not_https"], ["x", "mailto:hello@example.org?cc=a@b.test", "not_https"], ["x", "https://u:p@www.zeffy.com/", "not_https"],
    ["x", "https://www.zeffy.com:8443/", "not_https"], ["x", "https://WWW.ZEFFY.COM/", "not_https"], ["x", "https://www.zeffy.com./", "not_https"], ["x", "https://xn--zffy-6qa.com/", "not_https"],
    ["https://www.example.org/", "https://evil.net/", "display_mismatch"], ["www.example.org/events", "https://evil.net/", "display_mismatch"],
    ["example.org", "https://example.org.evil.net/", "display_mismatch"], ["hello@example.org", "https://evil.net/", "display_mismatch"],
    ["someone@evil.test", "mailto:hello@example.org", "display_mismatch"],
    // NL-2: only ONE leading "www." is ignored; another subdomain, a doubled www or a look-alike still refuses.
    ["events.example.org/x", "https://www.example.org/x", "display_mismatch"], ["www.www.example.org", "https://www.example.org/", "display_mismatch"],
    ["example.org", "https://www.example.org.evil.net/", "display_mismatch"], ["wwwexample.org", "https://example.org/", "display_mismatch"]] as const)
    expect([t, u, R(t, u)]).toEqual([t, u, why]);
  // NL-2, Fable Addendum 2 (a) (5fe8f229): the ONLY loosening is apex <-> www. The injection fixture's planted link stays inert
  // (no source, or display_mismatch whatever site its text names), and email-shaped text on an https link stays refused.
  const planted = INTERACTIVE_QUAL_FIXTURES.planted;
  expect(linkDecision("click here", planted, SRC({}))).toMatchObject({ live: false, reason: "no_source" });
  for (const t of ["www.example.org", "example.org/events", "https://example.org/", "www.evil.test.example.org"])
    expect([t, R(t, planted)]).toEqual([t, "display_mismatch"]);
  for (const [t, u] of [["hello@example.org", "https://www.example.org/"], ["www.hello@example.org", "https://example.org/"]] as const)
    expect([t, R(t, u)]).toEqual([t, "display_mismatch"]);
  // NL-2 (the live send's events link): bare text, www href and the reverse are the same site.
  for (const [t, u] of [["example.org/events", "https://www.example.org/events"], ["www.example.org/events", "https://example.org/events"],
    ["https://example.org/events", "https://www.example.org/events"], ["example.org", "https://www.example.org/"]] as const)
    expect([t, R(t, u), linkDecision(t, u, SRC({ [u]: "members/x.md" })).live]).toEqual([t, null, true]);
  expect(linkDecision("Tickets", "https://www.zeffy.com/unsourced", prov)).toMatchObject({ live: false, reason: "no_source" }); // provenance is a floor
});
it("inline [text](url) only: live with a source, inert = its text only otherwise, malformed and bare URLs are text; links[] uses the same rule", () => {
  const prov = SRC({ "https://www.zeffy.com/t": "members/notes/n.md", "https://www.example.org/events": "member message" });
  const { html, links } = renderNewsletterV3Full({ title: "T", sections: [{ heading: "H",
    body: "Buy [tickets](https://www.zeffy.com/t) now. Or [this](https://evil.net/x). Bare https://www.zeffy.com/t stays text. Broken [link(https://www.zeffy.com/t) and [x]( ) and [](https://www.zeffy.com/t).",
    links: [{ text: "Events", url: "https://www.example.org/events" }, { text: "Elsewhere", url: "https://evil.net/" }] }] }, { provenance: prov });
  expect(html).toContain('<a href="https://www.zeffy.com/t" style='); expect(html).toContain(">tickets</a>");
  expect(html).toContain("Or this."); expect(html).not.toContain("https://evil.net/x"); // inert = its text only (Director)
  expect(html).toContain("Bare https://www.zeffy.com/t stays text."); // no autolinking
  expect(html).toContain("Broken [link(https://www.zeffy.com/t) and [x]( ) and [](https://www.zeffy.com/t)."); // malformed: literal, never dropped
  expect(html).toContain('<a href="https://www.example.org/events" style='); expect(html).toContain(">Elsewhere</li>"); expect(html).not.toContain("(https://evil.net/)");
  expect(links.map((l) => [l.text, l.live, l.source ?? l.reason])).toEqual([["tickets", true, "members/notes/n.md"], ["this", false, "no_source"], ["", false, "malformed_text"],
    ["Events", true, "member message"], ["Elsewhere", false, "no_source"]]);
  expect(renderNewsletterV3({ title: "T", sections: [{ heading: "H", body: "[t](https://www.zeffy.com/t)" }] })).not.toContain('<a href="https://www.zeffy.com'); // no provenance = no live link
});
it("E-14: headerPhotos = exactly four E-1 URLs, else the site's default strip; goldens present and absent", () => {
  const four = [1, 2, 3, 4].map((n) => `${S}/newsletter/2026-10/p${n}.jpg`), def = [...DEFAULT_HEADER_PHOTOS];
  expect(headerPhotosOf({ headerPhotos: four })).toEqual(four);
  for (const bad of [undefined, four.slice(0, 3), [...four.slice(0, 3), "https://evil.net/newsletter/p.jpg"], [...four.slice(0, 3), `${S}/files/p.pdf`]]) expect(headerPhotosOf({ headerPhotos: bad })).toEqual(def);
  const withP = renderNewsletterV3({ title: "T", headerPhotos: four, sections: [{ heading: "H", body: "B" }] }), without = renderNewsletterV3({ title: "T", sections: [{ heading: "H", body: "B" }] });
  expect(referencedImages(withP).filter((u) => u.includes("/2026-10/p"))).toEqual(four);
  expect(referencedImages(without).filter((u) => u.includes("/newsletter/2026-09/"))).toEqual(def);
  expect(four.reduce((h, u, k) => h.replace(u, def[k]), withP)).toBe(without); // the ONLY difference is the four photos
  // Director (24 Oct): the default is four different NON-pool photos (no /newsletter/photos/ pool shots).
  expect(def.every((u) => !u.includes("/newsletter/photos/")) && new Set(def).size === 4).toBe(true);
});
it.skip("v3 renders the site template in the current theme; only allowlisted URLs become attributes; fixed View on web and the unsubscribe anchor", () => {
  const html = renderNewsletterV3({ title: "October in Example Park", sections: [{ heading: "Halloween", body: `Trick-or-treat at the Community Center.\n${S}/newsletter/2026-10/block-party-yard-sign.jpg\nMore at [the events page](${S}/events) and https://evil.net/x.`,
    links: [{ text: "Details", url: `${S}/events/halloween-2026` }, { text: "Elsewhere", url: "https://evil.net/" }] }] }, { provenance: SRC({ [`${S}/events`]: "member message", [`${S}/events/halloween-2026`]: "members/notes/n.md" }) });
  expect(RENDERER_V3).toBe("kapelle.newsletter-renderer/v3");
  expect(html).toContain(`<img src="${S}/newsletter/2026-10/block-party-yard-sign.jpg" alt="" width="400" style=`);
  expect(html).toContain(`<a href="${S}/events" style=`); expect(html).toContain(">the events page</a>"); expect(html).toContain("https://evil.net/x."); expect(html).not.toContain('href="https://evil.net');
  expect(html).toContain(">Elsewhere</li>"); expect(html).not.toContain("(https://evil.net/)");
  expect(html).toContain(`href="${VIEW_ON_WEB}"`); expect(VIEW_ON_WEB).toBe(`${S}/newsletter`);
  expect(html.split(UNSUB_ANCHOR).length).toBe(2); expect(UNSUB_TOKEN).toBe("{{{RESEND_UNSUBSCRIBE_URL}}}"); // E-6' default until the owner's inbox proof
  for (const c of [CP_THEME.primary, CP_THEME.primaryDark, CP_THEME.accent, CP_THEME.surface]) expect(html).toContain(c);
  expect(referencedImages(html)).toEqual([`${S}/images/brand/example-org-emblem.png`, ...DEFAULT_HEADER_PHOTOS, `${S}/newsletter/2026-10/block-party-yard-sign.jpg`]);
  expect(html).not.toMatch(/fonts\.googleapis|<style|<script/i);
  // The schema, catalog and rules are untouched: no requal (Fable verifies at the head).
  // Package F (delta A, Fable): task rules and the access table unchanged; chat rules MOVE (A-6) and the catalog MOVES (5253d856 -> 529a957b).
  expect([TEAMTASK_RULES_HASH.slice(7, 15), CHAT_RULES_HASH.slice(7, 15), toolCatalogHash().slice(7, 15), ACCESS_TABLE_HASH.slice(7, 15)]).toEqual(["7aa5cc18", "6a4e0e0a", "1f130437", "0c125e32"]); // LIBRARY L1+L2 moved the access table (was a8ad1844), then J2 chat.draft.share; // PACKAGE P moved chat's rules + the catalog (F: b326f5e7, 529a957b) // Package F: the A-6 rules line + delta A catalog
});

/** A fake site: records every call; per URL: status, content type, body bytes, or a redirect. */
function site(over: Record<string, { status?: number; type?: string; body?: Uint8Array; headStatus?: number }> = {}) {
  const calls: { url: string; method: string; redirect?: string; range?: string }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), redirect: init.redirect, range: (init.headers as any)?.Range });
    const o = over[url] ?? {}, status = init.method === "HEAD" ? (o.headStatus ?? o.status ?? 200) : (o.status ?? 200);
    return new Response(init.method === "HEAD" || status >= 300 && status < 400 ? null : Buffer.from(o.body ?? new TextEncoder().encode("IMG:" + url)), { status, headers: { "content-type": o.type ?? "image/jpeg", ...(status >= 300 && status < 400 ? { location: "https://evil.net/x.jpg" } : {}) } });
  };
  return { fetch, calls };
}
const hash = (s: string | Uint8Array) => "sha256:" + createHash("sha256").update(s).digest("hex");
it("E-2: the allowlist precedes the network (an off-host URL = zero fetches); HEAD then a ranged GET on 403/405; no redirects; a bounded content hash", async () => {
  const s = site(), a = `${S}/newsletter/a.jpg`;
  await expect(hashImages(s.fetch, ["https://evil.net/newsletter/a.jpg"])).rejects.toMatchObject({ label: "newsletter_images_unserved" });
  expect(s.calls).toEqual([]); // never contacted
  expect(await hashImages(s.fetch, [a])).toEqual([{ url: a, sha256: hash("IMG:" + a) }]);
  expect(s.calls.map((c) => [c.method, c.redirect])).toEqual([["HEAD", "manual"], ["GET", "manual"]]);
  const f405 = site({ [a]: { headStatus: 405 } }); await hashImages(f405.fetch, [a]);
  expect(f405.calls.map((c) => [c.method, c.range ?? null])).toEqual([["HEAD", null], ["GET", "bytes=0-0"], ["GET", null]]);
  for (const bad of [{ status: 404 }, { status: 302 }, { type: "text/html" }, { body: new Uint8Array(IMAGE_PREFLIGHT.maxBytes + 1) }])
    await expect(hashImages(site({ [a]: bad }).fetch, [a])).rejects.toMatchObject({ label: "newsletter_images_unserved" });
  // Re-check compares bytes: "replaced" is not "gone".
  const prepared = await hashImages(site().fetch, [a]);
  expect(await recheckImages(site().fetch, prepared)).toEqual({ ok: true });
  expect(await recheckImages(site({ [a]: { body: new TextEncoder().encode("other bytes") } }).fetch, prepared)).toEqual({ ok: false, label: "newsletter_image_changed", url: a });
  expect(await recheckImages(site({ [a]: { status: 404 } }).fetch, prepared)).toEqual({ ok: false, label: "newsletter_images_unserved", url: a });
});
it("E-9: one sender-domain rule: inside <…> if present, exactly one @, lower-cased, trailing dot stripped, ASCII only", () => {
  expect(senderDomain("Example Park Neighborhood Association <newsletter@example.org>")).toBe("example.org");
  expect(senderDomain("NEWSLETTER@example.org.")).toBe("example.org");
  expect(senderDomain("Agent <agent@send.example.org>")).toBe("send.example.org"); // a subdomain is a different domain
  expect(senderDomain("Ñame Ünicode <newsletter@example.org>")).toBe("example.org"); // the display name may be non-ASCII
  for (const bad of ["a@b@example.org", "no-at-sign", "x@exámple.test", "x@", "<x@y.test> trailing", "ñ@example.org",
    "EXNA\r\nBcc: a@evil.test <newsletter@example.org>", "EXNA\n <newsletter@example.org>", "CP\u0000NA <newsletter@example.org>", "EXNA\u007f <newsletter@example.org>",
    "CP <NA> <newsletter@example.org>", "EXNA > <newsletter@example.org>", "EXNA <newsletter@example.org", "newsletter@example.org>"])
    expect([bad, senderDomain(bad)]).toEqual([bad, null]);
  expect(senderDomain("x@example.org.evil.net")).not.toBe("example.org");
});

it("E-10 (b) fix 1 with CP's REAL strings: the release-path test compares ADDRESSES (one E-9 extraction), never the raw strings", () => {
  const from: string = "Example Park Neighborhood Association <newsletter@example.org>", testFrom: string = "newsletter@example.org";
  expect(testFrom === from).toBe(false); // a string comparison would make CP unmintable
  expect(senderAddress(testFrom)).toBe("newsletter@example.org");
  expect(senderAddress(from)).toBe(senderAddress(testFrom)); // => path "release" (with a list configured)
  expect(senderAddress("Example Park agent <agent@example.org>")).not.toBe(senderAddress(from)); // another address on the domain => "preview"
  expect(senderAddress("NEWSLETTER@example.org.")).toBe("NEWSLETTER@example.org"); // the domain is normalised, the local part as written
});

// Fable F-1 (dede195b review) / E-6' (proven on delivered mail: triple substituted, double left literal): the footer rule.
it("F-1: exactly one TRIPLE-brace unsubscribe placeholder, as the footer anchor's href; zero, two, stray or double refuse", () => {
  const html = renderNewsletterV3({ title: "T", sections: [{ heading: "H", body: "B" }] });
  expect(unsubscribeFormOk(html)).toBe(true);
  expect(html).toContain(`<a href="${UNSUB_TOKEN}"`); expect(UNSUB_TOKEN).toBe("{{{RESEND_UNSUBSCRIBE_URL}}}"); // the golden carries the triple, in the href
  expect(unsubscribeFormOk(html.replace(UNSUB_ANCHOR, ""))).toBe(false); // zero
  expect(unsubscribeFormOk(html.replace("</body>", UNSUB_ANCHOR + "</body>"))).toBe(false); // two
  expect(unsubscribeFormOk(html.replace("</body>", `<p>${UNSUB_TOKEN}</p></body>`))).toBe(false); // a stray triple outside the anchor
  expect(unsubscribeFormOk(html.replace(UNSUB_ANCHOR, UNSUB_ANCHOR.replace(UNSUB_TOKEN, "{{RESEND_UNSUBSCRIBE_URL}}")))).toBe(false); // the double (Sep 4)
  expect(unsubscribeFormOk(html.replace("</body>", '<a href="{{RESEND_UNSUBSCRIBE_URL}}">Unsubscribe</a></body>'))).toBe(false); // an extra double
});
