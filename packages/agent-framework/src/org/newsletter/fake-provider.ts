// Newsletter slice 2, S2-b: a FAKE broadcast provider for the F-7 executor's tests (never the network). In-memory broadcasts;
// fault injection per call: refuse (a definite "not done"), throw-before (nothing happened, answer lost), throw-after (it
// happened, answer lost: the reconcile-by-reads case); `complete: false` listings and unknown recipient counts on demand.
import { createHash } from "node:crypto";
import { ProviderError, type ProviderPort } from "./release.js";

type Fault = { op: keyof ProviderPort; kind: "refuse" | "throw-before" | "throw-after"; times: number };
export class FakeProvider implements ProviderPort {
  readonly broadcasts = new Map<string, { id: string; name: string; status: "draft" | "queued" | "sent"; subject: string; html: string; recipients: number }>();
  readonly calls: { op: string; arg: string }[] = [];
  private faults: Fault[] = [];
  listComplete = true;
  /** Called when a broadcast is sent (tests model an addition to the audience during the send). */
  onSend: (() => void) | null = null;
  constructor(public audienceSize = 3) {}
  fault(op: keyof ProviderPort, kind: Fault["kind"], times = 1) { this.faults.push({ op, kind, times }); }
  private async run<T>(op: keyof ProviderPort, arg: string, apply: () => T): Promise<T> {
    this.calls.push({ op, arg });
    const f = this.faults.find((x) => x.op === op && x.times > 0);
    if (f) { f.times--; if (f.kind === "refuse") throw new ProviderError("newsletter_provider_refused", false); if (f.kind === "throw-before") throw new ProviderError("newsletter_provider_uncertain", true); }
    const r = apply();
    if (f?.kind === "throw-after") throw new ProviderError("newsletter_provider_uncertain", true);
    return r;
  }
  createDraft(o: Parameters<ProviderPort["createDraft"]>[0]) {
    return this.run("createDraft", o.name, () => { const id = "bc_" + (this.broadcasts.size + 1); this.broadcasts.set(id, { id, name: o.name, status: "draft", subject: o.subject, html: o.html, recipients: 0 }); return { id }; });
  }
  getBroadcast(id: string) {
    return this.run("getBroadcast", id, () => { const b = this.broadcasts.get(id);
      return b ? { id, name: b.name, status: b.status, subject: b.subject, htmlSha256: "sha256:" + createHash("sha256").update(b.html).digest("hex") } : null; });
  }
  send(id: string) {
    return this.run("send", id, () => { const b = this.broadcasts.get(id); if (!b) throw new ProviderError("newsletter_provider_refused", false); b.status = "queued"; this.onSend?.(); return { accepted: true }; });
  }
  listBroadcasts() { return this.run("listBroadcasts", "", () => ({ complete: this.listComplete, items: [...this.broadcasts.values()].map((b) => ({ id: b.id, name: b.name })) })); }
}
