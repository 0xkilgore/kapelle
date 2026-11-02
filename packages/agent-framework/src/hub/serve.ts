// Entrypoint: `node --import tsx src/hub/serve.ts <hub-config.json>` — the shared hub until SIGTERM/SIGINT.
import { readFileSync } from "node:fs";
import { openHub, startMailCountLog } from "./hub-launcher.js";
const path = process.argv[2];
if (!path) { console.error("usage: serve.ts <hub-config.json>"); process.exit(2); }
const h = await openHub(JSON.parse(readFileSync(path, "utf8")));
console.log(JSON.stringify({ ok: true, port: h.port }));
const mailLog = startMailCountLog(h.mail); // hourly + at shutdown: {"mail":{"sent","failed","lastError"}} (counts only)
const stop = async () => { mailLog.stop(); await h.close(); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
