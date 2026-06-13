import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    retry: 2, // M3: mitigate CI flakiness from timeouts/race conditions
    coverage: {
      provider: "v8",
      // NOTE: coverage must be run with --coverage.include CLI flag:
      //   npx vitest run --coverage --coverage.include="packages/**/dist/**/*.js"
      // The vitest config file's include filtering conflicts with v8 on Windows.
      thresholds: {
        // Global thresholds (all packages):
        // Target 5 files avg 69.2%: harness=68.8%, config=76.8%, openai=86.7%,
        // anthropic=59.7%, engine=54.3%. Global avg pulled down by untested packages.
        lines: 40,
        branches: 40,
        functions: 35,
        statements: 40,
      },
    },
  },
})
