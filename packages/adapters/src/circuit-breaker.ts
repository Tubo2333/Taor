// @harness/adapters — CircuitBreakerAdapter (GAP-7)
//
// Decorator pattern wrapping LLMAdapter. Standard 3-state breaker:
// CLOSED → OPEN → HALF_OPEN → CLOSED.
//
// ## Design decisions
//
// - Resides in @harness/adapters, NOT @harness/core (adapter concern)
// - Decorates LLMAdapter — transparent to the TAOR loop
// - Auto-wrapped by createHarness() when HarnessConfig.circuitBreaker is set
// - Manual wrapping also supported (pass CircuitBreakerAdapter as `adapter` + circuitBreaker: false)
//
// ## Failure counting
//
// Uses a sliding time window (config.windowDuration). Failures older than
// the window are pruned on each onFailure() call. This prevents stale
// failures from keeping the breaker OPEN indefinitely.
//
// ## Half-open semantics
//
// Only `halfOpenMaxRequests` requests are allowed in HALF_OPEN state.
// Additional requests throw CircuitBreakerOpenError just like OPEN state.

import type { LLMAdapter, ThinkEvent, AdapterRequest } from "./types.js"
import type { RequestOptions } from "./types.js"
import type { HarnessError, Message, TurnContext } from "@harness/core"
import type { ToolDescriptor, ToolResult } from "@harness/tools"

// ═══════════════════════════════════════════════════════════════════
// ─── Types ───
// ═══════════════════════════════════════════════════════════════════

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN"

export interface CircuitBreakerConfig {
  /** Number of failures within `windowDuration` before opening (default: 5). */
  failureThreshold?: number
  /** Time in ms before transitioning from OPEN to HALF_OPEN (default: 30_000). */
  recoveryTimeout?: number
  /** Maximum requests allowed in HALF_OPEN state (default: 1). */
  halfOpenMaxRequests?: number
  /** Sliding window duration in ms for failure counting (default: 60_000). */
  windowDuration?: number
}

export class CircuitBreakerOpenError extends Error {
  public readonly retryAfterMs: number

  constructor(retryAfterMs: number) {
    super(
      `Circuit breaker is OPEN. Retry after ${Math.round(retryAfterMs / 1000)}s.`,
    )
    this.name = "CircuitBreakerOpenError"
    this.retryAfterMs = retryAfterMs
  }
}

const DEFAULTS: Required<CircuitBreakerConfig> = {
  failureThreshold: 5,
  recoveryTimeout: 30_000,
  halfOpenMaxRequests: 1,
  windowDuration: 60_000,
}

// ═══════════════════════════════════════════════════════════════════
// ─── CircuitBreakerAdapter ───
// ═══════════════════════════════════════════════════════════════════

/**
 * Circuit breaker decorator for LLMAdapter.
 *
 * Wraps any LLMAdapter with a 3-state circuit breaker pattern.
 * Transparent to the TAOR loop — same interface, automatic state transitions.
 *
 * ## Usage
 *
 * ```ts
 * // Auto-wrap via createHarness (recommended):
 * createHarness({ model: "claude-sonnet-4-6", circuitBreaker: { failureThreshold: 5 } })
 *
 * // Manual wrapping:
 * const adapter = new CircuitBreakerAdapter(new AnthropicAdapter({ model: "..." }))
 * createHarness({ adapter: () => adapter, circuitBreaker: false })
 * ```
 */
export class CircuitBreakerAdapter implements LLMAdapter {
  // ── State ──

  private state: CircuitBreakerState = "CLOSED"
  private failures: number[] = [] // timestamps of failures (ms since epoch)
  private openedAt: number = 0
  private halfOpenInFlight: number = 0
  private config: Required<CircuitBreakerConfig>

  constructor(
    private inner: LLMAdapter,
    config: CircuitBreakerConfig = {},
  ) {
    this.config = { ...DEFAULTS, ...config }
  }

  // ── LLMAdapter interface (delegated) ──

  get provider(): string {
    return this.inner.provider
  }

  get version(): string {
    return this.inner.version
  }

  getModelInfo(model: string) {
    return this.inner.getModelInfo(model)
  }

