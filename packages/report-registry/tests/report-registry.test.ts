import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ContentAddressedBlobStore, EncryptedContentAddressedBlobStore, blobKeyFromBase64 } from "../src/blob-store.ts";
import { actions, reduceReport, type ReportDocument, type ReportOperation } from "../src/model.ts";
import { buildAttentionProjection } from "../src/projection.ts";
import { registerReport } from "../src/register.ts";
import { probeReactor } from "../src/reactor.ts";
import { FilesystemReportStore } from "../src/store.ts";

const T0 = "2026-08-13T12:00:00.000Z";
const T1 = "2026-08-13T12:01:00.000Z";
const T2 = "2026-08-13T12:02:00.000Z";

function tempStores() {
  const root = mkdtempSync(join(tmpdir(), "report-registry-test-"));
  return {
    root,
    reports: new FilesystemReportStore(join(root, "documents")),
    blobs: new ContentAddressedBlobStore(join(root, "blobs")),
  };
}

function registered(options: { lifecycle?: "draft" | "final"; ref?: string } = {}): ReportDocument {
  return reduceReport(null, actions.registerReport({
    report_ref: options.ref ?? "report:test:one",
    title: "Test report",
    project_ref: "daily-driver",
    producer: { kind: "agent", id: "research-agent" },
    content: {
      storage: "inline_markdown",
      mime_type: "text/markdown",
      filename: "report.md",
      content_hash: "a".repeat(64),
      byte_size: 7,
      markdown: "# Test\n",
      blob_ref: null,
    },
    lifecycle: options.lifecycle ?? "final",
  }, "research-agent", T0));
}

function withAttention(ref: string, request: "read" | "decide" = "decide", reviewBy?: string): ReportDocument {
  const doc = registered({ ref });
  return reduceReport(doc, actions.requestReview({
    request,
    reason_code: "operator_decision",
    reason: "Choose a path",
    review_by: reviewBy,
  }, "research-agent", doc.state.global.revision, T1));
}

