/**
 * Enhanced MockAdapter — shared test fixture for integration tests.
 *
 * Supports: multi-turn scenarios, tool call simulation, error injection,
 * token usage reporting, and stop reason control.
 */

import type { TurnContext, HarnessError } from "@harness/core"
import type { ToolDescriptor } from "@harness/tools"

// ─── Configuration types ───

export interface MockThinkYield {
  type: "text" | "thinking" | "tool_use" | "stop" | "error"
  content?: string
  call?: { id: string; name: string; arguments: Record<string, unknown> }
  reason?: string
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  error?: HarnessError
}

export interface MockTurn {
  /** Events to yield in this turn's think() call, in order.
   *  Must end with a "stop" event for the turn to complete normally. */
  yields: MockThinkYield[]
  /** If set, throw this error instead of yielding events */
  throwError?: Error
  /** Delay in ms before each yield (simulates network latency) */
  delay?: number
}

export interface MockAdapterConfig {
  /** Sequence of turns. Each think() call consumes the next turn. */
  turns?: MockTurn[]
  /** Custom model info overrides */
  modelInfoOverrides?: Record<string, Partial<ReturnType<MockAdapter["getModelInfo"]>>>
  /** Default token usage for stops that don't specify one */
  defaultUsage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  /** Role for wrapToolResult: "user" (Anthropic default) or "tool" (OpenAI). */
  wrapToolResultRole?: "user" | "tool"
}

/**
 * Enhanced mock adapter for integration testing.
 *
 * Usage:
 * ```ts
 * const mock = new MockAdapter({
 *   turns: [
 *     { yields: [{type:"text", content:"Hello"},{type:"stop",reason:"end_turn"}] },
 *     { yields: [{type:"tool_use", call:{id:"1",name:"echo",arguments:{x:1}}},{type:"stop",reason:"tool_use"}] },
 *   ],
 * })
 * ```
 */
export class MockAdapter {
  readonly provider = "mock"
  readonly version = "1.0.0"

  private turns: MockTurn[]
  private turnIndex = 0
  private modelInfoOverrides: MockAdapterConfig["modelInfoOverrides"]
  private defaultUsage: Required<MockAdapterConfig["defaultUsage"]> extends infer T ? T : never
  private _wrapToolResultRole: "user" | "tool"

  /** Expose the number of think() calls made (for assertions) */
  thinkCallCount = 0
  /** Expose the last request passed to think() */
  lastRequest: unknown = null

  constructor(config: MockAdapterConfig = {}) {
    this.turns = config.turns ?? [{
      yields: [
        { type: "text", content: "Mock response" },
        { type: "stop", reason: "end_turn", usage: { input: 10, output: 5 } },
      ],
    }]
    this.modelInfoOverrides = config.modelInfoOverrides ?? {}
    this._wrapToolResultRole = config.wrapToolResultRole ?? "user"
    this.defaultUsage = {
      input: config.defaultUsage?.input ?? 10,
      output: config.defaultUsage?.output ?? 5,
      cacheRead: config.defaultUsage?.cacheRead ?? 0,
      cacheWrite: config.defaultUsage?.cacheWrite ?? 0,
    }
  }

  getModelInfo(model: string) {
    const base = {
      id: model,
      maxInputTokens: 200_000,
      maxOutputTokens: 8_000,
    }
    if (this.modelInfoOverrides?.[model]) {
      return { ...base, ...this.modelInfoOverrides[model] }
    }
    return base
  }

  supports(_feature: string, _model?: string): boolean {
    return false
  }

  async buildRequest(
    _ctx: TurnContext,
    _opts: { systemPrompt?: string; maxTokens?: number; temperature?: number; tools?: ToolDescriptor[] },
  ): Promise<unknown> {
    return { mock: true }
  }

  async *think(
    _request: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<
    {
      type: string
      content?: string
      call?: { id: string; name: string; arguments: Record<string, unknown> }
      reason?: string
      usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
      error?: HarnessError
    },
    void,
    void
  > {
    this.thinkCallCount++
    this.lastRequest = _request

    const turn = this.turns[this.turnIndex]
    this.turnIndex = (this.turnIndex + 1) % this.turns.length

    // If no turn configured, yield a default text + stop
    if (!turn) {
      if (signal.aborted) return
      yield { type: "text", content: "Default mock response" }
      yield { type: "stop", reason: "end_turn", usage: this.defaultUsage }
      return
    }

    // Error injection
    if (turn.throwError) {
      throw turn.throwError
    }

    // Yield configured events
    for (const event of turn.yields) {
      if (signal.aborted) return

      // Apply delay if configured
      if (turn.delay && turn.delay > 0) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, turn.delay!)
          signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("Aborted")) }, { once: true })
        })
      }

      if (event.type === "stop") {
        // Ensure usage is populated
        const usage = event.usage ?? this.defaultUsage
        yield { type: "stop", reason: event.reason ?? "end_turn", usage }
      } else if (event.type === "tool_use") {
        yield {
          type: "tool_use",
          call: event.call ?? { id: "mock-call", name: "mock_tool", arguments: {} },
        }
      } else if (event.type === "error") {
        yield { type: "error", error: event.error! }
      } else {
        yield event as any
      }
    }
  }

  formatToolResult(
    _callId: string,
    result: { ok: boolean; data?: unknown; error?: string },
  ): unknown {
    return result.ok ? JSON.stringify(result.data) : result.error ?? "tool error"
  }

  wrapToolResult(
    callId: string,
    result: { ok: boolean; data?: unknown; error?: string },
    _toolName?: string,
  ): { role: string; content: { type: string; tool_use_id: string; content: string; is_error?: boolean }[] } {
    const block: { type: string; tool_use_id: string; content: string; is_error?: boolean } = {
      type: "tool_result",
      tool_use_id: callId,
      content: result.ok ? (typeof result.data === "string" ? result.data : JSON.stringify(result.data ?? "OK")) : result.error ?? "error",
    }
    if (!result.ok) block.is_error = true
    return { role: this._wrapToolResultRole, content: [block] }
  }

  parseToolCalls(_content: unknown): { id: string; name: string; arguments: Record<string, unknown> }[] {
    return []
  }

  countTokens(messages: unknown[]): number {
    return JSON.stringify(messages).length / 4
  }

  countRequestTokens(_request: unknown): number {
    return 50
  }

  normalizeError(error: unknown): HarnessError {
    return {
      code: "mock_error",
      message: error instanceof Error ? error.message : String(error),
      source: "adapter",
      recoverable: false,
      cause: error,
      timestamp: Date.now(),
    }
  }
}
