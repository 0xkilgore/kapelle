// AGENT-HANDBOOK-V1 H1 (design v2; Fable b375b67b): fixed, content-free labels. Store refusals use handbook_*; a task or chat
// turn that cannot load its approved context refuses BEFORE inference with its path's family (teamtask_* / chat_*).
export const HANDBOOK_REASONS = ["handbook_oversize", "handbook_approval_conflict", "handbook_input_invalid",
  // H2: a handbook action on an org where the feature is not enabled (org.json handbook absent/false).
  "handbook_not_enabled",
  // H2 (Fable C-B): approve's digest (the session-fresh challenge's) is not the server-normalized text's sha256.
  "handbook_digest_mismatch"] as const;
