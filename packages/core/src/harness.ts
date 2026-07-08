// @taor/core — Harness main class (AsyncGenerator + EventEmitter + TAOR loop)
//
// ## Dependency inversion
//
// `@taor/core` cannot runtime-import from `@taor/adapters` or `@taor/tools`
// (circular project references). Instead, the Harness constructor receives
// pre-instantiated `IAdapter` and `IToolRegistry` objects that satisfy
// structural interfaces defined below. The `createHarness()` factory in
// `@taor/engine` wires everything together.

import type { ResolvedConfig, Logger } from "./config.js"
import type { HarnessEvent, UserDecision } from "./events.js"
import type {
  SessionState,
  TurnState,
  HarnessContext,
  Message,
  MessageContent,
  ToolCall,
  ToolCallResult,
  Observation,
  HarnessError,
  TurnContext,
} from "./context.js"
import type { TokenUsage, TurnRecord, SessionStatus, Unsubscribe, CompressLevel } from "./types.js"
import type { SessionResult } from "./session.js"

// Re-export for downstream consumers
export type { SessionState } from "./context.js"
export type { TurnRecord } from "./types.js"

// ═══════════════════════════════════════════════════════════════════
// ─── Structural interfaces (dependency inversion) ───
// ═══════════════════════════════════════════════════════════════════

/** Result of a tool execution (structural — matches @taor/tools ToolResult). */
interface ToolExecResult {
  ok: boolean
  data?: unknown
  error?: string
  code?: string
  recoverable?: boolean
  meta?: { duration: number; truncated?: boolean; artifacts?: string[] }
}

/** Tool descriptor as consumed by the TAOR loop (structural). */
interface ToolDef {
  name: string
  description: string
  parameters: object
  execute(params: unknown, ctx: ToolExecContext): Promise<ToolExecResult>
  permissions?: string[]
  risk?: "low" | "medium" | "high"
  requiresApproval?: boolean | ((params: unknown, ctx: ToolExecContext) => boolean)
}

interface ToolExecContext {
  session: SessionState
  turn: TurnState
  signal: AbortSignal
  logger: Logger
}

/** Structural adapter interface — satisfied by LLMAdapter from @taor/adapters. */
export interface IAdapter {
  readonly provider: string
  readonly version?: string
  getModelInfo(model: string): {
    id: string
    provider?: string
    maxInputTokens: number
    maxOutputTokens: number
    supportsThinking?: boolean
    supportsVision?: boolean
    supportsPromptCaching?: boolean
    supportsToolUse?: boolean
    costPer1kInput?: number
    costPer1kOutput?: number
  }
  supports?(feature: string, model?: string): boolean
  buildRequest(ctx: TurnContext, opts: AdapterRequestOpts): Promise<unknown>
  think(request: unknown, signal: AbortSignal): AsyncGenerator<ThinkEvent, void, void>
  parseToolCalls?(rawResponse: unknown): { id: string; name: string; arguments: Record<string, unknown> }[]
  formatToolResult(callId: string, result: ToolExecResult): unknown
  wrapToolResult(callId: string, result: ToolExecResult, toolName?: string): Message
  normalizeError(error: unknown): HarnessError
  countTokens(messages: Message[]): number
  countRequestTokens?(request: unknown): number
}

interface AdapterRequestOpts {
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  thinking?: { budgetTokens: number }
  tools?: unknown[]
}

/** Structural think event — satisfied by ThinkEvent from @taor/adapters. */
type ThinkEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_use"; call: { id: string; name: string; arguments: Record<string, unknown> } }
  | { type: "stop"; reason: string; usage: TokenUsage }
  | { type: "error"; error: HarnessError }

/** Structural tool registry — satisfied by ToolRegistry from @taor/tools. */
export interface IToolRegistry {
  register(inputs: unknown[]): void
  get(name: string): ToolDef | undefined
  list(): ToolDef[]
  readonly size: number
  remove(name: string): boolean
  clear(): void
}

/** Structural permission verdict — satisfied by PermissionVerdict from @taor/permission. */
interface IPermissionVerdict {
  level: "deny" | "boundary" | "allow" | "ask"
  reason: string
  rule?: { level: string; pattern: string; reason?: string }
}

/** Structural permission engine — satisfied by PermissionEngine from @taor/permission. */
export interface IPermissionEngine {
  evaluate(tool: string, params: Record<string, unknown>): IPermissionVerdict
  addRule(rule: {
    level: string
    pattern: string
    resourceConstraints?: {
      paramAnnotation: string
      allowlist?: string[]
      denylist?: string[]
    }
    risk?: string | string[]
    reason?: string
  }): void
  removeRule(pattern: string): number
  allowAll(scope: "turn" | "session"): void
  denyAll(scope: "turn" | "session"): void
  resetScope(): void
}

/** Structural hook registry — satisfied by HookRegistry from @taor/hooks. */
export interface IHookRegistry {
  execute(hook: string, ...args: unknown[]): Promise<unknown[]>
  on(hook: string, handler: (...args: unknown[]) => Promise<unknown>, opts?: {
    priority?: number
    once?: boolean
    name?: string
    signal?: AbortSignal
  }): () => void
  off(hook: string, name: string): void
  offAll(hook: string): void
}

/** Structural subagent coordinator — satisfied by SubagentCoordinator from @taor/subagent. */
export interface ISubagentCoordinator {
  spawn(spec: {
    description: string
    prompt: string
    tools?: unknown[]
    model?: string
    isolation?: "inline" | "process" | "worktree"
    schema?: unknown
    maxTurns?: number
    timeout?: number
  }): Promise<{
    readonly id: string
    readonly description: string
    status: string
    started(): Promise<void>
    done(): Promise<{
      ok: boolean
      data?: unknown
      turns: number
      tokenUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
      artifacts?: { key: string; path?: string; mimeType?: string; size?: number }[]
      error?: string
    }>
    abort(reason?: string): void
  }>
}

/** Structural memory facade — satisfied by MemoryFacade from @taor/memory. */
export interface IMemoryFacade {
  readonly backendType?: { user: string; project: string; session: string }
  readonly user: {
    get<T>(key: string): Promise<T | undefined>
    set<T>(key: string, value: T, opts?: { ttl?: number; tags?: string[] }): Promise<void>
    delete(key: string): Promise<void>
    has(key: string): Promise<boolean>
    list(opts?: { prefix?: string; tags?: string[]; limit?: number; offset?: number }): Promise<{ key: string; value: unknown; metadata?: { type: string; createdAt: number; updatedAt: number; expiresAt?: number; tags: string[] } }[]>
    clear(): Promise<void>
  }
  readonly project: {
    get<T>(key: string): Promise<T | undefined>
    set<T>(key: string, value: T, opts?: { ttl?: number; tags?: string[] }): Promise<void>
    delete(key: string): Promise<void>
    has(key: string): Promise<boolean>
    list(opts?: { prefix?: string; tags?: string[]; limit?: number; offset?: number }): Promise<{ key: string; value: unknown; metadata?: { type: string; createdAt: number; updatedAt: number; expiresAt?: number; tags: string[] } }[]>
    clear(): Promise<void>
  }
  readonly session: {
    get<T>(key: string): Promise<T | undefined>
    set<T>(key: string, value: T, opts?: { ttl?: number; tags?: string[] }): Promise<void>
    delete(key: string): Promise<void>
    has(key: string): Promise<boolean>
    list(opts?: { prefix?: string; tags?: string[]; limit?: number; offset?: number }): Promise<{ key: string; value: unknown; metadata?: { type: string; createdAt: number; updatedAt: number; expiresAt?: number; tags: string[] } }[]>
    clear(): Promise<void>
  }
}

