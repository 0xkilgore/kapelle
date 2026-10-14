import { createHash, timingSafeEqual } from "node:crypto";
import type { GatewayPrincipal, GatewayScope } from "./types.js";
import type { TaskSource } from "../../generated/task-authority/v1/gen/schema/types.js";
import { GatewayError } from "./types.js";

type ClientConfig = {
  clientId: string;
  actorId: string;
  tokenSha256: Buffer;
  scopes: ReadonlySet<GatewayScope>;
  allowedSources: ReadonlySet<TaskSource>;
  canAssignOwner: boolean;
};

export type GatewayClientInput = {
  clientId: string;
  actorId: string;
  token: string;
  scopes: GatewayScope[];
  allowedSources: TaskSource[];
  canAssignOwner?: boolean;
};

const taskSources = new Set<TaskSource>([
  "HUMAN",
  "CLI",
  "AGENT",
  "PERSONAL_CRM",
  "MIGRATION",
]);

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export class AuthRegistry {
  readonly #clients: ClientConfig[];

  constructor(inputs: GatewayClientInput[]) {
    if (inputs.length === 0) throw new Error("at least one gateway client is required");
    this.#clients = inputs.map((input) => {
      if (
        !input.clientId.trim() ||
        !input.actorId.trim() ||
        input.token.length < 24
      ) {
        throw new Error("gateway clients require an id, actor, and token of at least 24 characters");
      }
      if (
        !Array.isArray(input.allowedSources) ||
        input.allowedSources.length === 0 ||
        input.allowedSources.some((source) => !taskSources.has(source))
      ) {
        throw new Error("gateway clients require at least one valid allowedSources entry");
      }
      return {
        clientId: input.clientId.trim(),
        actorId: input.actorId.trim(),
        tokenSha256: digest(input.token),
        scopes: new Set(input.scopes),
        allowedSources: new Set(input.allowedSources),
        canAssignOwner: input.canAssignOwner === true,
      };
    });
  }

  authenticate(header: string | undefined): GatewayPrincipal {
    const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
    if (!match) throw new GatewayError("bearer token required", 401, "UNAUTHENTICATED");
    const candidate = digest(match[1]);
    const client = this.#clients.find((entry) =>
      timingSafeEqual(entry.tokenSha256, candidate),
    );
    if (!client) throw new GatewayError("invalid bearer token", 401, "UNAUTHENTICATED");
    return {
      clientId: client.clientId,
      actorId: client.actorId,
      scopes: client.scopes,
      allowedSources: client.allowedSources,
      canAssignOwner: client.canAssignOwner,
    };
  }
}

export function requireScope(principal: GatewayPrincipal, scope: GatewayScope): void {
  if (!principal.scopes.has(scope)) {
    throw new GatewayError(`scope ${scope} required`, 403, "FORBIDDEN");
  }
}
