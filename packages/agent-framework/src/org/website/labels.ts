// Website pack request/proposal labels persisted on request rows (no imports: failure-labels.ts reads this without a cycle).
export const WEBSITE_REQUEST_REASONS = ["website_ops_not_json", "website_ops_invalid", "website_content_unsafe", "website_image_missing", "website_op_incomplete",
  "website_op_target_unknown", "website_base_shape_changed", "website_base_too_large", "website_file_too_large", "website_base_missing", "website_request_not_applicable",
  "website_no_change", "website_request_interrupted", "website_image_changed", "website_image_target_ambiguous", "website_image_conflict", "website_image_too_large",
  // J2 (Add photos): the base file has no galleryPhotos list to add to.
  "website_gallery_missing"] as const;
export const WEBSITE_APPLY_REASONS = ["website_base_moved", "website_branch_conflict", "website_outcome_unknown_after_restart", "website_preview_pending",
  "website_image_readback_failed",
  // Update the open draft (Fable ACCEPT e483c8dd, C-1): the target PR was merged/closed; its branch is not where the card bound it.
  "website_pr_closed", "website_branch_moved"] as const;