describe("report document model", () => {
  it("registers a source-neutral final report with provenance", () => {
    const doc = registered();
    assert.equal(doc.header.documentType, "kilgore/report");
    assert.equal(doc.state.global.revision, 1);
    assert.equal(doc.state.global.producer.id, "research-agent");
    assert.equal(doc.state.global.lifecycle, "final");
    assert.equal(doc.operations.global.length, 1);
  });

  it("enforces optimistic revision checks and operation idempotency", () => {
    const doc = registered();
    const op = actions.requestReview({ request: "read" }, "research-agent", 1, T1);
    const once = reduceReport(doc, op);
    const twice = reduceReport(once, op);
    assert.equal(twice.state.global.revision, 2);
    assert.equal(twice.operations.global.length, 2);
    assert.throws(() => reduceReport(once, actions.markRead("chris", 1, T2)), /revision conflict/);
  });

  it("keeps feedback routing explicit and auditable", () => {
    let doc = withAttention("report:test:feedback");
    doc = reduceReport(doc, actions.addFeedback({ feedback_id: "feedback:1", body: "Use the smaller slice." }, "chris", 2, T2));
    assert.equal(doc.state.global.review.feedback[0].route.status, "unrouted");
    doc = reduceReport(doc, actions.markFeedbackRouted({ feedback_id: "feedback:1", destination: "agent:research-agent" }, "feedback-router", 3, "2026-08-13T12:03:00.000Z"));
    assert.equal(doc.state.global.review.feedback[0].route.status, "routed");
    assert.equal(doc.state.global.review.feedback[0].route.destination, "agent:research-agent");
  });

  it("resolves a read request when the report is marked read", () => {
    let doc = withAttention("report:test:read", "read");
    doc = reduceReport(doc, actions.markRead("chris", 2, T2));
    assert.equal(doc.state.global.review.read_at, T2);
    assert.equal(doc.state.global.attention.resolution, "read");
  });

  it("removes superseded reports from mutable lifecycle", () => {
    let doc = withAttention("report:test:old");
    doc = reduceReport(doc, actions.supersedeReport({ superseded_by_ref: "report:test:new" }, "research-agent", 2, T2));
    assert.equal(doc.state.global.lifecycle, "superseded");
    assert.equal(doc.state.global.superseded_by_ref, "report:test:new");
    assert.throws(() => reduceReport(doc, actions.addFeedback({ body: "too late" }, "chris", 3)), /superseded/);
  });

  it("supports read/unread/read with first opening, feedback, content and history preserved", () => {
    let doc = withAttention("report:test:unread", "read");
    doc = reduceReport(doc, actions.addFeedback({ feedback_id: "keep", body: "Existing feedback" }, "chris", 2, T1));
    doc = reduceReport(doc, actions.markRead("chris", 3, T1));
    const before = structuredClone(doc);
    const unread = actions.markUnread("chris", 4, T2);
    doc = reduceReport(doc, unread);
    assert.equal(doc.state.global.review.read_at, null);
    assert.equal(doc.state.global.review.opened_at, T1);
    assert.deepEqual(doc.state.global.review.feedback, before.state.global.review.feedback);
    assert.deepEqual(doc.state.global.content, before.state.global.content);
    assert.deepEqual(doc.operations.global.slice(0, -1), before.operations.global);
    assert.deepEqual(doc.state.global.attention, { ...before.state.global.attention, resolved_at: null, resolution: null });
    assert.equal(doc.state.global.revision, 5);
    assert.strictEqual(reduceReport(doc, unread), doc);
    doc = reduceReport(doc, actions.markRead("chris", 5, T2));
    assert.equal(doc.state.global.review.read_at, T2);
    assert.equal(doc.state.global.review.opened_at, T1);
    assert.equal(doc.state.global.attention.resolution, "read");
  });

  it("keeps all other attention decisions unchanged when marking unread", () => {
    for (const [request, resolution] of [
      ["read", "dismissed"], ["read", "resolved"], ["approve", "resolved"],
      ["approve", null], ["answer", null], ["none", null],
    ] as const) {
      let doc = registered();
      if (request !== "none") doc = reduceReport(doc, actions.requestReview({ request }, "chris", doc.state.global.revision, T1));
      if (resolution) doc = reduceReport(doc, (resolution === "dismissed" ? actions.dismissAttention : actions.resolveAttention)("chris", doc.state.global.revision, T1));
      doc = reduceReport(doc, actions.markRead("chris", doc.state.global.revision, T1));
      const attention = structuredClone(doc.state.global.attention);
      doc = reduceReport(doc, actions.markUnread("chris", doc.state.global.revision, T2));
      assert.equal(doc.state.global.review.read_at, null);
      assert.deepEqual(doc.state.global.attention, attention);
    }
  });

  it("rejects invalid unread lifecycle, revision and metadata without altering legacy state", () => {
    for (const kind of ["draft", "withdrawn", "superseded", "stale", "missing_revision", "actor", "timestamp"] as const) {
      const doc = registered();
      if (["draft", "withdrawn", "superseded"].includes(kind)) doc.state.global.lifecycle = kind as "draft" | "withdrawn" | "superseded";
      delete (doc.state.global as Partial<typeof doc.state.global>).review;
      const before = structuredClone(doc);
      const op = actions.markUnread(kind === "actor" ? " " : "chris", kind === "stale" ? 99 : 1, kind === "timestamp" ? "invalid" : T1);
      if (kind === "missing_revision") op.expected_revision = null;
      assert.throws(() => reduceReport(doc, op));
      assert.deepEqual(doc, before);
    }
    const legacy = registered();
    delete (legacy.state.global as Partial<typeof legacy.state.global>).review;
    const unread = reduceReport(legacy, actions.markUnread("chris", 1, T1));
    assert.deepEqual(unread.state.global.review, { opened_at: null, read_at: null, feedback: [] });
  });

  it("replays old standalone read history with its first-read timestamp intact", () => {
    let original = withAttention("report:test:old-read", "read");
    original = reduceReport(original, actions.markRead("chris", 2, T1));
    original = reduceReport(original, actions.markRead("chris", 3, T2));
    let replayed: ReportDocument | null = null;
    for (const operation of JSON.parse(JSON.stringify(original.operations.global)) as ReportOperation[]) replayed = reduceReport(replayed, operation);
    assert.deepEqual(replayed, JSON.parse(JSON.stringify(original)));
    assert.equal(replayed?.state.global.review.read_at, T1);
  });
});