  supports(feature: Parameters<LLMAdapter["supports"]>[0], model?: string): boolean {
    return this.inner.supports(feature, model)
  }

  buildRequest(ctx: TurnContext, opts: RequestOptions): Promise<AdapterRequest> {
    return this.inner.buildRequest(ctx, opts)
  }

  /**
   * Core interception point. Checks breaker state before delegating to inner adapter.
   *
   * - OPEN: checks if recovery timeout elapsed → HALF_OPEN, else throws
   * - HALF_OPEN: checks in-flight count against max, else throws
   * - CLOSED: passes through
   *
   * On inner success: reset failures, transition HALF_OPEN→CLOSED
   * On inner failure: record failure, potentially transition CLOSED→OPEN or HALF_OPEN→OPEN
   */
  async *think(request: AdapterRequest, signal: AbortSignal): AsyncGenerator<ThinkEvent> {
    // ── State check before delegating ──

    if (this.state === "OPEN") {
      const elapsed = Date.now() - this.openedAt
      if (elapsed < this.config.recoveryTimeout) {
        throw new CircuitBreakerOpenError(
          this.config.recoveryTimeout - elapsed,
        )
      }
      // Recovery timeout elapsed → transition to HALF_OPEN
      this.state = "HALF_OPEN"
      this.halfOpenInFlight = 0
    }

    if (this.state === "HALF_OPEN") {
      if (this.halfOpenInFlight >= this.config.halfOpenMaxRequests) {
        throw new CircuitBreakerOpenError(this.config.recoveryTimeout)
      }
      this.halfOpenInFlight++
    }

    // ── Delegate to inner adapter ──

    try {
      yield* this.inner.think(request, signal)
      this.onSuccess()
    } catch (err) {
      // Don't trip breaker for CircuitBreakerOpenError (would cause loop)
      if (err instanceof CircuitBreakerOpenError) {
        throw err
      }
      this.onFailure()
      throw err
    } finally {
      if (this.state === "HALF_OPEN") {
        this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1)
      }
    }
  }

  parseToolCalls(rawResponse: unknown) {
    return this.inner.parseToolCalls(rawResponse)
  }

  formatToolResult(callId: string, result: ToolResult) {
    return this.inner.formatToolResult(callId, result)
  }

  wrapToolResult(callId: string, result: ToolResult, toolName?: string): Message {
    return this.inner.wrapToolResult(callId, result, toolName)
  }

  countTokens(messages: Message[]): number {
    return this.inner.countTokens(messages)
  }

  countRequestTokens(request: AdapterRequest): number {
    return this.inner.countRequestTokens(request)
  }

  normalizeError(error: unknown): HarnessError {
    return this.inner.normalizeError(error)
  }

  // ── State machine transitions ──

  /**
   * Called when the inner adapter succeeds.
   * Resets failure count and transitions HALF_OPEN → CLOSED.
   */
  private onSuccess(): void {
    this.failures = []
    if (this.state === "HALF_OPEN") {
      this.state = "CLOSED"
    }
  }

  /**
   * Called when the inner adapter fails.
   * Records the failure timestamp and checks if the breaker should OPEN.
   */
  private onFailure(): void {
    const now = Date.now()

    // Prune stale failures (outside the sliding window)
    const windowStart = now - this.config.windowDuration
    this.failures = this.failures.filter((t) => t > windowStart)

    // Record this failure
    this.failures.push(now)

    // Check threshold
    if (this.failures.length >= this.config.failureThreshold) {
      if (this.state === "CLOSED" || this.state === "HALF_OPEN") {
        this.state = "OPEN"
        this.openedAt = now
      }
    }
  }

  // ── Introspection (for testing) ──

  /**
   * Get the current circuit breaker state.
   * Exposed for testing and monitoring.
   */
  getState(): CircuitBreakerState {
    return this.state
  }

  /**
   * Get the count of failures in the current sliding window.
   * Exposed for testing and monitoring.
   */
  getFailureCount(): number {
    const now = Date.now()
    const windowStart = now - this.config.windowDuration
    return this.failures.filter((t) => t > windowStart).length
  }

  /**
   * Get the underlying adapter. For advanced use cases.
   */
  getInner(): LLMAdapter {
    return this.inner
  }
}
