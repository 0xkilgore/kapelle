// Transcription T-1 (plan v2 §2, §5; Fable R-1, R-3, R-4): the pinned profile and reservation math, the fixed label vocabulary
// in failure-labels CODES, the FAKE backend port, the org config block, and the transcription policy approved only through the
// owner-only Ops route (`totp` tier). Fake data only; no network.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { TRANSCRIPTION_PROFILES, TRANSCRIPTION_FAILURE_REASONS, transcriptionProfileHash, transcriptionProfileSchema, transcriptionReservationUsd,
  transcriptionCostUsd, TranscriptionRefused, TranscriptionUncertain } from "../src/org/transcription/profile.js";
import { fakeTranscriptionBackend, FAKE_MEETING } from "../src/org/transcription/adapter.js";
import { transcriptionPolicyHash, type TranscriptionPolicy } from "../src/org/transcription/policy.js";
import { failureLabel, REASON_PATTERN } from "../src/task-delegation/failure-labels.js";
import { openOrgRuntime, orgRuntimeConfigSchema } from "../src/org/org-runtime.js";
import { runtimeCatalogSchema, claudeProfileFromBinding } from "../src/agent-kit/runtime-catalog.js";
import { catalogSha256 } from "../src/agent-kit/kit-host.js";
import { authMailText } from "../src/hub/auth-mail.js";
import { hosted } from "./org-meeting-kit.js";
import { RP, ORIGIN } from "./soft-authenticator.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const W4 = { model: "claude-opus-5-5", credentialTeamId: "00000000-0000-4000-8000-000000000001", credentialKind: "claude-code-oauth" as const, runtime: "claude-agent-sdk" as const,
  sdkVersion: "0.2.90", cliVersion: "2.1.295", maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: "isolated" as const, thinking: "adaptive" as const, effort: "high" as const };

it("the pinned profile: fixed params (diarize, mip_opt_out, no callback), one origin, a hash per backend; reservation and cost", () => {
  const dg = TRANSCRIPTION_PROFILES.deepgram, fk = TRANSCRIPTION_PROFILES.fake;
  expect(dg).toMatchObject({ backend: "deepgram", origin: "https://api.deepgram.com", path: "/v1/listen", model: "nova-3",
    params: { diarize: true, utterances: true, punctuate: true, smart_format: true, mip_opt_out: true }, limits: { maxAudioMinutes: 120, maxUploadBytes: 250 * 1024 * 1024 } });
  expect(Object.keys(dg.params)).not.toContain("callback");
  expect(transcriptionProfileHash(dg)).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(transcriptionProfileHash(dg)).not.toBe(transcriptionProfileHash(fk));
  // Nothing else is admissible: another origin, a callback, opt-out off, an unpinned model.
  for (const bad of [{ ...dg, origin: "https://evil.test" }, { ...dg, params: { ...dg.params, callback: "https://x" } }, { ...dg, params: { ...dg.params, mip_opt_out: false } },
    { ...dg, model: "nova-latest" }, { ...dg, limits: { ...dg.limits, maxUploadBytes: 251 * 1024 * 1024 } }])
    expect(transcriptionProfileSchema.safeParse(bad).success).toBe(false);
  // R-4: duration x rate x margin, capped at the per-job ceiling (maxAudioMinutes x rate x margin); settlement without margin.
  expect(transcriptionReservationUsd(dg, 1800)).toBeCloseTo(0.5 * 0.258 * 1.2, 10);
  expect(transcriptionReservationUsd(dg, 5 * 3600)).toBeCloseTo(2 * 0.258 * 1.2, 10);
  expect(transcriptionReservationUsd(dg, -5)).toBe(0);
  expect(transcriptionCostUsd(dg, 3600)).toBeCloseTo(0.258, 10);
});

it("every transcription label is in the failure-label CODES and persists verbatim; an :err= detail only on a known HTTP base", () => {
  for (const l of TRANSCRIPTION_FAILURE_REASONS) { expect(failureLabel(new Error(l)), l).toBe(l); expect(REASON_PATTERN.test(l), l).toBe(true); }
  expect(failureLabel(new TranscriptionRefused("transcription_http_429"))).toBe("transcription_http_429");
  expect(failureLabel(new TranscriptionUncertain("transcription_deadline_exceeded"))).toBe("transcription_deadline_exceeded");
  expect(failureLabel(new Error("transcription_http_429:err=rate_limit_exceeded"))).toBe("transcription_http_429:err=rate_limit_exceeded");
  for (const odd of ["transcription_http_429:err=Too Many", "transcription_http_999:err=x", "transcription_something_new", "media_whatever"])
    expect(failureLabel(new Error(odd)), odd).toBe("unlabeled");
});

