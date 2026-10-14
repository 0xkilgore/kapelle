import { AuthRegistry, requireScope } from "../src/gateway/auth.js";
import { describe, expect, it } from "vitest";

const token = "test-token-with-at-least-24-characters";

describe("gateway authentication", () => {
  const registry = new AuthRegistry([{
    clientId: "daily-driver",
    actorId: "daily-driver",
    token,
    scopes: ["task.read", "projection.read"],
    allowedSources: ["HUMAN"],
  }]);

  it("authenticates a configured bearer token and binds its actor", () => {
    const principal = registry.authenticate(`Bearer ${token}`);
    expect(principal.clientId).toBe("daily-driver");
    expect(principal.actorId).toBe("daily-driver");
    expect(principal.scopes).toEqual(new Set(["task.read", "projection.read"]));
    expect(principal.allowedSources).toEqual(new Set(["HUMAN"]));
    expect(principal.canAssignOwner).toBe(false);
  });

  it("rejects missing and invalid bearer tokens", () => {
    expect(() => registry.authenticate(undefined)).toThrow("bearer token required");
    expect(() => registry.authenticate(`Bearer ${"x".repeat(40)}`)).toThrow(
      "invalid bearer token",
    );
  });

  it("fails closed when a client lacks the requested scope", () => {
    const principal = registry.authenticate(`Bearer ${token}`);
    expect(() => requireScope(principal, "task.update")).toThrow("scope task.update required");
    expect(() => requireScope(principal, "projection.read")).not.toThrow();
  });

  it("requires an explicit non-empty source allowlist", () => {
    expect(() => new AuthRegistry([{
      clientId: "unsafe",
      actorId: "unsafe",
      token,
      scopes: ["task.create"],
      allowedSources: [],
    }])).toThrow();
  });
});
