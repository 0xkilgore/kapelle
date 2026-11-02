import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import type { ReportRegistryMcp } from "../src/mcp-client.ts";
import {
  buildPromotionRequestPlan,
  loadPromotionRequest,
  parsePromotionRequest,
  promotePromotionRequest,
  type PromotionRequest,
} from "../src/promotion-request.ts";
import { LIVE_PROMOTION_CONFIRMATION } from "../src/promote.ts";

type FakeDocument = {
  header: { id: string; name: string; documentType: string };
  state: { global: Record<string, unknown> };
};

class FakeMcp implements ReportRegistryMcp {
  documents = new Map<string, FakeDocument>();
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
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
      const document = this.documents.get(String(args.documentId));
      if (!document) throw new Error("not found");
      const actions = args.actions as Array<{ type: string; input: Record<string, unknown> }>;
      for (const action of actions) {
        if (action.type === "REGISTER_REPORT") {
          document.state.global = {
            reportRef: action.input.reportRef,
            title: action.input.title,
            projectRef: action.input.projectRef ?? null,
            familyRef: action.input.familyRef ?? null,
            sourceRef: action.input.sourceRef,
            producer: structuredClone(action.input.producer),
            content: structuredClone(action.input.content),
            lifecycle: action.input.lifecycle,
            revision: 1,
            attention: blankAttention(),
          };
        } else if (action.type === "REQUEST_REVIEW") {
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

function blankAttention() {
  return {
    request: "NONE",
    reasonCode: null,
    reason: null,
    reviewBy: null,
    expiresAt: null,
    requestedAt: null,
    resolvedAt: null,
  };
}

function fixture(attention: PromotionRequest["attention"] = { request: "READ" }) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "promotion-request-test-")));
  const contentPath = join(root, "operator-report.md");
  const requestPath = join(root, "request.json");
  const contentBytes = Buffer.from("# Operator report\n\nCANARY_PRIVATE_BODY_7bb1\n");
  writeFileSync(contentPath, contentBytes);
  const request: PromotionRequest = {
    schemaVersion: "report-promotion-request.v2",
    contentPath,
    title: "Operator report",
    reportRef: "report:test:operator-report:v1",
    sourceRef: "agent://research-agent/operator-report/v1",
    expectedContentHash: createHash("sha256").update(contentBytes).digest("hex"),
    expectedByteSize: contentBytes.byteLength,
    projectRef: "daily-driver",
    familyRef: "operator-report",
    producer: { kind: "AGENT", id: "research-agent", label: "Research Agent" },
    attention,
    occurredAt: "2026-08-19T15:00:00.000Z",
  };
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  return { root, contentPath, requestPath, request };
}

