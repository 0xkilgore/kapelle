import {isTaskUrlKind, taskUrlCommands, type TaskUrlMutation} from "./taskUrlConnection";
import "server-only";
import { verifyNativeTaskOperationReceipt, type NativeTaskReceiptOnly } from "./nativeTaskOperationReceipt";

import {
  NativeTaskGatewayError,
  readBoundedResponse,
  record,
  taskAuthorityAuthorization,
  taskAuthorityOrigin,
} from "./nativeTaskIntake";

const REQUEST_TIMEOUT_MS = 12_000;

export class NativeTaskMutationRejectionError extends NativeTaskGatewayError {
  constructor(readonly stage: "preflight" | "reactor") {
    super(stage === "preflight"
      ? "Task Authority could not apply this change in the task’s current state. The saved change is kept; refresh the task details and retry after the issue is resolved."
      : "Task Authority rejected this saved operation after processing began. Some steps may have applied. Check its status before making another change.", stage === "preflight" ? "http_error" : "conflict");
  }
}


export type NativeTaskPriority = "HIGH" | "MED" | "LOW" | null;
export type NativeTaskStatus = "OPEN" | "BLOCKED" | "SNOOZED" | "DONE" | "ARCHIVED";
export type NativeTaskProjectedStatus = "OPEN" | "BLOCKED" | "SNOOZED";

export type NativeTaskEditPatch = {
  title?: string;
  dueAt?: string | null;
  priority?: NativeTaskPriority;
  projectId?: string | null;
  addLabels?: string[];
  removeLabels?: string[];
};

export type NativeTaskMutation = TaskUrlMutation
  | {
      kind: "edit";
      patch: NativeTaskEditPatch;
    }
  | { kind: "snooze"; snoozedUntil: string }
  | { kind: "postpone"; snoozedUntil: string }
  | { kind: "unsnooze" };

export type NativeTaskMutationReceipt = {
  taskId: string;
  revision: number;
  operationId: string;
  replayed: boolean;
  status: NativeTaskProjectedStatus;
  title: string;
  priority: NativeTaskPriority;
  dueAt: string | null;
  snoozedUntil: string | null;
  projectId: string | null;
  labels: string[];
};
export type NativeTaskMutationResult = NativeTaskMutationReceipt | NativeTaskReceiptOnly;

function endpoint(taskId: string, mutation: NativeTaskMutation): { url: string; method: "PATCH" | "POST" | "DELETE" } {
  const base = `${taskAuthorityOrigin()}/v1/tasks/${encodeURIComponent(taskId)}`;
  if (mutation.kind === "connect-url") return {url:base+"/connections/urls",method:"POST"};
  if (mutation.kind === "remove-url") return {url:base+"/connections/urls/"+encodeURIComponent(mutation.refId),method:"DELETE"};
  if (mutation.kind === "edit") return { url: base, method: "PATCH" };
  return { url: `${base}/${mutation.kind}`, method: "POST" };
}

