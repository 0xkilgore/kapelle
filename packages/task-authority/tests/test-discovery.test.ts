import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** Committed test files relative to this package; falls back to the filesystem outside a git checkout (e.g. a ZIP download). */
function committedTests(): string[] {
  try {
    return execFileSync("git", ["ls-files", "--", "*.test.ts"], { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return (readdirSync(packageRoot, { recursive: true }) as string[])
      .map((path) => path.split("\\").join("/"))
      .filter((path) => path.endsWith(".test.ts") && !path.startsWith("node_modules/"));
  }
}

describe("canonical test discovery", () => {
  it("keeps every committed test inside a Vitest include root", () => {
    const committed = committedTests();

    const outsideGate = committed.filter(
      (path) =>
        !path.startsWith("tests/") &&
        !/^generated\/.+\/tests\/.+\.test\.ts$/.test(path),
    );

    expect(committed.length).toBeGreaterThan(0);
    expect(outsideGate).toStrictEqual([]);
  });
});
