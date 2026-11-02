// Chat turn stop reasons persisted on turn rows and tool-call rows (no imports: failure-labels.ts reads this without a cycle).
export const CHAT_STOP_REASONS = ["chat_turn_interrupted", "chat_member_inactive", "chat_runner_not_installed", "chat_stopped_by_member",
  // C-3 scheduler (PLAN §5): the first cap to arrive ends the turn with its label.
  "chat_cap_requests", "chat_cap_tools", "chat_cap_wall", "chat_cap_usd", "chat_cap_context", "chat_org_cap", "chat_tool_refused", "chat_profile_not_qualified",
  "chat_execution_unconfirmed",
  // C-3/C-4 tool-call outcomes returned to the model and counted (never the tool's text).
  "chat_tool_unknown", "chat_tool_args_invalid", "chat_tool_result_too_large", "chat_tool_not_installed", "chat_tool_failed",
  // C-4 tools: snapshot scope, draft envelope, provenance (E-5), artifacts.
  "chat_tool_path_not_admitted", "chat_tool_needs_draft_plan", "chat_tool_sources_invalid", "chat_tool_artifact_unknown", "chat_snapshot_too_large",
  // Package F delta A-4 (Fable): a newsletter image that is not an E-1 URL on the turn's site image list (the version is refused).
  "newsletter_image_not_listed",
  // PACKAGE P: edit_draft_artifact refusals (nothing written) and the member-link check (the version is refused).
  "draft_edit_stale", "draft_edit_not_found", "draft_edit_ambiguous", "draft_edit_field_unknown", "draft_edit_conflict", "draft_member_link_missing",
  // WC-3: the turn's snapshot has no files (no request made, nothing reserved, not counted against the daily allowance).
  "chat_no_files",
  // C-5 draft envelope closures (recorded on the envelope).
  "chat_draft_expired", "chat_draft_exhausted", "chat_draft_snapshot_changed",
  // AGENT-HANDBOOK-V1 H1 (Fable B-4): the handbook feature is on but no approved handbook exists, or the turn's system map could not
  // be made (over its cap). Refused at turn start: no request, nothing reserved.
  "chat_handbook_missing", "chat_system_map_unavailable"] as const;
