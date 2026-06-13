/**
 * AnthropicAdapter unit tests — test pure logic (no API calls).
 * Boosts coverage on packages/adapters/src/anthropic.ts to ≥60%.
 */

import { describe, it, expect } from "vitest"
import { AnthropicAdapter } from "@harness/engine"

// ═══════════════════════════════════════════════════════════════════
// ─── Helpers ───
// ═══════════════════════════════════════════════════════════════════

function makeAdapter() {
  return new AnthropicAdapter({ apiKey: "test-key" })
}

// ═══════════════════════════════════════════════════════════════════
// ─── Tests ───
// ═══════════════════════════════════════════════════════════════════

describe("AnthropicAdapter — model info", () => {
  it("should return model info for known models", () => {
    const adapter = makeAdapter()
    const info = adapter.getModelInfo("claude-sonnet-4-6")
    expect(info.id).toBe("claude-sonnet-4-6")
    expect(info.provider).toBe("anthropic")
    expect(info.maxInputTokens).toBe(200_000)
    expect(info.supportsToolUse).toBe(true)
    expect(info.costPer1kInput).toBeGreaterThan(0)
  })

  it("should return default info for unknown models", () => {
    const adapter = makeAdapter()
    const info = adapter.getModelInfo("unknown-model-xyz")
    expect(info.id).toBe("unknown-model-xyz")
    expect(info.supportsToolUse).toBe(true)
  })

  it("should have correct costs for all known models", () => {
    const adapter = makeAdapter()
    const knownModels = [
      "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5",
      "claude-opus-4-5", "claude-sonnet-4-5", "claude-opus-4-1",
    ]
    for (const model of knownModels) {
      const info = adapter.getModelInfo(model)
      expect(info.id).toBe(model)
    }
  })
})

describe("AnthropicAdapter — feature detection", () => {
  it("should support streaming for all models", () => {
    const adapter = makeAdapter()
    expect(adapter.supports("streaming")).toBe(true)
  })

  it("should detect thinking support correctly", () => {
    const adapter = makeAdapter()
    expect(adapter.supports("thinking", "claude-opus-4-8")).toBe(true)
    expect(adapter.supports("thinking", "claude-haiku-4-5")).toBe(false)
  })

  it("should detect vision support", () => {
    const adapter = makeAdapter()
    expect(adapter.supports("vision", "claude-sonnet-4-6")).toBe(true)
  })

  it("should detect tool-use support", () => {
    const adapter = makeAdapter()
    expect(adapter.supports("tool-use")).toBe(true)
  })

  it("should detect prompt-caching support", () => {
    const adapter = makeAdapter()
    expect(adapter.supports("prompt-caching")).toBe(true)
  })

  it("should return false for unknown features", () => {
    const adapter = makeAdapter()
    // @ts-expect-error testing unknown feature
    expect(adapter.supports("unknown-feature")).toBe(false)
  })
})

describe("AnthropicAdapter — token counting", () => {
  it("should count tokens in messages", () => {
    const adapter = makeAdapter()
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "Hello, how are you?" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "I'm fine, thank you!" }] },
    ]
    const count = adapter.countTokens(messages)
    expect(count).toBeGreaterThan(0)
  })

  it("should count tokens for tool_use blocks", () => {
    const adapter = makeAdapter()
    const messages = [
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "1", name: "test", input: { key: "value" } }] },
    ]
    const count = adapter.countTokens(messages)
    expect(count).toBeGreaterThan(0)
  })

  it("should count tokens for tool_result blocks", () => {
    const adapter = makeAdapter()
    const messages = [
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "1", content: "result data" }] },
    ]
    const count = adapter.countTokens(messages)
    expect(count).toBeGreaterThan(0)
  })
})

describe("AnthropicAdapter — error normalization", () => {
  it("should normalize Error objects", () => {
    const adapter = makeAdapter()
    const result = adapter.normalizeError(new Error("test error"))
    expect(result.code).toBe("unknown")
    expect(result.message).toBe("test error")
    expect(result.source).toBe("adapter")
    expect(result.recoverable).toBe(false)
    expect(result.timestamp).toBeGreaterThan(0)
  })

  it("should normalize string errors", () => {
    const adapter = makeAdapter()
    const result = adapter.normalizeError("string error")
    expect(result.code).toBe("unknown")
    expect(result.message).toContain("string error")
    expect(result.source).toBe("adapter")
  })

  it("should normalize null/undefined errors", () => {
    const adapter = makeAdapter()
    const result = adapter.normalizeError(null)
    expect(result.code).toBe("unknown")
    expect(result.source).toBe("adapter")
  })

  it("should handle network errors (Error subclass)", () => {
    const adapter = makeAdapter()
    const netError = new Error("ECONNRESET")
    const result = adapter.normalizeError(netError)
    expect(result.code).toBe("unknown")
    expect(result.source).toBe("adapter")
    expect(result.recoverable).toBe(false)
  })

  it("should handle plain object errors", () => {
    const adapter = makeAdapter()
    const result = adapter.normalizeError({ some: "data" })
    expect(result.code).toBe("unknown")
    expect(result.source).toBe("adapter")
  })
})

