// Chat content v1, WC-1 (Fable R-2): members/website/ is owned by the website content sync. Every other writer into the org
// folder (chat uploads and shares, approved notes, web and email intake, transcripts) and the draft artifact store call this
// before they write, so a symlinked or misconfigured target can never land inside the generated set. No imports beyond node
// (failure-labels.ts reads the labels without a cycle).
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const WEBSITE_CONTENT_ROOT = "members/website";
/** Package F (Fable H-8): the generated list of the site images a newsletter body may use (website/content.ts writes it). */
export const SITE_IMAGES_FILE = `${WEBSITE_CONTENT_ROOT}/site-images.md`;
export const WEBSITE_CONTENT_REASONS = ["website_content_too_large", "website_content_malformed", "website_content_failed", "website_content_path_reserved",
  "website_content_deadline", "website_content_refresh_cap"] as const;

/** The real path of `p`: the nearest existing ancestor resolved (symlinks followed), the rest appended. */
function real(p: string, depth = 0): string {
  if (existsSync(p)) return realpathSync(p);
  let link = false; try { link = lstatSync(p).isSymbolicLink(); } catch { /* absent */ }
  if (link && depth < 40) return real(resolve(dirname(p), readlinkSync(p)), depth + 1); // a dangling link: where it points
  const up = dirname(p);
  return up === p ? p : join(real(up, depth), basename(p));
}
/** True when `target` (absolute) resolves inside members/website or the sync's .website-next / .website-prev. */
export function inWebsiteRoot(folder: string, target: string) {
  const members = real(join(folder, "members")), t = real(target);
  return ["website", ".website-next", ".website-prev"].some((r) => { const rel = relative(join(members, r), t); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); });
}
/** Refuse a write whose target resolves into the website set (a fixed label; the error type is the caller's). */
export function refuseWebsiteRoot(folder: string, target: string, make: (label: string) => Error = (l) => new Error(l)) {
  if (inWebsiteRoot(folder, target)) throw make("website_content_path_reserved");
}
