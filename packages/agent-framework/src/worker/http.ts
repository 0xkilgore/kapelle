import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RestrictedWorker } from "./worker.js";
export function workerHandler(worker: RestrictedWorker, token: () => string, observationOnly = false) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      });
      res.end(JSON.stringify(body));
    };
    const secret = token(),
      a = Buffer.from(req.headers.authorization ?? ""),
      b = Buffer.from("Bearer " + secret);
    if (
      secret.length < 32 ||
      a.length !== b.length ||
      !timingSafeEqual(a, b) ||
      req.headers.origin ||
      req.headers["x-id-owner"] ||
      req.headers["x-id-admin"]
    )
      return reply(403, { ok: false, error: "forbidden" });
    if (observationOnly) return reply(403, { ok: false, error: 'observation_only' });
    if (req.method === "GET" && req.url === "/status")
      return reply(200, { ok: true, contract: "kapelle.document-review/v1", ...worker.status() });
    if (req.method === 'GET' && req.url?.startsWith('/executions/')) {
      try { const execution=worker.execution(decodeURIComponent(req.url.slice('/executions/'.length)));
        return execution ? reply(200,{ok:true,execution}) : reply(404,{ok:false,error:'not_found'});
      } catch { return reply(409,{ok:false,error:'execution_unavailable'}); }
    }
    if (req.method !== "POST" || req.url !== "/run")
      return reply(404, { ok: false, error: "not_found" });
    if (!(req.headers["content-type"] ?? "").startsWith("application/json"))
      return reply(415, { ok: false, error: "json_required" });
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const c of req) {
        size += c.length;
        if (size > 600000) return reply(413, { ok: false, error: "request_too_large" });
        chunks.push(Buffer.from(c));
      }
      const result = await worker.run(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      return reply(200, { ok: true, result });
    } catch {
      return reply(409, { ok: false, error: "restricted_worker_did_not_complete" });
    }
  };
}
