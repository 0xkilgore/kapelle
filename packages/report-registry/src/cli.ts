#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --experimental-strip-types
import {publishPrivateRequest,readPrivateJSON,readPrivateReaderProfile,parsePrivateBinding,assertNativeModelAdmission} from './private-publication.ts';
import { resolve } from "node:path";
import { ContentAddressedBlobStore } from "./blob-store.ts";
import { HttpReportRegistryMcp } from "./mcp-client.ts";
import { buildAttentionProjection } from "./projection.ts";
import {
  LIVE_PROMOTION_CONFIRMATION,
  promoteReport,
  type LiveAttention,
  type LiveProducerKind,
} from "./promote.ts";
import { probeReactor } from "./reactor.ts";
import { registerReport } from "./register.ts";
import {
  buildPromotionRequestPlan,
  loadPromotionRequest,
  promotePromotionRequest,
} from "./promotion-request.ts";
import { FilesystemReportStore } from "./store.ts";

function parse(argv: string[]): { command: string; values: Record<string, string> } {
  const [command = "help", ...rest] = argv;
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!key?.startsWith("--") || rest[i + 1] == null) throw new Error(`expected --key value, got ${key ?? "end"}`);
    values[key.slice(2)] = rest[i + 1];
  }
  return { command, values };
}

