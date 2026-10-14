import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { HttpReportRegistryMcp, requireLoopbackMcpEndpoint, type ReportRegistryMcp } from "../src/mcp-client.ts";
import {
  LIVE_PROMOTION_CONFIRMATION,
  promoteReport,
  type PromoteReportInput,
} from "../src/promote.ts";

type FakeDocument = {
  header: { id: string; name: string; documentType: string };
  state: { global: Record<string, unknown> };
};

class FakeMcp implements ReportRegistryMcp {
  documents = new Map<string, FakeDocument>();
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  failNextAddActions = false;
  failAfterRegisterNextAddActions = false;
  nextId = 1;

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args: structuredClone(args) });
    if (name === "getDocuments") return { documentIds: [...this.documents.keys()] };
    if (name === "getDocument") {
      const document = this.documents.get(String(args.id));
      if (!document) throw new Error("not found");
      return { document: structuredClone(document) };
    }
    if (name === "createDocument") {
      const id = `document-${this.nextId++}`;
      const document: FakeDocument = {
        header: { id, name: String(args.name), documentType: String(args.documentType) },
        state: { global: {} },
      };
      this.documents.set(id, document);
      return { document: structuredClone(document) };
    }
    if (name === "addActions") {
      if (this.failNextAddActions) {
        this.failNextAddActions = false;
        throw new Error("simulated lost connection");
      }
      const document = this.documents.get(String(args.documentId));
      if (!document) throw new Error("not found");
      const actions = args.actions as Array<{ type: string; input: Record<string, unknown> }>;
      for (const action of actions) {
        if (action.type === "REGISTER_REPORT") {
          const input = action.input;
          document.state.global = {
            id: input.id,
            reportRef: input.reportRef,
            title: input.title,
            projectRef: input.projectRef ?? null,
            familyRef: input.familyRef ?? null,
            sourceRef: input.sourceRef ?? null,
            producer: structuredClone(input.producer),
            content: structuredClone(input.content),
            lifecycle: input.lifecycle,
            revision: 1,
            attention: {
              request: "NONE",
              reasonCode: null,
              reason: null,
              reviewBy: null,
              expiresAt: null,
              requestedAt: null,
              resolvedAt: null,
            },
          };
          if (this.failAfterRegisterNextAddActions) {
            this.failAfterRegisterNextAddActions = false;
            throw new Error("simulated partial batch failure");
          }
        } else if (action.type === "REQUEST_REVIEW") {
          if (action.input.expectedRevision !== document.state.global.revision) {
            throw new Error("simulated revision conflict");
          }
          document.state.global.attention = {
            request: action.input.request,
            reasonCode: action.input.reasonCode ?? null,
            reason: action.input.reason ?? null,
            reviewBy: action.input.reviewBy ?? null,
            expiresAt: action.input.expiresAt ?? null,
            requestedAt: action.input.occurredAt,
            resolvedAt: null,
          };
          document.state.global.revision = Number(document.state.global.revision) + 1;
        }
      }
      return { ok: true };
    }
    throw new Error(`unexpected tool ${name}`);
  }
}

function fixture(overrides: Partial<PromoteReportInput> = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "report-promotion-test-")));
  const file = join(root, "report.md");
  writeFileSync(file, "# Operator report\n\nChoose the bounded path.\n");
  const input: PromoteReportInput = {
    confirmation: LIVE_PROMOTION_CONFIRMATION,
    driveId: "drive:test",
    file,
    title: "Operator report",
    reportRef: "report:test:operator-report",
    sourceRef: "agent://research-agent/operator-report",
    projectRef: "daily-driver",
    familyRef: "daily-driver-status",
    producer: { kind: "AGENT", id: "research-agent", label: "Research Agent" },
    attention: "DECIDE",
    reasonCode: "operator_decision",
    reason: "Choose the bounded path.",
    reviewBy: "2026-08-16T17:00:00.000Z",
    actorId: "research-agent",
    occurredAt: "2026-08-15T14:00:00.000Z",
    receiptDir: join(root, "receipts"),
    lockDir: join(root, "publisher-locks"),
    ...overrides,
  };
  return { root, file, input };
}

