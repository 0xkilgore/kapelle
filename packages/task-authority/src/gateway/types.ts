import type {
  TaskAuthorityAction,
  TaskAuthorityDocument,
  TaskAuthorityGlobalState,
} from "../../generated/task-authority/v1/gen/types.js";
import type { TaskSource } from "../../generated/task-authority/v1/gen/schema/types.js";

export type GatewayScope =
  | "task.read"
  | "task.create"
  | "task.update"
  | "task.complete"
  | "projection.read";

export type GatewayPrincipal = {
  clientId: string;
  actorId: string;
  scopes: ReadonlySet<GatewayScope>;
  allowedSources: ReadonlySet<TaskSource>;
  canAssignOwner: boolean;
};

export type GatewayAction = TaskAuthorityAction & {
  id: string;
  timestampUtcMs: string;
};

export type ReactorTaskDocument = Pick<TaskAuthorityDocument, "header" | "state"> & {
  operations?: TaskAuthorityDocument["operations"];
};

export type ReactorOperation = {
  id: string | null;
  index: number;
  error: string | null;
  action: { id: string; type: string; input: Record<string, unknown> };
};

export type ReactorPort = {
  probe(driveId: string): Promise<void>;
  createDocument(input: {
    documentType: "kilgore/task";
    name: string;
    driveId: string;
  }): Promise<string>;
  findDocumentByName(
    driveId: string,
    name: string,
    maxCandidates: number,
  ): Promise<string | null>;
  getDocument(id: string): Promise<ReactorTaskDocument>;
  getOperations(id: string, sinceRevision?: number): Promise<ReactorOperation[]>;
  addActions(documentId: string, actions: GatewayAction[]): Promise<void>;
};

export type MutationReceipt = {
  operationId: string;
  taskId: string;
  actionType: string;
  revision: number;
  operationIndexes: number[];
  payloadHash: string;
  replayed: boolean;
};

export type PendingMutation = {
  operationId: string;
  payloadHash: string;
  taskId: string | null;
  actionType: string;
  expectedRevision: number;
  actionIds: string[];
  actionInputs: Array<Record<string, unknown>> | null;
  resultStateHash: string | null;
  intentName: string | null;
  createdAt: string;
};

export type CachedTask = {
  taskId: string;
  revision: number;
  state: TaskAuthorityGlobalState;
  updatedAt: string;
};

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}
