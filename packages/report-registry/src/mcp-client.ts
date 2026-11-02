const MAX_MCP_RESPONSE_BYTES = 2_000_000;

type McpEnvelope = {
  jsonrpc?: unknown;
  error?: unknown;
  result?: {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
};

export type ReportRegistryMcp = {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Synchronous durable marker after local framing, immediately before possible send. */
  callWithStart?(name: string, args: Record<string, unknown>, beforeSend: () => void): Promise<unknown>;
};

export class HttpReportRegistryMcp implements ReportRegistryMcp {
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly #token: string;

  constructor(endpoint: string, token: string, timeoutMs = 10_000) {
    this.endpoint = requireLoopbackMcpEndpoint(endpoint);
    this.#token = requireMcpToken(token);
    this.timeoutMs = timeoutMs;
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.callWithStart(name, args, () => {});
  }

  async callWithStart(name: string, args: Record<string, unknown>, beforeSend: () => void): Promise<unknown> {
    const request: RequestInit = {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${name}-${crypto.randomUUID()}`,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    beforeSend();
    const response = await fetch(this.endpoint, request);
    if (!response.ok) throw new Error(`MCP_HTTP_ERROR: ${name} returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_RESPONSE_BYTES) {
      throw new Error(`MCP_RESPONSE_TOO_LARGE: ${name}`);
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_MCP_RESPONSE_BYTES) {
      throw new Error(`MCP_RESPONSE_TOO_LARGE: ${name}`);
    }
    const envelope = parseEnvelope(body, response.headers.get("content-type"));
    if (envelope.error) throw new Error(`MCP_JSONRPC_ERROR: ${name}`);
    if (envelope.result?.isError) throw new Error(`MCP_TOOL_REJECTED: ${name}`);
    if (envelope.result?.structuredContent !== undefined) return envelope.result.structuredContent;
    const text = envelope.result?.content?.find((entry) => entry.type === "text")?.text;
    if (typeof text !== "string" || text.length === 0) throw new Error(`MCP_PAYLOAD_MISSING: ${name}`);
    return JSON.parse(text) as unknown;
  }
}

export function requireLoopbackMcpEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("MCP_ENDPOINT_INVALID: endpoint must be a URL");
  }
  if (endpoint.username || endpoint.password || endpoint.protocol !== "http:") {
    throw new Error("MCP_ENDPOINT_FORBIDDEN: only authenticated loopback HTTP is supported");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("MCP_ENDPOINT_FORBIDDEN: endpoint must be loopback");
  }
  return endpoint.toString();
}

export function requireMcpToken(value: string): string {
  if (typeof value !== "string" || value.length < 32) {
    throw new Error("MCP_TOKEN_INVALID: a token of at least 32 characters is required");
  }
  if (/\s/.test(value)) throw new Error("MCP_TOKEN_INVALID: token must not contain whitespace");
  return value;
}

function parseEnvelope(body: string, contentType: string | null): McpEnvelope {
  if (!contentType?.toLowerCase().includes("text/event-stream")) {
    const parsed = JSON.parse(body) as McpEnvelope;
    if (validEnvelope(parsed)) return parsed;
    throw new Error("MCP_ENVELOPE_INVALID");
  }
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) continue;
    const parsed = JSON.parse(data) as McpEnvelope;
    if (validEnvelope(parsed)) return parsed;
  }
  throw new Error("MCP_ENVELOPE_INVALID");
}

function validEnvelope(value: McpEnvelope): boolean {
  return Boolean(value && value.jsonrpc === "2.0" && (value.result !== undefined || value.error !== undefined));
}
