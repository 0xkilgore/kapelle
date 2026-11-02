import "server-only";
import { chicagoTaskDate } from "./nativeTaskDates";
import { verifyNativeTaskOperationReceipt } from "./nativeTaskOperationReceipt";

const MAX_REQUEST_CHARACTERS = 2_000;
const MAX_TITLE_CHARACTERS = 500;
const MAX_GATEWAY_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const CREATE_PATTERNS = [
  /^(?:please\s+)?create\s+(?:a\s+)?task\s+to\s+(.+)$/iu,
  /^(?:please\s+)?add\s+(?:a\s+)?task\s+to\s+(.+)$/iu,
] as const;

export type NativeTaskPreview = {
  title: string;
};

export type NativeTaskOrganization = {
  projectId: string | null;
  labels: string[];
};

export type NativeTaskRelationship = {
  source: "HUMAN";
  sourceRef: string | null;
};

const PERSONAL_CRM_CONTACT_REF = /^personalcrm:contact:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

export type NativeTaskCreateReceipt = {
  taskId: string;
  revision: number;
  operationId: string;
};

export type NativeTaskCompleteReceipt = NativeTaskCreateReceipt & {
  status: "DONE";
  replayed: boolean;
};

export class NativeTaskGatewayError extends Error {
  constructor(
    message: string,
    readonly kind: "not_configured" | "endpoint_not_allowed" | "credential_missing" | "timeout" | "conflict" | "http_error" | "invalid_contract",
  ) {
    super(message);
  }
}

function capitalize(value: string): string {
  const [first, ...rest] = Array.from(value);
  return first ? `${first.toLocaleUpperCase("en-US")}${rest.join("")}` : value;
}

export function previewNativeTaskRequest(text: string): NativeTaskPreview {
  const normalized = text.normalize("NFKC").trim();
  if (!normalized) throw new Error("Enter a task first.");
  if ([...normalized].length > MAX_REQUEST_CHARACTERS) throw new Error("That task is too long.");
  if (/[\p{Cc}\p{Cf}]/u.test(normalized)) throw new Error("Use a single printable line for the task request.");

  let rawTitle = normalized;
  for (const pattern of CREATE_PATTERNS) {
    const match = normalized.match(pattern);
    if (!match) continue;
    rawTitle = match[1]?.trim() ?? "";
    break;
  }

  rawTitle = rawTitle.replace(/[.]$/u, "").trim();
  if (!rawTitle) throw new Error("The task needs a title.");
  const title = capitalize(rawTitle);
  if (title.length > MAX_TITLE_CHARACTERS) throw new Error("The task title is too long.");
  return { title };
}

export function normalizeNativeTaskOrganization(
  projectIdValue: unknown,
  labelsValue: unknown,
): NativeTaskOrganization {
  let projectId: string | null = null;
  if (projectIdValue !== undefined && projectIdValue !== null) {
    if (typeof projectIdValue !== "string") throw new Error("Project must be text.");
    const normalized = projectIdValue.normalize("NFKC").trim();
    if (normalized.length > 500 || /[\p{Cc}\p{Cf}]/u.test(normalized)) throw new Error("Project is invalid.");
    projectId = normalized || null;
  }
  if (labelsValue === undefined) return { projectId, labels: [] };
  if (!Array.isArray(labelsValue) || labelsValue.length > 8) throw new Error("Use at most 8 tags.");
  const labels = labelsValue.map((value) => {
    if (typeof value !== "string") throw new Error("Tags must be text.");
    const normalized = value.normalize("NFKC").trim().toLowerCase()
      .replace(/^#+/u, "")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
    if (!normalized || normalized.length > 64) throw new Error("A tag is invalid.");
    return normalized;
  });
  if (new Set(labels).size !== labels.length) throw new Error("Remove duplicate tags.");
  return { projectId, labels };
}

export function normalizeNativeTaskRelationship(value: unknown): NativeTaskRelationship {
  if (value === undefined || value === null || value === "") return { source: "HUMAN", sourceRef: null };
  if (typeof value !== "string") throw new Error("Relationship reference is invalid.");
  const sourceRef = value.normalize("NFKC").trim();
  if (!PERSONAL_CRM_CONTACT_REF.test(sourceRef)) throw new Error("Relationship reference is invalid.");
  // This is a human commitment made in People; CRM supplies its context link.
  return { source: "HUMAN", sourceRef: sourceRef.toLowerCase() };
}

export function todayTaskDueAt(now = new Date()): string {
  return `${chicagoTaskDate(now)}T18:00:00.000Z`;
}

export function taskDueAtForLocalDate(value: unknown, now = new Date()): string {
  if (value === undefined || value === null || value === "") return todayTaskDueAt(now);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error("Choose a valid due date.");
  }
  const dueAt = `${value}T18:00:00.000Z`;
  const parsed = new Date(dueAt);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("Choose a valid due date.");
  }
  return dueAt;
}

