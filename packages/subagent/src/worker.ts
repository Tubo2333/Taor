// @harness/subagent — SubagentWorker (inline TAOR loop in same process)

import type { TokenUsage, Message, Logger } from "@harness/core"
import type { SubagentSpec, SubagentResult } from "./types.js"
import type { SubagentHandleImpl } from "./handle.js"

// ═══════════════════════════════════════════════════════════════════
// ─── Structural interface (avoids importing @harness/adapters) ───
// ═══════════════════════════════════════════════════════════════════

interface InlineAdapter {
  readonly provider: string
  buildRequest(
    messages: Message[],
    systemPrompt: string,
    model: string,
    tools?: InlineTool[],
  ): Promise<unknown>
  think(
    request: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<InlineThinkEvent, void, void>
  /** Format a tool execution result. TG0: returns string or structured content. */
  formatToolResult(
    callId: string,
    result: { ok: boolean; data?: unknown; error?: string },
  ): unknown
}

interface InlineTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(params: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }>
}

interface InlineThinkEvent {
  type: string
  content?: string
  call?: { id: string; name: string; arguments: Record<string, unknown> }
  reason?: string
  usage?: TokenUsage
}

// ═══════════════════════════════════════════════════════════════════
// ─── Defaults ───
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_MAX_TURNS = 20
const DEFAULT_TIMEOUT = 300_000 // 5 minutes

// ═══════════════════════════════════════════════════════════════════
// ─── SubagentWorker ───
// ═══════════════════════════════════════════════════════════════════

/**
 * SubagentWorker — runs an independent TAOR loop.
 *
 * TG0: inline isolation only. The worker runs in the same process, sharing
 * the parent's adapter but with a restricted tool set and independent
 * turn/token budget.
 *
 * TG1: process/worktree isolation via child_process.fork() + IPC.
 */
export class SubagentWorker {
  private handle: SubagentHandleImpl
  private spec: SubagentSpec
  private adapter: InlineAdapter
  private tools: InlineTool[]
  private logger: Logger
  private abortController = new AbortController()

