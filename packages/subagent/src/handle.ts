// @taor/subagent — SubagentHandle implementation (lifecycle state machine)

import type {
  SubagentHandle,
  SubagentStatus,
  SubagentResult,
  SubagentError,
  SubagentHeartbeat,
} from "./types.js"
import type { Unsubscribe, TokenUsage } from "@taor/core"

// ═══════════════════════════════════════════════════════════════════
// ─── SubagentHandleImpl ───
// ═══════════════════════════════════════════════════════════════════

/**
 * SubagentHandleImpl — state machine:
 *
 * ```
 *             spawn()
 *   pending ──────────→ starting ──────────→ running
 *     │                     │                    │
 *     │ abort()             │ startup fails      │ done / error
 *     ▼                     ▼                    ▼
 *   aborted              error              done / error / aborted
 * ```
 *
 * States are irreversible. Events fire on the side-channel via `on()`.
 *
 * ## Event types
 *
 * | Event | Handler signature | When |
 * |-------|-------------------|------|
 * | started | `() => void` | Worker is running |
 * | done | `(result: SubagentResult) => void` | Worker completed |
 * | error | `(error: SubagentError) => void` | Startup or execution failed |
 * | heartbeat | `(h: SubagentHeartbeat) => void` | Turn boundary update |
 * | status-change | `(from: SubagentStatus, to: SubagentStatus) => void` | Any state transition |
 */
export class SubagentHandleImpl implements SubagentHandle {
  readonly id: string
  readonly description: string
  status: SubagentStatus = "pending"

  // ── Promise resolvers ──
  private _startedResolve: (() => void) | null = null
  private _startedReject: ((err: Error) => void) | null = null
  private _startedPromise: Promise<void> | null = null

  private _doneResolve: ((result: SubagentResult) => void) | null = null
  private _doneReject: ((err: Error) => void) | null = null
  private _donePromise: Promise<SubagentResult> | null = null

  // ── Event listeners ──
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  // ── Result persistence (F-2: survives done() called after _onDone) ──
  private _lastResult: SubagentResult | null = null

  // ── Heartbeat (A5: zombie detection) ──
  private _lastHeartbeat = Date.now()
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null

  // ── Abort ──
  private _aborted = false
  private _abortReason: string | undefined

