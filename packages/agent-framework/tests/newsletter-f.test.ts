// Package F delta A (Fable FABLE-REVIEW-PACKAGE-F-DELTA-A.md A-1, A-3): the email's section images and numbered lists, as goldens
// (tests/fixtures/newsletter-f/*.html, byte for byte) plus the rules the goldens show. Layout in a browser: newsletter-f-browser.test.ts.
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderNewsletterV3, referencedImages } from "../src/org/newsletter/render-cp.js";
import { F_CASES } from "./newsletter-f-cases.js";

const golden = (k: string) => readFileSync(join(import.meta.dirname, "fixtures", "newsletter-f", `${k}.html`), "utf8");
const IMG = "https://www.example.org/images/events/block-party.jpg";

it("goldens: each image position, a caption, the mixed lists render byte for byte", () => {
  for (const [k, c] of Object.entries(F_CASES)) expect(renderNewsletterV3(c), k).toBe(golden(k));
});

it("A-1: images above/below are full width with an escaped plain caption (no link, emphasis or markup parsing)", () => {
  const above = golden("image-above"), below = golden("image-below");
  expect(above.indexOf(`src="${IMG}"`)).toBeLessThan(above.indexOf("Over 300 neighbors"));
  expect(below.indexOf(`src="${IMG}"`)).toBeGreaterThan(below.indexOf("Over 300 neighbors"));
  expect(above).toContain(">Neighbors at Block Party, Nov 8 [photo](https://evil.net) **bold** &lt;b&gt;x&lt;/b&gt;</p>");
  expect(above).not.toContain('href="https://evil.net'); expect(above).not.toContain("<strong>bold");
  for (const k of ["image-above", "image-below", "image-left", "image-right"]) expect(referencedImages(golden(k))).toContain(IMG); // E-2 sees every section image
});

it("A-1: left/right = two stacking columns with the image FIRST in the source (Outlook's fallback: the image above the text)", () => {
  const left = golden("image-left"), right = golden("image-right");
  for (const h of [left, right]) {
    expect(h.indexOf(`src="${IMG}"`)).toBeLessThan(h.indexOf("Over 300 neighbors"));
    expect(h).toMatch(/display:inline-block;margin:0 -1px;max-width:230px;min-width:200px;/);
    expect(h).toMatch(/display:inline-block;margin:0 -1px;max-width:354px;min-width:240px;/);
  }
  expect(left).toContain('<div dir="ltr" style="font-size:0;text-align:left;">'); expect(right).toContain('<div dir="rtl" style="font-size:0;text-align:left;">');
  expect(right).toContain('alt="Neighbors &quot;at&quot; Block Party"');
});

it("A-3: a numbered list continues over blank and indented lines, keeps its start (>1, <=999), and mixes with bullets", () => {
  const h = golden("lists-mixed");
  const ols = [...h.matchAll(/<ol( start="\d+")? style=/g)].map((m) => m[1] ?? "");
  expect(ols).toEqual(["", ' start="5"', ' start="999"']);
  expect(h).toMatch(/<li [^>]*>Tree planting<br>Bring gloves\.<\/li>/);
  expect((h.match(/<\/ol>/g) ?? []).length).toBe(3); expect(h).toContain("<ul "); expect(h).toContain(">1000. not a list</p>");
  // A list that starts at 1 has no start attribute; one item resumed after text keeps its number.
  expect(renderNewsletterV3({ title: "T", sections: [{ heading: "H", body: "1. a\n2. b" }] })).toMatch(/<ol style=[^>]*><li [^>]*>a<\/li><li [^>]*>b<\/li><\/ol>/);
});

// Package A2 (the owner's first live edit: the preview showed the link list twice): a links[] entry already live in its section's
// body is shown once; a different link in links[] still shows; the release card's decision list holds each link once.
it("A2: a link in the body AND in links[] renders once; other links[] entries still render", async () => {
  const { renderNewsletterV3Full } = await import("../src/org/newsletter/render-cp.js");
  const MAP = "https://viewer.mapme.com/trickortreat", FORM = "https://forms.gle/abc123", prov = (u: string) => (u === MAP || u === FORM ? "member message" : null);
  const { html, links } = renderNewsletterV3Full({ title: "T", sections: [{ heading: "Halloween night",
    body: `See the [Trick-or-Treat Map](${MAP}).`, links: [{ text: "View the Trick-or-Treat Map", url: MAP }, { text: "Sign up to hand out candy", url: FORM }] }] }, { provenance: prov });
  expect(html.split(`href="${MAP}"`).length - 1).toBe(1);
  expect(html.split(`href="${FORM}"`).length - 1).toBe(1);
  expect(html).not.toContain(">View the Trick-or-Treat Map</a>");
  expect(links.filter((d) => d.live).map((d) => d.href)).toEqual([MAP, FORM]);
});
