// Entrypoint: `node --import tsx src/org/serve.ts <org-config.json>` — one org runtime until SIGTERM/SIGINT.
import { readFileSync } from "node:fs";
import { openOrgRuntime } from "./org-runtime.js";
const path = process.argv[2];
if (!path) { console.error("usage: serve.ts <org-config.json>"); process.exit(2); }
const org = await openOrgRuntime(JSON.parse(readFileSync(path, "utf8")));
console.log(JSON.stringify({ ok: true, orgId: org.config.orgId, swept: { orphans: org.swept.orphans.length, replies: org.swept.replies.length } }));
const stop = async () => { await org.close(); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
