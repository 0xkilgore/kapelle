// IMAGES-V1: every fixed image label (no imports: failure-labels.ts reads this without a cycle).
export const IMAGE_REASONS = [
  // I1 decoder + store
  "image_too_large", "image_type_not_admitted", "image_type_mismatch", "image_unreadable", "image_too_many_pixels", "image_dimensions", "image_animated",
  "image_output_too_large", "image_decoder_usage", "image_output_unwritable", "image_decoder_unavailable", "image_decoder_timeout", "image_upload_rate_limited",
  "image_limit", "image_org_storage_full", "image_upload_unknown", "image_upload_consumed", "image_upload_expired", "image_upload_session_mismatch",
  "image_size_mismatch", "image_upload_aborted", "image_upload_busy", "image_unknown", "image_not_configured",
  // I2 extraction
  "image_request_invalid", "image_request_too_large", "image_tool_calls_refused", "image_extract_unreadable", "image_extract_cap", "image_extract_busy",
  "image_extract_not_configured", "image_profile_not_qualified", "image_proposal_unknown", "image_proposal_invalid", "image_extract_org_cap", "image_extract_interrupted",
  // LIBRARY L1: the shared drive
  "drive_name_invalid", "drive_limit", "drive_image_unknown", "drive_image_unreadable", "drive_image_published", "drive_not_available", "drive_store_failed",
  // LIBRARY L2: publish-on-prepare and the public files route
  "newsletter_release_needs_publish", "newsletter_publish_list_changed", "newsletter_release_no_drive_images", "files_public_route_off", "files_used_in_sent_newsletter",
  "files_not_public", "files_unpublished", "files_quarantined", "library_hash_mismatch",
] as const;