export function taskAuthorityOrigin(): string {
  const configured = process.env.KAPELLE_TASK_AUTHORITY_URL?.trim();
  if (!configured) {
    throw new NativeTaskGatewayError("Task Authority is not configured.", "not_configured");
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new NativeTaskGatewayError("Task Authority endpoint is invalid.", "endpoint_not_allowed");
  }

  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || (url.pathname !== "/" && url.pathname !== "")
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new NativeTaskGatewayError(
      "Task creation requires an exact loopback Task Authority endpoint.",
      "endpoint_not_allowed",
    );
  }

  return url.origin;
}

function taskAuthorityCreateEndpoint(): string {
  return `${taskAuthorityOrigin()}/v1/tasks`;
}

function taskAuthorityCompleteEndpoint(taskId: string): string {
  return `${taskAuthorityOrigin()}/v1/tasks/${encodeURIComponent(taskId)}/complete`;
}

export function taskAuthorityAuthorization(): string {
  const token = process.env.KAPELLE_TASK_AUTHORITY_TOKEN?.trim();
  if (!token || token.length < 24 || /\s/.test(token)) {
    throw new NativeTaskGatewayError("Task Authority credentials are unavailable.", "credential_missing");
  }
  return `Bearer ${token}`;
}

export async function readBoundedResponse(response: Response, maximumBytes = MAX_GATEWAY_RESPONSE_BYTES): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new NativeTaskGatewayError("Task Authority returned an oversized response.", "invalid_contract");
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      throw new NativeTaskGatewayError("Task Authority returned an oversized response.", "invalid_contract");
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw new NativeTaskGatewayError("Task Authority returned an oversized response.", "invalid_contract");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function createNativeTask(
  input: { title: string; operationId: string; projectId: string | null; labels: string[]; dueAt: string | null; relationship?: NativeTaskRelationship; timeoutMs?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<NativeTaskCreateReceipt> {
  const endpoint = taskAuthorityCreateEndpoint();
  const authorization = taskAuthorityAuthorization();

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operationId: input.operationId,
        expectedRevision: 0,
        title: input.title,
        projectId: input.projectId,
        labels: input.labels,
        dueAt: input.dueAt,
        source: input.relationship?.source ?? "HUMAN",
        ...(input.relationship?.sourceRef ? { sourceRef: input.relationship.sourceRef } : {}),
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(15_000, Math.max(REQUEST_TIMEOUT_MS, input.timeoutMs ?? REQUEST_TIMEOUT_MS))),
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new NativeTaskGatewayError("Task Authority timed out.", "timeout");
    }
    throw new NativeTaskGatewayError("Task Authority could not be reached.", "http_error");
  }

  let raw: string;
  try {
    raw = await readBoundedResponse(response);
  } catch (error) {
    if (error instanceof NativeTaskGatewayError) throw error;
    throw new NativeTaskGatewayError("Task Authority returned an unreadable response.", "invalid_contract");
  }
  if (!response.ok) {
    throw new NativeTaskGatewayError(`Task Authority rejected the request (HTTP ${response.status}).`, "http_error");
  }

  let payload: Record<string, unknown> | null;
  try {
    payload = record(JSON.parse(raw));
  } catch {
    payload = null;
  }
  if (response.status === 202) throw new NativeTaskGatewayError("Task creation is still pending. Retry the saved request.", "invalid_contract");
  return parseNativeTaskCreateReceipt(payload, input);
}

