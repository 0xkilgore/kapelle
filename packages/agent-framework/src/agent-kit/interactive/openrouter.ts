// The slice-1 pilot interactive profile: the qualified hosted Sonnet pins (Bedrock US / Vertex us-east5, ZDR, no fallbacks)
// with the slice-1 tool catalog and turn caps. Qualified SEPARATELY (R-8) from the one-POST profile.
import {OPENROUTER_PROFILES} from '../hosted/openrouter.js';
import {interactiveFromHosted, interactiveProfileSchema, type InteractiveProfile} from './profile.js';
import {imageProfileFromHosted, type ImageProfile} from './image.js';
import {FLYER_RULES_HASH} from './flyer.js';

export const INTERACTIVE_PROFILES: Record<'sonnet', InteractiveProfile> = {
  // QUALIFIED (live attempt 2, Director-approved, owner run 2026-10-17): the qualificationRef is the sha256 of the passing live report
  // interactive-qualification-or-sonnet-4-6-us-chat-live-20261017T195518658Z.json (run id run-1792266886-83059-10579, code dd23c356;
  // 7/7 cases, every request routed Amazon Bedrock, nonConforming 0, $0.159 settled; profileHash sha256:56a25c88…, toolCatalogHash
  // sha256:5253d856…). TRACKED byte-identical copy of the run and probe reports with SHA256SUMS (hashes, labels, facts and costs
  // only): agent-framework/qualification/interactive/2026-10-17-dd23c356/ (Fable's ruling). Pinning never
  // changes the profile hash (F-8 rule); verifyInteractiveQualificationReport checks the report against this profile.
  // Package E addendum 2 (Fable E-15): the catalog moved (5253d856 -> 5d6b3df3: inline [text](url) links + headerPhotos), so the
  // dd23c356 report below no longer VERIFIES against this profile (qualification_cases_mismatch; its profileHash predates the
  // catalog). The ref stays (not "pending:") so the ONE live task requal can run at the SAME head as the chat requal (the task
  // runner needs a non-pending profile); the install-time verifiers refuse this head until both new reports are pinned.
  // Package F (F2): QUALIFIED at F1c 46fbcfec (Director's run, owner-approved, 2026-10-25): the qualificationRef is the sha256 of
  // interactive-qualification-or-sonnet-4-6-us-chat-live-20261025T193727161Z.json (11/11, QUALIFY_OK, $0.552925; casesHash
  // sha256:91725235…, profileHash sha256:4960ec96…, toolCatalogHash sha256:529a957b…). TRACKED byte-identical with its probe and
  // SHA256SUMS: agent-framework/qualification/interactive/2026-10-25-46fbcfec/. dd23c356 (above) is history.
  // P2-REL (Fable P2 Addendum 2 + FABLE-REVIEW-P2-REL-7202C36F Addendum 1): QUALIFIED at 7202c36f (Ops' run, owner-approved, 2026-10-29):
  // the qualificationRef is the sha256 of interactive-qualification-or-sonnet-4-6-us-chat-live-20261029T211649179Z.json (13/13, $1.29;
  // casesHash dd7ff50d, profileHash d2623809, catalog 1f130437, identical at the pin head 0baa14ea). TRACKED byte-identical with its
  // probe and SHA256SUMS: agent-framework/qualification/interactive/2026-10-29-7202c36f/. 46fbcfec (above) is history.
  sonnet: interactiveProfileSchema.parse({...interactiveFromHosted('or-sonnet-4-6-us-chat', OPENROUTER_PROFILES.sonnet),
    qualificationRef: 'sha256:9240278e1d9979016e6c4bf4b82634ec567af24dc6a2806e8da17b287b8267a7'}),
};

/** IMAGES-V1 I2: the flyer-reading profile, derived from the SAME qualified hosted pins plus the image caps and the flyer rules'
 *  hash. The text profile above is untouched.
 *  QUALIFIED (I2c live attempt 2, owner-approved <= $2, run by the Director 2026-10-22 17:09Z at code 852a70c8; Fable ACCEPT):
 *  the qualificationRef is the sha256 of flyer-qualification-or-sonnet-4-6-us-flyer-live-2026-10-22T17-09-39-013Z.json (7/7,
 *  every case Amazon Bedrock, $0.062212 settled, profileHash a7d5d834…). TRACKED byte-identical copy with SHA256SUMS (also the
 *  failed attempt-1 report, 0/7 environment-only, $0): agent-framework/qualification/flyer/2026-10-22-852a70c8/. Pinning never
 *  changes the profile hash; verifyFlyerQualificationReport checks the report against this profile. */
export const IMAGE_PROFILES: Record<'sonnet', ImageProfile> = {
  sonnet: {...imageProfileFromHosted('or-sonnet-4-6-us-flyer', OPENROUTER_PROFILES.sonnet, FLYER_RULES_HASH),
    qualificationRef: 'sha256:9c6a0b704f6a195209ae11564b619e42b1b0e3cc499b1221f745e7b9567f8742'},
};
