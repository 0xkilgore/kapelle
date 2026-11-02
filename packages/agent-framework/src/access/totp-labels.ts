// Newsletter send slice 1: the authenticator step-up's fixed refusals (no imports: failure-labels.ts reads this without a cycle).
export const TOTP_REASONS = ["totp_not_configured", "totp_key_unavailable", "totp_enroll_token_invalid", "totp_enroll_not_pending", "totp_enroll_codes_invalid",
  "totp_not_enrolled", "totp_code_invalid", "totp_factor_locked", "totp_clock_skew", "totp_mint_rate_limited"] as const;