  // ── Accumulators ──
  private messages: Message[] = []
  private totalTurns = 0
  private tokenUsage: TokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  }

  constructor(
    handle: SubagentHandleImpl,
    spec: SubagentSpec,
    adapter: InlineAdapter,
    tools: InlineTool[],
    logger: Logger,
  ) {
    this.handle = handle
    this.spec = spec
    this.adapter = adapter
    this.tools = tools
    this.logger = logger
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Main ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Run the inline TAOR loop.
   *
   * Called by SubagentCoordinator after handle creation.
   * Returns a SubagentResult when the loop terminates.
   */
  async run(): Promise<SubagentResult> {
    const maxTurns = this.spec.maxTurns ?? DEFAULT_MAX_TURNS
    const timeout = this.spec.timeout ?? DEFAULT_TIMEOUT

    // Timeout guard
    const timeoutId = setTimeout(() => {
      this.abortController.abort()
    }, timeout)

    const startTime = Date.now()

    // A5: Periodic heartbeat (every 5s) for zombie detection
    const heartbeatInterval = setInterval(() => {
      this.handle._onHeartbeat(
        this.totalTurns,
        Date.now() - startTime,
        this.tokenUsage,
      )
    }, 5000)

    try {
      // ── Push system + user prompt ──
      this.messages.push({
        role: "user",
        content: [{ type: "text", text: this.spec.prompt }],
      })

      // Signal started
      this.handle._onStarted()

      // ── TAOR loop ──
      for (
        let turn = 0;
        turn < maxTurns && !this.abortController.signal.aborted;
        turn++
      ) {
        const turnStart = Date.now()

        // ── THINK ──
        // F-3: spec.prompt is the user message (pushed above). Don't pass it
        // again as system prompt — it causes duplicate instructions to the LLM.
        const request = await this.adapter.buildRequest(
          this.messages,
          "",
          this.spec.model ?? "default",
          this.tools.length > 0 ? this.tools : undefined,
        )

        const pendingToolCalls: {
          id: string
          name: string
          arguments: Record<string, unknown>
        }[] = []
        let stopReason = "end_turn"
        let turnInput = 0
        let turnOutput = 0

        try {
          for await (const te of this.adapter.think(
            request,
            this.abortController.signal,
          )) {
            if (this.abortController.signal.aborted) break

            switch (te.type) {
              case "tool_use":
                if (te.call) pendingToolCalls.push(te.call)
                break
              case "stop":
                if (te.usage) {
                  turnInput = te.usage.input
                  turnOutput = te.usage.output
                }
                stopReason = te.reason ?? "end_turn"
                break
              // S-2: Adapter errors must not be silently dropped
              case "error":
                throw new Error(
                  (te as { error?: { message?: string } }).error?.message ??
                    "Adapter error during think()",
                )
            }
          }
        } catch (err) {
          if (this.abortController.signal.aborted) break
          return {
            ok: false,
            turns: this.totalTurns,
            tokenUsage: this.tokenUsage,
            error: err instanceof Error ? err.message : String(err),
          }
        }

        // ── ACT ──
        const toolResults: string[] = []
        for (const tc of pendingToolCalls) {
          if (this.abortController.signal.aborted) break

          const tool = this.tools.find((t) => t.name === tc.name)
          if (!tool) continue

          let execResult: { ok: boolean; data?: unknown; error?: string }
          try {
            const result = await tool.execute(tc.arguments)
            execResult = result
            toolResults.push(
              result.ok
                ? `Tool ${tc.name}: OK`
                : `Tool ${tc.name}: ${result.error ?? "error"}`,
            )
          } catch (err) {
            execResult = {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }
            toolResults.push(
              `Tool ${tc.name}: ${err instanceof Error ? err.message : String(err)}`,
            )
          }

          // I-3: Use adapter's formatToolResult for standard-compliant output
          // instead of ad-hoc string construction. Falls back to text on error.
          const formattedContent = execResult.ok
            ? this.adapter.formatToolResult(tc.id, execResult)
            : `Tool ${tc.name}: ${execResult.error ?? "error"}`
          this.messages.push({
            role: "tool",
            content: [
              {
                type: "tool_result",
                tool_use_id: tc.id,
                content: formattedContent as string,
              },
            ],
          })
        }

        // ── OBSERVE ──
        this.tokenUsage.input += turnInput
        this.tokenUsage.output += turnOutput
        this.tokenUsage.total = this.tokenUsage.input + this.tokenUsage.output
        this.totalTurns = turn + 1

        // Heartbeat at turn boundary
        this.handle._onHeartbeat(
          turn,
          Date.now() - startTime,
          this.tokenUsage,
        )

        // Stop if LLM produced no tool calls (conversation complete)
        if (pendingToolCalls.length === 0 && stopReason !== "max_tokens") {
          break
        }
      }

      // ── Build result ──
      const wasAborted = this.abortController.signal.aborted
      // I-1: Include aborted flag so handle._onDone can transition to "aborted"
      // instead of "error" for timeout/abort scenarios.
      return {
        ok: !wasAborted,
        aborted: wasAborted,
        turns: this.totalTurns,
        tokenUsage: this.tokenUsage,
        error: wasAborted ? "Aborted or timed out" : undefined,
      } as SubagentResult & { aborted: boolean }
    } catch (err) {
      return {
        ok: false,
        turns: this.totalTurns,
        tokenUsage: this.tokenUsage,
        error: err instanceof Error ? err.message : String(err),
      }
    } finally {
      clearTimeout(timeoutId)
      clearInterval(heartbeatInterval)
    }
  }

  /**
   * Signal the worker to abort at the next turn boundary.
   */
  abort(): void {
    this.abortController.abort()
  }
}
