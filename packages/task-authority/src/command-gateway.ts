import { createHash } from "node:crypto";
import type {
  TaskAuthorityAction,
  TaskAuthorityDocument,
} from "document-models/task-authority/v1";
import {
  actions,
  reducer,
  utils,
} from "document-models/task-authority/v1";

export type TaskCommand = {
  type: TaskAuthorityAction["type"];
  input: Record<string, unknown>;
};

export type CommandEnvelope = {
  operationId: string;
  actorId: string;
  sourceClient: string;
  expectedRevision: number;
  command: TaskCommand;
};

export type OperationReceipt = {
  operationId: string;
  taskId: string | null;
  actionType: TaskAuthorityAction["type"];
  revision: number;
  operationIndex: number;
  payloadHash: string;
};

type StoredReceipt = OperationReceipt;

export type GatewaySnapshot = {
  document: TaskAuthorityDocument;
  receipts: OperationReceipt[];
};

const actionCreators: Record<string, (input: never) => TaskAuthorityAction> = {
  CREATE_TASK: actions.createTask,
  UPDATE_TITLE: actions.updateTitle,
  UPDATE_BODY: actions.updateBody,
  SET_PROJECT: actions.setProject,
  SET_DUE: actions.setDue,
  SET_PRIORITY: actions.setPriority,
  SET_ASSIGNEE: actions.setAssignee,
  COMPLETE_TASK: actions.completeTask,
  REOPEN_TASK: actions.reopenTask,
  SNOOZE_TASK: actions.snoozeTask,
  UNSNOOZE_TASK: actions.unsnoozeTask,
  BLOCK_TASK: actions.blockTask,
  UNBLOCK_TASK: actions.unblockTask,
  ARCHIVE_TASK: actions.archiveTask,
  ADD_LABEL: actions.addLabel,
  REMOVE_LABEL: actions.removeLabel,
  ADD_COMMENT: actions.addComment,
  ADD_DEPENDENCY: actions.addDependency,
  REMOVE_DEPENDENCY: actions.removeDependency,
  ADD_EXTERNAL_REF: actions.addExternalRef,
  REMOVE_EXTERNAL_REF: actions.removeExternalRef,
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(envelope: CommandEnvelope): string {
  const { actorId, sourceClient, command } = envelope;
  const input = { ...command.input };
  delete input.actorId;
  delete input.occurredAt;
  return createHash("sha256")
    .update(canonical({ actorId, sourceClient, type: command.type, input }))
    .digest("hex");
}

function revisionOf(document: TaskAuthorityDocument): number {
  return document.operations.global.length;
}

function assertCanonicalIdentity(document: TaskAuthorityDocument): void {
  const taskId = document.state.global.id;
  if (taskId != null && taskId !== document.header.id) {
    throw new Error("task state identity does not match the Reactor document PHID");
  }
}

function requiredEnvelopeText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field}: required`);
  if (normalized.length > 500) throw new Error(`${field}: too long`);
  return normalized;
}

export class TaskCommandGateway {
  #document: TaskAuthorityDocument;
  #receipts = new Map<string, StoredReceipt>();
  #clock: () => string;
  #authorizations: Map<string, Set<string>>;

  constructor(options?: {
    document?: TaskAuthorityDocument;
    clock?: () => string;
    snapshot?: GatewaySnapshot;
    authorizations?: Record<string, readonly string[]>;
  }) {
    this.#document = structuredClone(
      options?.snapshot?.document ?? options?.document ?? utils.createDocument(),
    );
    assertCanonicalIdentity(this.#document);
    for (const receipt of options?.snapshot?.receipts ?? []) {
      this.#receipts.set(receipt.operationId, structuredClone(receipt));
    }
    this.#clock = options?.clock ?? (() => new Date().toISOString());
    this.#authorizations = new Map(
      Object.entries(options?.authorizations ?? {}).map(([client, actors]) => [
        client,
        new Set(actors),
      ]),
    );
  }

  get document(): TaskAuthorityDocument {
    return structuredClone(this.#document);
  }

  snapshot(): GatewaySnapshot {
    return {
      document: structuredClone(this.#document),
      receipts: [...this.#receipts.values()].map((receipt) => structuredClone(receipt)),
    };
  }

  execute(envelope: CommandEnvelope): OperationReceipt {
    const operationId = requiredEnvelopeText(envelope.operationId, "operationId");
    const actorId = requiredEnvelopeText(envelope.actorId, "actorId");
    const sourceClient = requiredEnvelopeText(envelope.sourceClient, "sourceClient");
    if (!this.#authorizations.get(sourceClient)?.has(actorId)) {
      throw new Error("unauthorized client and actor combination");
    }
    const hash = payloadHash({ ...envelope, operationId, actorId, sourceClient });
    const existing = this.#receipts.get(operationId);
    if (existing) {
      if (existing.payloadHash !== hash) {
        throw new Error("operationId already used for a different canonical payload");
      }
      return structuredClone(existing);
    }

    const currentRevision = revisionOf(this.#document);
    if (envelope.expectedRevision !== currentRevision) {
      throw new Error(
        `revision conflict: expected ${envelope.expectedRevision}, current ${currentRevision}`,
      );
    }

    const creator = actionCreators[envelope.command.type];
    if (!creator) throw new Error(`unsupported action type: ${envelope.command.type}`);
    const callerInput = { ...envelope.command.input };
    delete callerInput.actorId;
    delete callerInput.occurredAt;
    if (
      envelope.command.type === "CREATE_TASK" &&
      Object.prototype.hasOwnProperty.call(callerInput, "id")
    ) {
      throw new Error("CREATE_TASK.id is server-managed");
    }
    if (envelope.command.type === "CREATE_TASK") {
      callerInput.id = this.#document.header.id;
    }
    const action = creator({
      ...callerInput,
      actorId,
      occurredAt: this.#clock(),
    } as never);
    const nextDocument = reducer(this.#document, action);
    const lastOperation = nextDocument.operations.global.at(-1);
    if (lastOperation?.error) {
      throw new Error(lastOperation.error);
    }
    assertCanonicalIdentity(nextDocument);
    const receipt: OperationReceipt = {
      operationId,
      taskId: nextDocument.state.global.id ?? null,
      actionType: envelope.command.type,
      revision: revisionOf(nextDocument),
      operationIndex: nextDocument.operations.global.length - 1,
      payloadHash: hash,
    };
    this.#document = nextDocument;
    this.#receipts.set(operationId, receipt);
    return structuredClone(receipt);
  }
}