describe("live report promotion", () => {
  it("registers immutable Markdown and attention, verifies state, and writes a content-free receipt", async () => {
    const mcp = new FakeMcp();
    const { input } = fixture();
    const receipt = await promoteReport(input, mcp);

    assert.equal(receipt.status, "CREATED");
    assert.equal(receipt.documentId, "document-1");
    assert.equal(receipt.attention, "DECIDE");
    const add = mcp.calls.find((call) => call.name === "addActions");
    const actions = add?.args.actions as Array<{ type: string; input: Record<string, unknown> }>;
    assert.deepEqual(actions.map((action) => action.type), ["REGISTER_REPORT", "REQUEST_REVIEW"]);
    assert.equal((actions[0].input.content as Record<string, unknown>).contentHash, receipt.contentHash);
    assert.equal(actions[1].input.expectedRevision, 1);
    const storedReceipt = readFileSync(receipt.receiptPath, "utf8");
    assert.doesNotMatch(storedReceipt, /Choose the bounded path/);
    assert.equal(statSync(receipt.receiptPath).mode & 0o777, 0o600);
  });

  it("matches the cross-repository service-actor publisher envelope", async () => {
    const mcp = new FakeMcp();
    const { input } = fixture({
      driveId: "drive:report-registry",
      reportRef: "report:test:service-actor-envelope",
      actorId: "service:report-publisher",
      occurredAt: "2026-08-23T15:00:00.000Z",
      reviewBy: "2026-08-24T17:00:00.000Z",
    });
    await promoteReport(input, mcp);
    const fixturePath = join(
      import.meta.dirname,
      "fixtures/producer-envelope.service-actor.v1.json",
    );
    const golden = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      actorId: string;
      calls: Array<{ name: string; args: Record<string, unknown> }>;
    };
    assert.equal(golden.actorId, input.actorId);
    assert.deepEqual(
      mcp.calls.filter((call) =>
        new Set(["createDocument", "addActions"]).has(call.name),
      ),
      golden.calls,
    );
  });

  it("is idempotent for an identical reportRef and content receipt", async () => {
    const mcp = new FakeMcp();
    const { input } = fixture();
    const first = await promoteReport(input, mcp);
    const second = await promoteReport(input, mcp);
    assert.equal(second.status, "CREATED");
    assert.equal(second.promotedAt, first.promotedAt);
    assert.deepEqual(second, first);
    assert.equal(mcp.calls.filter((call) => call.name === "createDocument").length, 1);
    assert.equal(mcp.calls.filter((call) => call.name === "addActions").length, 1);
  });

  it("serializes the same Drive/report across different receipt directories", async () => {
    const mcp = new FakeMcp();
    const { input, root } = fixture();
    const first = promoteReport(input, mcp);
    await assert.rejects(
      promoteReport({ ...input, receiptDir: join(root, "other-receipts") }, mcp),
      /PROMOTION_LOCKED/,
    );
    assert.equal((await first).status, "CREATED");
  });

  it("requires the shared publisher lock directory before contacting the Drive", async () => {
    const mcp = new FakeMcp();
    const { input } = fixture();
    await assert.rejects(
      promoteReport({ ...input, lockDir: undefined as unknown as string }, mcp),
      /PROMOTION_LOCK_DIR_REQUIRED/,
    );
    assert.equal(mcp.calls.length, 0);
  });

  it("recognizes the exact receipt during its no-clobber publication window", async () => {
    const mcp = new FakeMcp();
    const { input } = fixture();
    const first = await promoteReport(input, mcp);
    const publicationLink = `${first.receiptPath}.race.tmp`;
    linkSync(first.receiptPath, publicationLink);
    try {
      assert.deepEqual(await promoteReport(input, mcp), first);
    } finally {
      unlinkSync(publicationLink);
    }
  });

  it("rejects pathname substitution when recovering an existing receipt", async () => {
    const mcp = new FakeMcp();
    const { input, root } = fixture();
    const first = await promoteReport(input, mcp);
    const substituted = join(root, "substituted-receipt.json");
    writeFileSync(substituted, readFileSync(first.receiptPath), { mode: 0o600 });
    unlinkSync(first.receiptPath);
    symlinkSync(substituted, first.receiptPath);
    await assert.rejects(promoteReport(input, mcp), /PROMOTION_RECEIPT_INVALID/);
  });

  it("recovers the blank intent document after a create-to-actions crash window", async () => {
    const mcp = new FakeMcp();
    mcp.failNextAddActions = true;
    const { input } = fixture();
    await assert.rejects(promoteReport(input, mcp), /simulated lost connection/);
    const recovered = await promoteReport(input, mcp);
    assert.equal(recovered.status, "RECOVERED");
    assert.equal(mcp.calls.filter((call) => call.name === "createDocument").length, 1);
    assert.equal(mcp.documents.size, 1);
  });

  it("recovers a matching report when registration landed before the review request failed", async () => {
    const mcp = new FakeMcp();
    mcp.failAfterRegisterNextAddActions = true;
    const { input } = fixture();
    await assert.rejects(promoteReport(input, mcp), /simulated partial batch failure/);

    const recovered = await promoteReport(input, mcp);
    assert.equal(recovered.status, "RECOVERED");
    assert.equal(recovered.documentId, "document-1");
    assert.equal(mcp.calls.filter((call) => call.name === "createDocument").length, 1);
    const writes = mcp.calls.filter((call) => call.name === "addActions");
    assert.equal(writes.length, 2);
    const recoveryActions = writes[1].args.actions as Array<{ type: string; input: Record<string, unknown> }>;
    assert.deepEqual(recoveryActions.map((action) => action.type), ["REQUEST_REVIEW"]);
    assert.equal(recoveryActions[0].input.expectedRevision, 1);
    assert.equal(mcp.documents.get("document-1")?.state.global.revision, 2);
  });

  it("fails closed when a reportRef is reused for different bytes", async () => {
    const mcp = new FakeMcp();
    const { input, file } = fixture();
    await promoteReport(input, mcp);
    writeFileSync(file, "# Changed report\n");
    await assert.rejects(promoteReport(input, mcp), /REPORT_REF_CONFLICT:.*content\.contentHash/);
  });

  it("rejects staged-file replacement against the caller-supplied identity before MCP use", async () => {
    const mcp = new FakeMcp();
    const { input, file } = fixture();
    const admittedBytes = readFileSync(file);
    const expectedContentHash = createHash("sha256").update(admittedBytes).digest("hex");
    const expectedByteSize = admittedBytes.byteLength;

    writeFileSync(file, "# Replaced after admission\n");

    await assert.rejects(
      promoteReport({ ...input, expectedContentHash, expectedByteSize }, mcp),
      /EXPECTED_CONTENT_IDENTITY_MISMATCH/,
    );
    assert.equal(mcp.calls.length, 0);
  });

  it("requires the explicit live gate before reading or mutating the Reactor", async () => {
    const mcp = new FakeMcp();
    const { input } = fixture({ confirmation: "yes" });
    await assert.rejects(promoteReport(input, mcp), /PROMOTION_CONFIRMATION_REQUIRED/);
    assert.equal(mcp.calls.length, 0);
  });

  it("requires an explicit authority actor instead of defaulting to producer metadata", async () => {
    const mcp = new FakeMcp();
    const { input } = fixture();
    await assert.rejects(
      promoteReport(
        { ...input, actorId: undefined as unknown as string },
        mcp,
      ),
      /ACTORID_REQUIRED/u,
    );
    assert.equal(mcp.calls.length, 0);
  });

  it("keeps unsupported binaries out of the inline-only live slice", async () => {
    const mcp = new FakeMcp();
    const { root, input } = fixture();
    const pdf = join(root, "report.pdf");
    writeFileSync(pdf, "%PDF-1.4\n");
    await assert.rejects(promoteReport({ ...input, file: pdf }, mcp), /CONTENT_TYPE_UNSUPPORTED/);
    assert.equal(mcp.calls.length, 0);
  });

  it("rejects empty Markdown before contacting the Reactor", async () => {
    const mcp = new FakeMcp();
    const { input, file } = fixture();
    writeFileSync(file, "\n\t");
    await assert.rejects(promoteReport(input, mcp), /CONTENT_EMPTY/);
    assert.equal(mcp.calls.length, 0);
  });

  it("rejects Markdown that is not valid round-trippable UTF-8", async () => {
    const mcp = new FakeMcp();
    const { input, file } = fixture();
    writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    await assert.rejects(promoteReport(input, mcp), /CONTENT_ENCODING_INVALID/);
    assert.equal(mcp.calls.length, 0);
  });

  it("never overwrites a stale receipt temporary file", async () => {
    const mcp = new FakeMcp();
    const { input, file } = fixture();
    const bytes = readFileSync(file);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const receiptId = createHash("sha256")
      .update(`${input.driveId}\0${input.reportRef}\0${contentHash}`)
      .digest("hex")
      .slice(0, 24);
    mkdirSync(input.receiptDir, { recursive: true, mode: 0o700 });
    const temporary = join(input.receiptDir, `${receiptId}.json.${process.pid}.tmp`);
    writeFileSync(temporary, "sentinel", { mode: 0o600 });

    const receipt = await promoteReport(input, mcp);
    assert.equal(receipt.status, "CREATED");
    assert.equal(readFileSync(temporary, "utf8"), "sentinel");
  });
});

