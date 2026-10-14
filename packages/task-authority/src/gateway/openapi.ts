import { assertSafeRouteSurface } from "../network-surface.js";

export const GATEWAY_ROUTES = [
  "GET /health",
  "GET /ready",
  "GET /openapi.json",
  "POST /v1/tasks",
  "GET /v1/tasks",
  "GET /v1/tasks/{id}",
  "PATCH /v1/tasks/{id}",
  "POST /v1/tasks/{id}/complete",
  "POST /v1/tasks/{id}/reopen",
  "POST /v1/tasks/{id}/snooze",
  "POST /v1/tasks/{id}/unsnooze",
  "POST /v1/tasks/{id}/block",
  "POST /v1/tasks/{id}/unblock",
  "POST /v1/tasks/{id}/archive",
  "GET /v1/projections/today",
  "GET /v1/projections/morning-digest",
] as const;

assertSafeRouteSurface(GATEWAY_ROUTES);

export const TASK_GATEWAY_OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Private Task Authority Gateway", version: "0.3.0" },
  servers: [{ url: "http://127.0.0.1:4260" }],
  paths: {
    "/health": {
      get: {
        security: [],
        responses: {
          "200": {
            description: "Process is live",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/ready": {
      get: {
        security: [],
        responses: {
          "200": {
            description: "Dependencies are ready",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "503": {
            description: "A dependency is not ready",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/openapi.json": { get: {} },
    "/v1/tasks": { get: {}, post: {} },
    "/v1/tasks/{id}": { get: {}, patch: {} },
    "/v1/tasks/{id}/complete": { post: {} },
    "/v1/tasks/{id}/reopen": { post: {} },
    "/v1/tasks/{id}/snooze": { post: {} },
    "/v1/tasks/{id}/unsnooze": { post: {} },
    "/v1/tasks/{id}/block": { post: {} },
    "/v1/tasks/{id}/unblock": { post: {} },
    "/v1/tasks/{id}/archive": { post: {} },
    "/v1/projections/today": { get: {} },
    "/v1/projections/morning-digest": {
      get: {
        description: "Owner-only, source-ordered aggregate for the Morning Digest",
        parameters: [
          { name: "timeZone", in: "query", schema: { type: "string", default: "America/Chicago" } },
          { name: "focusLimit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 5 } },
          { name: "thisWeekLimit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 8 } },
          { name: "completedLimit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 3 } },
        ],
        responses: {
          "200": {
            description: "Fresh authority aggregate, including authoritative empty",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/MorningDigestProjection" },
              },
            },
          },
          "400": { description: "Invalid time zone or row limit" },
          "401": { description: "Missing or invalid credential" },
          "403": { description: "Credential lacks projection.read" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
    },
    schemas: {
      MorningDigestTaskRow: {
        type: "object",
        additionalProperties: false,
        required: [
          "id", "title", "status", "priority", "projectId", "dueAt",
          "ownerId", "completedAt", "updatedAt", "revision",
        ],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          status: { type: "string", enum: ["OPEN", "BLOCKED", "SNOOZED", "DONE", "ARCHIVED"] },
          priority: { type: ["string", "null"], enum: ["HIGH", "MED", "LOW", null] },
          projectId: { type: ["string", "null"] },
          dueAt: { type: ["string", "null"], format: "date-time" },
          ownerId: { type: "string", const: "chris" },
          completedAt: { type: ["string", "null"], format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          revision: { type: "integer", minimum: 0 },
        },
      },
      MorningDigestSection: {
        type: "object",
        additionalProperties: false,
        required: ["rows", "totalCount", "hasMore"],
        properties: {
          rows: {
            type: "array",
            items: { $ref: "#/components/schemas/MorningDigestTaskRow" },
          },
          totalCount: { type: "integer", minimum: 0 },
          hasMore: { type: "boolean" },
        },
      },
      MorningDigestProjection: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind", "state", "reasonCode", "viewerTimeZone", "localDate",
          "previousLocalDate", "weekEndsOn", "generatedAt", "ownerId",
          "focus", "counts", "thisWeek", "completedPreviousLocalDay",
        ],
        properties: {
          kind: { type: "string", const: "task-authority.morning-digest.v1" },
          state: { type: "string", enum: ["fresh", "authoritative_empty"] },
          reasonCode: { type: "string", enum: ["SOURCE_GENERATED", "NO_MATCHING_TASKS"] },
          viewerTimeZone: { type: "string" },
          localDate: { type: "string", format: "date" },
          previousLocalDate: { type: "string", format: "date" },
          weekEndsOn: { type: "string", format: "date" },
          generatedAt: { type: "string", format: "date-time" },
          ownerId: { type: "string", const: "chris" },
          focus: { $ref: "#/components/schemas/MorningDigestSection" },
          counts: {
            type: "object",
            additionalProperties: false,
            required: ["overdue", "dueThisWeek", "completedPreviousLocalDay"],
            properties: {
              overdue: { type: "integer", minimum: 0 },
              dueThisWeek: { type: "integer", minimum: 0 },
              completedPreviousLocalDay: { type: "integer", minimum: 0 },
            },
          },
          thisWeek: { $ref: "#/components/schemas/MorningDigestSection" },
          completedPreviousLocalDay: { $ref: "#/components/schemas/MorningDigestSection" },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
} as const;
