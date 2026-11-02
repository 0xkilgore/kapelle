import {parseNativeTaskSourceRef,type NativeSourceTarget} from './nativeDocumentSourceContract';
import "server-only";

import {
  NativeTaskGatewayError,
  readBoundedResponse,
  record,
  taskAuthorityAuthorization,
  taskAuthorityOrigin,
} from "./nativeTaskIntake";

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const REQUEST_TIMEOUT_MS = 2_000;

export function isNativeTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

export type NativeTaskComment = {
  id: string;
  bodyMarkdown: string;
  addedAt: string;
  addedBy: string;
};

export type NativeTaskExternalRef = {
  id: string;
  authority: string;
  opaqueId: string;
  deepLink: string | null;
  addedAt?: string | null;
  addedBy?: string | null;
};

export type NativeTaskDocument = {
  nativeSource?:NativeSourceTarget;
  relationshipRef?: string;
  reportDocumentId?: string;
  inboxWorkflowId?: string;
  id: string;
  revision: number;
  title: string;
  bodyMarkdown: string;
  status: "OPEN" | "SNOOZED" | "BLOCKED" | "DONE" | "ARCHIVED";
  priority: "HIGH" | "MED" | "LOW" | null;
  projectId: string | null;
  labels: string[];
  assigneeId: string | null;
  dueAt: string | null;
  snoozedUntil: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  dependsOn: string[];
  comments: NativeTaskComment[];
  externalRefs: NativeTaskExternalRef[];
};

export type NativeTaskDetailRead =
  | { kind: "ok"; task: NativeTaskDocument }
  | { kind: "missing" }
  | { kind: "unavailable"; error: string };

function text(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function requiredText(value: unknown, maximum: number): string {
  const admitted = text(value, maximum);
  if (!admitted) throw new Error("Task Authority returned an invalid task document.");
  return admitted;
}

function nullableText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  return requiredText(value, maximum);
}

function instant(value: unknown): string | null {
  if (value === null) return null;
  const admitted = text(value, 40);
  if (!admitted || !Number.isFinite(Date.parse(admitted))) {
    throw new Error("Task Authority returned an invalid task document.");
  }
  return admitted;
}

export function parseNativeTaskDocument(value: unknown): NativeTaskDocument {
  const task = record(value);
  if (!task) throw new Error("Task Authority returned an invalid task document.");
  const status = task.status;
  if (status !== "OPEN" && status !== "SNOOZED" && status !== "BLOCKED" && status !== "DONE" && status !== "ARCHIVED") {
    throw new Error("Task Authority returned an invalid task document.");
  }
  const priority = task.priority;
  if (priority !== null && priority !== "HIGH" && priority !== "MED" && priority !== "LOW") {
    throw new Error("Task Authority returned an invalid task document.");
  }
  if (!Number.isSafeInteger(task.revision) || (task.revision as number) < 0) {
    throw new Error("Task Authority returned an invalid task document.");
  }
  if (!Array.isArray(task.labels) || task.labels.length > 100 || !Array.isArray(task.dependsOn) || task.dependsOn.length > 100) {
    throw new Error("Task Authority returned an invalid task document.");
  }
  if (!Array.isArray(task.comments) || task.comments.length > 250 || !Array.isArray(task.externalRefs) || task.externalRefs.length > 250) {
    throw new Error("Task Authority returned an invalid task document.");
  }

  const nativeSource=parseNativeTaskSourceRef(task.sourceRef);
  return {
    ...(nativeSource?{nativeSource}:{}),
    ...(typeof task.sourceRef === "string" && /^kapelle:report:[a-f0-9-]{36}$/.test(task.sourceRef) ? { reportDocumentId: task.sourceRef.slice("kapelle:report:".length) } : {}),
    ...(typeof task.sourceRef === "string" && /^kapelle:inbox-workflow:[a-f0-9]{64}$/.test(task.sourceRef) ? { inboxWorkflowId: task.sourceRef.slice("kapelle:inbox-workflow:".length) } : {}),
    ...(typeof task.sourceRef === "string" && /^personalcrm:contact:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(task.sourceRef) ? { relationshipRef: task.sourceRef.toLowerCase() } : {}),
    id: requiredText(task.id, 256),
    revision: task.revision as number,
    title: requiredText(task.title, 500),
    bodyMarkdown: text(task.bodyMarkdown, 50_000) ?? "",
    status,
    priority,
    projectId: nullableText(task.projectId, 256),
    labels: task.labels.map((label) => requiredText(label, 128)),
    assigneeId: nullableText(task.assigneeId, 256),
    dueAt: instant(task.dueAt),
    snoozedUntil: instant(task.snoozedUntil),
    createdAt: instant(task.createdAt),
    updatedAt: instant(task.updatedAt),
    dependsOn: task.dependsOn.map((dependency) => requiredText(dependency, 256)),
    comments: task.comments.map((value) => {
      const comment = record(value);
      if (!comment) throw new Error("Task Authority returned an invalid task document.");
      return {
        id: requiredText(comment.id, 256),
        bodyMarkdown: requiredText(comment.bodyMarkdown, 10_000),
        addedAt: requiredText(comment.addedAt, 40),
        addedBy: requiredText(comment.addedBy, 256),
      };
    }),
    externalRefs: task.externalRefs.map((value) => {
      const external = record(value);
      if (!external) throw new Error("Task Authority returned an invalid task document.");
      return {
        id: requiredText(external.id, 256),
        authority: requiredText(external.authority, 256),
        opaqueId: requiredText(external.opaqueId, external.authority === "web/url" ? 2_000 : 1_024),
        ...(external.addedAt === undefined ? {} : { addedAt: instant(external.addedAt) }),
        ...(external.addedBy === undefined ? {} : { addedBy: nullableText(external.addedBy, 256) }),
        deepLink: external.deepLink === null || external.deepLink === undefined
          ? null
          : requiredText(external.deepLink, 4_000),
      };
    }),
  };
}

export async function readNativeTaskDocument(
  taskId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NativeTaskDetailRead> {
  if (!isNativeTaskId(taskId)) return { kind: "missing" };
  let response: Response;
  try {
    response = await fetchImpl(`${taskAuthorityOrigin()}/v1/tasks/${encodeURIComponent(taskId)}`, {
      headers: {
        accept: "application/json",
        authorization: taskAuthorityAuthorization(),
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof NativeTaskGatewayError) return { kind: "unavailable", error: error.message };
    return { kind: "unavailable", error: "Task Authority could not be reached." };
  }
  if (response.status === 404) return { kind: "missing" };
  if (!response.ok) return { kind: "unavailable", error: `Task Authority returned HTTP ${response.status}.` };
  try {
    return { kind: "ok", task: parseNativeTaskDocument(JSON.parse(await readBoundedResponse(response))) };
  } catch (error) {
    return {
      kind: "unavailable",
      error: error instanceof Error ? error.message : "Task Authority returned an invalid task document.",
    };
  }
}
