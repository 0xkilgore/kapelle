import { AuthRegistry, requireScope } from "./auth.js";
import { TaskGatewayCore, type GatewayCommand } from "./core.js";
import { TASK_GATEWAY_OPENAPI } from "./openapi.js";
import { indexTask, projectMorningDigest, projectToday } from "../projection.js";
import { GatewayError, type GatewayPrincipal, type GatewayScope } from "./types.js";

type JsonObject = Record<string, unknown>;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function head(response: Response): Response {
  return new Response(null, { status: response.status, headers: response.headers });
}

async function body(request: Request): Promise<JsonObject> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as JsonObject;
  } catch {
    throw new GatewayError("a JSON object body is required", 400, "INVALID_JSON");
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new GatewayError(`${field} is required`, 400, "INVALID_REQUEST");
  }
  return value.trim();
}

function revision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new GatewayError(
      "expectedRevision must be a non-negative integer",
      400,
      "INVALID_REQUEST",
    );
  }
  return value as number;
}

function boundedQueryInteger(
  url: URL,
  field: string,
  fallback: number,
): number {
  const raw = url.searchParams.get(field);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new GatewayError(`${field} must be between 1 and 100`, 400, "INVALID_REQUEST");
  }
  return value;
}

function viewerTimeZone(url: URL): string {
  const value = url.searchParams.get("timeZone") ?? "America/Chicago";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    throw new GatewayError("timeZone must be a valid IANA time zone", 400, "INVALID_REQUEST");
  }
  return value;
}

function mutationEnvelope(input: JsonObject): { operationId: string; expectedRevision: number } {
  return {
    operationId: text(input.operationId, "operationId"),
    expectedRevision: revision(input.expectedRevision),
  };
}

const patchCommands: Record<string, { type: GatewayCommand["type"]; field: string }> = {
  title: { type: "UPDATE_TITLE", field: "title" },
  bodyMarkdown: { type: "UPDATE_BODY", field: "bodyMarkdown" },
  projectId: { type: "SET_PROJECT", field: "projectId" },
  dueAt: { type: "SET_DUE", field: "dueAt" },
  priority: { type: "SET_PRIORITY", field: "priority" },
  assigneeId: { type: "SET_ASSIGNEE", field: "assigneeId" },
};

function taskView(task: Awaited<ReturnType<TaskGatewayCore["getTask"]>>) {
  return { ...task.state, id: task.taskId, revision: task.revision };
}