  constructor(id: string, description: string) {
    this.id = id
    this.description = description
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Lifecycle (called by coordinator) ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Transition state. Called by coordinator to advance the state machine.
   * Prefixed with _ to indicate internal API (not for user code).
   * Idempotent — no-op if already in target or terminal state.
   */
  _transition(to: SubagentStatus): void {
    const from = this.status
    if (from === to) return

    // Terminal states: done, error, aborted — cannot transition out
    if (from === "done" || from === "error" || from === "aborted") return

    this.status = to
    this.fire("status-change", from, to)
  }

  /**
   * Called by coordinator when worker starts successfully.
   * Resolves the started() promise.
   */
  _onStarted(): void {
    this._transition("running")
    this._lastHeartbeat = Date.now() // S-4: reset heartbeat on start
    if (this._startedResolve) {
      this._startedResolve()
      this._startedResolve = null
    }
    this.fire("started")
  }

  /**
   * Called by coordinator when worker completes.
   * Persists result (F-2) so done() can retrieve it even if called late.
   * Resolves the done() promise.
   */
  _onDone(result: SubagentResult & { aborted?: boolean }): void {
    // F-2: persist result for late done() callers
    this._lastResult = result

    // I-1: respect aborted flag from worker (timeout → "aborted", not "error")
    if (result.aborted) {
      this._transition("aborted")
    } else {
      this._transition(result.ok ? "done" : "error")
    }

    if (this._doneResolve) {
      this._doneResolve(result)
      this._doneResolve = null
    }
    if (result.ok && !result.aborted) {
      this.fire("done", result)
    } else {
      this.fire("error", {
        code: result.aborted ? "aborted" : "execution_error",
        message: result.error ?? (result.aborted ? "Aborted" : "Unknown error"),
        subagentId: this.id,
      } as SubagentError)
    }
  }

  /**
   * Called by coordinator on worker error.
   */
  _onError(error: SubagentError): void {
    this._transition("error")

    // S-3: persist error as result for late done() callers
    this._lastResult = {
      ok: false,
      turns: 0,
      tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      error: error.message,
    }

    // Reject started() if startup failed
    if (this._startedReject) {
      this._startedReject(new Error(error.message))
      this._startedReject = null
    }

    // Reject done() with the error
    if (this._doneReject) {
      this._doneReject(new Error(error.message))
      this._doneReject = null
    }

    this.fire("error", error)
  }

  /**
   * Called by coordinator at turn boundaries for heartbeat events.
   */
  /**
   * Start monitoring heartbeat health. If no heartbeat for `timeoutMs`,
   * the subagent is considered a zombie and auto-aborted.
   */
  startHeartbeatWatch(timeoutMs: number = 30_000): void {
    if (this._heartbeatTimer) return // already watching
    this._lastHeartbeat = Date.now()
    this._heartbeatTimer = setInterval(() => {
      if (
        this.status === "done" ||
        this.status === "error" ||
        this.status === "aborted"
      ) {
        this.stopHeartbeatWatch()
        return
      }
      if (Date.now() - this._lastHeartbeat > timeoutMs) {
        this.abort(`Heartbeat timeout: no response for ${timeoutMs}ms`)
        this.stopHeartbeatWatch()
      }
    }, Math.min(timeoutMs / 2, 5000)) // check at half the timeout interval
  }

  /** Stop heartbeat monitoring (called on completion/abort). */
  stopHeartbeatWatch(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }

  _onHeartbeat(
    turnIndex: number,
    elapsed: number,
    tokenUsage: TokenUsage,
  ): void {
    this._lastHeartbeat = Date.now()
    this.fire("heartbeat", {
      subagentId: this.id,
      turnIndex,
      elapsed,
      tokenUsage,
    } as SubagentHeartbeat)
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Public API ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Wait for the sub-agent to actually start.
   * For inline isolation, resolves immediately.
   * For process/worktree isolation, waits for fork/git worktree creation.
   */
  async started(): Promise<void> {
    // If already running or terminal, resolve immediately
    if (
      this.status === "running" ||
      this.status === "done" ||
      this.status === "error"
    ) {
      return
    }
    if (this.status === "aborted") {
      throw new Error(`Subagent "${this.id}" was aborted`)
    }

    if (!this._startedPromise) {
      this._startedPromise = new Promise<void>((resolve, reject) => {
        this._startedResolve = resolve
        this._startedReject = reject
      })
    }
    return this._startedPromise
  }

  /**
   * Wait for the sub-agent to complete.
   * Internally awaits started() first.
   */
  async done(): Promise<SubagentResult> {
    // F-2: if worker already completed, return the persisted result
    if (this.status === "done" && this._lastResult) {
      return this._lastResult
    }
    if (this.status === "error" && this._lastResult) {
      return this._lastResult
    }
    if (this.status === "aborted" && this._lastResult) {
      return this._lastResult
    }

    // Fallback: terminal but no persisted result (abort-before-start)
    if (this.status === "done") {
      return {
        ok: true,
        turns: 0,
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }
    }
    if (this.status === "error") {
      return {
        ok: false,
        turns: 0,
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        error: "Subagent errored before completion",
      }
    }
    if (this.status === "aborted") {
      return {
        ok: false,
        turns: 0,
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        error: this._abortReason ?? "Aborted",
      }
    }

    if (!this._donePromise) {
      this._donePromise = new Promise<SubagentResult>((resolve, reject) => {
        this._doneResolve = resolve
        this._doneReject = reject
      })
    }
    return this._donePromise
  }

  /**
   * Abort the sub-agent.
   * - pending: cancels startup → aborted
   * - starting/running: sends abort signal → worker stops at next turn boundary
   */
  abort(reason?: string): void {
    this._aborted = true
    this._abortReason = reason
    this.stopHeartbeatWatch() // I-2: cleanup heartbeat timer on abort

    if (this.status === "pending") {
      this._transition("aborted")
      if (this._startedReject) {
        this._startedReject(new Error(reason ?? "Aborted"))
      }
      if (this._doneReject) {
        this._doneReject(new Error(reason ?? "Aborted"))
      }
      return
    }

    if (
      this.status === "starting" ||
      this.status === "running"
    ) {
      this._transition("aborted")
      // F-1: Unlock started() Promise — without this, started() hangs forever
      if (this._startedResolve) {
        this._startedResolve()
        this._startedResolve = null
      }
      const result: SubagentResult = {
        ok: false,
        turns: 0,
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        error: reason ?? "Aborted",
      }
      if (this._doneResolve) {
        this._doneResolve(result)
        this._doneResolve = null
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Events ──
  // ═══════════════════════════════════════════════════════════════

  on(
    event: "started",
    handler: () => void,
    opts?: { signal?: AbortSignal },
  ): Unsubscribe
  on(
    event: "done",
    handler: (result: SubagentResult) => void,
    opts?: { signal?: AbortSignal },
  ): Unsubscribe
  on(
    event: "error",
    handler: (error: SubagentError) => void,
    opts?: { signal?: AbortSignal },
  ): Unsubscribe
  on(
    event: "heartbeat",
    handler: (h: SubagentHeartbeat) => void,
    opts?: { signal?: AbortSignal },
  ): Unsubscribe
  on(
    event: "status-change",
    handler: (from: SubagentStatus, to: SubagentStatus) => void,
    opts?: { signal?: AbortSignal },
  ): Unsubscribe
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(
    event: string,
    handler: (...args: any[]) => void,
    opts?: { signal?: AbortSignal },
  ): Unsubscribe {
    const set =
      this.listeners.get(event) ??
      (() => {
        const s = new Set<(...args: unknown[]) => void>()
        this.listeners.set(event, s)
        return s
      })()
    set.add(handler)

    // Auto-unsubscribe on signal abort (I-5: parity with Harness.on())
    if (opts?.signal) {
      opts.signal.addEventListener(
        "abort",
        () => set.delete(handler),
        { once: true },
      )
    }

    return () => set.delete(handler)
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Internal ──
  // ═══════════════════════════════════════════════════════════════

  private fire(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const handler of set) {
      try {
        handler(...args)
      } catch {
        // Event listener errors must not propagate
      }
    }
  }
}
