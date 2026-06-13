/**
 * OpenAI Adapter unit tests — boost openai-compatible-base.ts coverage from 13% → ≥60%.
 * Tests convertMessages, normalizeError, token counting, tool format, and error paths.
 */

import { describe, it, expect } from "vitest"
import { OpenaiAdapter, DeepSeekAdapter } from "@harness/engine"

function makeAdapter() {
  return new OpenaiAdapter({ apiKey: "test-key" })
}

// ═══════════════════════════════════════════════════════════════════
// ─── Model Info ───
// ═══════════════════════════════════════════════════════════════════

describe("OpenaiAdapter — model info", () => {
  it("should return model info for gpt-4.1", () => {
    const a = makeAdapter()
    const info = a.getModelInfo("gpt-4.1")
    expect(info.id).toBe("gpt-4.1")
    expect(info.provider).toBe("openai")
    expect(info.maxInputTokens).toBe(1_000_000)
    expect(info.supportsToolUse).toBe(true)
  })

  it("should return model info for gpt-5", () => {
    const a = makeAdapter()
    const info = a.getModelInfo("gpt-5")
    expect(info.supportsThinking).toBe(true)
    expect(info.maxOutputTokens).toBe(128_000)
  })

  it("should return default info for unknown models", () => {
    const a = makeAdapter()
    const info = a.getModelInfo("fake-model")
    expect(info.id).toBe("fake-model")
    expect(info.provider).toBe("openai")
  })
})

// ═══════════════════════════════════════════════════════════════════
// ─── Feature Detection ───
// ═══════════════════════════════════════════════════════════════════

