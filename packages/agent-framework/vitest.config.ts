import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  // The native backend's slower tests hit vitest's 5 s default under full-suite load (they pass alone). Per-test timeouts
  // that are set explicitly are unchanged; the sqlite backend keeps the default.
  // setupFiles: every test file removes the temp dirs it created (tests/setup-scratch.ts; KEEP_WORLD=1 keeps them).
  test: { globals: true, include: ["tests/**/*.test.ts"], setupFiles: ["tests/setup-scratch.ts"], testTimeout: process.env.KAPELLE_FRAMEWORK_BACKEND === "sqlite" ? 5_000 : 20_000 },
  plugins: [tsconfigPaths()],
});
