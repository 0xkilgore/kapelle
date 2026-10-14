export type McpEnvelope = {
  jsonrpc?: unknown;
  id?: unknown;
  error?: unknown;
  result?: {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
  };
};

export function parseMcpEnvelope(body: string, contentType: string | null): McpEnvelope {
  if (!contentType?.toLowerCase().includes("text/event-stream")) {
    const parsed = JSON.parse(body) as McpEnvelope;
    if (isJsonRpcEnvelope(parsed)) return parsed;
    throw new Error("Vetra returned a non-JSON-RPC payload");
  }

  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) continue;
    let parsed: McpEnvelope;
    try {
      parsed = JSON.parse(data) as McpEnvelope;
    } catch {
      continue;
    }
    if (isJsonRpcEnvelope(parsed)) return parsed;
  }
  throw new Error("Vetra returned no JSON-RPC event");
}

function isJsonRpcEnvelope(value: McpEnvelope): boolean {
  return Boolean(value && value.jsonrpc === "2.0" && (value.result !== undefined || value.error !== undefined));
}

export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Concurrency must be a positive integer");
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await map(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function validatedMcpEndpoint(value: string, allowedRemoteHosts: readonly string[]): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) return null;
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (!loopback && (url.protocol !== "https:" || !allowedRemoteHosts.includes(url.hostname))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function reportRegistryAuthorizationHeader(value: string | undefined): string | null {
  const token = value?.trim();
  if (!token || token.length < 32 || /\s/.test(token)) return null;
  return `Bearer ${token}`;
}
