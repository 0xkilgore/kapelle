import { describe, expect, it } from "vitest";
import {
  assertSafeRouteSurface,
  NETWORK_ROUTES,
} from "../src/network-surface.js";

describe("slice 1 network surface", () => {
  it("exposes no network routes", () => {
    expect(NETWORK_ROUTES).toStrictEqual([]);
    expect(() => assertSafeRouteSurface()).not.toThrow();
  });

  it("fails a future route contract containing prohibited capabilities", () => {
    expect(() => assertSafeRouteSurface(["POST /v1/tasks/bulk-import"])).toThrow(
      /prohibited route term/,
    );
  });
});
