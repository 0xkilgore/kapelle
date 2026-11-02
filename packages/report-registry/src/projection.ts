import type { ReportDocument } from "./model.ts";

export type AttentionProjectionItem = {
  report_ref: string;
  title: string;
  project_ref: string | null;
  producer: { kind: string; id: string; label?: string };
  request: string;
  reason_code: string | null;
  reason: string | null;
  review_by: string | null;
  requested_at: string | null;
  canonical_url: string;
  content: { mime_type: string; content_hash: string; byte_size: number };
  allowed_actions: string[];
};

export type AttentionProjection = {
  schema_version: "kapelle.report-attention.v1";
  generated_at: string;
  total_matching: number;
  truncated: boolean;
  items: AttentionProjectionItem[];
};

const ACTIONS: Record<string, string[]> = {
  read: ["open", "mark_read", "dismiss"],
  answer: ["open", "add_feedback", "resolve", "dismiss"],
  decide: ["open", "add_feedback", "resolve", "dismiss"],
  approve: ["open", "add_feedback", "resolve", "dismiss"],
  request_change: ["open", "add_feedback", "resolve", "dismiss"],
};

export function buildAttentionProjection(
  documents: ReportDocument[],
  options: { now?: string; maxItems?: number; maxBytes?: number } = {},
): AttentionProjection {
  const now = options.now ?? new Date().toISOString();
  const maxItems = options.maxItems ?? 25;
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const eligible = documents
    .map((d) => d.state.global)
    .filter((s) => s.lifecycle === "final")
    .filter((s) => s.attention.request !== "none" && s.attention.resolved_at == null)
    .filter((s) => s.attention.expires_at == null || Date.parse(s.attention.expires_at) > Date.parse(now))
    .sort((a, b) => {
      const dueA = a.attention.review_by ?? "9999";
      const dueB = b.attention.review_by ?? "9999";
      return dueA.localeCompare(dueB) || (a.attention.requested_at ?? "").localeCompare(b.attention.requested_at ?? "") || a.report_ref.localeCompare(b.report_ref);
    });

  const items: AttentionProjectionItem[] = [];
  for (const s of eligible) {
    if (items.length >= maxItems) break;
    const item: AttentionProjectionItem = {
      report_ref: s.report_ref,
      title: s.title,
      project_ref: s.project_ref,
      producer: s.producer,
      request: s.attention.request,
      reason_code: s.attention.reason_code,
      reason: s.attention.reason,
      review_by: s.attention.review_by,
      requested_at: s.attention.requested_at,
      canonical_url: `report://${encodeURIComponent(s.report_ref)}`,
      content: {
        mime_type: s.content.mime_type,
        content_hash: s.content.content_hash,
        byte_size: s.content.byte_size,
      },
      allowed_actions: ACTIONS[s.attention.request] ?? ["open"],
    };
    const candidate = [...items, item];
    const envelope = { schema_version: "kapelle.report-attention.v1", generated_at: now, total_matching: eligible.length, truncated: true, items: candidate };
    if (Buffer.byteLength(JSON.stringify(envelope)) > maxBytes) break;
    items.push(item);
  }
  return {
    schema_version: "kapelle.report-attention.v1",
    generated_at: now,
    total_matching: eligible.length,
    truncated: items.length < eligible.length,
    items,
  };
}