function rewriteRequest(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function applyRuntime(root: string, admitted: ReturnType<typeof loadPromotionRequest>) {
  return {
    confirmation: LIVE_PROMOTION_CONFIRMATION,
    planDigest: buildPromotionRequestPlan(admitted).planDigest,
    driveId: "drive:test",
    receiptDir: join(root, "receipts"),
    lockDir: join(root, "publisher-locks"),
    actorId: "research-agent",
  };
}

async function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe("report promotion request contract", () => {
  it("builds a content-free NONE plan", () => {
    const { root, requestPath } = fixture({ request: "NONE" });
    const admitted = loadPromotionRequest(requestPath, root);
    const plan = buildPromotionRequestPlan(admitted);
    assert.equal(plan.schemaVersion, "report-promotion-plan.v2");
    assert.equal(plan.attention.request, "NONE");
    assert.equal(plan.content.filename, "operator-report.md");
    assert.equal(plan.content.byteSize, Buffer.byteLength("# Operator report\n\nCANARY_PRIVATE_BODY_7bb1\n"));
    assert.match(plan.content.contentHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(plan), /CANARY_PRIVATE_BODY_7bb1/);
    assert.doesNotMatch(JSON.stringify(plan), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("admits the canonical request emitted by the agent completion boundary", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-done-promotion-request-test-")));
    const contentPath = join(root, "example-site-decision.md");
    const requestPath = join(root, "candidate.json");
    const contentBytes = Buffer.from("# Example site decision\n\nCANARY_MANAGER_ARTIFACT_BODY_43c1\n");
    writeFileSync(contentPath, contentBytes);
    const goldenPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "report-promotion-request.manager-golden.v2.json");
    const managerEmitted = JSON.parse(readFileSync(goldenPath, "utf8"));
    writeFileSync(requestPath, `${JSON.stringify({
      ...managerEmitted,
      contentPath,
      expectedContentHash: createHash("sha256").update(contentBytes).digest("hex"),
      expectedByteSize: contentBytes.byteLength,
    }, null, 2)}\n`);

    const admitted = loadPromotionRequest(requestPath, root);
    const plan = buildPromotionRequestPlan(admitted);
    assert.deepEqual(plan, {
      schemaVersion: "report-promotion-plan.v2",
      planDigest: plan.planDigest,
      title: "Example site decision",
      reportRef: "report:dispatch:phid:dispatch:abc-123",
      sourceRef: "kapelle-dispatch://phid%3Adispatch%3Aabc-123",
      projectRef: "project:example-site",
      familyRef: null,
      producer: { kind: "SERVICE", id: "agent-manager", label: "Agent Manager" },
      attention: {
        request: "DECIDE",
        reasonCode: "operator_decision",
        reason: "Choose the bounded path.",
        reviewBy: null,
        expiresAt: null,
      },
      occurredAt: "2026-08-21T15:00:00.000Z",
      content: {
        filename: "example-site-decision.md",
        contentHash: admitted.content.contentHash,
        byteSize: admitted.content.byteSize,
      },
    });
    assert.doesNotMatch(JSON.stringify(plan), /CANARY_MANAGER_ARTIFACT_BODY_43c1/);
    assert.doesNotMatch(JSON.stringify(plan), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("maps explicit READ attention to the existing writer and preserves the source filename", async () => {
    const { root, requestPath } = fixture({ request: "READ" });
    const admitted = loadPromotionRequest(requestPath, root);
    const mcp = new FakeMcp();
    const receipt = await promotePromotionRequest(admitted, applyRuntime(root, admitted), mcp);
    assert.equal(receipt.status, "CREATED");
    assert.equal(receipt.attention, "READ");
    assert.equal(receipt.contentHash, admitted.content.contentHash);
    assert.equal(receipt.byteSize, admitted.content.byteSize);
    const add = mcp.calls.find((call) => call.name === "addActions");
    const actions = add?.args.actions as Array<{ type: string; input: Record<string, unknown> }>;
    assert.deepEqual(actions.map((action) => action.type), ["REGISTER_REPORT", "REQUEST_REVIEW"]);
    const content = actions[0].input.content as Record<string, unknown>;
    assert.equal(content.filename, "operator-report.md");
    assert.equal(content.markdown, "# Operator report\n\nCANARY_PRIVATE_BODY_7bb1\n");
    assert.equal(actions[1].input.request, "READ");
  });

  it("maps DECIDE reason and review deadline exactly", async () => {
    const attention: PromotionRequest["attention"] = {
      request: "DECIDE",
      reasonCode: "operator_decision",
      reason: "Choose the bounded path.",
      reviewBy: "2026-08-20T17:00:00.000Z",
      expiresAt: "2026-08-22T17:00:00.000Z",
    };
    const { root, requestPath } = fixture(attention);
    const mcp = new FakeMcp();
    const admitted = loadPromotionRequest(requestPath, root);
    await promotePromotionRequest(admitted, applyRuntime(root, admitted), mcp);
    const write = mcp.calls.find((call) => call.name === "addActions");
    const actions = write?.args.actions as Array<{ type: string; input: Record<string, unknown> }>;
    assert.deepEqual(actions[1].input, {
      expectedRevision: 1,
      request: "DECIDE",
      reasonCode: "operator_decision",
      reason: "Choose the bounded path.",
      reviewBy: "2026-08-20T17:00:00.000Z",
      expiresAt: "2026-08-22T17:00:00.000Z",
      occurredAt: "2026-08-19T15:00:00.000Z",
      actorId: "research-agent",
    });
  });

  it("rejects unknown keys and unsupported or missing schema versions", () => {
    const { request } = fixture();
    assert.throws(() => parsePromotionRequest({ ...request, surprise: true }), /PROMOTION_REQUEST_UNKNOWN_FIELD/);
    assert.throws(() => parsePromotionRequest({ ...request, schemaVersion: "report-promotion-request.v3" }), /PROMOTION_REQUEST_SCHEMA_UNSUPPORTED/);
    const { schemaVersion: _removed, ...missing } = request;
    assert.throws(() => parsePromotionRequest(missing), /PROMOTION_REQUEST_SCHEMA_UNSUPPORTED/);
    assert.throws(() => parsePromotionRequest({ ...request, producer: { ...request.producer, surprise: true } }), /PRODUCER_UNKNOWN_FIELD/);
    assert.throws(() => parsePromotionRequest({ ...request, attention: { ...request.attention, surprise: true } }), /ATTENTION_UNKNOWN_FIELD/);
  });

  it("bounds and authenticates the request file before parsing it", () => {
    const linkedFixture = fixture();
    const requestLink = join(linkedFixture.root, "request-link.json");
    symlinkSync(linkedFixture.requestPath, requestLink);
    assert.throws(() => loadPromotionRequest(requestLink, linkedFixture.root), /REQUEST_FILE_INVALID/);

    const invalidFixture = fixture();
    writeFileSync(invalidFixture.requestPath, Buffer.from([0xff, 0xfe, 0x80]));
    assert.throws(() => loadPromotionRequest(invalidFixture.requestPath, invalidFixture.root), /REQUEST_ENCODING_INVALID/);

    const largeFixture = fixture();
    writeFileSync(largeFixture.requestPath, Buffer.alloc(64 * 1024 + 1, 0x61));
    assert.throws(() => loadPromotionRequest(largeFixture.requestPath, largeFixture.root), /REQUEST_FILE_TOO_LARGE/);
  });

  it("rejects relative paths, traversal/sibling escapes, symlinks, hardlinks, directories, and unsupported files", () => {
    const relativeFixture = fixture();
    rewriteRequest(relativeFixture.requestPath, { ...relativeFixture.request, contentPath: "operator-report.md" });
    assert.throws(() => loadPromotionRequest(relativeFixture.requestPath, relativeFixture.root), /CONTENT_PATH_NOT_ABSOLUTE/);

    const outsideRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "promotion-request-outside-")));
    const outside = join(outsideRoot, "outside.md");
    writeFileSync(outside, "outside\n");
    const escapeFixture = fixture();
    rewriteRequest(escapeFixture.requestPath, { ...escapeFixture.request, contentPath: outside });
    assert.throws(() => loadPromotionRequest(escapeFixture.requestPath, escapeFixture.root), /OUTSIDE_ALLOWED_ROOT/);

    const sibling = `${escapeFixture.root}-sibling`;
    mkdirSync(sibling);
    const siblingFile = join(sibling, "sibling.md");
    writeFileSync(siblingFile, "sibling\n");
    rewriteRequest(escapeFixture.requestPath, { ...escapeFixture.request, contentPath: siblingFile });
    assert.throws(() => loadPromotionRequest(escapeFixture.requestPath, escapeFixture.root), /OUTSIDE_ALLOWED_ROOT/);

    const linkFixture = fixture();
    const symlink = join(linkFixture.root, "linked.md");
    symlinkSync(linkFixture.contentPath, symlink);
    rewriteRequest(linkFixture.requestPath, { ...linkFixture.request, contentPath: symlink });
    assert.throws(() => loadPromotionRequest(linkFixture.requestPath, linkFixture.root), /CONTENT_PATH_NOT_CANONICAL/);

    const danglingFixture = fixture();
    const dangling = join(danglingFixture.root, "dangling.md");
    symlinkSync(join(danglingFixture.root, "missing.md"), dangling);
    rewriteRequest(danglingFixture.requestPath, { ...danglingFixture.request, contentPath: dangling });
    assert.throws(() => loadPromotionRequest(danglingFixture.requestPath, danglingFixture.root), /CONTENT_FILE_INVALID/);

    const hardlinkFixture = fixture();
    const hardlink = join(hardlinkFixture.root, "hardlink.md");
    linkSync(hardlinkFixture.contentPath, hardlink);
    rewriteRequest(hardlinkFixture.requestPath, { ...hardlinkFixture.request, contentPath: hardlink });
    assert.throws(() => loadPromotionRequest(hardlinkFixture.requestPath, hardlinkFixture.root), /NOT_SAFE_REGULAR_FILE/);

    const directoryFixture = fixture();
    const directory = join(directoryFixture.root, "directory.md");
    mkdirSync(directory);
    rewriteRequest(directoryFixture.requestPath, { ...directoryFixture.request, contentPath: directory });
    assert.throws(() => loadPromotionRequest(directoryFixture.requestPath, directoryFixture.root), /NOT_SAFE_REGULAR_FILE/);

    const extensionFixture = fixture();
    const textFile = join(extensionFixture.root, "report.txt");
    writeFileSync(textFile, "text\n");
    rewriteRequest(extensionFixture.requestPath, { ...extensionFixture.request, contentPath: textFile });
    assert.throws(() => loadPromotionRequest(extensionFixture.requestPath, extensionFixture.root), /CONTENT_TYPE_UNSUPPORTED/);
  });

  it("requires canonical absolute allowed roots", () => {
    const { root, requestPath } = fixture();
    assert.throws(() => loadPromotionRequest(requestPath, "."), /ALLOWED_ROOT_NOT_ABSOLUTE/);
    assert.throws(() => loadPromotionRequest(requestPath, `${root}/`), /ALLOWED_ROOT_NOT_CANONICAL/);
    const parent = dirname(root);
    const rootLink = join(parent, `promotion-root-link-${process.pid}-${Date.now()}`);
    symlinkSync(root, rootLink);
    assert.throws(() => loadPromotionRequest(requestPath, rootLink), /ALLOWED_ROOT_NOT_CANONICAL/);
  });

  it("rejects empty, invalid UTF-8, and oversized Markdown before any MCP use", () => {
    const mcp = new FakeMcp();
    const emptyFixture = fixture();
    writeFileSync(emptyFixture.contentPath, "\n\t");
    assert.throws(() => loadPromotionRequest(emptyFixture.requestPath, emptyFixture.root), /CONTENT_EMPTY/);

    const invalidFixture = fixture();
    writeFileSync(invalidFixture.contentPath, Buffer.from([0xff, 0xfe, 0x80]));
    assert.throws(() => loadPromotionRequest(invalidFixture.requestPath, invalidFixture.root), /CONTENT_ENCODING_INVALID/);

    const largeFixture = fixture();
    writeFileSync(largeFixture.contentPath, Buffer.alloc(256 * 1024 + 1, 0x61));
    assert.throws(() => loadPromotionRequest(largeFixture.requestPath, largeFixture.root), /CONTENT_TOO_LARGE/);
    assert.equal(mcp.calls.length, 0);
  });

  it("rejects attention metadata with NONE and malformed timestamps", () => {
    const { request } = fixture();
    assert.throws(() => parsePromotionRequest({
      ...request,
      attention: { request: "NONE", reason: "This should not exist." },
    }), /ATTENTION_METADATA_WITHOUT_REQUEST/);
    assert.throws(() => parsePromotionRequest({ ...request, occurredAt: "2026-08-19T15:00:00Z" }), /occurredAt/);
    assert.throws(() => parsePromotionRequest({
      ...request,
      attention: { request: "READ", reviewBy: "not-a-date" },
    }), /attention.reviewBy/);
  });

  it("requires URI provenance and refuses local file source authority", () => {
    const { request } = fixture();
    assert.throws(() => parsePromotionRequest({ ...request, sourceRef: "/tmp/report.md" }), /SOURCE_REF_INVALID/);
    assert.throws(() => parsePromotionRequest({ ...request, sourceRef: "file:///tmp/report.md" }), /SOURCE_REF_INVALID/);
  });

  it("inherits idempotent retry and changed-content conflict behavior", async () => {
    const { root, requestPath, contentPath } = fixture({ request: "READ" });
    const mcp = new FakeMcp();
    const admitted = loadPromotionRequest(requestPath, root);
    const first = await promotePromotionRequest(admitted, applyRuntime(root, admitted), mcp);
    const secondAdmitted = loadPromotionRequest(requestPath, root);
    const second = await promotePromotionRequest(secondAdmitted, applyRuntime(root, secondAdmitted), mcp);
    assert.equal(first.status, "CREATED");
    assert.equal(second.status, "CREATED");
    assert.equal(second.promotedAt, first.promotedAt);
    assert.equal(mcp.calls.filter((call) => call.name === "createDocument").length, 1);
    writeFileSync(contentPath, "# Changed report\n");
    await assert.rejects(
      Promise.resolve().then(() => loadPromotionRequest(requestPath, root)),
      /PROMOTION_REQUEST_CONTENT_RECEIPT_MISMATCH/,
    );
  });

  it("requires the existing literal live confirmation before MCP use", async () => {
    const { root, requestPath } = fixture();
    const mcp = new FakeMcp();
    await assert.rejects(
      promotePromotionRequest(loadPromotionRequest(requestPath, root), { ...applyRuntime(root, loadPromotionRequest(requestPath, root)), confirmation: "yes" }, mcp),
      /PROMOTION_CONFIRMATION_REQUIRED/,
    );
    assert.equal(mcp.calls.length, 0);
  });

  it("requires live promotion to match the exact reviewed plan digest", async () => {
    const { root, requestPath } = fixture();
    const admitted = loadPromotionRequest(requestPath, root);
    const mcp = new FakeMcp();
    await assert.rejects(
      promotePromotionRequest(admitted, { ...applyRuntime(root, admitted), planDigest: "0".repeat(64) }, mcp),
      /PROMOTION_PLAN_DIGEST_MISMATCH/,
    );
    assert.equal(mcp.calls.length, 0);
  });

  it("rejects mutation of admitted bytes before staging or MCP use", async () => {
    const { root, requestPath } = fixture();
    const admitted = loadPromotionRequest(requestPath, root);
    const runtime = applyRuntime(root, admitted);
    admitted.content.bytes[0] = 0x58;
    const mcp = new FakeMcp();
    await assert.rejects(promotePromotionRequest(admitted, runtime, mcp), /PROMOTION_ADMITTED_CONTENT_INVALID/);
    assert.equal(mcp.calls.length, 0);
  });

  it("rejects deterministic staged-file replacement before MCP use", async () => {
    const { root, requestPath } = fixture();
    const admitted = loadPromotionRequest(requestPath, root);
    const mcp = new FakeMcp();
    const originalReadFileSync = fs.readFileSync;
    let replaced = false;
    fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (
        typeof path === "string"
        && path.includes("report-promotion-request-")
        && path.endsWith("operator-report.md")
      ) {
        writeFileSync(path, "# Replaced after admission\n");
        replaced = true;
      }
      return originalReadFileSync(path, ...(args as Parameters<typeof originalReadFileSync> extends [unknown, ...infer Rest] ? Rest : never));
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        promotePromotionRequest(admitted, applyRuntime(root, admitted), mcp),
        /EXPECTED_CONTENT_IDENTITY_MISMATCH/,
      );
    } finally {
      fs.readFileSync = originalReadFileSync;
      syncBuiltinESMExports();
    }
    assert.equal(replaced, true);
    assert.equal(mcp.calls.length, 0);
  });
});