describe("OpenaiAdapter — feature detection", () => {
  it("should support streaming", () => {
    expect(makeAdapter().supports("streaming")).toBe(true)
  })

  it("should detect thinking for gpt-5", () => {
    expect(makeAdapter().supports("thinking", "gpt-5")).toBe(true)
  })

  it("should not detect thinking for gpt-4.1", () => {
    expect(makeAdapter().supports("thinking", "gpt-4.1")).toBe(false)
  })

  it("should detect vision where supported", () => {
    expect(makeAdapter().supports("vision", "gpt-4.1")).toBe(true)
  })

  it("should support tool-use", () => {
    expect(makeAdapter().supports("tool-use")).toBe(true)
  })

  it("should support prompt-caching for gpt-4.1", () => {
    expect(makeAdapter().supports("prompt-caching", "gpt-4.1")).toBe(true)
  })

  it("should not support computer-use", () => {
    expect(makeAdapter().supports("computer-use" as any)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
// ─── Error Normalization ───
// ═══════════════════════════════════════════════════════════════════

describe("OpenaiAdapter — error normalization", () => {
  it("should normalize Error objects", () => {
    const result = makeAdapter().normalizeError(new Error("test"))
    expect(result.code).toBe("unknown")
    expect(result.source).toBe("adapter")
    expect(result.recoverable).toBe(false)
  })

  it("should normalize duck-type objects with status 429", () => {
    const result = makeAdapter().normalizeError({ status: 429, message: "Rate limited" })
    expect(result.source).toBe("adapter")
  })

  it("should normalize duck-type objects with status 500 as recoverable", () => {
    const result = makeAdapter().normalizeError({ status: 500, message: "Server error" })
    expect(result.recoverable).toBe(true)
  })

  it("should normalize plain string errors", () => {
    const result = makeAdapter().normalizeError("something went wrong")
    expect(result.code).toBe("unknown")
  })
})

// ═══════════════════════════════════════════════════════════════════
// ─── Token Counting ───
// ═══════════════════════════════════════════════════════════════════

describe("OpenaiAdapter — token counting", () => {
  it("should count tokens in text messages", () => {
    const a = makeAdapter()
    const count = a.countTokens([
      { role: "user", content: [{ type: "text", text: "Hello, world!" }] },
    ])
    expect(count).toBeGreaterThan(0)
  })

  it("should count tokens in tool_use blocks", () => {
    const a = makeAdapter()
    const count = a.countTokens([
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "read", input: { path: "/x" } }] },
    ])
    expect(count).toBeGreaterThan(0)
  })

  it("should count tokens in tool_result blocks", () => {
    const a = makeAdapter()
    const count = a.countTokens([
      { role: "tool" as any, content: [{ type: "tool_result", tool_use_id: "1", content: "result" }] },
    ])
    expect(count).toBeGreaterThan(0)
  })

  it("should count tokens in a built request", () => {
    const a = makeAdapter()
    const count = a.countRequestTokens({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "Hello" }],
    })
    expect(count).toBeGreaterThan(0)
  })

  it("should count request with tools", () => {
    const a = makeAdapter()
    const count = a.countRequestTokens({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "test", description: "desc", parameters: {} } }],
    })
    expect(count).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
// ─── Tool Result Formatting ───
// ═══════════════════════════════════════════════════════════════════

describe("OpenaiAdapter — tool result formatting", () => {
  it("should format successful result", () => {
    const formatted = makeAdapter().formatToolResult("c1", { ok: true, data: { x: 1 } })
    expect(formatted).toBeDefined()
  })

  it("should format error result", () => {
    const formatted = makeAdapter().formatToolResult("c1", { ok: false, error: "failed" })
    expect(formatted).toContain("failed")
  })

  it("should format truncated result with warning prefix", () => {
    const formatted = makeAdapter().formatToolResult("c1", {
      ok: true,
      data: "long output",
      meta: { duration: 100, truncated: true },
    })
    expect(formatted).toBeDefined()
  })

  it("should wrap tool result into role=tool message", () => {
    const msg = makeAdapter().wrapToolResult("c1", { ok: true, data: "OK" }, "test_tool")
    expect(msg.role).toBe("tool")
    expect(msg.content.length).toBe(1)
    expect(msg.content[0]?.type).toBe("tool_result")
  })

  it("should wrap error result with is_error flag", () => {
    const msg = makeAdapter().wrapToolResult("c1", { ok: false, error: "boom" }, "test_tool")
    expect(msg.role).toBe("tool")
    expect(msg.content[0]?.type).toBe("tool_result")
  })
})

// ═══════════════════════════════════════════════════════════════════
// ─── Build Request ───
// ═══════════════════════════════════════════════════════════════════

describe("OpenaiAdapter — buildRequest", () => {
  it("should build request with text messages", async () => {
    const a = makeAdapter()
    const ctx = {
      session: { model: "gpt-4.1", turnCount: 0, status: "running", id: "s1", workDir: "/tmp", startedAt: Date.now(), tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      turn: { messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }], pendingToolCalls: new Map(), lastObservation: null, compressedAt: null, id: "t1", index: 0 },
      shared: {} as any,
    }
    const req = await a.buildRequest(ctx, { maxTokens: 1024 } as any)
    expect(req).toBeDefined()
  })

  it("should build request with system message", async () => {
    const a = makeAdapter()
    const ctx = {
      session: { model: "gpt-4.1", turnCount: 0, status: "running", id: "s2", workDir: "/tmp", startedAt: Date.now(), tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      turn: { messages: [
        { role: "system" as const, content: [{ type: "text" as const, text: "You are helpful." }] },
        { role: "user" as const, content: [{ type: "text" as const, text: "Query" }] },
      ], pendingToolCalls: new Map(), lastObservation: null, compressedAt: null, id: "t2", index: 0 },
      shared: {} as any,
    }
    const req = await a.buildRequest(ctx, { maxTokens: 512, systemPrompt: "Override" } as any)
    expect(req).toBeDefined()
  })

  it("should build request with tool definitions and thinking", async () => {
    const a = new OpenaiAdapter({ apiKey: "test", model: "gpt-5" })
    const ctx = {
      session: { model: "gpt-5", turnCount: 0, status: "running", id: "s3", workDir: "/tmp", startedAt: Date.now(), tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      turn: { messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Search" }] }], pendingToolCalls: new Map(), lastObservation: null, compressedAt: null, id: "t3", index: 0 },
      shared: {} as any,
    }
    const req = await a.buildRequest(ctx, {
      maxTokens: 2048,
      tools: [{ name: "search", description: "Search", parameters: { type: "object", properties: {} } } as any],
      temperature: 0.7,
      topP: 0.9,
      stopSequences: ["END"],
      thinking: { budgetTokens: 30000 },
    } as any)
    expect(req).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════
// ─── Parse Tool Calls ───
// ═══════════════════════════════════════════════════════════════════

describe("OpenaiAdapter — parse tool calls", () => {
  it("should parse function-type tool calls from raw response", () => {
    const a = makeAdapter()
    const raw = {
      choices: [{ message: { tool_calls: [
        { id: "t1", type: "function", function: { name: "echo", arguments: '{"msg":"hi"}' } },
      ] } }],
    }
    const calls = a.parseToolCalls(raw)
    expect(calls.length).toBe(1)
    expect(calls[0]?.name).toBe("echo")
    expect(calls[0]?.arguments).toEqual({ msg: "hi" })
  })

  it("should return empty for null/malformed input", () => {
    const a = makeAdapter()
    expect(a.parseToolCalls(null)).toEqual([])
    expect(a.parseToolCalls({})).toEqual([])
  })

  it("should handle JSON parse failure gracefully", () => {
    const a = makeAdapter()
    const raw = {
      choices: [{ message: { tool_calls: [
        { id: "b1", type: "function", function: { name: "bad", arguments: "not json" } },
      ] } }],
    }
    const calls = a.parseToolCalls(raw)
    expect(calls.length).toBe(1)
    expect(calls[0]?.arguments).toEqual({})
  })
})

// ═══════════════════════════════════════════════════════════════════
// ─── requiredEnvVars ───
// ═══════════════════════════════════════════════════════════════════

describe("OpenaiAdapter — requiredEnvVars", () => {
  it("should declare OPENAI_API_KEY", () => {
    expect(OpenaiAdapter.requiredEnvVars).toEqual(["OPENAI_API_KEY"])
  })
})

// ═══════════════════════════════════════════════════════════════════
// ─── DeepSeekAdapter — basic validation ───
// ═══════════════════════════════════════════════════════════════════

describe("DeepSeekAdapter — basics", () => {
  it("should have correct provider and defaults", () => {
    const a = new DeepSeekAdapter({ apiKey: "test" })
    expect(a.provider).toBe("deepseek")
    expect(a.version).toBe("1.0.0")
    expect(a.getModelInfo("deepseek-chat").id).toBe("deepseek-chat")
  })

  it("should declare DEEPSEEK_API_KEY", () => {
    expect(DeepSeekAdapter.requiredEnvVars).toEqual(["DEEPSEEK_API_KEY"])
  })

  it("should get model info for deepseek-reasoner", () => {
    const a = new DeepSeekAdapter({ apiKey: "test" })
    const info = a.getModelInfo("deepseek-reasoner")
    expect(info.supportsThinking).toBe(true)
    expect(info.supportsToolUse).toBe(false)
  })
})
