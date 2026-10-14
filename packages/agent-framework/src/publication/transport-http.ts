import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { assert } from "../validation.js";

/** Fixed configured origin only. HTTP is allowed solely for a private loopback listener. */
export function privateEndpoint(value: string) {
  const url = new URL(value);
  assert(
    !url.username && !url.password && !url.search && !url.hash && url.pathname === "/",
    "Invalid transport origin",
  );
  assert(
    url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)),
    "Private transport origin required",
  );
  return url.origin;
}
export async function boundedBytes(response: Response, limit: number) {
  assert(response.body, "Transport response unavailable");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      assert(size <= limit, "Transport response too large");
      chunks.push(item.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export async function jsonRequest(
  origin: string,
  path: string,
  token: () => string,
  request: typeof fetch,
  body?: unknown,
) {
  const secret = token();
  assert(secret.length >= 32, "Transport credential unavailable");
  let response: Response;
  try {
    response = await request(new URL(path, origin), {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Transport acknowledgement unavailable; reconcile saved identity");
  }
  if (response.status === 404 && body === undefined) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Transport denied or unavailable");
  }
  try {
    return JSON.parse((await boundedBytes(response, 300_000)).toString("utf8"));
  } catch {
    throw new Error("Transport receipt unavailable");
  }
}
export function machineHandler(
  token: () => string,
  route: (method: string, url: URL, body: unknown) => Promise<unknown>,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "private, no-store",
      });
      res.end(JSON.stringify(body));
    };
    let secret: string;
    try {
      secret = token();
    } catch {
      return reply(503, { error: "credential_scope_unavailable" });
    }
    const actual = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from(`Bearer ${secret}`);
    if (
      secret.length < 32 ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      return reply(403, { error: "forbidden" });
    // Browser/owner-session requests never reach the machine command surface.
    if (req.headers.origin || req.headers["x-id-team"] || req.headers["x-id-admin"])
      return reply(403, { error: "forbidden" });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        assert(size <= 262144, "Request too large");
        chunks.push(Buffer.from(chunk));
      }
      const body = size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const result = await route(
        req.method ?? "",
        new URL(req.url ?? "/", "http://machine.invalid"),
        body,
      );
      reply(result === null ? 404 : 200, result ?? { error: "not_found" });
    } catch {
      reply(409, { error: "publication_not_admitted_or_unconfirmed" });
    }
  };
}
