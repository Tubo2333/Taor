import { defineConfig } from "vitest/config"
import { resolve } from "path"

const taorPackages = [
  "core", "engine", "adapters", "permission", "hooks",
  "tools", "memory", "subagent", "compressor", "telemetry", "mcp", "cli",
]

// MCP integration tests need a mock binary not available in CI — skip them there
const exclude = process.env.CI
  ? ["tests/integration/mcp.test.ts"]
  : []

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      taorPackages.map((pkg) => [
        `@taor/${pkg}`,
        resolve(__dirname, `packages/${pkg}/dist/index.js`),
      ]),
    ),
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude,
    retry: 2,
  },
})