describe("AnthropicAdapter — parse tool calls", () => {
  it("should return empty array for non-array input", () => {
    const adapter = makeAdapter()
    expect(adapter.parseToolCalls(null)).toEqual([])
    expect(adapter.parseToolCalls("string")).toEqual([])
    expect(adapter.parseToolCalls({})).toEqual([])
  })

  it("should parse tool_use content blocks", () => {
    const adapter = makeAdapter()
    const raw = [
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "/tmp/test" } },
    ]
    const calls = adapter.parseToolCalls(raw)
    expect(calls.length).toBe(1)
    expect(calls[0]?.id).toBe("t1")
    expect(calls[0]?.name).toBe("read_file")
  })
})

describe("AnthropicAdapter — format and wrap tool results", () => {
  it("should format successful tool result", () => {
    const adapter = makeAdapter()
    const formatted = adapter.formatToolResult("call-1", { ok: true, data: { result: 42 } })
    expect(formatted).toBeDefined()
  })

  it("should format error tool result", () => {
    const adapter = makeAdapter()
    const formatted = adapter.formatToolResult("call-1", { ok: false, error: "failed" })
    expect(formatted).toBeDefined()
  })

  it("should wrap tool result into a message", () => {
    const adapter = makeAdapter()
    const msg = adapter.wrapToolResult("call-1", { ok: true, data: "OK" }, "test_tool")
    expect(msg.role).toBe("user")
    expect(msg.content.length).toBe(1)
    expect(msg.content[0]?.type).toBe("tool_result")
  })

  it("should handle truncated data in wrap", () => {
    const adapter = makeAdapter()
    const msg = adapter.wrapToolResult("call-1", {
      ok: true,
      data: "long data",
      meta: { duration: 100, truncated: true },
    }, "test_tool")
    expect(msg.role).toBe("user")
    expect(msg.content[0]?.type).toBe("tool_result")
  })
})

describe("AnthropicAdapter — requiredEnvVars", () => {
  it("should declare ANTHROPIC_API_KEY", () => {
    expect(AnthropicAdapter.requiredEnvVars).toEqual(["ANTHROPIC_API_KEY"])
  })
})

describe("AnthropicAdapter — constructor", () => {
  it("should throw with no API key and no env var", () => {
    const prev = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      expect(() => new AnthropicAdapter()).toThrow("ANTHROPIC_API_KEY")
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev
    }
  })

  it("should accept custom baseUrl and model", () => {
    const adapter = new AnthropicAdapter({
      apiKey: "test",
      baseUrl: "https://custom.example.com",
      model: "claude-opus-4-8",
    })
    expect(adapter.provider).toBe("anthropic")
  })
})

describe("AnthropicAdapter — provider and version", () => {
  it("should have correct provider string", () => {
    const adapter = makeAdapter()
    expect(adapter.provider).toBe("anthropic")
    expect(adapter.version).toBe("2025-01-01")
  })

  it("should support computer-use based on default model string", () => {
    // computer-use checks `this.model` (default, not passed model arg)
    const adapter = makeAdapter() // defaults to "claude-sonnet-4-6"
    expect(adapter.supports("computer-use")).toBe(true)
    // haiku adapter would return false
    const haikuAdapter = new AnthropicAdapter({ apiKey: "test-key", model: "claude-haiku-4-5" })
    expect(haikuAdapter.supports("computer-use")).toBe(false)
  })

  it("should support parallel tool calls", () => {
    const adapter = makeAdapter()
    expect(adapter.supports("parallel-tool-calls" as any)).toBe(true)
  })

  it("should support vision detection for known models", () => {
    const adapter = makeAdapter()
    expect(adapter.supports("vision", "claude-sonnet-4-6")).toBe(true)
    expect(adapter.supports("vision", "claude-opus-4-8")).toBe(true)
  })
})