it("the FAKE backend: deterministic, scripted failures (refused before send / uncertain after send), billed overage, abort", async () => {
  const sha = "a".repeat(64), other = "b".repeat(64), ref = "c".repeat(64), unc = "d".repeat(64), over = "e".repeat(64);
  const fake = fakeTranscriptionBackend({ [ref]: { refused: "transcription_http_400" }, [unc]: { uncertain: "transcription_deadline_exceeded" }, [over]: { billedSec: 999 } });
  const req = (audioSha256: string) => ({ audioPath: "/nonexistent", audioSha256, durationSec: 50, contentType: "audio/wav" });
  const r1 = await fake.transcribe(req(sha), new AbortController().signal), r2 = await fake.transcribe(req(other), new AbortController().signal);
  expect(r1).toEqual({ utterances: FAKE_MEETING, billedSec: 50, requestId: "fake-aaaaaaaaaaaa", region: "fake", model: "nova-3" });
  expect(r2.utterances).toEqual(r1.utterances);
  expect(new Set(FAKE_MEETING.map((u) => u.speaker))).toEqual(new Set([0, 1])); // numeric indices only, never names
  expect(FAKE_MEETING.some((u) => /ignore previous instructions/i.test(u.text))).toBe(true); // R-6 injection line for later suites
  await expect(fake.transcribe(req(ref), new AbortController().signal)).rejects.toBeInstanceOf(TranscriptionRefused);
  await expect(fake.transcribe(req(unc), new AbortController().signal)).rejects.toBeInstanceOf(TranscriptionUncertain);
  expect((await fake.transcribe(req(over), new AbortController().signal)).billedSec).toBe(999);
  const ac = new AbortController(); ac.abort();
  await expect(fake.transcribe(req(sha), ac.signal)).rejects.toMatchObject({ label: "transcription_aborted_before_send" });
  expect(fake.calls).toHaveLength(5); // the aborted one never reached the backend
});

it("receipts name a transcription start and a transcript acceptance (fixed template)", () => {
  const r = { actor: "robin@exna.test", action: "transcript.start", artifactDigest: "sha256:" + "ab".repeat(32), operationId: "op-1", at: "2026-10-16T12:00:00.000Z", authn: "email-session" };
  expect(authMailText({ orgId: "exna", orgLabel: "EXNA", to: "robin@exna.test", kind: "receipt", link: "https://x/o/exna/", receipt: r }).subject).toBe("EXNA: you started a transcription of a recording");
  expect(authMailText({ orgId: "exna", orgLabel: "EXNA", to: "robin@exna.test", kind: "receipt", link: "https://x/o/exna/", receipt: { ...r, action: "transcript.accept" } }).text)
    .toMatch(/^You accepted a transcript in EXNA\.\n\nAudio: sha256:/);
});

