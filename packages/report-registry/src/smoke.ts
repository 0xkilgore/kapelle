import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentAddressedBlobStore } from "./blob-store.ts";
import { buildAttentionProjection } from "./projection.ts";
import { registerReport } from "./register.ts";
import { FilesystemReportStore } from "./store.ts";

const root = mkdtempSync(join(tmpdir(), "report-registry-smoke-"));
const markdown = join(root, "daily-brief.md");
writeFileSync(markdown, "# Daily brief\n\nOne decision is needed.\n");
const reports = new FilesystemReportStore(join(root, "documents"));
const blobs = new ContentAddressedBlobStore(join(root, "blobs"));
registerReport({
  file: markdown,
  title: "Daily brief",
  project_ref: "kapelle-daily-driver",
  producer: { kind: "agent", id: "research-agent" },
  attention: "decide",
  reason: "Choose the first implementation slice",
  report_ref: "report:smoke:daily-brief",
}, { reports, blobs });
console.log(JSON.stringify(buildAttentionProjection(reports.list()), null, 2));
