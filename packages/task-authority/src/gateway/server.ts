import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { TaskGatewayApi } from "./api.js";
import { AuthRegistry, type GatewayClientInput } from "./auth.js";
import { TaskGatewayCore } from "./core.js";
import { DriveInstanceLock } from "./drive-lock.js";
import { McpReactorClient } from "./reactor-client.js";
import { ReceiptStore } from "./receipt-store.js";
import type { ReactorPort } from "./types.js";

const MAX_BODY_BYTES = 1_048_576;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function clients(): GatewayClientInput[] {
  const value = JSON.parse(requiredEnv("TASK_GATEWAY_CLIENTS_JSON")) as unknown;
  if (!Array.isArray(value)) throw new Error("TASK_GATEWAY_CLIENTS_JSON must be an array");
  return value as GatewayClientInput[];
}

async function requestBody(request: IncomingMessage): Promise<ArrayBuffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  const result = Buffer.concat(chunks);
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
}

async function webRequest(request: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value != null) headers.set(name, value);
  }
  const body = await requestBody(request);
  return new Request(`http://127.0.0.1${request.url ?? "/"}`, {
    method: request.method,
    headers,
    body,
  });
}

async function send(response: ServerResponse, webResponse: Response): Promise<void> {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}

export function startGatewayFromEnvironment(options?: { reactor?: ReactorPort }) {
  const host = process.env.TASK_GATEWAY_HOST?.trim() ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("Task Gateway must bind to 127.0.0.1");
  const port = Number(process.env.TASK_GATEWAY_PORT ?? "4260");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("TASK_GATEWAY_PORT must be a valid TCP port");
  }
  const driveId = requiredEnv("TASK_GATEWAY_DRIVE_ID");
  const lock = DriveInstanceLock.acquire(requiredEnv("TASK_GATEWAY_LOCK_DIR"), driveId);
  let receipts: ReceiptStore | undefined;
  let core: TaskGatewayCore | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    receipts?.close();
    lock.release();
  };
  try {
    receipts = new ReceiptStore(requiredEnv("TASK_GATEWAY_RECEIPT_DB"));
    core = new TaskGatewayCore({
      driveId,
      reactor: options?.reactor ?? new McpReactorClient(
        process.env.TASK_GATEWAY_REACTOR_MCP_URL ?? "http://127.0.0.1:14250/mcp",
      ),
      receipts,
      ownsDrive: () => lock.isOwned(),
    });
    const api = new TaskGatewayApi(core, new AuthRegistry(clients()));
    const server = createServer(async (request, response) => {
      try {
        await send(response, await api.handle(await webRequest(request)));
      } catch {
        response.statusCode = 400;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ error: { code: "BAD_REQUEST", message: "invalid request" } }));
      }
    });
    const close = server.close.bind(server);
    server.close = ((callback?: (error?: Error) => void) => {
      core?.beginShutdown();
      return close(callback);
    }) as typeof server.close;
    server.listen(port, host);
    server.once("error", () => {
      core?.beginShutdown();
      cleanup();
    });
    server.once("close", () => {
      core?.beginShutdown();
      cleanup();
    });
    return server;
  } catch (error) {
    cleanup();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const server = startGatewayFromEnvironment();
  const shutdown = () => server.close();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.once("close", () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  });
  server.once("error", (error) => {
    console.error(`Task Gateway failed to start: ${error.message}`);
    process.exitCode = 1;
  });
}
