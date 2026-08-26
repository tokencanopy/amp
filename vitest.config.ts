import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The ACP and API suites each bind a port and spawn child processes;
    // running files in parallel makes port and process ownership ambiguous.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
