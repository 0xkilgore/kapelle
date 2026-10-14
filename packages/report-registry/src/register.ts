import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { BlobStore } from "./blob-store.ts";
import { actions, type AttentionRequest, type ContentDescriptor, type Producer, type ReportDocument } from "./model.ts";
import { FilesystemReportStore } from "./store.ts";

const MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export type RegisterReportInput = {
  file: string;
  title: string;
  project_ref?: string | null;
  family_ref?: string | null;
  source_ref?: string | null;
  producer: Producer;
  lifecycle?: "draft" | "final";
  attention?: Exclude<AttentionRequest, "none"> | null;
  reason_code?: string | null;
  reason?: string | null;
  review_by?: string | null;
  expires_at?: string | null;
  report_ref?: string;
  actor?: string;
  ts?: string;
};

export function registerReport(
  input: RegisterReportInput,
  stores: { reports: FilesystemReportStore; blobs: BlobStore },
): ReportDocument {
  const bytes = readFileSync(input.file);
  const filename = basename(input.file);
  const mime = MIME[extname(filename).toLowerCase()] ?? "application/octet-stream";
  const hash = createHash("sha256").update(bytes).digest("hex");
  const inline = mime === "text/markdown" && bytes.byteLength <= 256 * 1024;
  const content: ContentDescriptor = inline
    ? { storage: "inline_markdown", mime_type: mime, filename, content_hash: hash, byte_size: bytes.byteLength, markdown: bytes.toString("utf8"), blob_ref: null }
    : (() => {
        const receipt = stores.blobs.put(bytes);
        return { storage: "blob", mime_type: mime, filename, content_hash: receipt.content_hash, byte_size: receipt.byte_size, markdown: null, blob_ref: receipt.blob_ref };
      })();

  const actor = input.actor ?? input.producer.id;
  const ts = input.ts ?? new Date().toISOString();
  const reportRef = input.report_ref ?? `report:${randomUUID()}`;
  let document = stores.reports.apply(reportRef, actions.registerReport({
    report_ref: reportRef,
    title: input.title,
    project_ref: input.project_ref,
    family_ref: input.family_ref,
    source_ref: input.source_ref,
    producer: input.producer,
    content,
    lifecycle: input.lifecycle ?? "final",
  }, actor, ts));

  if (input.attention) {
    document = stores.reports.apply(reportRef, actions.requestReview({
      request: input.attention,
      reason_code: input.reason_code,
      reason: input.reason,
      review_by: input.review_by,
      expires_at: input.expires_at,
    }, actor, document.state.global.revision, ts));
  }
  return document;
}
