// Meeting transcription (Fable R-1, plan v2 §2): a per-org hosted transcription profile, pinned like the hosted-inference
// profiles. Host-owned facts only: the backend, the ONE origin and path, the exact model, the fixed request parameters
// (diarization on, provider training/retention opt-out on, no callback), the reservation rate and margin, and the per-job
// ceilings. Nothing from a browser, a reviewer or a transcript can supply an origin, a parameter, a key or a price.
import { z } from "zod";
import { digest } from "../../content.js";

export const transcriptionProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  backend: z.enum(["fake", "deepgram"]),
  /** The ONLY origin + path a request goes to (fake: never contacted). */
  origin: z.literal("https://api.deepgram.com"), path: z.literal("/v1/listen"),
  model: z.literal("nova-3"), language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  /** Fixed query (R-1): diarize, utterances, punctuate, smart_format, mip_opt_out. Never a callback. */
  params: z.object({ diarize: z.literal(true), utterances: z.literal(true), punctuate: z.literal(true), smart_format: z.literal(true), mip_opt_out: z.literal(true) }).strict(),
  /** USD per hour of audio, pinned by Ops; RESERVING uses rate x margin; settlement uses the billed duration x rate. */
  pricing: z.object({ version: z.string().min(1).max(60), usdPerAudioHour: z.number().positive().max(100), reservationMargin: z.number().min(1).max(3) }).strict(),
  limits: z.object({ maxAudioMinutes: z.number().int().min(1).max(240), maxUploadBytes: z.number().int().min(1).max(250 * 1024 * 1024) }).strict(),
}).strict();
export type TranscriptionProfile = z.infer<typeof transcriptionProfileSchema>;
export const transcriptionProfileHash = (p: TranscriptionProfile) => digest(transcriptionProfileSchema.parse(p));

/** The pilot profile (D-1 placeholder: Deepgram prerecorded Nova-3 only). The rate is the published base rate checked
 *  2026-10-15 (TRANSCRIPTION.md §B); the effective opt-out rate is confirmed at admission (Fable note) and re-pinned. */
const base = { origin: "https://api.deepgram.com", path: "/v1/listen", model: "nova-3", language: "en",
  params: { diarize: true, utterances: true, punctuate: true, smart_format: true, mip_opt_out: true },
  pricing: { version: "deepgram-nova-3-prerecorded-2026-10-15", usdPerAudioHour: 0.258, reservationMargin: 1.2 },
  limits: { maxAudioMinutes: 120, maxUploadBytes: 250 * 1024 * 1024 } } as const;
export const TRANSCRIPTION_PROFILES = Object.freeze({
  deepgram: transcriptionProfileSchema.parse({ id: "dg-nova-3-en", backend: "deepgram", ...base }),
  fake: transcriptionProfileSchema.parse({ id: "fake-nova-3-en", backend: "fake", ...base }),
});

/** R-4: what one job may reserve: the (sniffed) duration x rate x margin, never above the per-job ceiling. */
export function transcriptionReservationUsd(p: TranscriptionProfile, durationSec: number) {
  const ceiling = (p.limits.maxAudioMinutes / 60) * p.pricing.usdPerAudioHour * p.pricing.reservationMargin;
  return Math.min(ceiling, (Math.max(0, durationSec) / 3600) * p.pricing.usdPerAudioHour * p.pricing.reservationMargin);
}
/** Settlement: the provider's billed duration x the pinned rate (no margin). */
export const transcriptionCostUsd = (p: TranscriptionProfile, billedSec: number) => (Math.max(0, billedSec) / 3600) * p.pricing.usdPerAudioHour;

/** Every fixed label the transcription path can persist (job rows, audit, Ops status). All are in failure-labels.ts CODES
 *  (Fable's standing rule); an HTTP label may carry `:err=<provider error code>` (content-free), like hosted `:code=`. */
export const TRANSCRIPTION_FAILURE_REASONS = [
  "transcription_not_configured", "transcription_profile_not_qualified", "transcription_no_policy", "transcription_policy_profile_mismatch",
  "transcription_key_missing", "transcription_origin_not_admitted", "transcription_ambient_proxy_refused",
  "transcription_aborted_before_send", "transcription_aborted_after_send", "transcription_deadline_exceeded", "transcription_transport_failed",
  "transcription_http_400", "transcription_http_401", "transcription_http_402", "transcription_http_403", "transcription_http_404", "transcription_http_408",
  "transcription_http_413", "transcription_http_415", "transcription_http_422", "transcription_http_429", "transcription_http_4xx", "transcription_http_5xx",
  "transcription_http_unexpected", "transcription_response_not_json", "transcription_response_too_large", "transcription_response_malformed",
  "transcription_output_empty", "transcription_model_mismatch", "transcription_duration_over_cap", "transcription_monthly_cap_exceeded",
  "transcription_job_cap_exceeded", "transcription_outcome_unknown_after_restart", "transcription_bill_over_reservation",
  "media_type_not_admitted", "media_too_large", "media_too_long", "media_duration_unknown", "media_duration_implausible", "media_size_mismatch",
  "media_upload_session_mismatch", "media_upload_unknown", "media_upload_expired", "media_upload_consumed", "media_upload_rate_limited",
  "media_upload_aborted",
  "transcript_attestation_required", "transcript_job_unknown", "transcript_job_state", "transcript_audio_digest_mismatch", "transcript_audio_missing",
  "transcript_discarded", "transcription_write_interrupted", "transcription_reservation_failed", "transcript_part_unknown",
  "media_retention_expired", "transcription_internal_error", "adopt_transcript_parts_overlap",
] as const;
export type TranscriptionLabel = (typeof TRANSCRIPTION_FAILURE_REASONS)[number];

/** A definite refusal: nothing was processed (release the reservation). */
export class TranscriptionRefused extends Error { constructor(readonly label: string) { super(label); this.name = "TranscriptionRefused"; } }
/** The request may have been processed and billed (keep the reservation `unsettled`; never resubmit automatically). */
export class TranscriptionUncertain extends Error { constructor(readonly label: string) { super(label); this.name = "TranscriptionUncertain"; } }
