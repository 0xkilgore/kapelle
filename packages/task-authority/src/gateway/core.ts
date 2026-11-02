import { randomUUID } from "node:crypto";
import { actions, reducer, utils } from "../../generated/task-authority/v1/index.js";
import type {
  TaskAuthorityAction,
  TaskAuthorityDocument,
} from "../../generated/task-authority/v1/gen/types.js";
import type { TaskSource } from "../../generated/task-authority/v1/gen/schema/types.js";
import { canonicalHash } from "./canonical.js";
import { ReceiptStore } from "./receipt-store.js";
import type {
  CachedTask,
  GatewayAction,
  GatewayPrincipal,
  MutationReceipt,
  PendingMutation,
  ReactorOperation,
  ReactorPort,
  ReactorTaskDocument,
} from "./types.js";
import { GatewayError } from "./types.js";

export type GatewayCommand = {
  type: TaskAuthorityAction["type"];
  input: Record<string, unknown>;
};

export type MutationRequest = {
  operationId: string;
  expectedRevision: number;
  taskId?: string;
  commands: GatewayCommand[];
};

const creators: Record<string, (input: never) => TaskAuthorityAction> = {
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
};

const CREATE_RECOVERY_SCAN_LIMIT = 100;

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new GatewayError(`${field} is required`, 400, "INVALID_REQUEST");
  if (normalized.length > 500) {
    throw new GatewayError(`${field} is too long`, 400, "INVALID_REQUEST");
  }
  return normalized;
}

function revision(document: ReactorTaskDocument): number {
  return document.operations?.global.length ?? document.header.revision.global ?? 0;
}

function asCached(document: ReactorTaskDocument, now: string): CachedTask {
  const taskId = document.state.global.id;
  if (!taskId || taskId !== document.header.id) {
    throw new GatewayError("task document identity invariant failed", 502, "REACTOR_INVARIANT");
  }
  return { taskId, revision: revision(document), state: document.state.global, updatedAt: now };
}

export class TaskGatewayCore {
  readonly #driveId: string;
  readonly #reactor: ReactorPort;
  readonly #receipts: ReceiptStore;
  readonly #clock: () => string;
  readonly #ownsDrive: () => boolean;
  #shuttingDown = false;

  constructor(options: {
    driveId: string;
    reactor: ReactorPort;
    receipts: ReceiptStore;
    ownsDrive: () => boolean;
    clock?: () => string;
  }) {
    this.#driveId = options.driveId;
    this.#reactor = options.reactor;
    this.#receipts = options.receipts;
    this.#ownsDrive = options.ownsDrive;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  async ready(): Promise<void> {
    this.#assertLocallyReady();
    await this.#reactor.probe(this.#driveId);
    this.#assertLocallyReady();
  }

  beginShutdown(): void {
    this.#shuttingDown = true;
  }

  #assertLocallyReady(): void {
    if (this.#shuttingDown) throw new Error("gateway is shutting down");
    if (!this.#ownsDrive()) throw new Error("task drive lock is not owned");
    this.#receipts.probe();
  }

  async mutate(
    principal: GatewayPrincipal,
    request: MutationRequest,
  ): Promise<MutationReceipt> {
    const operationId = required(request.operationId, "operationId");
    if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) {
      throw new GatewayError("expectedRevision must be a non-negative integer", 400, "INVALID_REQUEST");
    }
    if (request.commands.length < 1 || request.commands.length > 8) {
      throw new GatewayError("a mutation requires between 1 and 8 commands", 400, "INVALID_REQUEST");
    }
    const creating = request.commands[0]?.type === "CREATE_TASK";
    if (creating !== (request.taskId == null)) {
      throw new GatewayError("CREATE_TASK is the only mutation without a task id", 400, "INVALID_REQUEST");
    }
    if (creating && (request.commands.length !== 1 || request.expectedRevision !== 0)) {
      throw new GatewayError("task creation requires one command at revision zero", 400, "INVALID_REQUEST");
    }
    if (
      creating &&
      Object.prototype.hasOwnProperty.call(request.commands[0]?.input ?? {}, "id")
    ) {
      throw new GatewayError(
        "CREATE_TASK.id is server-managed",
        400,
        "INVALID_REQUEST",
      );
    }
    if (creating) {
      const input = request.commands[0]?.input ?? {};
      const source = input.source;
      if (
        typeof source !== "string" ||
        !principal.allowedSources.has(source as TaskSource)
      ) {
        throw new GatewayError(
          `source is not allowed for client ${principal.clientId}`,
          403,
          "FORBIDDEN_SOURCE",
        );
      }
      const ownerId = input.ownerId;
      if (
        typeof ownerId !== "string" ||
        (!principal.canAssignOwner && ownerId !== principal.actorId)
      ) {
        throw new GatewayError(
          "ownerId must match the authenticated actor",
          403,
          "FORBIDDEN_OWNER",
        );
      }
    }
    const canonicalCommands = request.commands.map((command) => ({
      type: command.type,
      input: Object.fromEntries(
        Object.entries(command.input).filter(([key]) => key !== "actorId" && key !== "occurredAt" && key !== "id"),
      ),
    }));
    const payloadHash = canonicalHash({
      actorId: principal.actorId,
      sourceClient: principal.clientId,
      taskId: request.taskId ?? null,
      commands: canonicalCommands,
    });
    const now = this.#clock();
    const pending: PendingMutation = {
      operationId,
      payloadHash,
      taskId: request.taskId ?? null,
      actionType: request.commands.map((command) => command.type).join("+"),
      expectedRevision: request.expectedRevision,
      actionIds: request.commands.map(() => randomUUID()),
      actionInputs: null,
      resultStateHash: null,
      intentName: creating ? `task-intent-${canonicalHash(operationId).slice(0, 24)}` : null,
      createdAt: now,
    };
    const wasPending = this.#receipts.find(operationId) != null;
    const reserved = this.#receipts.reserve(pending);
    if ("revision" in reserved) return { ...reserved, replayed: true };
    try {
      return await this.#continue(principal, reserved, request.commands, !wasPending);
    } catch (error) {
      if (reserved.taskId == null && error instanceof GatewayError && error.code === "MODEL_REJECTED") {
        // No Reactor mutation was attempted; the empty allocation is harmless but
        // the idempotency reservation must not trap a corrected request.
        this.#receipts.abandon(reserved.operationId);
      }
      throw error;
    }
  }