function requestBody(
  input: { expectedRevision: number; operationId: string; mutation: NativeTaskMutation },
): Record<string, unknown> {
  const envelope = {
    operationId: input.operationId,
    expectedRevision: input.expectedRevision,
  };
  if (input.mutation.kind === "connect-url") return {...envelope,url:input.mutation.url};
  if (input.mutation.kind === "edit") return { ...envelope, patch: input.mutation.patch };
  if ((input.mutation.kind === "snooze" || input.mutation.kind === "postpone")) {
    return { ...envelope, snoozedUntil: input.mutation.snoozedUntil };
  }
  return envelope;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

function priority(value: unknown): NativeTaskPriority | undefined {
  return value === null || value === "HIGH" || value === "MED" || value === "LOW"
    ? value as NativeTaskPriority
    : undefined;
}

function status(value: unknown): NativeTaskStatus | undefined {
  return value === "OPEN" || value === "BLOCKED" || value === "SNOOZED" || value === "DONE" || value === "ARCHIVED"
    ? value
    : undefined;
}

function matchesMutation(task: Record<string, unknown>, mutation: NativeTaskMutation): boolean {
  if (mutation.kind === "edit") {
    const taskLabels = Array.isArray(task.labels) ? task.labels : [];
    return Object.entries(mutation.patch).every(([key, value]) => {
      if (key === "addLabels") return (value as string[]).every((label) => taskLabels.includes(label));
      if (key === "removeLabels") return (value as string[]).every((label) => !taskLabels.includes(label));
      return task[key] === value;
    });
  }
  if (mutation.kind === "postpone") return task.status === "SNOOZED" && task.snoozedUntil === mutation.snoozedUntil && task.dueAt === mutation.snoozedUntil;
  if (mutation.kind === "snooze") {
    return task.status === "SNOOZED" && task.snoozedUntil === mutation.snoozedUntil;
  }
  return task.status === "OPEN" && task.snoozedUntil === null;
}

function expectedActionType(mutation: NativeTaskMutation): string {
  if (isTaskUrlKind(mutation.kind)) return taskUrlCommands(mutation as TaskUrlMutation, "")[0].type;
  if (mutation.kind === "postpone") return "SET_DUE+SNOOZE_TASK";
  if (mutation.kind === "snooze") return "SNOOZE_TASK";
  if (mutation.kind === "unsnooze") return "UNSNOOZE_TASK";
  const actionByField: Record<string, string> = {
    title: "UPDATE_TITLE",
    dueAt: "SET_DUE",
    priority: "SET_PRIORITY",
    projectId: "SET_PROJECT",
  };
  return Object.entries((mutation as {kind:"edit";patch:NativeTaskEditPatch}).patch).flatMap(([key, value]) => {
    if (key === "addLabels") return (value as string[]).map(() => "ADD_LABEL");
    if (key === "removeLabels") return (value as string[]).map(() => "REMOVE_LABEL");
    return actionByField[key];
  }).join("+");
}

export function nativeTaskMutationCommandCount(mutation: NativeTaskMutation): number {
  if (mutation.kind !== "edit") return mutation.kind === "postpone" ? 2 : 1;
  return Object.entries(mutation.patch).reduce(
    (count, [key, value]) => count + (key === "addLabels" || key === "removeLabels" ? (value as string[]).length : 1),
    0,
  );
}

function expectedResultStatus(
  current: NativeTaskProjectedStatus,
  mutation: NativeTaskMutation,
): NativeTaskProjectedStatus {
  if (mutation.kind === "snooze" || mutation.kind === "postpone") return "SNOOZED";
  if (mutation.kind === "unsnooze") return "OPEN";
  return current;
}

export async function mutateNativeTask(
  input: {
    taskId: string;
    expectedRevision: number;
    operationId: string;
    mutation: NativeTaskMutation;
    expectedStatus: NativeTaskProjectedStatus;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<NativeTaskMutationResult> {
  const target = endpoint(input.taskId, input.mutation);
  const authorization = taskAuthorityAuthorization();

  let response: Response;
  try {
    response = await fetchImpl(target.url, {
      method: target.method,
      headers: {
        accept: "application/json",
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody(input)),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new NativeTaskGatewayError("Task Authority timed out. Retry this change.", "timeout");
    }
    throw new NativeTaskGatewayError("Task Authority could not be reached. Retry this change.", "http_error");
  }

  let raw: string;
  try {
    raw = await readBoundedResponse(response);
  } catch (error) {
    if (error instanceof NativeTaskGatewayError) throw error;
    throw new NativeTaskGatewayError("Task Authority returned an unreadable response.", "invalid_contract");
  }
  if (!response.ok) {
    let failure: Record<string, unknown> | null = null;
    try { failure = record(record(JSON.parse(raw))?.error); } catch { /* An unreadable rejection is still uncertain. */ }
    if (response.status === 422 && failure?.code === "MODEL_REJECTED") throw new NativeTaskMutationRejectionError("preflight");
    if (response.status === 422 && failure?.code === "REACTOR_MODEL_REJECTED") throw new NativeTaskMutationRejectionError("reactor");
    if (response.status === 409) {
      throw new NativeTaskGatewayError("This task changed after the snapshot was fetched. Refresh and try again.", "conflict");
    }
    if (response.status === 404) {
      throw new NativeTaskGatewayError("This task is no longer available in Task Authority.", "http_error");
    }
    throw new NativeTaskGatewayError(`Task Authority rejected the change (HTTP ${response.status}).`, "http_error");
  }

  let payload: Record<string, unknown> | null;
  try {
    payload = record(JSON.parse(raw));
  } catch {
    payload = null;
  }
  const authorityReceipt = record(payload?.receipt);
  const task = record(payload?.task);
  if (isTaskUrlKind(input.mutation.kind)) return {...verifyNativeTaskOperationReceipt(authorityReceipt,input),acknowledgedOnly:true};
  if (!task) {
    if (payload?.taskState === "not_read" && payload.task === null) return { ...verifyNativeTaskOperationReceipt(authorityReceipt, input), acknowledgedOnly: true };
    throw new NativeTaskGatewayError("Task Authority returned an invalid mutation receipt.", "invalid_contract");
  }
  const taskId = typeof task?.id === "string" ? task.id : null;
  const commandCount = nativeTaskMutationCommandCount(input.mutation);
  const revision = typeof task?.revision === "number" && Number.isSafeInteger(task.revision)
    && task.revision === input.expectedRevision + commandCount
    ? task.revision
    : null;
  const receiptRevision = typeof authorityReceipt?.revision === "number" && Number.isSafeInteger(authorityReceipt.revision)
    ? authorityReceipt.revision
    : null;
  const receiptOperationId = typeof authorityReceipt?.operationId === "string" ? authorityReceipt.operationId : null;
  const receiptTaskId = typeof authorityReceipt?.taskId === "string" ? authorityReceipt.taskId : null;
  const receiptActionType = typeof authorityReceipt?.actionType === "string" ? authorityReceipt.actionType : null;
  const receiptOperationIndexes = Array.isArray(authorityReceipt?.operationIndexes)
    ? authorityReceipt.operationIndexes
    : null;
  const receiptPayloadHash = typeof authorityReceipt?.payloadHash === "string" ? authorityReceipt.payloadHash : null;
  const replayed = typeof authorityReceipt?.replayed === "boolean" ? authorityReceipt.replayed : null;
  const taskStatus = status(task?.status);
  const title = typeof task?.title === "string" && [...task.title].length > 0 && [...task.title].length <= 500
    ? task.title
    : null;
  const taskPriority = priority(task?.priority);
  const dueAt = nullableString(task?.dueAt);
  const snoozedUntil = nullableString(task?.snoozedUntil);
  const projectId = nullableString(task?.projectId);
  const labels = Array.isArray(task?.labels)
    && task.labels.length <= 8
    && task.labels.every((label) => typeof label === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(label))
    && new Set(task.labels).size === task.labels.length
    ? task.labels as string[]
    : null;

  if (
    taskId !== input.taskId
    || revision === null
    || receiptOperationId !== input.operationId
    || receiptTaskId !== input.taskId
    || receiptRevision !== revision
    || receiptActionType !== expectedActionType(input.mutation)
    || receiptOperationIndexes === null
    || receiptOperationIndexes.length !== commandCount
    || !receiptOperationIndexes.every((value, index) => value === input.expectedRevision + index)
    || receiptPayloadHash === null
    || !/^[0-9a-f]{64}$/u.test(receiptPayloadHash)
    || replayed === null
    || taskStatus !== expectedResultStatus(input.expectedStatus, input.mutation)
    || title === null
    || taskPriority === undefined
    || dueAt === undefined
    || snoozedUntil === undefined
    || projectId === undefined
    || labels === null
    || !matchesMutation(task, input.mutation)
  ) {
    throw new NativeTaskGatewayError("Task Authority returned an invalid mutation receipt.", "invalid_contract");
  }

  return {
    taskId,
    revision,
    operationId: input.operationId,
    replayed,
    status: expectedResultStatus(input.expectedStatus, input.mutation),
    title,
    priority: taskPriority,
    dueAt,
    snoozedUntil,
    projectId,
    labels: [...labels],
  };
}