export function parseNativeTaskCreateReceipt(value: unknown, input: { operationId: string; relationship?: NativeTaskRelationship }): NativeTaskCreateReceipt {
  const payload = record(value);
  // Allocation is not creation: only the accepted CREATE operation can
  // confirm an add. A revision-zero document must remain an uncertain retry.
  const receipt = record(payload?.receipt);
  if (!receipt || receipt.operationId !== input.operationId
    || typeof receipt.taskId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(receipt.taskId)
    || receipt.actionType !== "CREATE_TASK" || receipt.revision !== 1
    || !Array.isArray(receipt.operationIndexes) || receipt.operationIndexes.length !== 1 || receipt.operationIndexes[0] !== 0
    || typeof receipt.payloadHash !== "string" || !/^[0-9a-f]{64}$/u.test(receipt.payloadHash) || typeof receipt.replayed !== "boolean") {
    throw new NativeTaskGatewayError("Task creation is not confirmed. Retry the saved request.", "invalid_contract");
  }
  if (payload?.taskState === "not_read" && payload.task === null) {
    return { taskId: receipt.taskId, revision: 1, operationId: input.operationId };
  }
  const task = record(payload?.task);
  if (!task || task.id !== receipt.taskId || typeof task.revision !== "number" || !Number.isSafeInteger(task.revision) || task.revision < 1
    || (payload?.taskState !== undefined && (payload.taskState !== "accepted_revision" || task.revision !== 1))) {
    throw new NativeTaskGatewayError("Task creation is not confirmed. Retry the saved request.", "invalid_contract");
  }
  if (input.relationship?.sourceRef && (task.source !== "HUMAN" || task.sourceRef !== input.relationship.sourceRef)) {
    throw new NativeTaskGatewayError("Task Authority did not confirm the linked task. Retry the same operation.", "invalid_contract");
  }
  return { taskId: receipt.taskId, revision: task.revision, operationId: input.operationId };
}

export async function completeNativeTask(
  input: { taskId: string; expectedRevision: number; operationId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<NativeTaskCompleteReceipt> {
  const endpoint = taskAuthorityCompleteEndpoint(input.taskId);
  const authorization = taskAuthorityAuthorization();

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operationId: input.operationId,
        expectedRevision: input.expectedRevision,
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new NativeTaskGatewayError("Task Authority timed out. Retry this completion.", "timeout");
    }
    throw new NativeTaskGatewayError("Task Authority could not be reached. Retry this completion.", "http_error");
  }

  let raw: string;
  try {
    raw = await readBoundedResponse(response);
  } catch (error) {
    if (error instanceof NativeTaskGatewayError) throw error;
    throw new NativeTaskGatewayError("Task Authority returned an unreadable response.", "invalid_contract");
  }
  if (!response.ok) {
    if (response.status === 409) {
      throw new NativeTaskGatewayError("This task changed after the snapshot was fetched. Wait for refresh and try again.", "conflict");
    }
    if (response.status === 404) {
      throw new NativeTaskGatewayError("This task is no longer available in Task Authority.", "http_error");
    }
    throw new NativeTaskGatewayError(`Task Authority rejected the completion (HTTP ${response.status}).`, "http_error");
  }

  let payload: Record<string, unknown> | null;
  try {
    payload = record(JSON.parse(raw));
  } catch {
    payload = null;
  }
  const receipt = record(payload?.receipt);
  const task = record(payload?.task);
  if (payload?.taskState === "not_read" && payload.task === null) {
    return { ...verifyNativeTaskOperationReceipt(receipt, { ...input, mutation: { kind: "complete" } }), status: "DONE" };
  }
  const taskId = typeof task?.id === "string" ? task.id : null;
  const revision = typeof task?.revision === "number" && Number.isSafeInteger(task.revision) && task.revision === input.expectedRevision + 1
    ? task.revision
    : null;
  const receiptOperationId = typeof receipt?.operationId === "string" ? receipt.operationId : null;
  const receiptTaskId = typeof receipt?.taskId === "string" ? receipt.taskId : null;
  const receiptActionType = typeof receipt?.actionType === "string" ? receipt.actionType : null;
  const receiptOperationIndexes = Array.isArray(receipt?.operationIndexes) ? receipt.operationIndexes : null;
  const receiptPayloadHash = typeof receipt?.payloadHash === "string" ? receipt.payloadHash : null;
  const receiptRevision = typeof receipt?.revision === "number" && Number.isSafeInteger(receipt.revision)
    ? receipt.revision
    : null;
  const replayed = typeof receipt?.replayed === "boolean" ? receipt.replayed : null;
  if (
    taskId !== input.taskId
    || task?.status !== "DONE"
    || revision === null
    || receiptOperationId !== input.operationId
    || receiptTaskId !== input.taskId
    || receiptRevision !== revision
    || receiptActionType !== "COMPLETE_TASK"
    || receiptOperationIndexes === null
    || receiptOperationIndexes.length !== 1
    || receiptOperationIndexes[0] !== input.expectedRevision
    || receiptPayloadHash === null
    || !/^[0-9a-f]{64}$/u.test(receiptPayloadHash)
    || replayed === null
  ) {
    throw new NativeTaskGatewayError("Task Authority returned an invalid completion receipt.", "invalid_contract");
  }

  return { taskId, revision, operationId: input.operationId, status: "DONE", replayed };
}