/** Structural compressor pipeline — satisfied by CompressorPipeline from @taor/compressor. */
export interface ICompressorPipeline {
  readonly triggerThreshold?: number
  compress(ctx: TurnContext): Promise<{
    messages: Message[]
    tokenCount: number
    level: string
    strategy: string
  }>
  clearCache(): void
}

// ═══════════════════════════════════════════════════════════════════
// ─── Event Emitter ───
// ═══════════════════════════════════════════════════════════════════

type EventHandler = (event: HarnessEvent) => void | Promise<void>

// ═══════════════════════════════════════════════════════════════════
// ─── Harness ───
// ═══════════════════════════════════════════════════════════════════

/**
 * Harness — bidirectional AsyncGenerator + multicast EventEmitter.
 *
 * ## Architecture
 *
 * ```
 *                    ┌──────────────────────────┐
 *                    │     TAOR Loop (internal)  │
 *                    │                          │
 *                    │  THINK ──→ ACT ──→ OBS   │
 *                    │    │         │       │    │
 *                    │    ▼         ▼       ▼    │
 *                    │ adapter   tools   format  │
 *                    └─────────┬────────────────┘
 *                              │ pushEvent()
 *                    ┌─────────▼────────────────┐
 *                    │    Bounded FIFO Queue      │
 *                    │   (capacity from config)   │
 *                    └─────────┬────────────────┘
 *                              │ next() pull
 *                    ┌─────────▼────────────────┐
 *                    │   Consumer (for await)     │
 *                    │   + next(decision) inject  │
 *                    └──────────────────────────┘
 * ```
 *
 * ## Event Queue
 *
 * Internal bounded FIFO queue. TAOR loop pushes events; consumer pulls via
 * `next()`. When the queue is full, the TAOR loop suspends (backpressure).
 * When empty, `next()` returns a pending Promise that resolves on next push.
 *
 * ## Bidirectional Channel
 *
 * When the ACT phase needs user approval for a tool call, the TAOR loop
 * yields `approval-required` and awaits. The consumer calls `next(decision)`
 * to inject the decision, which resolves the TAOR loop's await.
 *
 * ## Lifecycle
 *
 * ```
 * new Harness(config, adapter, registry)
 *   → harness.start(prompt)
 *   → for await (const event of harness) { ... }   // TAOR loop runs
 *   → harness.abort() / harness.kill()
 *   → loop terminates → SessionResult
 * ```
 */
