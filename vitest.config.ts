import { defineConfig } from "vitest/config"
import { resolve } from "path"

const taorPackages = [
  "core", "engine", "adapters", "permission", "hooks",
  "tools", "memory", "subagent", "compressor", "telemetry", "mcp", "cli",
]

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
    retry: 2,
  },
})
