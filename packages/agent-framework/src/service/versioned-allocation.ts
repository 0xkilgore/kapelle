import type { Action, PHDocument } from "document-model";
import { digest } from "../command-boundary.js";
import { assert } from "../validation.js";

/** The qualified Reactor's drives.addFile pins toVersion=1. Keep its dependent
 * document/Drive batch choreography, using the reserved document's native
 * genesis actions so v2 remains v2. No raw endpoint is exposed to clients.
 * Action identities are deterministic across retries of this allocation.
 */
export async function addVersionedFile(
  client: { executeBatch(request: unknown): Promise<unknown> },
  addFile: (input: { id: string; name: string; documentType: string }) => Action,
  driveId: string,
  document: PHDocument,
) {
  const genesis = structuredClone(document.operations.document).map((op) => op.action);
  assert(
    genesis.length === 2 &&
      genesis[0].type === "CREATE_DOCUMENT" &&
      genesis[1].type === "UPGRADE_DOCUMENT",
    "Native allocation requires intact genesis actions",
  );
  const create = genesis[0].input as Record<string, unknown>,
    upgrade = genesis[1].input as Record<string, unknown>;
  assert(
    create.documentId === document.header.id &&
      upgrade.documentId === document.header.id &&
      upgrade.fromVersion === 0 &&
      upgrade.toVersion === document.state.document.version,
    "Native allocation model version differs from genesis",
  );
  create.name = document.header.name;
  const id = (purpose: string) =>
    digest({ documentId: document.header.id, driveId, purpose }).slice(7);
  const relationship: Action = {
    id: id("relationship"),
    type: "ADD_RELATIONSHIP",
    scope: "document",
    timestampUtcMs: genesis[0].timestampUtcMs,
    input: { sourceId: driveId, targetId: document.header.id, relationshipType: "child" },
  };
  const driveAction = addFile({
    id: document.header.id,
    name: document.header.name,
    documentType: document.header.documentType,
  });
  driveAction.id = id("drive-file");
  driveAction.timestampUtcMs = genesis[0].timestampUtcMs;
  return client.executeBatch({
    jobs: [
      {
        key: "document",
        documentId: document.header.id,
        scope: "document",
        branch: "main",
        actions: [...genesis, relationship],
        dependsOn: [],
      },
      {
        key: "drive",
        documentId: driveId,
        scope: "global",
        branch: "main",
        actions: [driveAction],
        dependsOn: ["document"],
      },
    ],
  });
}
