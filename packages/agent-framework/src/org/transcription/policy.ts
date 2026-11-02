// The org's transcription policy (Fable R-3, plan v2 §5): a versioned artifact approved by `transcription.policy.approve`
// (`totp` tier: the owner-only Ops route until an authenticator-app step exists), exactly like the member-reply policy. It
// pins the backend profile, the retention numbers (D-2) and the recording-notice text (D-3) that the upload UI shows.
// Every job pins the active policy's hash; with no active policy, `transcript.start` refuses (transcription_no_policy).
import { z } from "zod";
import { digest } from "../../content.js";
import { canonical } from "../../command-boundary.js";
import { AccessError, type Authorization } from "../../access/org-access.js";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";

/** Plain text, one paragraph or a few lines: no control characters except newlines, no markup. */
const plain = (max: number) => z.string().min(1).max(max).refine((s) => !/[\u0000-\u0009\u000b-\u001f\u007f<>]/.test(s), "plain_text_only");
export const transcriptionPolicySchema = z.object({
  contract: z.literal("kapelle.transcription-policy/v1"), version: z.number().int().positive(),
  backend: z.enum(["fake", "deepgram"]), profileHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  /** D-2 placeholder: raw audio until a reviewer accepts the transcript + acceptPlusDays, never beyond hardCapDays from upload. */
  retention: z.object({ acceptPlusDays: z.number().int().min(0).max(30), hardCapDays: z.number().int().min(1).max(30) }).strict(),
  /** D-3: shown on the upload form and in the Transcribe dialog (owner's text). */
  noticeText: plain(1000),
}).strict().refine((p) => p.retention.acceptPlusDays <= p.retention.hardCapDays, "retention_invalid");
export type TranscriptionPolicy = z.infer<typeof transcriptionPolicySchema>;
export const transcriptionPolicyHash = (p: TranscriptionPolicy) => digest(transcriptionPolicySchema.parse(p));

const SCHEMA = `CREATE TABLE IF NOT EXISTS transcription_policy(hash TEXT PRIMARY KEY, json TEXT NOT NULL, approved_by TEXT NOT NULL, approved_at TEXT NOT NULL,
  authn TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1))) STRICT;`;

export class TranscriptionPolicies {
  private readonly now: () => string;
  constructor(private readonly a: SqliteAuthority, private readonly host: { profileHash: () => string | null }, now?: () => string) {
    this.now = now ?? (() => new Date().toISOString()); a.db.exec(SCHEMA);
  }
  /** Approve the exact policy (artifact digest = its hash). The policy must name the CONFIGURED profile: a policy cannot pick a
   *  backend the Ops config does not run. The previous active policy is deactivated in the same transaction. */
  approve(z: Authorization, policy: unknown) {
    const parsed = transcriptionPolicySchema.safeParse(policy);
    if (!parsed.success) throw new AccessError("transcription_policy_invalid");
    const p = parsed.data, h = transcriptionPolicyHash(p);
    if (!(z.action === "transcription.policy.approve" && z.artifactDigest === h && z.bodyHash === digest(p))) throw new AccessError("transcription_policy_approval_mismatch");
    const configured = this.host.profileHash();
    if (!configured) throw new AccessError("transcription_not_configured");
    if (p.profileHash !== configured) throw new AccessError("transcription_policy_profile_mismatch");
    this.a.write(() => {
      this.a.db.prepare("UPDATE transcription_policy SET active=0 WHERE active=1").run();
      this.a.db.prepare("INSERT INTO transcription_policy(hash,json,approved_by,approved_at,authn,active) VALUES (?,?,?,?,?,1) ON CONFLICT(hash) DO UPDATE SET active=1")
        .run(h, canonical(p), z.memberId, this.now(), z.authn);
    });
    return { policyHash: h, version: p.version };
  }
  /** The active policy, or null. A policy whose profile no longer matches the configured one is NOT active (re-approve). */
  active(): { hash: string; policy: TranscriptionPolicy } | null {
    const row = this.a.read(() => this.a.db.prepare("SELECT hash, json FROM transcription_policy WHERE active=1").get()) as { hash: string; json: string } | undefined;
    if (!row) return null;
    const policy = transcriptionPolicySchema.parse(JSON.parse(row.json));
    return policy.profileHash === this.host.profileHash() ? { hash: row.hash, policy } : null;
  }
}