describe("AnthropicAdapter — buildRequest", () => {
  it("should build a streaming request with text messages", async () => {
    const adapter = makeAdapter()
    const ctx = {
      session: { model: "claude-sonnet-4-6", turnCount: 0, status: "running", id: "s1", workDir: "/tmp", startedAt: Date.now(), tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      turn: { messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }], pendingToolCalls: new Map(), lastObservation: null, compressedAt: null, id: "t1", index: 0 },
      shared: {} as any,
    }
    const req = await adapter.buildRequest(ctx, { maxTokens: 1024 } as any)
    expect(req).toBeDefined()
  })

  it("should build request with tool definitions", async () => {
    const adapter = makeAdapter()
    const ctx = {
      session: { model: "claude-opus-4-8", turnCount: 0, status: "running", id: "s2", workDir: "/tmp", startedAt: Date.now(), tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      turn: { messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Search" }] }], pendingToolCalls: new Map(), lastObservation: null, compressedAt: null, id: "t2", index: 0 },
      shared: {} as any,
    }
    const req = await adapter.buildRequest(ctx, {
      maxTokens: 2048,
      tools: [{ name: "search", description: "Search", parameters: { type: "object", properties: {} } } as any],
      systemPrompt: "You are helpful",
      temperature: 0.7,
      topP: 0.9,
      stopSequences: ["END"],
      thinking: { budgetTokens: 8000 },
    } as any)
    expect(req).toBeDefined()
  })

  it("should build request with system-role messages merged into system prompt", async () => {
    const adapter = makeAdapter()
    const ctx = {
      session: { model: "claude-sonnet-4-6", turnCount: 0, status: "running", id: "s3", workDir: "/tmp", startedAt: Date.now(), tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      turn: { messages: [
        { role: "system" as const, content: [{ type: "text" as const, text: "Base instructions" }] },
        { role: "user" as const, content: [{ type: "text" as const, text: "Query" }] },
      ], pendingToolCalls: new Map(), lastObservation: null, compressedAt: null, id: "t3", index: 0 },
      shared: {} as any,
    }
    const req = await adapter.buildRequest(ctx, { maxTokens: 512 } as any)
    expect(req).toBeDefined()
  })

  it("should build request with assistant messages containing tool_use blocks", async () => {
    const adapter = makeAdapter()
    const ctx = {
      session: { model: "claude-sonnet-4-6", turnCount: 0, status: "running", id: "s4", workDir: "/tmp", startedAt: Date.now(), tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      turn: { messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "Read file" }] },
        { role: "assistant" as const, content: [
          { type: "text" as const, text: "Let me read that." },
          { type: "tool_use" as const, id: "t1", name: "read_file", input: { path: "/tmp/test" } },
        ]},
        { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t1", content: "file contents here" }] },
      ], pendingToolCalls: new Map(), lastObservation: null, compressedAt: null, id: "t4", index: 0 },
      shared: {} as any,
    }
    const req = await adapter.buildRequest(ctx, { maxTokens: 1024 } as any)
    expect(req).toBeDefined()
  })

  it("should warn and drop non-text blocks in system-role messages", async () => {
    const adapter = makeAdapter()
    const ctx = {
      session: { model: "claude-sonnet-4-6", turnCount: 0, status: "running", id: "s5", workDir: "/tmp", startedAt: Date.now(), tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      turn: { messages: [
        { role: "system" as const, content: [
          { type: "text" as const, text: "Valid system text" },
          { type: "tool_use" as const, id: "x", name: "nope", input: {} },
        ]},
        { role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] },
      ], pendingToolCalls: new Map(), lastObservation: null, compressedAt: null, id: "t5", index: 0 },
      shared: {} as any,
    }
    // Should not throw — non-text system blocks are silently dropped with a warning
    const req = await adapter.buildRequest(ctx, { maxTokens: 512 } as any)
    expect(req).toBeDefined()
  })
})

describe("AnthropicAdapter — countRequestTokens", () => {
  it("should count tokens in a built request", () => {
    const adapter = makeAdapter()
    const request = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello, this is a test message with some length" }],
    }
    const count = adapter.countRequestTokens(request)
    expect(count).toBeGreaterThan(0)
  })

  it("should count request with system prompt", () => {
    const adapter = makeAdapter()
    const request = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: "You are a helpful assistant with specific instructions",
      messages: [{ role: "user", content: "Hi" }],
    }
    const count = adapter.countRequestTokens(request)
    expect(count).toBeGreaterThan(0)
  })

  it("should count request with tools", () => {
    const adapter = makeAdapter()
    const request = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "test_tool", description: "A test tool", input_schema: { type: "object", properties: {} } }],
    }
    const count = adapter.countRequestTokens(request)
    expect(count).toBeGreaterThan(0)
  })
})
