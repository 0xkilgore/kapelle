// Package E (Director, 24 Oct): Word (.docx) and web page (.html) files are converted to text IN THE BROWSER (no dependency; the
// built-in DecompressionStream + DOMParser) and reach the server as an ordinary text upload named <base>.md. In REAL Chromium under
// the hub's production CSP: a .docx with a heading, a list, a table and a tab; an .html with a script and a style dropped; a broken
// .docx and a zip bomb refuse with plain words and upload nothing. The .docx files are built here with node:zlib (test-only).
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { transcriptionWorld } from "./transcription-world.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && existsSync(PLAYWRIGHT);

/** A minimal zip (deflated entries, central directory, end record): enough for a real Word reader and for ours. */
function zip(entries: Record<string, string | Buffer>) {
  const locals: Buffer[] = [], centrals: Buffer[] = []; let off = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content), data = deflateRawSync(raw), n = Buffer.from(name), crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); centrals.push(ch, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (t: string, extra = "") => `<w:p>${extra}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const DOC = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>` +
  p("October board meeting", '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>') + p("The cleanup is on Oct 31 at 9 AM.") +
  p("Bring gloves", '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>') +
  `<w:p><w:r><w:t>Budget</w:t><w:tab/><w:t>$412</w:t></w:r></w:p>` +
  `<w:tbl><w:tr><w:tc>${p("Role")}</w:tc><w:tc>${p("Name")}</w:tc></w:tr><w:tr><w:tc>${p("Chair")}</w:tc><w:tc>${p("Kara")}</w:tc></w:tr></w:tbl>` +
  `<w:sectPr/></w:body></w:document>`;
const DOCX = zip({ "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', "word/document.xml": DOC });
const BOMB = zip({ "word/document.xml": `<w:document ${W}><w:body>` + p("x".repeat(3 * 1024 * 1024)) + "</w:body></w:document>" });
// Fable E-8': a 50 MB inflated document.xml (the counter stops at 2 MB); and markup that is NOT WordprocessingML (an XHTML
// script, an event handler) inside document.xml: never run, never inserted, never text.
const BOMB50 = zip({ "word/document.xml": `<w:document ${W}><w:body>` + p("y".repeat(50 * 1024 * 1024)) + "</w:body></w:document>" });
const HOSTILE = zip({ "word/document.xml": `<?xml version="1.0"?><w:document ${W} xmlns:h="http://www.w3.org/1999/xhtml"><w:body>` +
  `<h:script>document.title="pwned-docx"</h:script><h:img src="x" onerror="document.title='pwned-img'"/>` + p("Safe text") + p("&lt;script&gt;alert(1)&lt;/script&gt;") + "</w:body></w:document>" });
const HTML = `<!doctype html><html><head><title>t</title><style>p{color:red}</style></head><body><h2>Block Party</h2><p style="color:red">Over 300 neighbors came.</p>` +
  `<script>document.title="pwned"</script><ul><li>24 volunteers</li><li>12 vendors</li></ul></body></html>`;

function uploaded(folder: string, name: string): string | null {
  const root = join(folder, "members", "uploads"); if (!existsSync(root)) return null;
  const walk = (d: string): string | null => { for (const e of readdirSync(d)) { const f = join(d, e); if (statSync(f).isDirectory()) { const r = walk(f); if (r) return r; } else if (e === name) return readFileSync(f, "utf8"); } return null; };
  return walk(root);
}

describe.skipIf(!enabled)("Word and web page files become text in the browser", () => {
  it(".docx and .html upload as <base>.md text; a broken .docx and a zip bomb refuse and upload nothing", async () => {
    const w = await transcriptionWorld({ chat: {} });
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await ctx.newPage(), [name, value] = w.alex.split("=");
      await ctx.addCookies([{ name, value, url: w.url }]);
      const errors: string[] = []; page.on("console", (x: any) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e: any) => errors.push("pageerror " + e.message));
      await page.goto(`${w.url}/o/exna/#chat`);
      await page.getByRole("button", { name: "New chat" }).click();
      await page.locator("#chat-text").waitFor();
      expect(await page.locator("#chat-file").getAttribute("accept")).toContain(".docx");
      await page.setInputFiles("#chat-file", { name: "Board minutes (Oct).docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: DOCX });
      await page.getByText("📎 Board minutes -Oct-.md").waitFor(); // (the notice "Added to this chat as …" is redrawn away at once)
      expect(uploaded(w.cfg.folder, "Board minutes -Oct-.md")).toBe("# October board meeting\n\nThe cleanup is on Oct 31 at 9 AM.\n\n- Bring gloves\n\nBudget\t$412\n\nRole\tName\n\nChair\tKara");
      await page.setInputFiles("#chat-file", { name: "blockparty.html", mimeType: "text/html", buffer: Buffer.from(HTML) });
      await page.getByText("📎 blockparty.md").waitFor();
      expect(uploaded(w.cfg.folder, "blockparty.md")).toBe("## Block Party\n\nOver 300 neighbors came.\n\n- 24 volunteers\n\n- 12 vendors");
      expect(await page.title()).not.toBe("pwned"); // the file's script never ran (DOMParser documents are inert)
      await page.setInputFiles("#chat-file", { name: "hostile.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: HOSTILE });
      await page.getByText("📎 hostile.md").waitFor();
      expect(uploaded(w.cfg.folder, "hostile.md")).toBe("Safe text\n\n<script>alert(1)</script>"); // Word's own escaped text stays text
      expect(await page.title()).not.toMatch(/pwned/);
      for (const [n, buf] of [["broken.docx", Buffer.from("PK\u0003\u0004 not really a zip")], ["bomb.docx", BOMB], ["bomb50.docx", BOMB50]] as const) {
        await page.setInputFiles("#chat-file", { name: n, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: buf });
        await page.getByText("That file couldn't be read. Save it again as .docx, or paste the text.").waitFor();
        expect(uploaded(w.cfg.folder, n.replace(".docx", ".md"))).toBeNull();
      }
      await page.setInputFiles("#chat-file", { name: "deck.pptx", mimeType: "application/octet-stream", buffer: Buffer.from("x") });
      await page.getByText("Only .md, .txt, .csv, Word (.docx) and web page (.html) files can be added.").waitFor();
      expect(errors.filter((e) => /Content Security Policy|Refused|pageerror/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); }
  }, 120_000);
});