export class TaskGatewayApi {
  constructor(
    readonly core: TaskGatewayCore,
    readonly auth: AuthRegistry,
    readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health" || url.pathname === "/ready") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response(JSON.stringify({
            error: { code: "METHOD_NOT_ALLOWED", message: "method not allowed" },
          }), {
            status: 405,
            headers: {
              allow: "GET, HEAD",
              "content-type": "application/json; charset=utf-8",
            },
          });
        }
        let response: Response;
        if (url.pathname === "/health") {
          response = json({ status: "ok" });
        } else {
          try {
            await this.core.ready();
            response = json({ status: "ready" });
          } catch {
            response = json({ status: "not_ready" }, 503);
          }
        }
        return request.method === "HEAD" ? head(response) : response;
      }
      const principal = this.auth.authenticate(request.headers.get("authorization") ?? undefined);
      if (url.pathname === "/openapi.json" && request.method === "GET") {
        requireScope(principal, "task.read");
        return json(TASK_GATEWAY_OPENAPI);
      }
      const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
      const lifecycleMatch = /^\/v1\/tasks\/([^/]+)\/(complete|reopen|snooze|unsnooze|block|unblock|archive)$/.exec(
        url.pathname,
      );

      if (request.method === "POST" && url.pathname === "/v1/tasks") {
        requireScope(principal, "task.create");
        return await this.#create(principal, await body(request));
      }
      if (request.method === "GET" && url.pathname === "/v1/tasks") {
        requireScope(principal, "task.read");
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const result = this.core.listTasks(limit, url.searchParams.get("cursor") ?? undefined);
        return json({ rows: result.rows.map(taskView), nextCursor: result.nextCursor });
      }
      if (request.method === "GET" && taskMatch) {
        requireScope(principal, "task.read");
        return json(taskView(await this.core.getTask(decodeURIComponent(taskMatch[1]))));
      }
      if (request.method === "PATCH" && taskMatch) {
        requireScope(principal, "task.update");
        return await this.#patch(principal, decodeURIComponent(taskMatch[1]), await body(request));
      }
      if (request.method === "POST" && lifecycleMatch) {
        const action = lifecycleMatch[2];
        requireScope(
          principal,
          ["snooze", "unsnooze", "block", "unblock"].includes(action)
            ? "task.update"
            : "task.complete",
        );
        return await this.#lifecycle(
          principal,
          decodeURIComponent(lifecycleMatch[1]),
          action,
          await body(request),
        );
      }
      if (request.method === "GET" && url.pathname === "/v1/projections/today") {
        requireScope(principal, "projection.read");
        const timeZone = viewerTimeZone(url);
        const limit = boundedQueryInteger(url, "limit", 100);
        const rows = this.core.allCachedTasks().map((task) =>
          indexTask(task.state, task.revision),
        );
        return json(projectToday(rows, timeZone, this.clock(), limit));
      }
      if (request.method === "GET" && url.pathname === "/v1/projections/morning-digest") {
        requireScope(principal, "projection.read");
        const rows = this.core.allCachedTasks().map((task) =>
          indexTask(task.state, task.revision),
        );
        return json(projectMorningDigest(rows, viewerTimeZone(url), this.clock(), {
          focus: boundedQueryInteger(url, "focusLimit", 5),
          thisWeek: boundedQueryInteger(url, "thisWeekLimit", 8),
          completedPreviousLocalDay: boundedQueryInteger(url, "completedLimit", 3),
        }));
      }
      throw new GatewayError("route not found", 404, "NOT_FOUND");
    } catch (error) {
      if (error instanceof GatewayError) {
        return json({ error: { code: error.code, message: error.message } }, error.status);
      }
      return json({ error: { code: "INTERNAL", message: "internal gateway error" } }, 500);
    }
  }

  async #create(principal: GatewayPrincipal, input: JsonObject): Promise<Response> {
    const envelope = mutationEnvelope(input);
    const receipt = await this.core.mutate(principal, {
      ...envelope,
      commands: [{
        type: "CREATE_TASK",
        input: {
          ...(Object.prototype.hasOwnProperty.call(input, "id") ? { id: input.id } : {}),
          title: input.title,
          bodyMarkdown: input.bodyMarkdown,
          projectId: input.projectId,
          priority: input.priority,
          dueAt: input.dueAt,
          labels: input.labels,
          assigneeId: input.assigneeId,
          ownerId: input.ownerId ?? principal.actorId,
          source: input.source ?? "HUMAN",
          sourceRef: input.sourceRef,
        },
      }],
    });
    return json({ receipt, task: taskView(await this.core.getTask(receipt.taskId)) }, 201);
  }

  async #patch(
    principal: GatewayPrincipal,
    taskId: string,
    input: JsonObject,
  ): Promise<Response> {
    const envelope = mutationEnvelope(input);
    const patch = input.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new GatewayError("patch object is required", 400, "INVALID_REQUEST");
    }
    const commands = Object.entries(patch as JsonObject).map(([key, value]) => {
      const mapping = patchCommands[key];
      if (!mapping) throw new GatewayError(`unsupported patch field ${key}`, 400, "INVALID_REQUEST");
      return { type: mapping.type, input: { [mapping.field]: value } };
    });
    const receipt = await this.core.mutate(principal, { ...envelope, taskId, commands });
    return json({ receipt, task: taskView(await this.core.getTask(taskId)) });
  }

  async #lifecycle(
    principal: GatewayPrincipal,
    taskId: string,
    verb: string,
    input: JsonObject,
  ): Promise<Response> {
    const envelope = mutationEnvelope(input);
    const commandByVerb: Record<string, GatewayCommand> = {
      complete: { type: "COMPLETE_TASK", input: { resolution: input.resolution } },
      reopen: { type: "REOPEN_TASK", input: { reason: input.reason } },
      snooze: { type: "SNOOZE_TASK", input: { snoozedUntil: input.snoozedUntil, reason: input.reason } },
      unsnooze: { type: "UNSNOOZE_TASK", input: {} },
      block: { type: "BLOCK_TASK", input: { reason: input.reason } },
      unblock: { type: "UNBLOCK_TASK", input: { resolution: input.resolution } },
      archive: { type: "ARCHIVE_TASK", input: { reason: input.reason } },
    };
    const receipt = await this.core.mutate(principal, {
      ...envelope,
      taskId,
      commands: [commandByVerb[verb]],
    });
    return json({ receipt, task: taskView(await this.core.getTask(taskId)) });
  }
}