  async getTask(taskId: string): Promise<CachedTask> {
    try {
      const document = await this.#reactor.getDocument(taskId);
      const cached = asCached(document, this.#clock());
      this.#receipts.upsertTask(cached);
      return cached;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(`task not available: ${String(error)}`, 404, "NOT_FOUND");
    }
  }

  listTasks(limit: number, afterId?: string): { rows: CachedTask[]; nextCursor: string | null } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new GatewayError("limit must be between 1 and 100", 400, "INVALID_REQUEST");
    }
    const rows = this.#receipts.listTasks({ limit: limit + 1, afterId });
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    return {
      rows: selected,
      nextCursor: hasMore ? selected.at(-1)?.taskId ?? null : null,
    };
  }

  allCachedTasks(): CachedTask[] {
    return this.#receipts.allTasks();
  }

  async #continue(
    principal: GatewayPrincipal,
    pending: PendingMutation,
    commands: GatewayCommand[],
    newReservation: boolean,
  ): Promise<MutationReceipt> {
    let taskId = pending.taskId;
    if (!taskId) {
      taskId = newReservation
        ? null
        : await this.#reactor.findDocumentByName(
          this.#driveId,
          pending.intentName ?? "",
          CREATE_RECOVERY_SCAN_LIMIT,
        );
      if (!taskId) {
        taskId = await this.#reactor.createDocument({
          documentType: "kilgore/task",
          name: pending.intentName ?? "task-intent",
          driveId: this.#driveId,
        });
      }
      this.#receipts.attachTask(pending.operationId, taskId, this.#clock());
    }

    let attachedPending = { ...pending, taskId };

    let current = await this.#reactor.getDocument(taskId);
    const expectedResultRevision = attachedPending.expectedRevision + commands.length;
    if (attachedPending.resultStateHash) {
      const attempted = await this.#matchingOperations(taskId, attachedPending, commands);
      this.#throwIfReducerRejected(attachedPending, attempted, true);
    }
    if (
      attachedPending.resultStateHash &&
      revision(current) === expectedResultRevision &&
      canonicalHash(current.state.global) === attachedPending.resultStateHash
    ) {
      const recovered = await this.#matchingOperations(taskId, attachedPending, commands);
      this.#throwIfReducerRejected(attachedPending, recovered, true);
      if (recovered.some((operation) => operation == null)) {
        throw new GatewayError(
          "Reactor operation ledger is not yet consistent; retry with the same operationId",
          503,
          "UNCERTAIN_MUTATION",
        );
      }
      return this.#acceptRecovered(attachedPending, current);
    }
    if (revision(current) !== attachedPending.expectedRevision) {
      if (!attachedPending.resultStateHash) {
        if (
          attachedPending.expectedRevision === 0 &&
          commands[0]?.type === "CREATE_TASK"
        ) {
          const operations = await this.#reactor.getOperations(taskId, 0);
          const rejectedCreate = operations.find(
            (operation) => operation.index === 0 && operation.action.type === "CREATE_TASK",
          );
          if (rejectedCreate?.error) {
            throw new GatewayError(
              "a previous create attempt for this operationId was rejected by Reactor; use a new operationId",
              409,
              "CREATE_REJECTED_USE_NEW_OPERATION_ID",
            );
          }
        }
        this.#receipts.abandon(attachedPending.operationId);
        throw new GatewayError(
          `revision conflict: expected ${attachedPending.expectedRevision}, current ${revision(current)}`,
          409,
          "REVISION_CONFLICT",
        );
      }
      throw new GatewayError(
        `mutation outcome is uncertain at revision ${revision(current)}; retry with the same operationId after review`,
        503,
        "UNCERTAIN_MUTATION",
      );
    }

    const prepared = this.#buildActions(
      current,
      taskId,
      principal.actorId,
      attachedPending,
      commands,
    );
    this.#receipts.prepareResult(
      attachedPending.operationId,
      prepared.resultStateHash,
      prepared.actionInputs,
      this.#clock(),
    );
    attachedPending = {
      ...attachedPending,
      resultStateHash: prepared.resultStateHash,
      actionInputs: prepared.actionInputs,
    };
    await this.#reactor.addActions(taskId, prepared.actions);
    current = await this.#reactor.getDocument(taskId);
    const results = await this.#matchingOperations(taskId, attachedPending, commands);
    this.#throwIfReducerRejected(attachedPending, results, false);
    if (
      results.some((operation) => operation == null) ||
      revision(current) !== expectedResultRevision ||
      canonicalHash(current.state.global) !== attachedPending.resultStateHash
    ) {
      throw new GatewayError(
        "Reactor write result is uncertain; retry with the same operationId",
        503,
        "UNCERTAIN_MUTATION",
      );
    }
    return this.#acceptRecovered(attachedPending, current);
  }

  async #matchingOperations(
    taskId: string,
    pending: PendingMutation,
    commands: GatewayCommand[],
  ): Promise<Array<ReactorOperation | undefined>> {
    const operations = await this.#reactor.getOperations(taskId, pending.expectedRevision);
    const byIndex = new Map(operations.map((operation) => [operation.index, operation]));
    return commands.map((command, index) => {
      const operation = byIndex.get(pending.expectedRevision + index);
      const expectedInput = pending.actionInputs?.[index];
      return operation?.action.type === command.type &&
        (operation.error != null || (
          expectedInput != null &&
          canonicalHash(operation.action.input) === canonicalHash(expectedInput)
        ))
        ? operation
        : undefined;
    });
  }

  #throwIfReducerRejected(
    pending: PendingMutation,
    operations: Array<ReactorOperation | undefined>,
    recovery: boolean,
  ): void {
    const reducerError = operations.find((operation) => operation?.error)?.error;
    if (!reducerError) return;
    if (recovery && pending.expectedRevision === 0 && pending.actionType === "CREATE_TASK") {
      throw new GatewayError(
        "a previous create attempt for this operationId was rejected by Reactor; use a new operationId",
        409,
        "CREATE_REJECTED_USE_NEW_OPERATION_ID",
      );
    }
    throw new GatewayError(reducerError, 422, "REACTOR_MODEL_REJECTED");
  }

  #buildActions(
    document: ReactorTaskDocument,
    taskId: string,
    actorId: string,
    pending: PendingMutation,
    commands: GatewayCommand[],
  ): {
    actions: GatewayAction[];
    actionInputs: Array<Record<string, unknown>>;
    resultStateHash: string;
  } {
    let candidate = utils.createDocument({ global: structuredClone(document.state.global) });
    candidate.header.id = document.header.id;
    candidate.header.name = document.header.name;
    const gatewayActions = commands.map((command, index) => {
      const creator = creators[command.type];
      if (!creator) {
        throw new GatewayError(`unsupported action ${command.type}`, 400, "INVALID_REQUEST");
      }
      const callerInput = { ...command.input };
      delete callerInput.actorId;
      delete callerInput.occurredAt;
      if (command.type === "CREATE_TASK") callerInput.id = taskId;
      let action: GatewayAction;
      try {
        const generated = creator({
          ...callerInput,
          actorId,
          occurredAt: this.#clock(),
        } as never);
        action = {
          ...generated,
          id: pending.actionIds[index],
          timestampUtcMs: this.#clock(),
        } as GatewayAction;
        candidate = reducer(candidate, action);
      } catch (error) {
        this.#receipts.abandon(pending.operationId);
        throw new GatewayError(String(error), 422, "MODEL_REJECTED");
      }
      const last = candidate.operations.global.at(-1);
      if (last?.error) {
        this.#receipts.abandon(pending.operationId);
        throw new GatewayError(last.error, 422, "MODEL_REJECTED");
      }
      return action;
    });
    return {
      actions: gatewayActions,
      actionInputs: gatewayActions.map((action) =>
        JSON.parse(JSON.stringify(action.input)) as Record<string, unknown>,
      ),
      resultStateHash: canonicalHash(candidate.state.global),
    };
  }

  #acceptRecovered(
    pending: PendingMutation,
    document: ReactorTaskDocument,
  ): MutationReceipt {
    const cached = asCached(document, this.#clock());
    const receipt: MutationReceipt = {
      operationId: pending.operationId,
      taskId: cached.taskId,
      actionType: pending.actionType,
      revision: cached.revision,
      operationIndexes: Array.from(
        { length: pending.actionIds.length },
        (_, index) => pending.expectedRevision + index,
      ),
      payloadHash: pending.payloadHash,
      replayed: false,
    };
    this.#receipts.accept(receipt, cached);
    return receipt;
  }
}
