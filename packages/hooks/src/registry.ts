// @harness/hooks — HookRegistry (chain-style registration + priority + short-circuit)

import type { Unsubscribe, HarnessError, Logger } from "@harness/core"
import type {
  HookName,
  HookHandlerMap,
  HookRegistration,
  HookInput,
  ErrorRecovery,
} from "./types.js"

// ═══════════════════════════════════════════════════════════════════
// ─── Internal handler entry ───
// ═══════════════════════════════════════════════════════════════════

interface HandlerEntry {
  handler: (...args: unknown[]) => Promise<unknown>
  priority: number
  once: boolean
  name: string
  signal?: AbortSignal
}

/** Auto-incrementing counter for unnamed handlers. */
let unnamedCounter = 0

/** Default priority when none is specified. */
const DEFAULT_PRIORITY = 0

// ═══════════════════════════════════════════════════════════════════
// ─── HookRegistry ───
// ═══════════════════════════════════════════════════════════════════

/**
 * HookRegistry — chainable hook registration with priority ordering.
 *
 * ## Usage
 *
 * ```ts
 * harness.hooks
 *   .on("beforeThink", injectContext, { priority: 100, name: "inject-ctx" })
 *   .on("afterAct", auditLog, { name: "audit" })
 * ```
 *
 * ## Execution order
 *
 * - Priority: higher → earlier execution.
 * - Same priority → registration order.
 * - Handler throws → remaining handlers still execute (independent error collection).
 * - All handlers complete → accumulated errors trigger `onError` hook (if any errors
 *   AND the failing hook is not `onError` itself, to prevent infinite recursion).
 *
 * ## Short-circuit semantics
 *
 * | Hook | Return value behavior |
 * |------|----------------------|
 * | `beforeThink` | Return `TurnContext` → replaces ctx for subsequent handlers. `void` → no change. |
 * | `afterThink` | Return `ThinkEvent[]` → replaces events. `void` → no change. |
 * | `beforeAct` | Return `ToolCall` → replaces call. Return `null` → **cancel tool call**. `void` → no change. |
 * | `afterObserve` | Return `Observation` → replaces observation. `void` → no change. |
 * | `onError` | Return `ErrorRecovery` → first non-void recovery action wins. `void` → default (abort). |
 */
export class HookRegistry {
  private handlers = new Map<HookName, HandlerEntry[]>()