describe("MCP endpoint boundary", () => {
  it("allows only loopback HTTP for the authenticated promotion boundary", () => {
    assert.equal(requireLoopbackMcpEndpoint("http://127.0.0.1:14250/mcp"), "http://127.0.0.1:14250/mcp");
    assert.throws(() => requireLoopbackMcpEndpoint("https://example.com/mcp"), /MCP_ENDPOINT_FORBIDDEN/);
    assert.throws(() => requireLoopbackMcpEndpoint("http://100.64.0.1:4250/mcp"), /MCP_ENDPOINT_FORBIDDEN/);
  });

  it("refuses redirects so a loopback endpoint cannot forward report content remotely", async () => {
    const originalFetch = globalThis.fetch;
    let observedRedirect: RequestRedirect | undefined;
    let observedAuthorization: string | null = null;
    globalThis.fetch = (async (_input, init) => {
      observedRedirect = init?.redirect;
      observedAuthorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        result: { structuredContent: { ok: true } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const token = "producer-token-000000000000000000000000000000";
      const mcp = new HttpReportRegistryMcp("http://127.0.0.1:14250/mcp", token);
      await mcp.call("getDocuments", { parentId: "drive:test" });
      assert.equal(observedRedirect, "error");
      assert.equal(observedAuthorization, `Bearer ${token}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
