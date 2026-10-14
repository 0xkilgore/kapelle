import type {
  GatewayAction,
  ReactorOperation,
  ReactorPort,
  ReactorTaskDocument,
} from "./types.js";
import { GatewayError } from "./types.js";

type McpEnvelope = {
  error?: unknown;
  result?: {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
  };
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reactor returned a non-object payload");
  }
  return value as Record<string, unknown>;
}

export class McpReactorClient implements ReactorPort {
  readonly #endpoint: string;
  readonly #graphqlEndpoint: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImpl: typeof fetch = fetch) {
    const parsed = new URL(endpoint);
    if (parsed.search || parsed.hash || !parsed.pathname.endsWith("/mcp")) {
      throw new Error("Reactor MCP endpoint must end in /mcp without query or fragment");
    }
    this.#endpoint = parsed.toString();
    parsed.pathname = parsed.pathname.slice(0, -4) + "/graphql/r";
    this.#graphqlEndpoint = parsed.toString();
    this.#fetch = fetchImpl;
  }

  async probe(driveId: string): Promise<void> {
    const response = await this.#fetch(this.#graphqlEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "{ __type(name: \"Query\") { fields { name } } }",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`Reactor probe: HTTP ${response.status}`);
    const payload = object(await response.json());
    if (payload.errors) throw new Error("Reactor probe returned GraphQL errors");
    const data = object(payload.data);
    const queryType = object(data.__type);
    const fields = Array.isArray(queryType.fields) ? queryType.fields : [];
    if (!fields.some((field) => object(field).name === "documentOperations")) {
      throw new Error("Reactor probe returned an unexpected response");
    }

    const documents = object(await this.#call(
      "getDocuments",
      { parentId: driveId },
      { bounded: true },
    ));
    if (!Array.isArray(documents.documentIds)) {
      throw new Error("Reactor MCP probe omitted documentIds");
    }
  }

  async createDocument(input: {
    documentType: "kilgore/task";
    name: string;
    driveId: string;
  }): Promise<string> {
    const payload = object(await this.#call("createDocument", input));
    const document = payload.document ? object(payload.document) : undefined;
    const header = document?.header ? object(document.header) : undefined;
    const id = payload.id ?? payload.documentId ?? header?.id;
    if (typeof id !== "string" || !id) throw new Error("createDocument omitted its id");
    return id;
  }

  async findDocumentByName(
    driveId: string,
    name: string,
    maxCandidates: number,
  ): Promise<string | null> {
    const payload = object(await this.#call("getDocuments", { parentId: driveId }));
    const ids = Array.isArray(payload.documentIds) ? payload.documentIds : [];
    if (ids.length > maxCandidates) {
      throw new GatewayError(
        `create recovery refused to scan ${ids.length} documents; limit is ${maxCandidates}`,
        503,
        "CREATE_RECOVERY_SCAN_LIMIT",
      );
    }
    for (const id of ids) {
      if (typeof id !== "string") continue;
      const candidate = await this.getDocument(id);
      if (candidate.header.name === name) return candidate.header.id;
    }
    return null;
  }

  async getDocument(id: string): Promise<ReactorTaskDocument> {
    const payload = object(await this.#call("getDocument", { id }));
    return object(payload.document) as unknown as ReactorTaskDocument;
  }

  async addActions(documentId: string, actions: GatewayAction[]): Promise<void> {
    const payload = object(await this.#call("addActions", {
      documentId,
      actions: actions.map((action) => ({
        type: action.type,
        input: action.input,
        scope: action.scope,
      })),
    }));
    if (payload.success !== true) throw new Error("Reactor rejected actions");
  }

  async getOperations(id: string, sinceRevision = 0): Promise<ReactorOperation[]> {
    const response = await this.#fetch(this.#graphqlEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `query Operations($id: String!, $since: Int!) {
          documentOperations(filter: {
            documentId: $id,
            scopes: ["global"],
            sinceRevision: $since
          }) {
            items { id index error action { id type input } }
          }
        }`,
        variables: { id, since: sinceRevision },
      }),
    });
    if (!response.ok) throw new Error(`Reactor operations: HTTP ${response.status}`);
    const payload = object(await response.json());
    if (payload.errors) throw new Error(`Reactor operations: ${JSON.stringify(payload.errors)}`);
    const data = object(payload.data);
    const result = object(data.documentOperations);
    return (Array.isArray(result.items) ? result.items : []) as ReactorOperation[];
  }

  async #call(
    name: string,
    args: Record<string, unknown>,
    options: { bounded?: boolean } = {},
  ): Promise<unknown> {
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${name}-${crypto.randomUUID()}`,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      ...(options.bounded
        ? { redirect: "error" as const, signal: AbortSignal.timeout(2_000) }
        : {}),
    });
    if (!response.ok) throw new Error(`Reactor ${name}: HTTP ${response.status}`);
    const body = await response.text();
    const data = body
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice(6);
    const envelope = JSON.parse(data ?? body) as McpEnvelope;
    if (envelope.error) throw new Error(`Reactor ${name}: ${JSON.stringify(envelope.error)}`);
    if (envelope.result?.isError) {
      throw new Error(`Reactor ${name}: ${JSON.stringify(envelope.result.content)}`);
    }
    if (envelope.result?.structuredContent != null) {
      return envelope.result.structuredContent;
    }
    const text = envelope.result?.content?.find((entry) => entry.type === "text")?.text;
    if (!text) throw new Error(`Reactor ${name}: missing payload`);
    return JSON.parse(text) as unknown;
  }
}