  /**
   * @param inputs — initial hook registrations from HarnessConfig.hooks.
   *   Can be `Partial<HookHandlerMap>` or `HookRegistration[]`.
   * @param logger — optional logger for handler errors (non-fatal).
   */
  constructor(inputs?: HookInput[], logger?: Logger) {
    if (!inputs || inputs.length === 0) return

    for (const input of inputs) {
      if (Array.isArray(input)) {
        // HookRegistration[]
        for (const reg of input) {
          this.register(reg, logger)
        }
      } else {
        // Partial<HookHandlerMap> — each key is a hook name, value is a handler.
        // `as any` is needed because Object.entries loses the correlation between
        // hook name and handler type (the handler is a union of all hook handlers).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const [hook, handler] of Object.entries(input)) {
          if (typeof handler === "function") {
            this.register(
              {
                hook: hook as HookName,
                handler: handler as any,
                priority: DEFAULT_PRIORITY,
                once: false,
              },
              logger,
            )
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Registration ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Register a hook handler.
   *
   * @param hook — hook point name
   * @param handler — handler function (typed per hook point)
   * @param opts.priority — execution priority (higher = earlier). Default 0.
   * @param opts.once — auto-unregister after first execution. Default false.
   * @param opts.name — name for debugging and `off()`. Auto-generated if omitted.
   * @param opts.signal — AbortSignal to auto-unregister.
   * @returns Unsubscribe function
   */
  on<K extends HookName>(
    hook: K,
    handler: HookHandlerMap[K],
    opts?: { priority?: number; once?: boolean; name?: string; signal?: AbortSignal },
  ): Unsubscribe {
    const name = opts?.name ?? `__unnamed_${++unnamedCounter}`
    const entry: HandlerEntry = {
      handler: handler as (...args: unknown[]) => Promise<unknown>,
      priority: opts?.priority ?? DEFAULT_PRIORITY,
      once: opts?.once ?? false,
      name,
      signal: opts?.signal,
    }

    const list = this.handlers.get(hook) ?? []
    list.push(entry)
    // Sort by priority descending (higher = earlier), then by insertion order (stable)
    list.sort((a, b) => b.priority - a.priority)
    this.handlers.set(hook, list)

    // Auto-unsubscribe on signal abort
    if (opts?.signal) {
      opts.signal.addEventListener(
        "abort",
        () => this.removeEntry(hook, name),
        { once: true },
      )
    }

    return () => this.removeEntry(hook, name)
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Removal ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Remove a handler by name from a specific hook point.
   */
  off(hook: HookName, name: string): void {
    this.removeEntry(hook, name)
  }

  /**
   * Remove all handlers for a specific hook point.
   */
  offAll(hook: HookName): void {
    this.handlers.delete(hook)
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Execution ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Execute all handlers for a hook point in priority order.
   *
   * Handler errors are collected — one failing handler does NOT prevent
   * subsequent handlers from running. After all handlers complete,
   * accumulated errors trigger the `onError` hook (unless the failing
   * hook IS `onError`, to prevent infinite recursion).
   *
   * @returns Array of handler return values. Callers interpret results
   *   based on hook semantics (see class-level JSDoc).
   */
  async execute<K extends HookName>(
    hook: K,
    ...args: Parameters<HookHandlerMap[K]>
  ): Promise<Array<Awaited<ReturnType<HookHandlerMap[K]>>>> {
    const list = this.handlers.get(hook)
    if (!list || list.length === 0) return []

    const results: Array<Awaited<ReturnType<HookHandlerMap[K]>>> = []
    const errors: HarnessError[] = []
    const toRemove: string[] = []

    // Snapshot the list — handlers added during execution are NOT executed
    // in the current run (prevents infinite loops).
    const snapshot = [...list]

    for (const entry of snapshot) {
      try {
        const result = await entry.handler(...args)
        results.push(result as Awaited<ReturnType<HookHandlerMap[K]>>)
      } catch (err) {
        errors.push({
          code: "hook_handler_error",
          message: err instanceof Error ? err.message : String(err),
          source: "harness",
          recoverable: true,
          cause: err,
          timestamp: Date.now(),
        })
      }

      // Mark for removal if `once: true`
      if (entry.once) {
        toRemove.push(entry.name)
      }
    }

    // Remove once-handlers after execution
    for (const name of toRemove) {
      this.removeEntry(hook, name)
    }

    // Fire onError for accumulated errors (unless this IS the onError hook)
    if (errors.length > 0 && hook !== "onError") {
      // F-1: Extract SessionContext from args if available.
      // TurnContext (most hooks) has .session + .shared; SessionContext same.
      // If args[0] has both, pass it so onError handlers get useful context.
      const sessionCtx =
        args[0] && typeof args[0] === "object" && "session" in args[0] && "shared" in args[0]
          ? (args[0] as { session: unknown; shared: unknown })
          : undefined
      await this.fireOnError(errors, sessionCtx as any)
    }

    return results
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Queries ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Number of registered handlers across all hook points.
   */
  get size(): number {
    let count = 0
    for (const list of this.handlers.values()) {
      count += list.length
    }
    return count
  }

  /**
   * List hook points that have at least one registered handler.
   */
  get hookNames(): HookName[] {
    return [...this.handlers.keys()]
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Helpers ──
  // ═══════════════════════════════════════════════════════════════

  private register(reg: HookRegistration, logger?: Logger): void {
    try {
      // Fast-fail: reject non-function handlers at registration time rather
      // than silently registering them and failing at execute() time.
      // The `as any` cast in the constructor path can pass non-functions.
      if (typeof reg.handler !== "function") {
        throw new TypeError(
          `HookRegistry: handler for hook "${reg.hook}" must be a function, ` +
            `got ${typeof reg.handler}`,
        )
      }

      // HookRegistration.handler is HookHandlerMap[HookName] (union of all handler
      // types). The `as any` is needed because TS can't narrow the union to the
      // specific hook's handler type — the type-level correlation between
      // `reg.hook` and `reg.handler` is lost in the HookRegistration struct.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.on(reg.hook, reg.handler as any, {
        priority: reg.priority,
        once: reg.once,
        name: reg.name,
      })
    } catch (err) {
      // Constructor-time registration failure is non-fatal — log and continue.
      logger?.warn(
        `[HookRegistry] Failed to register "${reg.hook}" handler: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private removeEntry(hook: HookName, name: string): void {
    const list = this.handlers.get(hook)
    if (!list) return

    const idx = list.findIndex((e) => e.name === name)
    if (idx !== -1) {
      list.splice(idx, 1)
      if (list.length === 0) {
        this.handlers.delete(hook)
      }
    }
  }

  /**
   * Fire the onError hook with collected errors.
   * Only the first non-void ErrorRecovery action is used.
   */
  private async fireOnError(errors: HarnessError[], sessionCtx?: { session: unknown; shared: unknown }): Promise<void> {
    const onErrorHandlers = this.handlers.get("onError")
    if (!onErrorHandlers || onErrorHandlers.length === 0) return

    // F-1: Construct a minimal valid SessionContext so onError handlers can
    // access ctx.session.id / ctx.shared.loadedResources without crashing.
    // When sessionCtx is unavailable (fireOnError from within execute()),
    // fall back to a minimal working context instead of null fields.
    const ctx = sessionCtx ?? {
      session: { id: "hook-error", workDir: "", model: "", startedAt: Date.now(), status: "error" as const, tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, turnCount: 0 },
      shared: { projectRoot: "", projectConfig: null, loadedResources: new Map() },
    }

    // Fire onError for each error. TG0: all errors sent to each handler.
    for (const entry of [...onErrorHandlers]) {
      try {
        // onError signature: (ctx: SessionContext, error: HarnessError) => Promise<ErrorRecovery | void>
        // The recovery action is collected but TG0 doesn't act on it.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await entry.handler(ctx as any, errors[0]!)
        if (entry.once) {
          this.removeEntry("onError", entry.name)
        }
      } catch {
        // Swallow — onError handler errors must not cascade
      }
    }
  }
}
