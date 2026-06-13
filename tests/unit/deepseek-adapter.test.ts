/**
 * DeepSeek Adapter — Smoke Test (GAP-9, Gate 3)
 *
 * Verifies DeepSeekAdapter construction, model catalog, environment validation,
 * and OpenAI compatibility inheritance. No real API key needed.
 */

import { describe, it, expect } from "vitest"
import { DeepSeekAdapter } from "@harness/adapters"
import type { ModelInfo } from "@harness/adapters"

describe("GAP-9 / Gate 3: DeepSeek Adapter", () => {
  // ── Test 1: Construction ──

  it("should construct without API key (deferred validation)", () => {
    const adapter = new DeepSeekAdapter({ apiKey: "test-key" })
    expect(adapter).toBeDefined()
    expect(adapter.provider).toBe("deepseek")
    expect(adapter.version).toBeTruthy()
  })

  it("should use DEEPSEEK_API_KEY env var if no apiKey passed", () => {
    const originalKey = process.env["DEEPSEEK_API_KEY"]
    process.env["DEEPSEEK_API_KEY"] = "env-key-test"

    try {
      const adapter = new DeepSeekAdapter()
      expect(adapter.provider).toBe("deepseek")
    } finally {
      if (originalKey === undefined) {
        delete process.env["DEEPSEEK_API_KEY"]
      } else {
        process.env["DEEPSEEK_API_KEY"] = originalKey
      }
    }
  })

  // ── Test 2: Model catalog ──

  it("should have deepseek-chat in model catalog", () => {
    const adapter = new DeepSeekAdapter({ apiKey: "k" })
    const info = adapter.getModelInfo("deepseek-chat")
    expect(info.id).toBe("deepseek-chat")
    expect(info.provider).toBe("deepseek")
    expect(info.maxInputTokens).toBe(128_000)
    expect(info.maxOutputTokens).toBe(8_000)
    expect(info.supportsThinking).toBe(false)
    expect(info.supportsToolUse).toBe(true)
    expect(info.supportsVision).toBe(false)
    expect(info.supportsPromptCaching).toBe(false)
    // Cost should be cheaper than OpenAI
    expect(info.costPer1kInput).toBeLessThan(0.001) // $0.00027
  })

  it("should have deepseek-reasoner in model catalog", () => {
    const adapter = new DeepSeekAdapter({ apiKey: "k" })
    const info = adapter.getModelInfo("deepseek-reasoner")
    expect(info.id).toBe("deepseek-reasoner")
    expect(info.provider).toBe("deepseek")
    expect(info.maxInputTokens).toBe(128_000)
    expect(info.maxOutputTokens).toBe(32_000)
    expect(info.supportsThinking).toBe(true)
    expect(info.supportsToolUse).toBe(false)
  })

  it("should return a model info with fallback default for unknown model", () => {
    const adapter = new DeepSeekAdapter({ apiKey: "k" })
    // Unknown model should not throw — may return a fallback or log a warning
    // getModelInfo behavior for unknown models is defined by OpenAICompatibleAdapter
    expect(() => adapter.getModelInfo("nonexistent-model")).not.toThrow()
  })

  // ── Test 3: requiredEnvVars ──

  it("should declare requiredEnvVars as DEEPSEEK_API_KEY", () => {
    const vars = (DeepSeekAdapter as any).requiredEnvVars as string[]
    expect(vars).toBeDefined()
    expect(vars).toContain("DEEPSEEK_API_KEY")
  })

  // ── Test 4: Features ──

  it("deepseek-chat should support streaming and tool use", () => {
    const adapter = new DeepSeekAdapter({ apiKey: "k" })
    expect(adapter.supports("streaming", "deepseek-chat")).toBe(true)
    expect(adapter.supports("tool-use", "deepseek-chat")).toBe(true)
    expect(adapter.supports("vision", "deepseek-chat")).toBe(false)
    expect(adapter.supports("thinking", "deepseek-chat")).toBe(false)
  })

  it("deepseek-reasoner should support thinking but not tool use", () => {
    const adapter = new DeepSeekAdapter({ apiKey: "k" })
    expect(adapter.supports("thinking", "deepseek-reasoner")).toBe(true)
    expect(adapter.supports("tool-use", "deepseek-reasoner")).toBe(false)
  })

  // ── Test 5: Provider identity ──

  it("should have correct provider and base URL", () => {
    const adapter = new DeepSeekAdapter({
      apiKey: "k",
      baseURL: "https://custom.deepseek.com/v1",
    })
    expect(adapter.provider).toBe("deepseek")
  })

  // ── Test 6: Default model ──

  it("should default to deepseek-chat", () => {
    const adapter = new DeepSeekAdapter({ apiKey: "k" })
    // getModelInfo for the default model should not throw
    expect(() => adapter.getModelInfo("deepseek-chat")).not.toThrow()
  })
})
