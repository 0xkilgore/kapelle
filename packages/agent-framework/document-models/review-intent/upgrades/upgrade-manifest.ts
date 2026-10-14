/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { UpgradeManifest } from "document-model";
import { v2 } from "./v2.js";
import { latestVersion, supportedVersions } from "./versions.js";

export const reviewIntentUpgradeManifest: UpgradeManifest<
  typeof supportedVersions
> = {
  documentType: "kapelle/review-intent",
  latestVersion,
  supportedVersions,
  upgrades: { v2 },
};
