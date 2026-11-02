// Package F (Fable ruling (a), the deprecation release; Ops 24 Oct): newsletter.linkHosts stays in the schema, validated and IGNORED.
// The same draft renders byte for byte with and without CP's nine hosts in the org config (the live org.json loads unchanged).
import { it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { transcriptionWorld } from "./transcription-world.js";
import { ChatTools } from "../src/org/chat/tools.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const HOSTS = ["community-centre.example.org", "maps-short.example.net", "maps.google.com", "photos.example.net", "vendor-one.example",
  "video.example.net", "www.example-commons.org", "www.instagram.com", "www.zeffy.com"];

it.skipIf(!enabled)("ruling (a): the same draft renders byte-identical with and without linkHosts (accepted at load, ignored by the renderer)", async () => {
  const html: string[] = [];
  for (const linkHosts of [undefined, HOSTS]) {
    const w = await transcriptionWorld({ chat: {}, newsletter: { totpKeyFile: "/nonexistent/totp.key", from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org", ...(linkHosts ? { linkHosts } : {}) } });
    try {
      mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
      writeFileSync(join(w.cfg.folder, "members/notes/n.md"), "# Notes\nTickets: https://www.zeffy.com/en-US/ticketing/example-event\n");
      const tools = new ChatTools(w.org.sqlite, { folder: w.cfg.folder, stateRoot: w.cfg.stateRoot, envelopeFor: () => ({ envelopeId: "env_" + "a".repeat(32), snapshotHash: "x" }) });
      const ctx = { turnId: "turn_" + randomUUID().replaceAll("-", ""), conversationId: "conv_lh", memberId: "m", scope: "member" as const };
      await tools.begin(ctx);
      const v = JSON.parse(((await tools.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content: { title: "Block Party",
        sections: [{ heading: "Tickets", body: "Buy [tickets](https://www.zeffy.com/en-US/ticketing/example-event) and see https://www.instagram.com/exna. Or [elsewhere](https://maps.google.com/x)." }],
        sources: [{ path: "members/notes/n.md", line: 2 }] } }), ctx)) as any).content);
      await tools.call("render_newsletter_preview", JSON.stringify({ artifactId: v.artifactId, version: v.version }), ctx);
      html.push(tools.previewHtml("conv_lh", v.artifactId, v.version)!);
    } finally { await w.close(); }
  }
  expect(html[0].length).toBeGreaterThan(1000);
  expect(html[1]).toBe(html[0]);
  expect(html[0]).not.toContain('href="https://maps.google.com'); // a listed extra host gives no link without a source
}, 120_000);
