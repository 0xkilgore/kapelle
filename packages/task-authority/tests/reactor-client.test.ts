import { describe, expect, it } from "vitest";
import { McpReactorClient } from "../src/gateway/reactor-client.js";

function response(value: unknown, contentType = "application/json") {
  return new Response(
    contentType === "text/event-stream"
      ? `event: message\ndata: ${JSON.stringify(value)}\n\n`
      : JSON.stringify(value),
    { status: 200, headers: { "content-type": contentType } },
  );
}

describe("McpReactorClient", () => {
  it("probes the Reactor contract and configured drive through bounded GraphQL and MCP", async () => {
    const calls: Array<{ url: string; body: any; redirect: RequestRedirect | undefined; signal: AbortSignal | null | undefined }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body, redirect: init?.redirect, signal: init?.signal });
      if (url.endsWith("/graphql/r")) {
        return response({
          data: { __type: { fields: [{ name: "documentOperations" }] } },
        });
      }
      return response({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          structuredContent: { documentIds: [] },
        },
      });
    };
    const client = new McpReactorClient("http://127.0.0.1:14250/mcp", fakeFetch);
    await expect(client.probe("configured-drive")).resolves.toBeUndefined();
    expect(calls.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:14250/graphql/r",
      "http://127.0.0.1:14250/mcp",
    ]);
    expect(calls[1]?.body.params).toEqual({
      name: "getDocuments",
      arguments: { parentId: "configured-drive" },
    });
    expect(calls.every(({ redirect }) => redirect === "error")).toBe(true);
    expect(calls.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
  });

  it("fails readiness on GraphQL errors without exposing them through the API contract", async () => {
    const fakeFetch: typeof fetch = async () => response({
      errors: [{ message: "private Reactor detail" }],
    });
    const client = new McpReactorClient("http://127.0.0.1:14250/mcp", fakeFetch);
    await expect(client.probe("configured-drive")).rejects.toThrow("GraphQL errors");
  });

  it("aborts a probe whose upstream never resolves", async () => {
    const fakeFetch: typeof fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    const client = new McpReactorClient("http://127.0.0.1:14250/mcp", fakeFetch);

    const startedAt = Date.now();
    await expect(client.probe("configured-drive")).rejects.toThrow();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
    expect(Date.now() - startedAt).toBeLessThan(3_500);
  }, 5_000);

  it("rejects endpoints that cannot prove the MCP/GraphQL Reactor pair", () => {
    expect(() => new McpReactorClient("http://127.0.0.1:14250/anything"))
      .toThrow("must end in /mcp");
    expect(() => new McpReactorClient("http://127.0.0.1:14250/mcp?target=other"))
      .toThrow("must end in /mcp");
  });

  it("uses MCP for documents and GraphQL for the operation/error ledger", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body });
      if (url.endsWith("/graphql/r")) {
        return response({
          data: {
            documentOperations: {
              items: [{
                id: "op",
                index: 0,
                error: null,
                action: { id: "action", type: "CREATE_TASK", input: { title: "x" } },
              }],
            },
          },
        });
      }
      return response({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: JSON.stringify({
            document: {
              header: { id: "task", name: "task", revision: { global: 1 } },
              state: { global: { id: "task" } },
            },
          }) }],
        },
      }, "text/event-stream");
    };
    const client = new McpReactorClient("http://127.0.0.1:14250/mcp", fakeFetch);

    expect((await client.getDocument("task")).header.id).toBe("task");
    expect(await client.getOperations("task", 0)).toEqual([
      {
        id: "op",
        index: 0,
        error: null,
        action: { id: "action", type: "CREATE_TASK", input: { title: "x" } },
      },
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:14250/mcp",
      "http://127.0.0.1:14250/graphql/r",
    ]);
  });

  it("sends only the MCP-supported action fields", async () => {
    let sent: any;
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      sent = body.params.arguments.actions[0];
      return response({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: "{\"success\":true}" }] },
      }, "text/event-stream");
    };
    const client = new McpReactorClient("http://127.0.0.1:14250/mcp", fakeFetch);
    await client.addActions("task", [{
      id: "private-action-id",
      timestampUtcMs: "2026-08-13T20:00:00.000Z",
      type: "UPDATE_TITLE",
      input: { title: "x", actorId: "chris", occurredAt: "2026-08-13T20:00:00.000Z" },
      scope: "global",
    } as any]);
    expect(sent).toEqual({
      type: "UPDATE_TITLE",
      input: { title: "x", actorId: "chris", occurredAt: "2026-08-13T20:00:00.000Z" },
      scope: "global",
    });
  });

  it("bounds the crash-recovery name scan before fetching candidates", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      return response({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({ documentIds: ["one", "two", "three"] }),
          }],
        },
      }, "text/event-stream");
    };
    const client = new McpReactorClient("http://127.0.0.1:14250/mcp", fakeFetch);

    await expect(client.findDocumentByName("drive", "intent", 2)).rejects.toMatchObject({
      code: "CREATE_RECOVERY_SCAN_LIMIT",
      status: 503,
    });
    expect(calls).toBe(1);
  });
});
