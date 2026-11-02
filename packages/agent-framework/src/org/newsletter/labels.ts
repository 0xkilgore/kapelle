// Newsletter send slice 1 (S1-c): the release core's fixed refusals and release/effect states (no imports: failure-labels.ts
// reads this without a cycle). States include the slice-2/3 ones now (Fable R-9), so the CHECK constraints never widen later.
export const NEWSLETTER_REASONS = ["newsletter_release_unknown", "newsletter_release_changed", "newsletter_release_state", "newsletter_killed",
  "newsletter_uncertain_release", "newsletter_approver_not_permitted", "newsletter_slug_invalid", "newsletter_slug_reused", "newsletter_history_incomplete",
  "newsletter_duplicate", "newsletter_test_missing", "newsletter_test_mismatch", "newsletter_test_wrong_recipient", "newsletter_test_stale",
  "newsletter_preflight_failed", "newsletter_images_unserved", "newsletter_transfer_missing", "newsletter_installation_not_authorized",
  "newsletter_suppression_stale", "newsletter_recipients_unknown", "newsletter_recipients_changed", "newsletter_release_cap", "newsletter_package_invalid",
  "newsletter_test_cap", "newsletter_overrun",
  // Slice 2, S2-b (F-7 executor): provider and projection outcomes.
  "newsletter_manifest_unwritable", "newsletter_draft_mismatch", "newsletter_provider_refused", "newsletter_provider_uncertain", "newsletter_count_unknown",
  "newsletter_restore_reconcile", "newsletter_create_ambiguous", "newsletter_create_absent", "newsletter_draft_held", "newsletter_history_unavailable",
  // Slice 2, S2-a (test send, approval attestation).
  "newsletter_test_not_configured", "newsletter_test_cooldown", "newsletter_test_unknown", "newsletter_test_preview_only", "newsletter_test_refused",
  "newsletter_attestation_required", "newsletter_sender_not_configured", "newsletter_draft_unavailable",
  // Slice 2, S2-c (Ops history import).
  "newsletter_history_import_invalid",
  // Slice 3, S3-c (Ops cutover facts, R-7).
  "newsletter_transfer_invalid", "newsletter_suppression_invalid", "newsletter_retire_invalid",
  // Package E (Fable e9cdd63c E-2/E-5, cbae22b4 E-9; E-4): an image whose bytes changed since prepare; an also-to recipient
  // skipped at send time; a test sender on another domain than the release From; an invalid link-host extras list.
  "newsletter_image_changed", "newsletter_test_recipient_skipped", "newsletter_sender_invalid", "newsletter_link_hosts_invalid",
  // Fable F-1 / E-6': the v3 footer's unsubscribe placeholder is not exactly one triple-brace anchor href.
  "newsletter_unsubscribe_invalid"] as const;
/** The order a release moves through (F-7); recovery compares a projection row's state with the DB's by this rank. */
export const PROGRESS = ["approved", "create_attempted", "draft_known", "send_attempted", "provider_accepted", "archive_pending", "done"] as const;
export const RELEASE_STATES = ["prepared", "approved", "create_attempted", "draft_known", "send_attempted", "provider_accepted", "uncertain", "held",
  "failed", "reconcile_required", "restore_reconcile_required", "archive_pending", "done"] as const;
/** States that hold an outcome nobody has reconciled yet: any one of them blocks EVERY release of the org (F-7). */
export const UNSETTLED_STATES = ["create_attempted", "send_attempted", "uncertain", "held", "reconcile_required", "restore_reconcile_required"] as const;