describe("promote-request CLI plan mode", () => {
  it("makes zero outbound calls and prints no body, token, endpoint, or content path", async () => {
    const { root, requestPath, contentPath } = fixture({ request: "READ" });
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const hook = join(root, "deny-network.mjs");
    writeFileSync(hook, "globalThis.fetch = async () => { throw new Error('OUTBOUND_CALLED'); };\n");
    const secret = "SECRET_TOKEN_CANARY_4d93";
    const endpoint = "http://127.0.0.1:9/mcp";
    const unusedRegistryHome = join(root, "must-not-create-registry-home");
    const result = await run(process.execPath, [
      "--import",
      hook,
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "src/cli.ts",
      "promote-request",
      "--request",
      requestPath,
      "--allowed-root",
      root,
      "--plan",
      "true",
    ], {
      cwd: packageRoot,
      env: {
        ...process.env,
        REPORT_REGISTRY_MCP_URL: endpoint,
        REPORT_REGISTRY_MCP_TOKEN: secret,
        REPORT_REGISTRY_DRIVE_ID: "drive:must-not-be-read",
        REPORT_REGISTRY_RECEIPTS_DIR: join(root, "must-not-exist"),
        REPORT_REGISTRY_HOME: unusedRegistryHome,
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /report-promotion-plan\.v2/);
    assert.match(result.stdout, /"planDigest": "[a-f0-9]{64}"/);
    assert.doesNotMatch(result.stdout + result.stderr, /OUTBOUND_CALLED/);
    assert.doesNotMatch(result.stdout + result.stderr, /CANARY_PRIVATE_BODY_7bb1/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
    assert.doesNotMatch(result.stdout + result.stderr, /127\.0\.0\.1:9/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(contentPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(result.stdout + result.stderr, /drive:must-not-be-read/);
    assert.equal(readFileSync(contentPath, "utf8"), "# Operator report\n\nCANARY_PRIVATE_BODY_7bb1\n");
    assert.throws(() => realpathSync.native(unusedRegistryHome), /ENOENT/);
  });

  it("reports only a bounded error category when validation fails", async () => {
    const { root, requestPath, request } = fixture({ request: "READ" });
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const secret = "SECRET_TOKEN_CANARY_54e7";
    const endpoint = "http://127.0.0.1:9/private-mcp";
    const drive = "drive:PRIVATE_DRIVE_CANARY_29ef";
    const receiptDir = join(root, "PRIVATE_RECEIPT_CANARY_61c2");
    rewriteRequest(requestPath, { ...request, unexpectedBody: "CANARY_PRIVATE_BODY_IN_REQUEST_2f68" });

    const result = await run(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "src/cli.ts",
      "promote-request",
      "--request",
      requestPath,
      "--allowed-root",
      root,
      "--plan",
      "true",
    ], {
      cwd: packageRoot,
      env: {
        ...process.env,
        REPORT_REGISTRY_MCP_URL: endpoint,
        REPORT_REGISTRY_MCP_TOKEN: secret,
        REPORT_REGISTRY_DRIVE_ID: drive,
        REPORT_REGISTRY_RECEIPTS_DIR: receiptDir,
      },
    });

    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), { ok: false, error: "PROMOTION_REQUEST_UNKNOWN_FIELD" });
    const combined = result.stdout + result.stderr;
    assert.doesNotMatch(combined, /CANARY_PRIVATE_BODY_IN_REQUEST_2f68/);
    assert.doesNotMatch(combined, new RegExp(secret));
    assert.doesNotMatch(combined, /127\.0\.0\.1:9/);
    assert.doesNotMatch(combined, new RegExp(drive));
    assert.doesNotMatch(combined, /PRIVATE_RECEIPT_CANARY_61c2/);
    assert.doesNotMatch(combined, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(combined, new RegExp(requestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(combined, /file:\/\//);
    assert.doesNotMatch(combined, /\/Users\//);
    assert.doesNotMatch(combined, /\n\s+at\s/);
  });

  it("requires an explicit live authority actor before any network call", async () => {
    const { root, requestPath } = fixture({ request: "READ" });
    const admitted = loadPromotionRequest(requestPath, root);
    const planDigest = buildPromotionRequestPlan(admitted).planDigest;
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const hook = join(root, "deny-network.mjs");
    writeFileSync(
      hook,
      "globalThis.fetch = async () => { throw new Error('OUTBOUND_CALLED'); };\n",
    );
    const result = await run(
      process.execPath,
      [
        "--import",
        hook,
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "src/cli.ts",
        "promote-request",
        "--request",
        requestPath,
        "--allowed-root",
        root,
        "--confirm",
        LIVE_PROMOTION_CONFIRMATION,
        "--plan-digest",
        planDigest,
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          REPORT_REGISTRY_MCP_URL: "http://127.0.0.1:9/mcp",
          REPORT_REGISTRY_MCP_TOKEN:
            "producer-token-000000000000000000000000000000",
          REPORT_REGISTRY_DRIVE_ID: "drive:report-registry",
          REPORT_REGISTRY_RECEIPTS_DIR: join(root, "receipts"),
          REPORT_REGISTRY_LOCKS_DIR: join(root, "locks"),
        },
      },
    );
    assert.notEqual(result.code, 0);
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: "CLI_ERROR",
    });
    assert.doesNotMatch(result.stdout + result.stderr, /OUTBOUND_CALLED/u);
  });
});