describe("content storage and registration", () => {
  it("stores small Markdown inline", () => {
    const stores = tempStores();
    const file = join(stores.root, "brief.md");
    writeFileSync(file, "# Brief\n\nHello.\n");
    const doc = registerReport({
      file, title: "Brief", producer: { kind: "human", id: "chris" }, report_ref: "report:test:md",
    }, stores);
    assert.equal(doc.state.global.content.storage, "inline_markdown");
    assert.match(doc.state.global.content.markdown ?? "", /Hello/);
    assert.equal(doc.state.global.content.blob_ref, null);
  });

  it("stores representative PDF and image bytes by content hash", () => {
    const stores = tempStores();
    const pdf = join(stores.root, "brief.pdf");
    const png = join(stores.root, "diagram.png");
    const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    writeFileSync(pdf, pdfBytes);
    writeFileSync(png, pngBytes);
    const pdfDoc = registerReport({ file: pdf, title: "PDF", producer: { kind: "agent", id: "cane" }, report_ref: "report:test:pdf" }, stores);
    const pngDoc = registerReport({ file: png, title: "PNG", producer: { kind: "agent", id: "cane" }, report_ref: "report:test:png" }, stores);
    assert.equal(pdfDoc.state.global.content.mime_type, "application/pdf");
    assert.equal(pngDoc.state.global.content.mime_type, "image/png");
    assert.equal(pdfDoc.state.global.content.storage, "blob");
    assert.deepEqual(stores.blobs.get(pdfDoc.state.global.content.blob_ref ?? ""), pdfBytes);
    assert.deepEqual(stores.blobs.get(pngDoc.state.global.content.blob_ref ?? ""), pngBytes);
  });

  it("reuses identical binary content without duplicating bytes", () => {
    const stores = tempStores();
    const receipt1 = stores.blobs.put(Buffer.from("same bytes"));
    const receipt2 = stores.blobs.put(Buffer.from("same bytes"));
    assert.equal(receipt1.blob_ref, receipt2.blob_ref);
    assert.equal(receipt1.path, receipt2.path);
  });

  it("encrypts blob bytes at rest and authenticates reads", () => {
    const root = mkdtempSync(join(tmpdir(), "report-registry-encrypted-"));
    const store = new EncryptedContentAddressedBlobStore(join(root, "blobs"), Buffer.alloc(32, 7));
    const plaintext = Buffer.from("private report material that must not appear on disk");
    const receipt = store.put(plaintext);
    const stored = readFileSync(receipt.path);
    assert.equal(stored.includes(plaintext), false);
    assert.deepEqual(store.get(receipt.blob_ref), plaintext);
    assert.equal(store.put(plaintext).path, receipt.path);

    stored[stored.byteLength - 1] ^= 0xff;
    writeFileSync(receipt.path, stored);
    assert.throws(() => store.get(receipt.blob_ref), /BLOB_AUTHENTICATION_FAILED/);
    assert.equal(store.has(receipt.blob_ref), false);
  });

  it("accepts only an exact 32-byte base64 blob key", () => {
    assert.equal(blobKeyFromBase64(Buffer.alloc(32, 9).toString("base64")).byteLength, 32);
    assert.equal(blobKeyFromBase64(`${Buffer.alloc(32, 9).toString("base64")}\n`).byteLength, 32);
    assert.throws(() => blobKeyFromBase64(Buffer.alloc(31).toString("base64")), /expected 32 decoded bytes/);
    assert.throws(() => blobKeyFromBase64("not base64!"), /expected base64/);
  });
});

