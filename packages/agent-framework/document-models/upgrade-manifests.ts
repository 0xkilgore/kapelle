/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { UpgradeManifest } from "document-model";
import { agentDefinitionUpgradeManifest } from "document-models/agent-definition/upgrades";
import { agentInstanceUpgradeManifest } from "document-models/agent-instance/upgrades";
import { dispatchUpgradeManifest } from "document-models/dispatch/upgrades";
import { reviewIntentUpgradeManifest } from "document-models/review-intent/upgrades";

export const upgradeManifests: UpgradeManifest<readonly number[]>[] = [
  agentDefinitionUpgradeManifest,
  agentInstanceUpgradeManifest,
  dispatchUpgradeManifest,
  reviewIntentUpgradeManifest,
];