function required(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function boundedErrorCategory(error: unknown): string {
  try {
    if (error instanceof Error) {
      const match = /^([A-Z][A-Z0-9_]{2,})(?::|\b)/.exec(error.message);
      if (match) return match[1];
    }
  } catch {
    // Fall through to a fixed category without rendering an untrusted error.
  }
  return "CLI_ERROR";
}

async function main(): Promise<void> {
const { command, values } = parse(process.argv.slice(2));
const root = resolve(values.store ?? process.env.REPORT_REGISTRY_HOME ?? ".report-registry");

if (command === "publish-private-request") {
  const admitted=loadPromotionRequest(required(values,"request"),required(values,"allowed-root"));
  if(values.plan!==undefined){
    if(values.plan!=="true"||values.confirm!==undefined)throw Error("PRIVATE_PUBLICATION_PLAN_INVALID");
    console.log(JSON.stringify({ok:true,plan:buildPromotionRequestPlan(admitted)},null,2));
  } else {
    const config=readPrivateJSON(required(values,"runtime-config"));
    if(config.schemaVersion!=="kapelle.document-outbox-publisher/v1"||typeof config.credentialFile!=="string")throw Error("PRIVATE_PUBLICATION_CONFIG_INVALID");
    if(typeof config.privatePublicationBindingFile!=="string")throw Error("PRIVATE_PUBLICATION_BINDING_REQUIRED");
    if(typeof config.privatePublicationReaderProfile!=="string")throw Error("PRIVATE_PUBLICATION_READER_BINDING_REQUIRED");
    const readerCredential=readPrivateReaderProfile(config.privatePublicationReaderProfile);
    const binding=parsePrivateBinding(readPrivateJSON(config.privatePublicationBindingFile));
    if(readerCredential.driveId!==binding.driveId)throw Error("PRIVATE_PUBLICATION_READER_SCOPE_MISMATCH");
    const credential=readPrivateJSON(config.credentialFile);const runtime=config.runtime as Record<string,unknown>;
    if(typeof config.privatePublicationModelAdmissionFile!=="string")throw Error("PRIVATE_PUBLICATION_MODEL_NOT_ADMITTED");
    assertNativeModelAdmission(readPrivateJSON(config.privatePublicationModelAdmissionFile),String(credential.endpoint),binding.driveId);
    for(const key of ["driveId","receiptDir","lockDir","actorId"])if(typeof runtime?.[key]!=="string")throw Error("PRIVATE_PUBLICATION_CONFIG_INVALID");
    const result=await publishPrivateRequest(admitted,{confirmation:required(values,"confirm"),planDigest:required(values,"plan-digest"),driveId:String(runtime.driveId),receiptDir:String(runtime.receiptDir),lockDir:String(runtime.lockDir),actorId:String(runtime.actorId)},binding,new HttpReportRegistryMcp(String(credential.endpoint),String(credential.token)),new HttpReportRegistryMcp(String(readerCredential.endpoint),String(readerCredential.token)));
    console.log(JSON.stringify({ok:true,...result},null,2));
  }
} else if (command === "promote-request") {
  const admitted = loadPromotionRequest(
    required(values, "request"),
    required(values, "allowed-root"),
  );
  if (values.plan !== undefined) {
    if (values.plan !== "true") throw new Error("--plan must be true when provided");
    if (values.confirm !== undefined) throw new Error("--plan and --confirm are mutually exclusive");
    console.log(JSON.stringify({ ok: true, plan: buildPromotionRequestPlan(admitted) }, null, 2));
  } else {
    const endpoint = values.endpoint ?? process.env.REPORT_REGISTRY_MCP_URL;
    const driveId = values.drive ?? process.env.REPORT_REGISTRY_DRIVE_ID;
    const receiptDir = values["receipt-dir"] ?? process.env.REPORT_REGISTRY_RECEIPTS_DIR;
    const lockDir = values["lock-dir"] ?? process.env.REPORT_REGISTRY_LOCKS_DIR;
    const token = process.env.REPORT_REGISTRY_MCP_TOKEN;
    if (!endpoint) throw new Error("--endpoint or REPORT_REGISTRY_MCP_URL is required");
    if (!driveId) throw new Error("--drive or REPORT_REGISTRY_DRIVE_ID is required");
    if (!receiptDir) throw new Error("--receipt-dir or REPORT_REGISTRY_RECEIPTS_DIR is required");
    if (!lockDir) throw new Error("--lock-dir or REPORT_REGISTRY_LOCKS_DIR is required");
    if (!token) throw new Error("REPORT_REGISTRY_MCP_TOKEN is required");
    const receipt = await promotePromotionRequest({ ...admitted }, {
      confirmation: required(values, "confirm"),
      planDigest: required(values, "plan-digest"),
      driveId,
      receiptDir,
      lockDir,
      actorId: required(values, "actor"),
    }, new HttpReportRegistryMcp(endpoint, token));
    console.log(JSON.stringify({ ok: true, receipt }, null, 2));
  }
} else if (command === "promote-live") {
  const producerRaw = required(values, "producer");
  const [kindRaw, ...idParts] = producerRaw.split(":");
  if (!idParts.length) throw new Error("--producer must be kind:id");
  const kind = kindRaw.toUpperCase() as LiveProducerKind;
  if (!["HUMAN", "AGENT", "SERVICE", "IMPORT"].includes(kind)) {
    throw new Error("producer kind must be human, agent, service, or import");
  }
  const attention = (values.attention ?? "none").toUpperCase() as LiveAttention;
  if (!["NONE", "READ", "ANSWER", "DECIDE", "APPROVE", "REQUEST_CHANGE"].includes(attention)) {
    throw new Error("attention must be none, read, answer, decide, approve, or request_change");
  }
  const endpoint = values.endpoint ?? process.env.REPORT_REGISTRY_MCP_URL;
  const driveId = values.drive ?? process.env.REPORT_REGISTRY_DRIVE_ID;
  const receiptDir = values["receipt-dir"] ?? process.env.REPORT_REGISTRY_RECEIPTS_DIR;
  const lockDir = values["lock-dir"] ?? process.env.REPORT_REGISTRY_LOCKS_DIR;
  const token = process.env.REPORT_REGISTRY_MCP_TOKEN;
  if (!endpoint) throw new Error("--endpoint or REPORT_REGISTRY_MCP_URL is required");
  if (!driveId) throw new Error("--drive or REPORT_REGISTRY_DRIVE_ID is required");
  if (!receiptDir) throw new Error("--receipt-dir or REPORT_REGISTRY_RECEIPTS_DIR is required");
  if (!lockDir) throw new Error("--lock-dir or REPORT_REGISTRY_LOCKS_DIR is required");
  if (!token) throw new Error("REPORT_REGISTRY_MCP_TOKEN is required");
  const receipt = await promoteReport({
    confirmation: required(values, "confirm"),
    driveId,
    file: required(values, "file"),
    title: required(values, "title"),
    reportRef: required(values, "ref"),
    sourceRef: required(values, "source"),
    projectRef: values.project,
    familyRef: values.family,
    producer: { kind, id: idParts.join(":"), label: values["producer-label"] },
    attention,
    reasonCode: values["reason-code"],
    reason: values.reason,
    reviewBy: values["review-by"],
    expiresAt: values.expires,
    actorId: required(values, "actor"),
    receiptDir,
    lockDir,
  }, new HttpReportRegistryMcp(endpoint, token));
  console.log(JSON.stringify({ ok: true, receipt }, null, 2));
} else if (command === "register") {
  const reports = new FilesystemReportStore(resolve(root, "documents"));
  const blobs = new ContentAddressedBlobStore(resolve(root, "blobs"));
  const producerRaw = required(values, "producer");
  const [kindRaw, ...idParts] = producerRaw.split(":");
  if (!idParts.length) throw new Error("--producer must be kind:id");
  const kind = kindRaw as "human" | "agent" | "service" | "import";
  if (!["human", "agent", "service", "import"].includes(kind)) throw new Error("producer kind must be human, agent, service, or import");
  const document = registerReport({
    file: required(values, "file"),
    title: required(values, "title"),
    project_ref: values.project,
    family_ref: values.family,
    source_ref: values.source,
    producer: { kind, id: idParts.join(":") },
    attention: values.attention as "read" | "answer" | "decide" | "approve" | "request_change" | undefined,
    reason_code: values["reason-code"],
    reason: values.reason,
    review_by: values["review-by"],
    expires_at: values.expires,
    report_ref: values.ref,
    actor: values.actor,
  }, { reports, blobs });
  console.log(JSON.stringify({
    ok: true,
    report_ref: document.state.global.report_ref,
    phid: document.header.id,
    revision: document.state.global.revision,
    content: document.state.global.content,
  }, null, 2));
} else if (command === "attention") {
  const reports = new FilesystemReportStore(resolve(root, "documents"));
  console.log(JSON.stringify(buildAttentionProjection(reports.list()), null, 2));
} else if (command === "reactor-check") {
  const result = await probeReactor(values.url);
  console.log(JSON.stringify(result, null, 2));
  if (!result.up) process.exitCode = 2;
} else {
  console.log(`Usage:
  report-registry publish-private-request --request PATH --allowed-root PATH --plan true
  report-registry publish-private-request --request PATH --allowed-root PATH --runtime-config PATH --confirm ${LIVE_PROMOTION_CONFIRMATION} --plan-digest SHA256
  report-registry promote-request --request PATH --allowed-root PATH --plan true
  report-registry promote-request --request PATH --allowed-root PATH --actor ACTOR_ID --confirm ${LIVE_PROMOTION_CONFIRMATION} --plan-digest SHA256 [--drive DRIVE_ID] [--endpoint MCP_URL] [--receipt-dir PATH] [--lock-dir PATH]
  report-registry promote-live --file PATH --title TITLE --ref REF --source SOURCE --producer agent:NAME --actor ACTOR_ID --drive DRIVE_ID --endpoint MCP_URL --receipt-dir PATH --lock-dir PATH --confirm ${LIVE_PROMOTION_CONFIRMATION} [--project REF] [--attention none|read|answer|decide|approve|request_change]
  report-registry register --file PATH --title TITLE --producer agent:NAME [--project REF] [--attention read|answer|decide|approve|request_change]
  report-registry attention [--store PATH]
  report-registry reactor-check [--url URL]`);
}
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: boundedErrorCategory(error) }));
  process.exitCode = 1;
}
