import { canonical, nativeModel } from "../command-boundary.js";
import { assert } from "../validation.js";
import type { ScopedStore } from "./native-backend.js";

/** Local scoped-Reactor extension. Ownership, initial model version and global
 * actions are read in one transaction. No projection or caller version is used.
 * Framework allocations start empty; in-place document upgrades/imported state
 * are deliberately unsupported until the full versioned spine replay is wired.
 */
export function withVersionedSnapshot(
  database: any,
  store: ScopedStore & { withTransaction(transaction: any): ScopedStore },
): ScopedStore {
  return new Proxy(store, {
    get(target, property) {
      if (property !== "readOwnedOperationSnapshot") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (input: Parameters<ScopedStore["readOwnedOperationSnapshot"]>[0]) =>
        database.transaction().execute(async (transaction: any) => {
          const snapshot = await store
            .withTransaction(transaction)
            .readOwnedOperationSnapshot(input);
          if (!snapshot) return null;
          const rows = await transaction
            .selectFrom("Operation")
            .select(["action", "error", "skip"])
            .where("documentId", "=", input.documentId)
            .where("scope", "=", "document")
            .where("branch", "=", "main")
            .orderBy("index", "asc")
            .limit(101)
            .execute();
          assert(rows.length <= 100, "Native document spine exceeds bound");
          const upgrades = rows.filter((row: any) => row.action.type === "UPGRADE_DOCUMENT");
          assert(
            upgrades.length === 1 && !upgrades[0].error && !upgrades[0].skip,
            "Native in-place upgrades require versioned spine replay",
          );
          const upgrade = upgrades[0].action.input;
          assert(
            upgrade.fromVersion === 0 && Number.isInteger(upgrade.toVersion),
            "Native initial model version unavailable",
          );
          const model = nativeModel(input.documentType, upgrade.toVersion);
          assert(
            upgrade.initialState &&
              upgrade.initialState.document?.version === upgrade.toVersion &&
              canonical(upgrade.initialState.global) ===
                canonical(model.utils.createState().global),
            "Native imported initial state requires versioned spine replay",
          );
          return { ...snapshot, initialModelVersion: upgrade.toVersion };
        });
    },
  });
}