describe("durability", () => {
  it("replays the operation stream after a fresh store instance", () => {
    const stores = tempStores();
    let doc = registered({ ref: "report:test:restart" });
    for (const operation of doc.operations.global) stores.reports.apply("report:test:restart", operation);
    doc = stores.reports.apply("report:test:restart", actions.requestReview({ request: "approve" }, "research-agent", 1, T1));
    stores.reports.apply("report:test:restart", actions.addFeedback({ feedback_id: "f:1", body: "Approved." }, "chris", 2, T2));
    const restarted = new FilesystemReportStore(join(stores.root, "documents"));
    const loaded = restarted.load("report:test:restart");
    assert.equal(loaded?.header.id, doc.header.id);
    assert.equal(loaded?.state.global.revision, 3);
    assert.equal(loaded?.state.global.attention.request, "approve");
    assert.equal(loaded?.state.global.review.feedback[0].body, "Approved.");
    assert.equal(loaded?.state.global.review.feedback[0].feedback_id, "f:1");
  });

  it("replays auto-generated feedback identity deterministically", () => {
    const stores = tempStores();
    const register = registered({ ref: "report:test:auto-feedback" }).operations.global[0];
    stores.reports.apply("report:test:auto-feedback", register);
    const operation = actions.addFeedback({ body: "Keep this identity." }, "chris", 1, T1);
    const first = stores.reports.apply("report:test:auto-feedback", operation);
    const restarted = new FilesystemReportStore(join(stores.root, "documents"));
    const loaded = restarted.load("report:test:auto-feedback");
    assert.equal(loaded?.header.id, first.header.id);
    assert.equal(loaded?.state.global.review.feedback[0].feedback_id, first.state.global.review.feedback[0].feedback_id);
  });

  it("persists an idempotent duplicate operation only once", () => {
    const stores = tempStores();
    const register = registered({ ref: "report:test:duplicate" }).operations.global[0];
    stores.reports.apply("report:test:duplicate", register);
    stores.reports.apply("report:test:duplicate", register);
    const logPath = join(stores.root, "documents", "operations", `${Buffer.from("report:test:duplicate").toString("base64url")}.jsonl`);
    assert.equal(readFileSync(logPath, "utf8").trim().split("\n").length, 1);
  });
});

describe("Kapelle attention projection", () => {
  it("shows only active final requests and orders by review deadline", () => {
    const first = withAttention("report:test:first", "decide", "2026-08-14T12:00:00.000Z");
    const later = withAttention("report:test:later", "read", "2026-08-20T12:00:00.000Z");
    const quiet = registered({ ref: "report:test:quiet" });
    const draft = registered({ ref: "report:test:draft", lifecycle: "draft" });
    const projection = buildAttentionProjection([later, quiet, draft, first], { now: T0 });
    assert.equal(projection.total_matching, 2);
    assert.deepEqual(projection.items.map((i) => i.report_ref), ["report:test:first", "report:test:later"]);
    assert.deepEqual(projection.items[0].allowed_actions, ["open", "add_feedback", "resolve", "dismiss"]);
  });

  it("excludes resolved, expired, superseded, and withdrawn reports", () => {
    let resolved = withAttention("report:test:resolved");
    resolved = reduceReport(resolved, actions.resolveAttention("chris", 2, T2));
    let superseded = withAttention("report:test:superseded");
    superseded = reduceReport(superseded, actions.supersedeReport({ superseded_by_ref: "report:test:new" }, "agent", 2, T2));
    let withdrawn = withAttention("report:test:withdrawn");
    withdrawn = reduceReport(withdrawn, actions.withdrawReport({}, "agent", 2, T2));
    let expired = registered({ ref: "report:test:expired" });
    expired = reduceReport(expired, actions.requestReview({ request: "read", expires_at: "2026-08-12T00:00:00.000Z" }, "agent", 1, T1));
    assert.equal(buildAttentionProjection([resolved, superseded, withdrawn, expired], { now: T0 }).items.length, 0);
  });

  it("enforces item-count and byte limits", () => {
    const docs = Array.from({ length: 20 }, (_, i) => withAttention(`report:test:${String(i).padStart(2, "0")}`));
    const byCount = buildAttentionProjection(docs, { now: T0, maxItems: 5 });
    assert.equal(byCount.items.length, 5);
    assert.equal(byCount.truncated, true);
    const byBytes = buildAttentionProjection(docs, { now: T0, maxBytes: 900 });
    assert.ok(byBytes.items.length < docs.length);
    assert.ok(Buffer.byteLength(JSON.stringify(byBytes)) <= 900);
  });
});

describe("Powerhouse Reactor boundary", () => {
  it("reports a healthy GraphQL Reactor without inventing package state", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ data: { __typename: "Query" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    try {
      assert.deepEqual(await probeReactor("http://reactor.test/graphql"), {
        up: true,
        url: "http://reactor.test/graphql",
        detail: "GraphQL Query",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when the Reactor is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    try {
      const result = await probeReactor("http://reactor.test/graphql");
      assert.equal(result.up, false);
      assert.match(result.detail, /ECONNREFUSED/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