describe.skipIf(!enabled)("transcription config + policy through the Ops socket", () => {
  it("config block (deepgram needs a key file); status; policy approved only via Ops, bound to the configured profile", async () => {
    const base = realpathSync(mkdtempSync("/tmp/kt1-")); chmodSync(base, 0o700);
    const sub = (r: string, n: string) => { const d = join(r, n); mkdirSync(d, { mode: 0o700 }); return d; };
    const file = (p: string, c: string) => { writeFileSync(p, c, { mode: 0o600 }); return p; };
    const make = (name: string, transcription?: unknown) => {
      const root = sub(base, name), secrets = sub(root, "secrets");
      const catalogPath = file(join(root, "catalog.json"), JSON.stringify(runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [claudeProfileFromBinding("claude-current", W4, "x"), hosted] })));
      return { contract: "kapelle.org-runtime/v1", orgId: "exna", label: "EXNA", stateRoot: sub(root, "state"), folder: sub(root, "folder"), accessSocket: join(sub(root, "run"), "a.sock"),
        opsSocket: join(sub(root, "ops"), "o.sock"), rpId: RP, origins: [ORIGIN], installations: [{ installationId: "inst-exna", domain: "in.exna.test", secretFile: file(join(secrets, "wh"), randomBytes(24).toString("base64url")) }],
        catalogPath, catalogSha256: catalogSha256(catalogPath), hostedProfileId: "hosted-sonnet", hosted: { secretFile: file(join(secrets, "k"), "sk-or-v1-SYNTHETIC"), monthlyUsd: 5 },
        replyDomain: "reply.exna.test", ...(transcription ? { transcription } : {}) };
    };
    const ops = (socket: string, route: string, body: unknown = {}): Promise<any> => new Promise((res, rej) => { const data = Buffer.from(JSON.stringify(body));
      const r = request({ socketPath: socket, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (x) => {
        const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => res(JSON.parse(Buffer.concat(c).toString()))); }); r.on("error", rej); r.end(data); });
    // Config: deepgram without a key file, an unknown field, or a cap over the bound is refused at parse.
    for (const bad of [{ backend: "deepgram", monthlyUsd: 5 }, { backend: "fake", monthlyUsd: 5, extra: 1 }, { backend: "fake", monthlyUsd: 5000 }, { backend: "whisper", monthlyUsd: 5 }])
      expect(orgRuntimeConfigSchema.safeParse(make(`bad-${Object.keys(bad).length}-${String((bad as any).backend)}-${(bad as any).monthlyUsd}`, bad)).success, JSON.stringify(bad)).toBe(false);
    // Off: no block -> status null, the policy route refuses with a fixed label.
    const offCfg = make("off"), off = await openOrgRuntime(offCfg, { fetchImpl: (async () => new Response("{}", { status: 503 })) as never });
    try {
      expect((await ops(offCfg.opsSocket, "/ops/status")).transcription).toBeNull();
      expect(await ops(offCfg.opsSocket, "/ops/transcription/policy/approve", { policy: {} })).toEqual({ ok: false, error: "transcription_not_configured" });
    } finally { await off.close(); }
    const cfg = make("on", { backend: "fake", monthlyUsd: 3 }), org = await openOrgRuntime(cfg, { fetchImpl: (async () => new Response("{}", { status: 503 })) as never });
    try {
      const ph = transcriptionProfileHash(TRANSCRIPTION_PROFILES.fake);
      expect((await ops(cfg.opsSocket, "/ops/status")).transcription).toEqual({ backend: "fake", profileId: "fake-nova-3-en", profileHash: ph, monthlyUsd: 3, qualificationRef: "pending:",
        limits: { maxAudioMinutes: 120, maxUploadBytes: 250 * 1024 * 1024 }, policy: null, jobs: {}, tombstones: 0, recovered: { resumedUnsettled: 0, orphans: 0, reapplied: 0, missing: 0, swept: 0 }, deletions: {}, holds: 0, held: [], transcriptEntries: 0,
        spend: expect.objectContaining({ monthlyCapUsd: 3, settledUsd: 0 }) });
      const policy: TranscriptionPolicy = { contract: "kapelle.transcription-policy/v1", version: 1, backend: "fake", profileHash: ph, retention: { acceptPlusDays: 7, hardCapDays: 30 },
        noticeText: "This meeting is recorded and transcribed for the meeting notes.\nTell the chair if you would rather not be recorded." };
      // Refused: unknown field, markup/control characters, retention over the cap, another profile.
      for (const bad of [{ ...policy, extra: true }, { ...policy, noticeText: "<b>hi</b>" }, { ...policy, noticeText: "a\u0007b" }, { ...policy, retention: { acceptPlusDays: 31, hardCapDays: 30 } },
        { ...policy, retention: { acceptPlusDays: 10, hardCapDays: 5 } }])
        expect(await ops(cfg.opsSocket, "/ops/transcription/policy/approve", { policy: bad }), JSON.stringify(bad).slice(0, 80)).toEqual({ ok: false, error: "transcription_policy_invalid" });
      expect(await ops(cfg.opsSocket, "/ops/transcription/policy/approve", { policy: { ...policy, profileHash: transcriptionProfileHash(TRANSCRIPTION_PROFILES.deepgram) } }))
        .toEqual({ ok: false, error: "transcription_policy_profile_mismatch" });
      expect(org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM access_authorizations WHERE action='transcription.policy.approve'").get()).toEqual({ n: 0 }); // nothing recorded
      expect(await ops(cfg.opsSocket, "/ops/transcription/policy/approve", { policy })).toEqual({ ok: true, policyHash: transcriptionPolicyHash(policy), version: 1 });
      expect((await ops(cfg.opsSocket, "/ops/status")).transcription.policy).toEqual({ hash: transcriptionPolicyHash(policy), version: 1 });
      expect(org.sqlite.db.prepare("SELECT approved_by, authn, active FROM transcription_policy").all()).toEqual([{ approved_by: "ops", authn: "ops-socket", active: 1 }]);
      // A new version replaces it (one active).
      const v2 = { ...policy, version: 2, retention: { acceptPlusDays: 3, hardCapDays: 14 } };
      expect((await ops(cfg.opsSocket, "/ops/transcription/policy/approve", { policy: v2 })).ok).toBe(true);
      expect(org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM transcription_policy WHERE active=1").get()).toEqual({ n: 1 });
      expect(org.transcription.policies.active()?.policy.version).toBe(2);
    } finally { await org.close(); }
    // The same store opened with a different configured backend: the old policy no longer counts (re-approve).
    const dgCfg = { ...cfg, transcription: { backend: "deepgram", monthlyUsd: 3, secretFile: file(join(base, "on", "secrets", "dg"), "dg-SYNTHETIC-NOT-A-KEY") } };
    const dg = await openOrgRuntime(dgCfg, { fetchImpl: (async () => new Response("{}", { status: 503 })) as never });
    try { expect((await ops(cfg.opsSocket, "/ops/status")).transcription).toMatchObject({ backend: "deepgram", policy: null }); }
    finally { await dg.close(); }
  }, 120_000);
});
