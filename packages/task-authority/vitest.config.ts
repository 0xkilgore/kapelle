import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  test: {
    include: [
      "tests/**/*.test.ts",
      "generated/**/tests/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["generated/**/src/reducers/**/*.ts", "src/**/*.ts"],
    },
  },
  plugins: [tsconfigPaths()],
});
