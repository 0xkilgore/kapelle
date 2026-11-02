// TEAM-TASKS-V1 (design of record 9320d2e5; Fable F-2, N-3): the fixed teamtask_* vocabulary (no imports: failure-labels.ts
// reads this without a cycle). Distinct from the Mac Task Authority task_* labels. Unknown and inaccessible task ids share
// teamtask_audience_not_permitted.
export const TEAMTASK_REASONS = ["teamtask_plan_changed", "teamtask_plan_expired", "teamtask_scope_not_permitted", "teamtask_tool_not_admitted",
  "teamtask_queue_full", "teamtask_budget_exhausted", "teamtask_claim_consumed", "teamtask_result_unverified", "teamtask_outcome_uncertain",
  "teamtask_audience_not_permitted", "teamtask_adoption_refused",
  // T1 additions (named in the commit): another attempt is approved/running; the task is done or cancelled; malformed input;
  // a cancelled attempt; an Ops reconcile whose evidence does not settle the fence; the runner is switched off by Ops.
  "teamtask_attempt_active", "teamtask_closed", "teamtask_input_invalid", "teamtask_cancelled", "teamtask_reconcile_refused", "teamtask_paused",
  // SCHEDULED-TASKS-V1 S1 (design 8cf4853f §4): fixed schedule labels (content-free).
  "teamtask_schedule_expired", "teamtask_schedule_pin_changed", "teamtask_schedule_source_refused", "teamtask_schedule_budget_exhausted",
  "teamtask_schedule_missed", "teamtask_schedule_no_new_sources", "teamtask_schedule_paused",
  // Fable N-1 (5bbc6d0b): a read refused because every source is already inline (a tool result, never an attempt end).
  "teamtask_source_inline",
  // The 62cea80c requal: a reply that only announced a step (no result) is refused, never Result ready.
  "teamtask_result_preamble",
  // Fable R-C: a result over a snapshot with files that cites none of them (complete or partial): refused, never Result ready.
  "teamtask_result_uncited",
  // AGENT-HANDBOOK-V1 H1 (Fable B-4): the handbook feature is on but no approved handbook exists; the active handbook is not the one
  // the plan was made with (a new plan is needed; a running attempt stops); the system map could not be made (over its cap).
  "teamtask_handbook_missing", "teamtask_handbook_changed", "teamtask_system_map_unavailable"] as const;
