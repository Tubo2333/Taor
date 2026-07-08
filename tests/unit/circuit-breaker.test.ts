/**
 * Circuit Breaker — Unit Tests (GAP-7)
 *
 * Tests the 3-state circuit breaker: CLOSED → OPEN → HALF_OPEN → CLOSED cycle.
 * Uses a mock LLMAdapter that can be made to succeed or fail on demand.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { CircuitBreakerAdapter, CircuitBreakerOpenError } from "@taor/adapters"
import type { LLMAdapter, ThinkEvent, AdapterRequest } from "@taor/adapters"
import type { Message, TurnContext, HarnessError } from "@taor/core"
import type { ToolDescriptor, ToolResult } from "@taor/tools"

// ═══════════════════════════════════════════════════════════════════
// ─── Mock Adapter ───
// ═══════════════════════════════════════════════════════════════════

type ThinkMode = "success" | "fail" | "fail-once"

function createMockAdapter(thinkMode: ThinkMode = "success"): LLMAdapter {
  let firstCall = true
  return {
    provider: "mock",
    version: "1.0.0",
    getModelInfo: () => ({
      id: "mock-model",
      provider: "mock",
      maxInputTokens: 1000,
      maxOutputTokens: 500,
      supportsThinking: false,
      supportsVision: false,
      supportsPromptCaching: false,
      supportsToolUse: false,
      costPer1kInput: 0,
      costPer1kOutput: 0,
    }),
    supports: () => true,
    buildRequest: async () => ({ mock: true }),
    think: async function* (): AsyncGenerator<ThinkEvent> {
      if (thinkMode === "fail") {
        throw new Error("Mock adapter failure")
      }
      if (thinkMode === "fail-once") {
        if (firstCall) {
          firstCall = false
          throw new Error("Mock adapter first-call failure")
        }
      }
      yield { type: "text", content: "mock response" }
      yield { type: "stop", reason: "end_turn", usage: { input: 10, output: 5 } }
    },
    parseToolCalls: () => [],
    formatToolResult: () => ({}),
    wrapToolResult: (_callId, _result) => ({ role: "user", content: "" } as Message),
    countTokens: () => 0,
    countRequestTokens: () => 0,
    normalizeError: (err) => ({
      code: "adapter_error",
      message: (err as Error).message,
      retryable: false,
    } as HarnessError),
  }
}

// Helper to drive the async generator
async function driveThink(
  adapter: LLMAdapter,
): Promise<ThinkEvent[]> {
  const events: ThinkEvent[] = []
  const gen = adapter.think({ mock: true } as AdapterRequest, new AbortController().signal)
  for await (const ev of gen) {
    events.push(ev)
  }
  return events
}

// ═══════════════════════════════════════════════════════════════════
// ─── Tests ───
// ═══════════════════════════════════════════════════════════════════

describe("GAP-7: Circuit Breaker", () => {
  // ── Test 1: Normal pass-through (CLOSED state) ──

  describe("CLOSED state — normal pass-through", () => {
    it("should delegate think() to inner adapter and return events", async () => {
      const inner = createMockAdapter("success")
      const breaker = new CircuitBreakerAdapter(inner)

      const events = await driveThink(breaker)
      expect(events).toHaveLength(2)
      expect(events[0]?.type).toBe("text")
      expect(breaker.getState()).toBe("CLOSED")
      expect(breaker.getFailureCount()).toBe(0)
    })

    it("should delegate provider/version/getModelInfo to inner adapter", () => {
      const inner = createMockAdapter("success")
      const breaker = new CircuitBreakerAdapter(inner)

      expect(breaker.provider).toBe("mock")
      expect(breaker.version).toBe("1.0.0")
      expect(breaker.getModelInfo("any").id).toBe("mock-model")
    })

    it("should delegate buildRequest to inner adapter", async () => {
      const inner = createMockAdapter("success")
      const breaker = new CircuitBreakerAdapter(inner)

      const req = await breaker.buildRequest({} as TurnContext, {})
      expect(req).toEqual({ mock: true })
    })
  })

  // ── Test 2: N failures → OPEN ──

  describe("CLOSED → OPEN transition", () => {
    it("should transition to OPEN after N failures in window", async () => {
      const inner = createMockAdapter("fail")
      const breaker = new CircuitBreakerAdapter(inner, {
        failureThreshold: 3,
        windowDuration: 10_000, // 10s window
      })

      // Cause 3 failures
      for (let i = 0; i < 3; i++) {
        await expect(driveThink(breaker)).rejects.toThrow("Mock adapter failure")
      }

      // Breaker should be OPEN now
      expect(breaker.getState()).toBe("OPEN")

      // Next call should throw CircuitBreakerOpenError
      await expect(driveThink(breaker)).rejects.toThrow(CircuitBreakerOpenError)
    })

    it("should NOT open if failures are below threshold", async () => {
      const inner = createMockAdapter("fail")
      const breaker = new CircuitBreakerAdapter(inner, {
        failureThreshold: 5,
        windowDuration: 10_000,
      })

      // Cause 4 failures (below threshold of 5)
      for (let i = 0; i < 4; i++) {
        await expect(driveThink(breaker)).rejects.toThrow("Mock adapter failure")
      }

      // Breaker should still be CLOSED
      expect(breaker.getState()).toBe("CLOSED")
      expect(breaker.getFailureCount()).toBe(4)
    })

    it("should prune stale failures outside the sliding window", async () => {
      const inner = createMockAdapter("fail")
      const breaker = new CircuitBreakerAdapter(inner, {
        failureThreshold: 3,
        windowDuration: 50, // very short window for test
      })

      // Cause 2 failures
      for (let i = 0; i < 2; i++) {
        await expect(driveThink(breaker)).rejects.toThrow("Mock adapter failure")
      }

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 60))

      // Stale failures should be pruned
      expect(breaker.getFailureCount()).toBe(0)

      // 1 more failure — still below threshold
      await expect(driveThink(breaker)).rejects.toThrow("Mock adapter failure")
      expect(breaker.getState()).toBe("CLOSED")
    })
  })

  // ── Test 3: OPEN → HALF_OPEN after timeout ──

  describe("OPEN → HALF_OPEN transition", () => {
    it("should transition to HALF_OPEN after recoveryTimeout", async () => {
      const inner = createMockAdapter("fail")
      const breaker = new CircuitBreakerAdapter(inner, {
        failureThreshold: 2,
        recoveryTimeout: 100, // short recovery timeout
        windowDuration: 10_000,
      })

      // Cause 2 failures to OPEN the breaker
      for (let i = 0; i < 2; i++) {
        await expect(driveThink(breaker)).rejects.toThrow("Mock adapter failure")
      }
      expect(breaker.getState()).toBe("OPEN")

      // Wait for recovery timeout
      await new Promise((resolve) => setTimeout(resolve, 120))

      // Next call — should enter HALF_OPEN, and since adapter is "fail",
      // it will fail and go back to OPEN
      await expect(driveThink(breaker)).rejects.toThrow("Mock adapter failure")
      // Should be back to OPEN after HALF_OPEN failure
      expect(breaker.getState()).toBe("OPEN")
    })
  })

  // ── Test 4: HALF_OPEN success → CLOSED ──

  describe("HALF_OPEN success → CLOSED", () => {
    it("should transition back to CLOSED on success in HALF_OPEN", async () => {
      // Use fail-once: first call fails, subsequent calls succeed
      const inner = createMockAdapter("fail-once")
      const breaker = new CircuitBreakerAdapter(inner, {
        failureThreshold: 1,
        recoveryTimeout: 50,
        windowDuration: 10_000,
      })

      // First call fails → OPEN
      await expect(driveThink(breaker)).rejects.toThrow("Mock adapter first-call failure")
      expect(breaker.getState()).toBe("OPEN")

      // Wait for recovery
      await new Promise((resolve) => setTimeout(resolve, 60))

      // Second call succeeds (fail-once: firstCall is already false)
      const events = await driveThink(breaker)
      expect(events).toHaveLength(2)
      expect(breaker.getState()).toBe("CLOSED")
      expect(breaker.getFailureCount()).toBe(0)
    })
  })

  // ── Test 5: HALF_OPEN failure → OPEN ──

  describe("HALF_OPEN failure → OPEN", () => {
    it("should go back to OPEN if HALF_OPEN request fails", async () => {
      const inner = createMockAdapter("fail")
      const breaker = new CircuitBreakerAdapter(inner, {
        failureThreshold: 1,
        recoveryTimeout: 50,
        windowDuration: 10_000,
      })

      // 1 failure → OPEN
      await expect(driveThink(breaker)).rejects.toThrow("Mock adapter failure")
      expect(breaker.getState()).toBe("OPEN")

      // Wait for recovery timeout
      await new Promise((resolve) => setTimeout(resolve, 60))

      // HALF_OPEN → fails → back to OPEN
      await expect(driveThink(breaker)).rejects.toThrow("Mock adapter failure")
      expect(breaker.getState()).toBe("OPEN")
    })
  })

  // ── Test 6: CircuitBreakerOpenError ──

  describe("CircuitBreakerOpenError", () => {
    it("should include retryAfterMs in error message", () => {
      const err = new CircuitBreakerOpenError(15_000)
      expect(err.name).toBe("CircuitBreakerOpenError")
      expect(err.retryAfterMs).toBe(15_000)
      expect(err.message).toContain("15s")
    })

    it("should NOT trip the breaker (no infinite loop)", async () => {
      const inner = createMockAdapter("fail")
      const breaker = new CircuitBreakerAdapter(inner, {
        failureThreshold: 1,
        recoveryTimeout: 10_000,
      })

      // 1 failure → OPEN
      await expect(driveThink(breaker)).rejects.toThrow("Mock adapter failure")
      expect(breaker.getState()).toBe("OPEN")

      // OPEN → throws CircuitBreakerOpenError (does NOT count as failure)
      await expect(driveThink(breaker)).rejects.toThrow(CircuitBreakerOpenError)
      await expect(driveThink(breaker)).rejects.toThrow(CircuitBreakerOpenError)
      await expect(driveThink(breaker)).rejects.toThrow(CircuitBreakerOpenError)

      // Should still be OPEN, not tripped by the CircuitBreakerOpenError
      expect(breaker.getState()).toBe("OPEN")
    })
  })

  // ── Test 7: Default configuration ──

  describe("Default configuration", () => {
    it("should use defaults when no config provided", () => {
      const inner = createMockAdapter("success")
      const breaker = new CircuitBreakerAdapter(inner)

      expect(breaker.getState()).toBe("CLOSED")
      expect(breaker.getFailureCount()).toBe(0)
    })

    it("should accept partial config overrides", async () => {
      const inner = createMockAdapter("fail")
      const breaker = new CircuitBreakerAdapter(inner, {
        failureThreshold: 2,
      })

      // Cause 2 failures with custom threshold
      for (let i = 0; i < 2; i++) {
        await expect(driveThink(breaker)).rejects.toThrow("Mock adapter failure")
      }

      expect(breaker.getState()).toBe("OPEN")
    })
  })

  // ── Test 8: getInner() access ──

  describe("getInner()", () => {
    it("should return the inner adapter", () => {
      const inner = createMockAdapter("success")
      const breaker = new CircuitBreakerAdapter(inner)

      expect(breaker.getInner()).toBe(inner)
    })
  })
})
