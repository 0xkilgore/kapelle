import type { Action, PHDocument, UpgradeTransition } from "document-model";
import type { ReviewIntentPHState as StateV1 } from "document-models/review-intent/v1";
import type { ReviewIntentPHState as StateV2 } from "document-models/review-intent/v2";

function upgradeReducer(document: PHDocument<StateV1>, _action: Action): PHDocument<StateV2> {
  return {
    ...document,
    // Historical genesis bytes belong to v1; versioned replay must retain them.
    initialState: document.initialState as unknown as StateV2,
    state: {
      ...document.state,
      global: {
        ...document.state.global,
        execution: null,
        proposal: document.state.global.proposal
          ? { ...document.state.global.proposal, expiresAt: null }
          : null,
      },
    },
  };
}

export const v2: UpgradeTransition = {
  toVersion: 2,
  upgradeReducer,
  description:
    "Add explicit website publication and optional expiry; preserve legacy approval and effect evidence.",
};