export class Harness
  implements AsyncGenerator<HarnessEvent, SessionResult, UserDecision | undefined>
{
  // ── Injected dependencies ──
  private config: ResolvedConfig
  private _adapter!: IAdapter
  private _registry!: IToolRegistry

  /** Guarded getter — throws descriptive error if adapter not injected. */
  get adapter(): IAdapter {
    if (!this._adapter) {
      throw new Error(
        "Harness.adapter not initialized — use createHarness() which provides AnthropicAdapter as default."
      )
    }
    return this._adapter
  }

  /** Guarded getter — throws descriptive error if registry not injected. */
  get registry(): IToolRegistry {
    if (!this._registry) {
      throw new Error(
        "Harness.registry not initialized — use createHarness() which provides ToolRegistry as default."
      )
    }
    return this._registry
  }

  // ── Session state ──
  private sessionState: SessionState
  private turnHistory: TurnRecord[] = []
  private currentTurn: TurnState | null = null

  // ── Event queue ──
  private eventQueue: HarnessEvent[] = []
  private queueCapacity: number
  private resolveNext:
    | ((value: IteratorResult<HarnessEvent, SessionResult>) => void)
    | null = null

  // ── TAOR loop control ──
  private abortController = new AbortController()
  private decisionResolve: ((value: UserDecision) => void) | null = null
  private isLoopRunning = false
  private isLoopDone = false
  private sessionResult: SessionResult | null = null
  private pendingPrompt: string | null = null
  private loopPromise: Promise<void> | null = null

  // ── Event emitter ──
  private listeners = new Map<string, Set<EventHandler>>()
  private wildcardListeners = new Set<EventHandler>()

  // ── Token tracking ──
  private totalTokens: TokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  }

  // ── Think retry counter (A4 F-1: prevents infinite retry loop) ──
  private _thinkRetries = 0

  // ── Pending tool calls for ACT phase ──
  private pendingToolCalls: {
    id: string
    name: string
    arguments: Record<string, unknown>
  }[] = []

  // ── Permission engine (injected) ──
  private permissionEngine: IPermissionEngine | null = null

  // ── Hook registry (injected) ──
  private hookRegistry: IHookRegistry | null = null

  // ── Subagent coordinator (injected) ──
  private subagentCoordinator: ISubagentCoordinator | null = null

  // ── Memory facade (injected) ──
  private memoryFacade: IMemoryFacade | null = null

  // ── Compressor pipeline (injected) ──
  private compressorPipeline: ICompressorPipeline | null = null

  // ── Messages accumulated across turns ──
  private messages: Message[] = []

  constructor(
    config: ResolvedConfig,
    adapter: IAdapter,
    registry: IToolRegistry,
  ) {
    // Deferred adapter injection is allowed for deserialized sessions.
    // createHarness() and deserialize() inject adapter + registry post-construction.

    this.config = config
    this._adapter = adapter
    this._registry = registry
    this.queueCapacity = config.session.eventQueueCapacity

    this.sessionState = {
      id: config.session.id,
      workDir: config.session.workDir,
      model: config.model,
      startedAt: Date.now(),
      status: "running",
      tokenUsage: this.totalTokens,
      turnCount: 0,
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Event Queue: push (internal) ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Push an event to the internal queue.
   *
   * If a consumer is waiting in `next()`, the event is delivered immediately
   * (bypassing the queue). Otherwise, it's enqueued.
   *
   * TG0 backpressure: if the queue is at capacity, the oldest event is
   * dropped and a warning is logged. TG1 will implement true async
   * backpressure (suspend TAOR loop until consumer catches up).
   */
  private pushEvent(event: HarnessEvent): void {
    // Fire side-channel listeners synchronously
    this.fireListeners(event)

    if (this.resolveNext) {
      const resolve = this.resolveNext
      this.resolveNext = null
      resolve({ done: false, value: event })
      return
    }

    // TG0 backpressure: drop oldest if full (prevents unbounded growth)
    if (this.eventQueue.length >= this.queueCapacity) {
      this.config.logger.warn(
        `[Harness] Event queue full (capacity=${this.queueCapacity}). ` +
          `Dropping oldest event. Consider increasing session.eventQueueCapacity.`,
      )
      this.eventQueue.shift()
    }

    this.eventQueue.push(event)
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Event Emitter: fire side-channel ──
  // ═══════════════════════════════════════════════════════════════

  private fireListeners(event: HarnessEvent): void {
    for (const handler of this.wildcardListeners) {
      try {
        handler(event)
      } catch {
        // Side-channel handler errors must not crash the TAOR loop
      }
    }

    const typed = this.listeners.get(event.type)
    if (typed) {
      for (const handler of typed) {
        try {
          handler(event)
        } catch {
          // swallow
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Decision channel: resolve (internal) ──
  // ═══════════════════════════════════════════════════════════════

  private async waitForDecision(): Promise<UserDecision> {
    return new Promise<UserDecision>((resolve) => {
      this.decisionResolve = resolve
    })
  }

  private resolveDecision(decision: UserDecision): void {
    if (this.decisionResolve) {
      const resolve = this.decisionResolve
      this.decisionResolve = null
      resolve(decision)
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── TAOR Loop (internal) ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * The TAOR main loop. Runs as a background async task.
   *
   * THINK → ACT → OBSERVE → repeat until maxTurns or abort.
   */
  private async runTAOR(): Promise<void> {
    this.isLoopRunning = true
    const maxTurns = this.config.session.maxTurns

    try {
      // ── Push initial user prompt ──
      if (this.pendingPrompt) {
        this.messages.push({
          role: "user",
          content: [{ type: "text", text: this.pendingPrompt }],
        })
      }

      // ── onSessionStart hook ──
      if (this.hookRegistry) {
        await this.hookRegistry.execute("onSessionStart", {
          session: this.sessionState,
          shared: {
            projectRoot: this.config.session.workDir,
            projectConfig: null,
            loadedResources: new Map(),
          },
        })
      }

      for (
        let turnIndex = 0;
        turnIndex < maxTurns && !this.abortController.signal.aborted;
        turnIndex++
      ) {
        // S-2: Pause at turn boundary — complete current turn, then wait.
        // This matches the API design spec: "完成当前 turn 后挂起".
        while (
          this.sessionState.status === "paused" &&
          !this.abortController.signal.aborted
        ) {
          await new Promise((r) => setTimeout(r, 100))
        }
        if (this.abortController.signal.aborted) break

        // ── Turn setup ──
        const turnId = `turn-${this.sessionState.id}-${turnIndex}`
        const turnStart = Date.now()

        const pendingMap = new Map<string, Readonly<ToolCall>>()
        this.pendingToolCalls = []
        this.currentTurn = {
          id: turnId,
          index: turnIndex,
          messages: [...this.messages],
          pendingToolCalls: pendingMap,
          lastObservation: null,
          compressedAt: null,
        }

        this.pushEvent({
          type: "turn-started",
          turnId,
          turnIndex,
          timestamp: turnStart,
        })

        // ═══════════════════════════════════════════════════════
        // ── THINK phase ──
        // ═══════════════════════════════════════════════════════

        this.pushEvent({
          type: "thinking",
          turnId,
          model: this.sessionState.model,
          timestamp: Date.now(),
        })

        let ctx = this.buildTurnContext()

        // ── beforeThink hook: handlers can modify ctx ──
        if (this.hookRegistry) {
          const results = await this.hookRegistry.execute("beforeThink", ctx)
          // Apply the last non-void ctx modification.
          // IMPORTANT: handlers must return the FULL TurnContext (not a partial).
          // The spread `{ ...ctx, ...r }` is SHALLOW at the top level:
          //   return { shared: { loadedResources: ... } }
          // will LOSE shared.projectRoot and shared.projectConfig.
          // Correct: return { ...ctx, shared: { ...ctx.shared, loadedResources: ... } }
          for (const r of results) {
            if (r && typeof r === "object") {
              ctx = { ...ctx, ...(r as Record<string, unknown>) } as typeof ctx
            }
          }
        }

        const tools = this.registry.list()

        const request = await this.adapter.buildRequest(ctx, {
          // TG0: maxTokens not yet configurable — adapter uses its default.
          // TG1: read from config.session.maxOutputTokens or similar.
          maxTokens: undefined,
          tools: tools.length > 0 ? tools : undefined,
        })

        // ── Consume adapter think stream ──
        let turnInputTokens = 0
        let turnOutputTokens = 0
        let turnCacheRead = 0
        let turnCacheWrite = 0
        let stopReason: string = "end_turn"
        const thinkEvents: {
          type: string
          content?: string
          call?: { id: string; name: string; arguments: Record<string, unknown> }
          reason?: string
          usage?: TokenUsage
        }[] = []

        try {
          for await (const te of this.adapter.think(
            request,
            this.abortController.signal,
          )) {
            if (this.abortController.signal.aborted) break

            // Accumulate for afterThink hook
            thinkEvents.push(te)

            switch (te.type) {
              case "text":
                this.pushEvent({
                  type: "thought",
                  turnId,
                  content: te.content,
                  kind: "text",
                  timestamp: Date.now(),
                })
                break

              case "thinking":
                this.pushEvent({
                  type: "thought",
                  turnId,
                  content: te.content,
                  kind: "thinking",
                  timestamp: Date.now(),
                })
                break

              case "tool_use":
                this.pendingToolCalls.push(te.call)
                break

              case "stop":
                turnInputTokens = te.usage.input
                turnOutputTokens = te.usage.output
                turnCacheRead = te.usage.cacheRead
                turnCacheWrite = te.usage.cacheWrite
                stopReason = te.reason
                break

              case "error":
                this.pushEvent({
                  type: "error",
                  turnId,
                  error: te.error,
                })
                // Fatal adapter error — abort the loop
                this.sessionState.status = "error"
                return
            }
          }
        } catch (err) {
          if (this.abortController.signal.aborted) break

          const adapterError = this.adapter.normalizeError(err)

          // ── onError hook + ErrorRecovery (A4) ──
          let recovery: { action: string; reason?: string } | null = null
          if (this.hookRegistry) {
            const results = await this.hookRegistry.execute(
              "onError",
              {
                session: this.sessionState,
                shared: {
                  projectRoot: this.config.session.workDir,
                  projectConfig: null,
                  loadedResources: new Map(),
                },
              },
              adapterError,
            )
            recovery = this.extractRecovery(results)
          }

          // F-1: Cap think retries to prevent infinite loop on unrecoverable errors
          if (recovery?.action === "retry" && this._thinkRetries < 3) {
            this._thinkRetries++
            this.config.logger.warn(
              `[Harness] Retrying THINK phase (${this._thinkRetries}/3): ${adapterError.message}`,
            )
            turnIndex-- // don't count this attempt as a turn
            continue // retry the THINK phase
          }
          this._thinkRetries = 0 // reset for next turn

          // F-2: Use continue (not break) so the turn loop properly advances
          if (recovery?.action === "skip_turn") {
            this.config.logger.warn(
              `[Harness] Skipping turn after adapter error: ${adapterError.message}`,
            )
            continue // skip this turn, proceed to next iteration
          }

          if (recovery?.action === "abort") {
            this.sessionState.status = "aborted"
            return
          }

          // "ignore" or no recovery: original behavior
          this.pushEvent({
            type: "error",
            turnId,
            error: adapterError,
          })
          this.sessionState.status = "error"
          return
        }

        // ── afterThink hook: handlers can inspect/modify think events ──
        if (this.hookRegistry) {
          const afterResults = await this.hookRegistry.execute(
            "afterThink",
            ctx,
            thinkEvents as unknown[],
          )
          // Apply the last non-void ThinkEvent[] from handlers (API §9.3)
          for (const r of afterResults) {
            if (Array.isArray(r)) {
              // Replace thinkEvents contents in-place (preserves reference)
              thinkEvents.length = 0
              thinkEvents.push(...r)
            }
          }
          // TG0 limitation: pendingToolCalls are extracted during THINK streaming,
          // before afterThink runs. If a handler filters out tool_use events, the
          // ACT phase will still execute the original tool calls. TG1 should
          // recompute pendingToolCalls from the modified thinkEvents.
        }

        // ═══════════════════════════════════════════════════════
        // ── ACT phase ──
        // ═══════════════════════════════════════════════════════

        const toolResults: ToolCallResult[] = []
        let autoApproveRest = false

        for (const tc of this.pendingToolCalls) {
          if (this.abortController.signal.aborted) break

          const tool = this.registry.get(tc.name)
          if (!tool) continue

          // ── Permission check (two-layer: built-in risk + PermissionEngine) ──
          const risk = tool.risk ?? "medium"

          // Layer 1: PermissionEngine (if injected). This is the authoritative
          // rule-based layer. It can deny, allow, or defer to the built-in check.
          let permVerdict: IPermissionVerdict | null = null
          if (this.permissionEngine && !autoApproveRest) {
            permVerdict = this.permissionEngine.evaluate(tc.name, tc.arguments)

            // Deny from permission engine → immediate block, skip execution
            if (permVerdict.level === "deny") {
              this.pushEvent({
                type: "blocked",
                turnId,
                callId: tc.id,
                tool: tc.name,
                level: "deny",
                reason: permVerdict.reason,
                timestamp: Date.now(),
              })
              continue
            }
          }

          // Layer 2: Built-in risk-based check + tool.requiresApproval.
          // Skipped if PermissionEngine returned "allow" (for non-boundary allow,
          // boundary is handled below with risk check).
          const builtinNeedsApproval =
            !autoApproveRest &&
            (typeof tool.requiresApproval === "function"
              ? tool.requiresApproval(tc.arguments, {
                  session: this.sessionState,
                  turn: this.currentTurn!,
                  signal: this.abortController.signal,
                  logger: this.config.logger,
                })
              : tool.requiresApproval === true || risk === "high")

          // PermissionEngine "allow" overrides built-in (skip approval prompt).
          // PermissionEngine "boundary" or "ask" defers to built-in.
          const needsApproval =
            builtinNeedsApproval &&
            permVerdict?.level !== "allow"

          if (needsApproval) {
            // TG0: When permVerdict.level === "boundary" and the tool is high-risk,
            // the approval reason defaults to "High-risk tool" — resource boundary
            // status (permVerdict.reason) is available but not surfaced in the prompt.
            // TG1: Surface boundary status explicitly in the approval-required reason.
            const approvalReason =
              permVerdict?.reason ??
              (risk === "high" ? "High-risk tool" : "Tool requires approval")

            this.pushEvent({
              type: "approval-required",
              turnId,
              callId: tc.id,
              tool: tc.name,
              params: tc.arguments,
              risk,
              reason: approvalReason,
              ttl: this.config.session.timeout === Infinity
                ? 120
                : Math.min(120, Math.floor(this.config.session.timeout / 1000)),
              timestamp: Date.now(),
            })

            const decision = await this.waitForDecision()

            if (decision.type === "deny") {
              this.pushEvent({
                type: "blocked",
                turnId,
                callId: tc.id,
                tool: tc.name,
                level: "deny",
                reason: decision.reason ?? "Denied by user",
                timestamp: Date.now(),
              })
              continue
            }

            if (decision.type === "approve-all") {
              autoApproveRest = true
            }
          }

          // ── beforeAct hook: handlers can modify or cancel the tool call ──
          let effectiveCall = { ...tc }
          if (this.hookRegistry) {
            const results = await this.hookRegistry.execute(
              "beforeAct",
              ctx,
              effectiveCall,
            )
            // Check for cancellation: if any handler returns null, skip this tool
            const cancelled = results.some((r) => r === null)
            if (cancelled) {
              this.pushEvent({
                type: "blocked",
                turnId,
                callId: tc.id,
                tool: tc.name,
                level: "deny",
                reason: "Cancelled by beforeAct hook",
                timestamp: Date.now(),
              })
              continue
            }
            // Apply the last non-void ToolCall modification
            for (const r of results) {
              if (r && typeof r === "object" && "arguments" in (r as Record<string, unknown>)) {
                effectiveCall = r as typeof effectiveCall
              }
            }
          }

          // TG0: pendingToolCalls retains the original tc.arguments —
          // effectiveCall overrides from beforeAct are reflected in callRecord
          // and tool execution params, but the original tc in pendingToolCalls
          // is not updated. This is fine because pendingToolCalls is only
          // read during ACT phase and not used after the tool executes.

          // ── Execute tool ──
          const callRecord: ToolCall = {
            id: effectiveCall.id,
            name: effectiveCall.name,
            arguments: effectiveCall.arguments,
            status: "running",
            startedAt: Date.now(),
            retries: 0,
          }

          this.pushEvent({
            type: "tool-call",
            turnId,
            callId: effectiveCall.id,
            tool: effectiveCall.name,
            params: effectiveCall.arguments,
            risk,
            timestamp: Date.now(),
          })

          try {
            const result = await tool.execute(effectiveCall.arguments, {
              session: this.sessionState,
              turn: this.currentTurn!,
              signal: this.abortController.signal,
              logger: this.config.logger,
            })

            callRecord.status = result.ok ? "done" : "error"

            this.pushEvent({
              type: "tool-result",
              turnId,
              callId: effectiveCall.id,
              tool: effectiveCall.name,
              ok: result.ok,
              duration: result.meta?.duration ?? 0,
              truncated: result.meta?.truncated,
              timestamp: Date.now(),
            })

            toolResults.push({
              call: callRecord,
              result,
            })
          } catch (err) {
            callRecord.status = "error"

            // ── onError hook + ErrorRecovery for tool errors (A4) ──
            let recovery: { action: string; reason?: string } | null = null
            if (this.hookRegistry) {
              const results = await this.hookRegistry.execute(
                "onError",
                {
                  session: this.sessionState,
                  shared: {
                    projectRoot: this.config.session.workDir,
                    projectConfig: null,
                    loadedResources: new Map(),
                  },
                },
                {
                  code: "tool_execution_error",
                  message: err instanceof Error ? err.message : String(err),
                  source: "tool" as const,
                  recoverable: true,
                  cause: err,
                  timestamp: Date.now(),
                } as HarnessError,
              )
              recovery = this.extractRecovery(results)
            }

            if (recovery?.action === "retry" && callRecord.retries < 3) {
              this.config.logger.warn(
                `[Harness] Retrying tool "${effectiveCall.name}" (attempt ${callRecord.retries + 1}/3)`,
              )
              callRecord.retries++
              try {
                const retryResult = await tool.execute(effectiveCall.arguments, {
                  session: this.sessionState,
                  turn: this.currentTurn!,
                  signal: this.abortController.signal,
                  logger: this.config.logger,
                })
                callRecord.status = retryResult.ok ? "done" : "error"
                // F-3: Only ONE tool-result event per tool execution
                this.pushEvent({
                  type: "tool-result",
                  turnId,
                  callId: effectiveCall.id,
                  tool: effectiveCall.name,
                  ok: retryResult.ok,
                  duration: (retryResult as ToolExecResult).meta?.duration ?? 0,
                  timestamp: Date.now(),
                })
                toolResults.push({ call: callRecord, result: retryResult })
                continue // go to next tool — skip error push below
              } catch {
                // Retry also failed — fall through to push error event
              }
            }

            if (recovery?.action === "skip_turn") {
              this.config.logger.warn(
                `[Harness] Skipping tool "${effectiveCall.name}" after error`,
              )
              continue // skip this tool, no tool-result event
            }

            if (recovery?.action === "abort") {
              this.sessionState.status = "aborted"
              this.abortController.abort(recovery.reason ?? "Tool error recovery: abort")
              break
            }

            // "ignore", no recovery, or retry exhausted: push error event + record failure
            this.pushEvent({
              type: "tool-result",
              turnId,
              callId: effectiveCall.id,
              tool: effectiveCall.name,
              ok: false,
              duration: 0,
              timestamp: Date.now(),
            })

            toolResults.push({
              call: { ...callRecord, status: "error" },
              result: {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
                code: "execution_failed",
                recoverable: false,
              },
            })
          }

          // ── afterAct hook: post-execution audit/logging ──
          if (this.hookRegistry) {
            const lastResult = toolResults[toolResults.length - 1]
            if (lastResult) {
              await this.hookRegistry.execute(
                "afterAct",
                ctx,
                callRecord,
                lastResult.result,
              )
            }
          }
        }

        // ═══════════════════════════════════════════════════════
        // ── OBSERVE phase ──
        // ═══════════════════════════════════════════════════════

        // Accumulate token usage (including cache tokens for accurate billing)
        this.totalTokens.input += turnInputTokens
        this.totalTokens.output += turnOutputTokens
        this.totalTokens.cacheRead += turnCacheRead
        this.totalTokens.cacheWrite += turnCacheWrite
        this.totalTokens.total =
          this.totalTokens.input + this.totalTokens.output

        // Build messages from tool results for next turn.
        // Collect into newMessages for the Observation.
        const newMessages: Message[] = []
        for (const tr of toolResults) {
          const msg = this.adapter.wrapToolResult(
            tr.call.id,
            tr.result as ToolExecResult,
            tr.call.name,
          )
          newMessages.push(msg)
          this.messages.push(msg)
        }

        const turnTokenUsage: TokenUsage = {
          input: turnInputTokens,
          output: turnOutputTokens,
          cacheRead: turnCacheRead,
          cacheWrite: turnCacheWrite,
          total: turnInputTokens + turnOutputTokens,
        }

        // Record observation
        let observation: Observation = {
          turnId,
          toolResults,
          newMessages,
          tokenUsage: turnTokenUsage,
          compressedAt: null,
        }

        // ── afterObserve hook: handlers can modify the observation ──
        if (this.hookRegistry) {
          const results = await this.hookRegistry.execute(
            "afterObserve",
            ctx,
            observation,
          )
          // Apply the last non-void Observation modification
          for (const r of results) {
            if (r && typeof r === "object" && "turnId" in (r as Record<string, unknown>)) {
              observation = r as Observation
            }
          }
        }

        if (this.currentTurn) {
          this.currentTurn.lastObservation = observation
        }

        // Record turn in history.
        // Use observation.tokenUsage (not turnTokenUsage) so that afterObserve
        // handler modifications to token counts are reflected in the turn record.
        const turnRecord: TurnRecord = {
          id: turnId,
          index: turnIndex,
          status: "completed",
          tokenUsage: observation.tokenUsage,
          toolCalls: toolResults.length,
          duration: Date.now() - turnStart,
          compressedAt: null,
        }
        this.turnHistory.push(turnRecord)

        // B1: snapshot messages for serialization
        this._turnMessages.push([...this.messages])

        // TG0: turnCount updated after successful OBSERVE. If abort() fires
        // mid-tool-execution, the current turn's record hasn't been pushed yet,
        // so turnCount and turnHistory.length remain consistent (both exclude it).
        this.sessionState.turnCount = turnIndex + 1

        // Reset turn-level permission overrides at turn boundary.
        // Without this, allowAll("turn") / denyAll("turn") would leak
        // across turns (see I-1 in Step 8 review).
        this.permissionEngine?.resetScope()

        // ── Compressor: check token budget at turn boundary ──
        // I-10: prevent unbounded context growth in long sessions.
        if (this.compressorPipeline) {
          const totalTokens = this.totalTokens.total
          const threshold = this.compressorPipeline.triggerThreshold ?? 100_000
          if (totalTokens > threshold) {
            // I-1: Rebuild ctx with latest this.messages before compress
            const compressCtx = this.buildTurnContext()

            // A2b: beforeCompress hook (I-2: level=null — actual level determined by pipeline)
            if (this.hookRegistry) {
              await this.hookRegistry.execute("beforeCompress", compressCtx, null)
            }

            const compressed = await this.compressorPipeline.compress(compressCtx)

            // F-1: Write compressed messages back so subsequent turns use condensed context
            this.messages = compressed.messages

            // A2b: afterCompress hook
            if (this.hookRegistry) {
              await this.hookRegistry.execute("afterCompress", compressCtx, {
                type: "compressed",
                turnId,
                level: compressed.level,
                beforeTokens: totalTokens,
                afterTokens: compressed.tokenCount,
                savingsPercent: Math.round(
                  (1 - compressed.tokenCount / totalTokens) * 100,
                ),
                strategy: compressed.strategy,
                timestamp: Date.now(),
              })
            }

            this.pushEvent({
              type: "compressed",
              turnId,
              level: compressed.level as CompressLevel,
              beforeTokens: totalTokens,
              afterTokens: compressed.tokenCount,
              savingsPercent: Math.round(
                (1 - compressed.tokenCount / totalTokens) * 100,
              ),
              strategy: compressed.strategy,
              timestamp: Date.now(),
            })
          }
        }

        this.pushEvent({
          type: "turn-ended",
          turnId,
          turnIndex,
          tokenUsage: turnRecord.tokenUsage,
          duration: turnRecord.duration,
          compressed: false,
        })

        // Loop termination: stop if the model produced no tool calls AND
        // the stop reason was a genuine end-of-turn (not max_tokens, which
        // means the model was cut off and should continue in the next turn).
        if (
          this.pendingToolCalls.length === 0 &&
          stopReason !== "max_tokens"
        ) {
          break
        }
      }

      // ── Loop finished ──
      if (this.abortController.signal.aborted) {
        this.sessionState.status = "aborted"
      } else {
        this.sessionState.status = "completed"
      }
    } catch (err) {
      // ── onError hook + ErrorRecovery for fatal errors (A4) ──
      const harnessError: HarnessError = {
        code: "fatal",
        message: err instanceof Error ? err.message : String(err),
        source: "harness",
        recoverable: false,
        cause: err,
        timestamp: Date.now(),
      }

      let recovery: { action: string; reason?: string } | null = null
      if (this.hookRegistry) {
        const results = await this.hookRegistry.execute(
          "onError",
          {
            session: this.sessionState,
            shared: {
              projectRoot: this.config.session.workDir,
              projectConfig: null,
              loadedResources: new Map(),
            },
          },
          harnessError,
        )
        recovery = this.extractRecovery(results)
      }

      if (recovery?.action === "ignore") {
        // F-4: Handler chose to ignore the fatal error, but still push a
        // warning-level error event so observability tooling can see it.
        this.sessionState.status = "completed"
        this.config.logger.warn(
          `[Harness] Fatal error ignored by onError handler: ${harnessError.message}`,
        )
        this.pushEvent({
          type: "error",
          error: { ...harnessError, code: "fatal_ignored", recoverable: true },
        })
      } else {
        // "abort", "retry" (not supported for fatal), or no recovery
        this.sessionState.status =
          recovery?.action === "abort" ? "aborted" : "error"

        this.pushEvent({
          type: "error",
        error: {
          code: "fatal",
          message: err instanceof Error ? err.message : String(err),
          source: "harness",
          recoverable: false,
          cause: err,
          timestamp: Date.now(),
        },
      })
      }
    } finally {
      this.isLoopRunning = false
      this.isLoopDone = true

      this.sessionResult = {
        sessionId: this.sessionState.id,
        status:
          this.sessionState.status === "completed" ||
          this.sessionState.status === "running"
            ? "completed"
            : this.sessionState.status === "aborted"
              ? "aborted"
              : "error",
        turns: this.turnHistory.length,
        tokenUsage: this.totalTokens,
        finalMessage: "",
        artifacts: [],
      }

      // ── onSessionEnd hook ──
      if (this.hookRegistry && this.sessionResult) {
        await this.hookRegistry.execute(
          "onSessionEnd",
          {
            session: this.sessionState,
            shared: {
              projectRoot: this.config.session.workDir,
              projectConfig: null,
              loadedResources: new Map(),
            },
          },
          this.sessionResult,
        )
      }

      // Wake up a waiting consumer
      if (this.resolveNext) {
        const resolve = this.resolveNext
        this.resolveNext = null
        resolve({ done: true, value: this.sessionResult })
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Helpers ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Extract the first non-void ErrorRecovery action from onError hook results.
   * Returns null if no recovery action was proposed (or all were void).
   */
  private extractRecovery(
    results: unknown[],
  ): { action: string; reason?: string } | null {
    for (const r of results) {
      if (
        r &&
        typeof r === "object" &&
        "action" in (r as Record<string, unknown>)
      ) {
        return r as { action: string; reason?: string }
      }
    }
    return null
  }

  private buildTurnContext(): TurnContext {
    if (!this.currentTurn) {
      throw new Error(
        "Harness: buildTurnContext() called with no active turn. " +
          "This is a framework bug — buildTurnContext should only be called " +
          "during an active TAOR turn.",
      )
    }
    return {
      session: this.sessionState,
      turn: this.currentTurn,
      shared: {
        projectRoot: this.config.session.workDir,
        projectConfig: null,
        loadedResources: new Map(),
      },
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── AsyncGenerator protocol ──
  // ═══════════════════════════════════════════════════════════════

  [Symbol.asyncIterator](): AsyncGenerator<
    HarnessEvent,
    SessionResult,
    UserDecision | undefined
  > {
    return this
  }

  /**
   * Pull the next event (consumer side).
   *
   * If a `decision` is provided, it resolves a pending approval-required
   * await in the TAOR loop before pulling the next event.
   */
  async next(
    decision?: UserDecision,
  ): Promise<IteratorResult<HarnessEvent, SessionResult>> {
    // ── Inject decision if provided ──
    if (decision) {
      this.resolveDecision(decision)

      // Handle interject: push a synthetic user message
      if (decision.type === "interject" && decision.message) {
        this.messages.push({
          role: "user",
          content: [{ type: "text", text: decision.message }],
        })
      }
    }

    // ── Start the TAOR loop on first next() call ──
    if (!this.loopPromise && this.pendingPrompt) {
      this.loopPromise = this.runTAOR()
    }

    // ── Return queued event if available ──
    if (this.eventQueue.length > 0) {
      return { done: false, value: this.eventQueue.shift()! }
    }

    // ── If loop is done, return final result ──
    if (this.isLoopDone && this.sessionResult) {
      return { done: true, value: this.sessionResult }
    }

    // ── Wait for next event ──
    return new Promise((resolve) => {
      this.resolveNext = resolve
    })
  }

  async return(
    value?: SessionResult | PromiseLike<SessionResult>,
  ): Promise<IteratorResult<HarnessEvent, SessionResult>> {
    this.abortController.abort()
    this.isLoopDone = true

    // F-2: Clear buffered events — ECMAScript AsyncGenerator spec:
    // once return() yields {done:true}, all subsequent next() calls
    // must also return {done:true}.
    this.eventQueue.length = 0

    // F-1/F-3: Unblock TAOR loop if waiting for decision
    if (this.decisionResolve) {
      const resolve = this.decisionResolve
      this.decisionResolve = null
      resolve({ type: "deny", callId: "__returned__" })
    }

    // F-4: Wait for TAOR loop to fully stop before returning
    if (this.loopPromise) {
      try { await this.loopPromise } catch { /* loop errors captured via events */ }
    }

    const result =
      (await value) ??
      this.sessionResult ?? {
        sessionId: this.sessionState.id,
        status: "aborted",
        turns: this.turnHistory.length,
        tokenUsage: this.totalTokens,
        finalMessage: "",
        artifacts: [],
      }

    this.sessionResult = result

    // Wake consumer
    if (this.resolveNext) {
      const resolve = this.resolveNext
      this.resolveNext = null
      resolve({ done: true, value: result })
    }

    return { done: true, value: result }
  }

  async throw(
    e: Error,
  ): Promise<IteratorResult<HarnessEvent, SessionResult>> {
    this.abortController.abort()
    this.isLoopDone = true

    // F-2: Clear buffered events (same protocol requirement as return())
    this.eventQueue.length = 0

    // F-1/F-3: Unblock TAOR loop if waiting for decision
    if (this.decisionResolve) {
      const resolve = this.decisionResolve
      this.decisionResolve = null
      resolve({ type: "deny", callId: "__thrown__" })
    }

    // F-4: Wait for TAOR loop to stop
    if (this.loopPromise) {
      try { await this.loopPromise } catch { /* loop errors captured via events */ }
    }

    this.pushEvent({
      type: "error",
      error: {
        code: "fatal",
        message: e.message,
        source: "harness",
        recoverable: false,
        cause: e,
        timestamp: Date.now(),
      },
    })

    const result: SessionResult = {
      sessionId: this.sessionState.id,
      status: "error",
      turns: this.turnHistory.length,
      tokenUsage: this.totalTokens,
      finalMessage: e.message,
      artifacts: [],
    }
    this.sessionResult = result

    if (this.resolveNext) {
      const resolve = this.resolveNext
      this.resolveNext = null
      resolve({ done: true, value: result })
    }

    return { done: true, value: result }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── EventEmitter protocol ──
  // ═══════════════════════════════════════════════════════════════

  /** Wildcard — listen to all events. */
  on(
    type: "*",
    handler: (event: HarnessEvent) => void | Promise<void>,
    opts?: { signal?: AbortSignal },
  ): Unsubscribe
  /** Typed — handler narrowed per event type. */
  on<E extends HarnessEvent["type"]>(
    type: E,
    handler: (
      event: Extract<HarnessEvent, { type: E }>,
    ) => void | Promise<void>,
    opts?: { signal?: AbortSignal },
  ): Unsubscribe
  on(
    type: string,
    handler: EventHandler,
    opts?: { signal?: AbortSignal },
  ): Unsubscribe {
    const set: Set<EventHandler> =
      type === "*"
        ? this.wildcardListeners
        : (this.listeners.get(type) ?? (() => {
            const s = new Set<EventHandler>()
            this.listeners.set(type, s)
            return s
          })())

    set.add(handler)

    // Auto-unsubscribe on signal abort
    if (opts?.signal) {
      opts.signal.addEventListener(
        "abort",
        () => set.delete(handler),
        { once: true },
      )
    }

    return () => set.delete(handler)
  }

  off(type: HarnessEvent["type"] | "*", handler: EventHandler): void {
    if (type === "*") {
      this.wildcardListeners.delete(handler)
    } else {
      this.listeners.get(type)?.delete(handler)
    }
  }

  offAll(type?: HarnessEvent["type"] | "*"): void {
    if (!type) {
      this.listeners.clear()
      this.wildcardListeners.clear()
    } else if (type === "*") {
      this.wildcardListeners.clear()
    } else {
      this.listeners.get(type)?.clear()
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Convenience ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Set the initial prompt and prepare the TAOR loop.
   * The loop does NOT start until the consumer's first `next()` call.
   */
  start(prompt: string): this {
    // I-6: Guard against accidental double-start
    if (this.loopPromise) {
      throw new Error(
        "Harness: cannot restart a running session. Create a new Harness instance.",
      )
    }
    if (this.pendingPrompt !== null) {
      this.config.logger.warn(
        "[Harness] start() called again before loop began — " +
          "previous prompt will be overwritten.",
      )
    }
    this.pendingPrompt = prompt
    return this
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Queries ──
  // ═══════════════════════════════════════════════════════════════

  get state(): SessionState {
    return { ...this.sessionState }
  }

  get turns(): TurnRecord[] {
    return [...this.turnHistory]
  }

  get tokenUsage(): TokenUsage {
    return { ...this.totalTokens }
  }

  get isRunning(): boolean {
    return this.isLoopRunning
  }

  /** Aggregated runtime metrics for observability tooling. */
  get metrics() {
    return {
      sessionId: this.sessionState.id,
      status: this.sessionState.status,
      turns: this.turnHistory.length,
      tokenUsage: { ...this.totalTokens },
      toolCalls: this.turnHistory.reduce((sum, t) => sum + t.toolCalls, 0),
      uptime: Date.now() - this.sessionState.startedAt,
      errors: this.turnHistory.filter(t => t.status === "error").length,
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Control ──
  // ═══════════════════════════════════════════════════════════════

  abort(reason?: string): void {
    // I-5: If the loop has already finished naturally, don't overwrite
    // the completed status. abort() is a no-op after the session ends.
    if (this.isLoopDone) return

    this.abortController.abort(reason)
    this.sessionState.status = "aborted"
    this.isLoopDone = true

    // F-1: Unblock TAOR loop if it's waiting for a decision.
    // Without this, the TAOR loop's `await waitForDecision()` would
    // never resolve → permanent deadlock.
    if (this.decisionResolve) {
      const resolve = this.decisionResolve
      this.decisionResolve = null
      resolve({ type: "deny", callId: "__aborted__", reason })
    }

    // Wake waiting consumer
    const result: SessionResult = {
      sessionId: this.sessionState.id,
      status: "aborted",
      turns: this.turnHistory.length,
      tokenUsage: this.totalTokens,
      finalMessage: reason ?? "Aborted",
      artifacts: [],
    }
    this.sessionResult = result

    if (this.resolveNext) {
      const resolve = this.resolveNext
      this.resolveNext = null
      resolve({ done: true, value: result })
    }
  }

  kill(): void {
    this.abortController.abort("killed")
    this.sessionState.status = "aborted"
    this.isLoopRunning = false
    this.isLoopDone = true

    // F-3: Unblock TAOR loop if waiting for decision — resolve THEN null,
    // never null before resolve (would cause permanent deadlock).
    if (this.decisionResolve) {
      const resolve = this.decisionResolve
      this.decisionResolve = null
      resolve({ type: "deny", callId: "__killed__" })
    }

    // Clear everything
    this.eventQueue.length = 0
    this.listeners.clear()
    this.wildcardListeners.clear()

    const result: SessionResult = {
      sessionId: this.sessionState.id,
      status: "aborted",
      turns: this.turnHistory.length,
      tokenUsage: this.totalTokens,
      finalMessage: "Killed",
      artifacts: [],
    }
    this.sessionResult = result

    if (this.resolveNext) {
      const resolve = this.resolveNext
      this.resolveNext = null
      resolve({ done: true, value: result })
    }
  }

  pause(): void {
    this.sessionState.status = "paused"
  }

  resume(): void {
    if (this.sessionState.status === "paused") {
      this.sessionState.status = "running"
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Sub-agent — see @taor/subagent ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Inject a subagent coordinator.
   *
   * Called by `createHarness()` in @taor/engine after constructing
   * the SubagentCoordinator with the parent's adapter + tool registry.
   */
  setSubagent(coordinator: ISubagentCoordinator): this {
    this.subagentCoordinator = coordinator
    return this
  }

  /**
   * Spawn a sub-agent. Delegates to the injected SubagentCoordinator.
   *
   * TG0: inline isolation only. Returns a Promise<handle> (async because
   * beforeSpawn hook must complete before worker creation — I-9).
   * The sub-agent runs in the background as an independent TAOR loop.
   *
   * @throws if the subagent coordinator is not injected
   */
  async spawn(spec: {
    description: string
    prompt: string
    tools?: unknown[]
    model?: string
    isolation?: "inline" | "process" | "worktree"
    maxTurns?: number
    timeout?: number
  }): Promise<{
    readonly id: string
    readonly description: string
    status: string
    started(): Promise<void>
    done(): Promise<{
      ok: boolean
      data?: unknown
      turns: number
      tokenUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
      error?: string
    }>
    abort(reason?: string): void
  }> {
    if (!this.subagentCoordinator) {
      throw new Error(
        "Harness.spawn() not initialized — call setSubagent() or use createHarness()",
      )
    }
    return this.subagentCoordinator.spawn(spec)
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Subsystem accessors ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Inject a hook registry.
   *
   * Called by `createHarness()` in @taor/engine after constructing
   * the HookRegistry from HarnessConfig.hooks.
   */
  setHooks(registry: IHookRegistry): this {
    this.hookRegistry = registry
    return this
  }

  get hooks(): IHookRegistry {
    if (!this.hookRegistry) {
      throw new Error(
        "Harness.hooks not initialized — call setHooks() or use createHarness()",
      )
    }
    return this.hookRegistry
  }

  /**
   * Inject a permission engine.
   *
   * Called by `createHarness()` in @taor/engine after constructing
   * the PermissionEngine with the resolved config + tool descriptors.
   * Must be called before the TAOR loop starts — permission checks
   * during ACT phase depend on this engine being available.
   */
  setPermission(engine: IPermissionEngine): this {
    this.permissionEngine = engine
    return this
  }

  get permission(): IPermissionEngine {
    if (!this.permissionEngine) {
      throw new Error(
        "Harness.permission not initialized — call setPermission() or use createHarness()",
      )
    }
    return this.permissionEngine
  }

  /**
   * Inject a memory facade.
   *
   * Called by `createHarness()` in @taor/engine after constructing
   * the MemoryFacade from HarnessConfig.memory.
   */
  setMemory(facade: IMemoryFacade): this {
    this.memoryFacade = facade
    return this
  }

  get memory(): IMemoryFacade {
    if (!this.memoryFacade) {
      throw new Error(
        "Harness.memory not initialized — call setMemory() or use createHarness()",
      )
    }
    return this.memoryFacade
  }

  /**
   * Inject a compressor pipeline.
   */
  setCompressor(pipeline: ICompressorPipeline): this {
    this.compressorPipeline = pipeline
    return this
  }

  get compressor(): ICompressorPipeline {
    if (!this.compressorPipeline) {
      throw new Error(
        "Harness.compressor not initialized — call setCompressor() or use createHarness()",
      )
    }
    return this.compressorPipeline
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Serialization (v2) ──
  // ═══════════════════════════════════════════════════════════════

  /** Per-turn message snapshots for serialization. */
  private _turnMessages: Message[][] = []

  /**
   * Serialize the session to a storable snapshot.
   * Must not be called while TAOR loop is running.
   */
  serialize(): {
    version: number
    sessionId: string
    model: string
    workDir: string
    startedAt: number
    tokenUsage: TokenUsage
    turnCount: number
    turns: { id: string; index: number; messages: Message[]; tokenUsage: TokenUsage; compressedAt: string | null }[]
    memorySnapshots: { user: Record<string, unknown>; project: Record<string, unknown> }
  } {
    if (this.isLoopRunning) {
      throw new Error(
        "Cannot serialize while TAOR loop is running. " +
          "Serialization is only safe at turn boundaries.",
      )
    }

    // Collect memory snapshots if memory facade is available
    const memorySnapshots = {
      user: {} as Record<string, unknown>,
      project: {} as Record<string, unknown>,
    }

    return {
      version: 1,
      sessionId: this.sessionState.id,
      model: this.sessionState.model,
      workDir: this.sessionState.workDir,
      startedAt: this.sessionState.startedAt,
      tokenUsage: { ...this.totalTokens },
      turnCount: this.turnHistory.length,
      turns: this.turnHistory.map((tr, i) => ({
        id: tr.id,
        index: tr.index,
        messages: this._turnMessages[i] ?? [],
        tokenUsage: tr.tokenUsage,
        compressedAt: tr.compressedAt,
      })),
      memorySnapshots,
    }
  }

  /**
   * Reconstruct a Harness session from a serialized snapshot.
   * Adapter + registry are passed directly — no post-construction injection needed.
   */
  static deserialize(
    data: {
      version: number
      sessionId: string
      model: string
      workDir: string
      startedAt: number
      tokenUsage: TokenUsage
      turnCount: number
      turns: { id: string; index: number; messages: Message[]; tokenUsage: TokenUsage; compressedAt: string | null }[]
    },
    config: ResolvedConfig,
    adapter: IAdapter,
    registry: IToolRegistry,
  ): Harness {
    const harness = new Harness(
      { ...config, session: { ...config.session, id: data.sessionId } },
      adapter,
      registry,
    )

    // Restore session state
    harness.sessionState.startedAt = data.startedAt
    harness.sessionState.turnCount = data.turnCount
    harness.totalTokens = { ...data.tokenUsage }
    harness.turnHistory = data.turns.map((t) => ({
      id: t.id,
      index: t.index,
      status: "completed" as const,
      tokenUsage: t.tokenUsage,
      toolCalls: 0,
      duration: 0,
      compressedAt: (t.compressedAt as CompressLevel) ?? null,
    }))
    harness._turnMessages = data.turns.map((t) => [...t.messages])
    harness.messages = data.turns.flatMap((t) => t.messages)
    harness.pendingPrompt = null // already consumed

    return harness
  }
}
