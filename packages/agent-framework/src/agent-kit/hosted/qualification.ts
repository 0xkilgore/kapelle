// Fable F-8: verify that a qualification report attests THIS deployed profile. The report file's sha256 must be the
// profile's qualificationRef, the report must be a passing live run, and its profileHash must equal profileHash(profile)
// (computed without qualificationRef, so pinning never changes it). Reports written before F-8 recorded the hash over the
// profile with its `pending:` ref; exactly those listed below are accepted by re-deriving that legacy value, nothing else.
import {createHash} from 'node:crypto';
import {digest} from '../../content.js';
import {profileHash, type RuntimeProfile} from '../runtime-catalog.js';

/** Pre-F-8 reports (sha256 of the report file -> the pending ref the profile carried when it ran). */
export const LEGACY_QUALIFICATION_REPORTS: Readonly<Record<string, string>> = Object.freeze({
  'sha256:28cd463000c78f44fa0d090b29cc6d498874d69d43a3d467df0426799a9f3178': 'pending:or-sonnet-4-6-us', // attempt 5, c9e3b0bd, 2026-10-16
});

export type QualificationVerdict = {ok: true; profileId: string; profileHash: string; legacy: boolean} | {ok: false; reason: string};
export function verifyQualificationReport(profile: RuntimeProfile, reportBytes: Buffer): QualificationVerdict {
  const fileHash = 'sha256:' + createHash('sha256').update(reportBytes).digest('hex');
  if (profile.qualificationRef !== fileHash) return {ok: false, reason: 'qualification_ref_mismatch'};
  let r: any;
  try { r = JSON.parse(reportBytes.toString('utf8')); } catch { return {ok: false, reason: 'qualification_report_malformed'}; }
  if (r?.contract !== 'kapelle.hosted-qualification/v1' || r.mode !== 'live' || r.profileId !== profile.id) return {ok: false, reason: 'qualification_report_not_for_profile'};
  if (!(r.total > 0 && r.passed === r.total && r.failure === null && Array.isArray(r.requests?.nonConforming) && r.requests.nonConforming.length === 0))
    return {ok: false, reason: 'qualification_report_not_passing'};
  const current = profileHash(profile);
  if (r.profileHash === current) return {ok: true, profileId: profile.id, profileHash: current, legacy: false};
  const legacyRef = LEGACY_QUALIFICATION_REPORTS[fileHash];
  if (legacyRef && r.profileHash === digest({...profile, qualificationRef: legacyRef})) return {ok: true, profileId: profile.id, profileHash: current, legacy: true};
  return {ok: false, reason: 'qualification_profile_hash_mismatch'};
}
