// Newsletter slice 3, S3-a: a FAKE Resend at the HTTP level (never the network), for the broadcast connector and the audience
// reader. In-memory broadcasts and contacts with the shapes Resend documents (Oct 18): POST /broadcasts, GET /broadcasts/{id},
// POST /broadcasts/{id}/send, GET /broadcasts (limit/after/has_more), GET /audiences/{id}/contacts (after/has_more). Every
// request is logged as "METHOD path" (Fable R-1: the test asserts the set). Faults per method+path pattern: an HTTP status,
// throw-before (nothing happened), throw-after (it happened, the answer was lost). Accepts segment_id or audience_id until
// the qualification pins one (R-1).
// S3 qualification (runner dry-run): the segment listing (GET /audiences, name included), a contact update (PATCH
// /audiences/{id}/contacts/{id}), POST /emails, and opt-in status progression (queued -> sent on the next read).
type Broadcast = { id: string; name: string; segment_id: string; from: string; subject: string; reply_to: string | null; html: string; text: string;
  status: "draft" | "queued" | "sent"; created_at: string };
type Fault = { method: string; path: RegExp; kind: number | "throw-before" | "throw-after"; times: number };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

export class FakeResend {
  readonly broadcasts: Broadcast[] = [];
  contacts: { id: string; email: string; unsubscribed: boolean }[] = [];
  readonly log: string[] = [];
  readonly keys: string[] = [];
  private readonly emailKeys: string[] = [];
  private faults: Fault[] = [];
  private readonly sendingShown = new Set<string>();
  pageSize = 2;
  /** Opt-in: a sent broadcast reads "sending" once, then "sent" (the live provider's progression, for Q2). */
  progressToSent = false;
  segmentName = "kapelle-qual-synthetic";
  /** Which list field the fake accepts (the qualification pins the real one; Q1's fallback is tested by narrowing this). */
  acceptFields: ("segment_id" | "audience_id")[] = ["segment_id", "audience_id"];
  readonly emails: { from: string; to: string[]; subject: string; reply_to?: string; idempotencyKey: string }[] = [];
  /** Called when a broadcast is sent (tests add a contact here to model an addition during the send). */
  onSend: (() => void) | null = null;
  constructor(readonly audienceId = "aud_exna") {}
  fault(method: string, path: RegExp, kind: Fault["kind"], times = 1) { this.faults.push({ method, path, kind, times }); }
  clearFaults() { this.faults = []; }
  setContacts(n: number, unsubscribed: number[] = []) { this.contacts = Array.from({ length: n }, (_, i) => ({ id: `ct_${i + 1}`, email: `p${i + 1}@example.org`, unsubscribed: unsubscribed.includes(i + 1) })); }

  fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect?: string }): Promise<Response> => {
    const u = new URL(url);
    if (u.origin !== "https://api.resend.com" || init.redirect !== "error") return json({ message: "not found" }, 404);
    const route = u.pathname.replace(/\/(bc|ct)_[A-Za-z0-9]+/g, "/{id}").replace(/\/audiences\/[^/]+/, "/audiences/{id}");
    if (init.method === "POST" && u.pathname === "/emails") this.emailKeys.push(init.headers["idempotency-key"] ?? "");
    this.log.push(`${init.method} ${route}`);
    this.keys.push(init.headers.authorization ?? "");
    if (!/^Bearer re_/.test(init.headers.authorization ?? "")) return json({ name: "missing_api_key" }, 401);
    const f = this.faults.find((x) => x.method === init.method && x.path.test(u.pathname) && x.times > 0);
    if (f) { f.times--; if (f.kind === "throw-before") throw new TypeError("fetch failed"); if (typeof f.kind === "number") return json({ name: "fault" }, f.kind); }
    const res = this.route(init.method, u, init.body ? JSON.parse(init.body) : null);
    if (f?.kind === "throw-after") throw new TypeError("socket hang up");
    return res;
  };
  private page<T extends { id: string }>(items: T[], u: URL) {
    const after = u.searchParams.get("after"), limit = Math.min(Number(u.searchParams.get("limit") ?? this.pageSize), this.pageSize);
    const start = after ? items.findIndex((x) => x.id === after) + 1 : 0, data = items.slice(start, start + limit);
    return { object: "list", has_more: start + limit < items.length, data };
  }
  private route(method: string, u: URL, b: any): Response {
    const p = u.pathname; let m: RegExpExecArray | null;
    if (method === "POST" && p === "/broadcasts") {
      const seg = this.acceptFields.includes("segment_id") && b?.segment_id ? b.segment_id : this.acceptFields.includes("audience_id") ? b?.audience_id : undefined;
      if (seg !== this.audienceId || typeof b?.name !== "string" || typeof b?.html !== "string") return json({ name: "validation_error" }, 422);
      const bc: Broadcast = { id: "bc_" + (this.broadcasts.length + 1), name: b.name, segment_id: seg, from: b.from, subject: b.subject, reply_to: b.reply_to ?? null,
        html: b.html, text: b.text, status: "draft", created_at: new Date().toISOString() };
      this.broadcasts.push(bc); return json({ id: bc.id });
    }
    if (method === "GET" && p === "/broadcasts") return json(this.page(this.broadcasts.map(({ html: _h, text: _t, ...x }) => ({ ...x, audience_id: x.segment_id })), u));
    if (method === "GET" && (m = /^\/broadcasts\/(bc_\w+)$/.exec(p))) {
      const bc = this.broadcasts.find((x) => x.id === m![1]); if (!bc) return json({ name: "not_found" }, 404);
      const shown = bc.status === "queued" && this.progressToSent ? (this.sendingShown.has(bc.id) ? (bc.status = "sent") : (this.sendingShown.add(bc.id), "sending")) : bc.status;
      return json({ object: "broadcast", ...bc, status: shown, audience_id: bc.segment_id });
    }
    if (method === "POST" && (m = /^\/broadcasts\/(bc_\w+)\/send$/.exec(p))) {
      const bc = this.broadcasts.find((x) => x.id === m![1]);
      if (!bc) return json({ name: "not_found" }, 404);
      if (bc.status !== "draft") return json({ name: "validation_error" }, 422);
      bc.status = "queued"; this.onSend?.(); return json({ id: bc.id });
    }
    if (method === "GET" && p === "/audiences") return json({ object: "list", has_more: false, data: [{ id: this.audienceId, name: this.segmentName, created_at: "2026-10-19T00:00:00.000Z" }] });
    if (method === "PATCH" && (m = /^\/audiences\/([^/]+)\/contacts\/(ct_\w+)$/.exec(p))) {
      const c = m[1] === this.audienceId ? this.contacts.find((x) => x.id === m![2]) : undefined;
      if (!c || typeof b?.unsubscribed !== "boolean") return json({ name: "not_found" }, 404);
      c.unsubscribed = b.unsubscribed; return json({ object: "contact", id: c.id });
    }
    if (method === "POST" && p === "/emails") {
      if (typeof b?.from !== "string" || !Array.isArray(b?.to)) return json({ name: "validation_error" }, 422);
      this.emails.push({ from: b.from, to: b.to, subject: b.subject, ...(b.reply_to ? { reply_to: b.reply_to } : {}), idempotencyKey: this.emailKeys.at(-1) ?? "" });
      return json({ id: "em-" + this.emails.length }); // the shared client accepts [A-Za-z0-9-] ids (Resend: UUIDs)
    }
    if (method === "GET" && (m = /^\/audiences\/([^/]+)\/contacts$/.exec(p))) {
      if (m[1] !== this.audienceId) return json({ name: "not_found" }, 404);
      return json(this.page(this.contacts.map((c) => ({ object: "contact", id: c.id, email: c.email, unsubscribed: c.unsubscribed })), u));
    }
    return json({ name: "not_found" }, 404);
  }
}
