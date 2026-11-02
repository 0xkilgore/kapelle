import {isTaskUrlKind,taskUrlCommands,type TaskUrlMutation} from "./taskUrlConnection";
import "server-only";
import { NativeTaskGatewayError, readBoundedResponse, record, taskAuthorityAuthorization, taskAuthorityOrigin } from "./nativeTaskIntake";
import type { NativeTaskMutation } from "./nativeTaskMutation";

export type NativeTaskOperation = NativeTaskMutation | { kind: "complete" };
export type NativeTaskAcceptedReceipt = { taskId: string; operationId: string; revision: number; replayed: boolean };
export type NativeTaskReceiptOnly = NativeTaskAcceptedReceipt & { acknowledgedOnly: true };
export type NativeTaskOperationIdentity = { taskId: string; operationId: string; expectedRevision: number; mutation: NativeTaskOperation };

export function nativeTaskOperationCommands(mutation: NativeTaskOperation, operationId = ""): { type: string; input: Record<string, unknown> }[] {
  if (isTaskUrlKind(mutation.kind)) return taskUrlCommands(mutation as TaskUrlMutation, operationId);
  if (mutation.kind === "complete") return [{ type: "COMPLETE_TASK", input: {} }];
  if (mutation.kind === "unsnooze") return [{ type: "UNSNOOZE_TASK", input: {} }];
  if (mutation.kind === "snooze") return [{ type: "SNOOZE_TASK", input: { snoozedUntil: mutation.snoozedUntil } }];
  if (mutation.kind === "postpone") return [{ type: "SET_DUE", input: { dueAt: mutation.snoozedUntil } }, { type: "SNOOZE_TASK", input: { snoozedUntil: mutation.snoozedUntil } }];
  const actions: Record<string, string> = { title: "UPDATE_TITLE", dueAt: "SET_DUE", priority: "SET_PRIORITY", projectId: "SET_PROJECT" };
  return Object.entries((mutation as {kind:"edit";patch:Record<string,unknown>}).patch).flatMap(([key, value]) => key === "addLabels" || key === "removeLabels"
    ? (value as string[]).map((label) => ({ type: key === "addLabels" ? "ADD_LABEL" : "REMOVE_LABEL", input: { label } }))
    : [{ type: actions[key], input: { [key]: value } }]);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

export function verifyNativeTaskOperationReceipt(value: unknown, identity: NativeTaskOperationIdentity): NativeTaskAcceptedReceipt {
  const receipt = record(value);
  const commands = nativeTaskOperationCommands(identity.mutation, identity.operationId);
  if (!receipt || receipt.taskId !== identity.taskId || receipt.operationId !== identity.operationId
    || !Number.isSafeInteger(receipt.revision) || receipt.revision !== identity.expectedRevision + commands.length
    || receipt.actionType !== commands.map((command) => command.type).join("+")
    || !Array.isArray(receipt.operationIndexes) || receipt.operationIndexes.length !== commands.length
    || !receipt.operationIndexes.every((index, offset) => index === identity.expectedRevision + offset)
    || typeof receipt.payloadHash !== "string" || !/^[0-9a-f]{64}$/u.test(receipt.payloadHash)
    || typeof receipt.replayed !== "boolean") throw new NativeTaskGatewayError("Task Authority returned an invalid operation receipt.", "invalid_contract");
  return { taskId: identity.taskId, operationId: identity.operationId, revision: receipt.revision as number, replayed: receipt.replayed };
}

export type NativeTaskOperationOutcome =
  | { status: "accepted"; receipt: NativeTaskReceiptOnly }
  | { status: "pending" | "not_found" | "rejected"; taskId: string; operationId: string; expectedRevision: number };

/** Reads exact operation evidence only. A rejection or missing row never proves zero effects. */
export async function readNativeTaskOperationOutcome(identity: NativeTaskOperationIdentity, fetchImpl: typeof fetch = fetch): Promise<NativeTaskOperationOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`${taskAuthorityOrigin()}/v1/tasks/${encodeURIComponent(identity.taskId)}/operations/${encodeURIComponent(identity.operationId)}`, {
      headers: { accept: "application/json", authorization: taskAuthorityAuthorization() }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(6000),
    });
  } catch (error) {
    if (error instanceof NativeTaskGatewayError) throw error;
    throw new NativeTaskGatewayError("The saved change could not be checked. Its retry is still saved.", "timeout");
  }
  let payload: Record<string, unknown> | null;
  try { payload = record(JSON.parse(await readBoundedResponse(response))); }
  catch { throw new NativeTaskGatewayError("Task Authority returned unreadable operation evidence. The retry is still saved.", "invalid_contract"); }
  const bound = { taskId: identity.taskId, operationId: identity.operationId, expectedRevision: identity.expectedRevision };
  if (response.status === 404 && record(payload?.error)?.code === "OPERATION_NOT_FOUND") return { status: "not_found", ...bound };
  if (response.status === 202 && payload?.status === "PENDING" && payload.taskId === identity.taskId && payload.operationId === identity.operationId) {
    if ((payload.expectedRevision !== undefined && payload.expectedRevision !== identity.expectedRevision)
      || (payload.commands !== undefined && JSON.stringify(canonical(payload.commands)) !== JSON.stringify(canonical(nativeTaskOperationCommands(identity.mutation, identity.operationId))))) throw new NativeTaskGatewayError("The operation evidence did not match the saved change. Its retry is still saved.", "invalid_contract");
    return { status: "pending", ...bound };
  }
  if (response.status === 409 && payload?.status === "REJECTED" && payload.taskId === identity.taskId && payload.operationId === identity.operationId && payload.expectedRevision === identity.expectedRevision) {
    if (payload.commands !== undefined && JSON.stringify(canonical(payload.commands)) !== JSON.stringify(canonical(nativeTaskOperationCommands(identity.mutation, identity.operationId)))) throw new NativeTaskGatewayError("The operation evidence did not match the saved change. Its retry is still saved.", "invalid_contract");
    return { status: "rejected", ...bound };
  }
  if (response.status !== 200 || payload?.status !== "ACCEPTED") throw new NativeTaskGatewayError("The saved change could not be confirmed. Its retry is still saved.", "http_error");
  if (payload.expectedRevision !== identity.expectedRevision
    || JSON.stringify(canonical(payload.commands)) !== JSON.stringify(canonical(nativeTaskOperationCommands(identity.mutation, identity.operationId)))) {
    throw new NativeTaskGatewayError("The operation evidence did not match the saved change. Its retry is still saved.", "invalid_contract");
  }
  return { status: "accepted", receipt: { ...verifyNativeTaskOperationReceipt(payload.receipt, identity), acknowledgedOnly: true } };
}

/** Confirms historical acceptance without reading or changing current task state. */
export async function readNativeTaskOperationReceipt(identity: NativeTaskOperationIdentity, fetchImpl: typeof fetch = fetch): Promise<NativeTaskReceiptOnly | null> {
  const outcome = await readNativeTaskOperationOutcome(identity, fetchImpl);
  if (outcome.status === "accepted") return outcome.receipt;
  if (outcome.status === "not_found") return null;
  if (outcome.status === "rejected") throw new NativeTaskGatewayError("Task Authority rejected this saved operation. Some steps may have applied. Check its status before making another change.", "conflict");
  throw new NativeTaskGatewayError("The saved change is still awaiting confirmation. Retry to check it again.", "timeout");
}
