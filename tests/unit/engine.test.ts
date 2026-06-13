/**
 * Engine unit tests — test createHarness() edge cases.
 * Boosts coverage on packages/engine/src/index.ts to ≥60%.
 */

import { describe, it, expect } from "vitest"
import { createHarness, AnthropicAdapter, OpenaiAdapter, DeepSeekAdapter } from "@taor/engine"
import { MockAdapter } from "../fixtures/mock-adapter.js"

describe("Engine — createHarness edge cases", () => {
  it("should reject invalid model", () => {
    expect(() =>
      createHarness({ model: "", tools: [], adapter: AnthropicAdapter }),
    ).toThrow()
  })

  it("should reject negative maxTurns", () => {
    expect(() =>
      createHarness({
        model: "claude-sonnet-4-6",
        tools: [],
        adapter: AnthropicAdapter,
        session: { maxTurns: -1 },
      }),
    ).toThrow()
  })

  it("should reject invalid permission level", () => {
    expect(() =>
      createHarness({
        model: "claude-sonnet-4-6",
        tools: [],
        adapter: AnthropicAdapter,
        permission: { defaultLevel: "invalid" as any },
      }),
    ).toThrow()
  })

  it("should create harness with AnthropicAdapter when env key is set", () => {
    const prev = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "test-key-for-unit-test"
    try {
      const harness = createHarness({
        model: "claude-haiku-4-5",
        tools: [],
        adapter: AnthropicAdapter,
      })
      expect(harness).toBeDefined()
      expect(harness.state.model).toBe("claude-haiku-4-5")
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prev
    }
  })
})

describe("Engine — adapter env var checks", () => {
  it("should have AnthropicAdapter.requiredEnvVars", () => {
    expect(AnthropicAdapter.requiredEnvVars).toEqual(["ANTHROPIC_API_KEY"])
  })

  it("should have OpenaiAdapter.requiredEnvVars", () => {
    expect(OpenaiAdapter.requiredEnvVars).toEqual(["OPENAI_API_KEY"])
  })

  it("should have DeepSeekAdapter.requiredEnvVars", () => {
    expect(DeepSeekAdapter.requiredEnvVars).toEqual(["DEEPSEEK_API_KEY"])
  })
})

describe("Engine — with MockAdapter", () => {
  it("should create harness with mock adapter", () => {
    const MockClass = class extends MockAdapter {
      constructor() { super({}) }
    }
    const harness = createHarness({
      model: "mock",
      tools: [],
      adapter: MockClass as any,
    })
    expect(harness).toBeDefined()
    expect(() => harness.abort("test")).not.toThrow()
  })

  it("should accept snapshot parameter without throwing", () => {
    const MockClass = class extends MockAdapter {
      constructor() { super({}) }
    }
    const snapshot = {
      version: 1,
      sessionId: "snap-1",
      model: "mock",
      workDir: "/tmp",
      startedAt: Date.now(),
      tokenUsage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      turnCount: 0,
      turns: [],
      memorySnapshots: { user: {}, project: {}, session: {} },
    }
    const harness = createHarness({
      model: "mock",
      tools: [],
      adapter: MockClass as any,
    }, snapshot as any)
    expect(harness).toBeDefined()
    expect(harness.state.id).toBe("snap-1")
  })

  it("should wire all subsystems when configured", () => {
    const MockClass = class extends MockAdapter {
      constructor() { super({}) }
    }
    const harness = createHarness({
      model: "mock",
      tools: [],
      adapter: MockClass as any,
      permission: { defaultLevel: "allow" },
      hooks: [],
      memory: { session: { backend: "memory" } },
      compressor: { triggerThreshold: 10000, targetThreshold: 5000 },
    } as any)
    expect(harness).toBeDefined()
    expect(harness.permission).toBeDefined()
    expect(harness.hooks).toBeDefined()
    expect(harness.memory).toBeDefined()
    expect(harness.compressor).toBeDefined()
  })
})
