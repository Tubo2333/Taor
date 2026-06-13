// @taor/subagent — Remote process entry point (child process)
//
// This module is fork()'d by ProcessWorker. It receives the subagent spec
// and tool module paths via IPC, imports tools, and runs an inline TAOR loop.
// Results are sent back to the parent via process.send().

import type { Message, TokenUsage } from "@taor/core"
import type { SubagentSpec, SubagentResult } from "./types.js"

// ═══════════════════════════════════════════════════════════════════
// ─── Structural interfaces (same as inline worker) ───
// ═══════════════════════════════════════════════════════════════════

interface RemoteTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(params: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }>
}

interface RemoteAdapter {
  buildRequest(
    messages: Message[],
    systemPrompt: string,
    model: string,
    tools?: RemoteTool[],
  ): Promise<unknown>
  think(
    request: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<
    { type: string; content?: string; call?: { id: string; name: string; arguments: Record<string, unknown> }; reason?: string; usage?: TokenUsage },
    void,
    void
  >
  formatToolResult(callId: string, result: { ok: boolean; data?: unknown; error?: string }): unknown
  wrapToolResult(callId: string, result: { ok: boolean; data?: unknown; error?: string }, toolName?: string): Message
}

// ═══════════════════════════════════════════════════════════════════
// ─── IPC Messages ───
// ═══════════════════════════════════════════════════════════════════

interface InitMessage {
  type: "init"
  spec: SubagentSpec
  toolModulePaths: string[]
  adapterModulePath: string
  model: string
}

// ═══════════════════════════════════════════════════════════════════
// ─── Main ───
// ═══════════════════════════════════════════════════════════════════

// Detect parent death — exit cleanly if IPC channel disconnects.
// Use exit(0) so process managers (PM2 etc.) don't interpret this as a crash.
process.on("disconnect", () => {
  process.exit(0)
})

// M4: Active orphan detection — if parent JS thread hangs (infinite loop),
// IPC won't disconnect. Track last heartbeat and exit if no message for 60s.
let lastHeartbeat = Date.now()
const HEARTBEAT_TIMEOUT = 60_000

const heartbeatCheck = setInterval(() => {
  if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT) {
    process.exit(0)
  }
}, 10_000)

let abortController = new AbortController()

process.on("message", async (msg: InitMessage | { type: "abort" }) => {
  lastHeartbeat = Date.now()
  if (msg.type === "abort") {
    abortController.abort()
    return
  }

  if (msg.type === "init") {
    try {
      const result = await runWorker(msg)
      if (process.send) process.send({ type: "done", result })
    } catch (err) {
      if (process.send) {
        process.send({
          type: "error",
          error: {
            code: "execution_error",
            message: err instanceof Error ? err.message : String(err),
          },
        })
      }
    } finally {
      // Give IPC time to flush before exit
      setTimeout(() => process.exit(0), 100)
    }
  }
})

async function runWorker(msg: InitMessage): Promise<SubagentResult> {
  // ── Import adapter + tools dynamically (I-2: 30s timeout per import) ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapterMod = await importWithTimeout(msg.adapterModulePath, 30_000) as any
  const adapter: RemoteAdapter = adapterMod.default ?? adapterMod

  const tools: RemoteTool[] = []
  for (const modPath of msg.toolModulePaths) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await importWithTimeout(modPath, 30_000) as any
    const ToolClass = mod.default ?? mod[Object.keys(mod)[0]!]
    if (typeof ToolClass === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const instance = new (ToolClass as any)()
      if (typeof instance.toDescriptor === "function") {
        const desc = instance.toDescriptor() as {
          name: string; description: string; parameters: Record<string, unknown>
          execute: (p: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>
        }
        tools.push({
          name: desc.name,
          description: desc.description,
          parameters: desc.parameters as Record<string, unknown>,
          execute: desc.execute as (p: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>,
        })
      }
    }
  }

  const maxTurns = msg.spec.maxTurns ?? 20
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: msg.spec.prompt }] },
  ]

  // Signal parent that worker is ready
  if (process.send) process.send({ type: "started" })

  const tokenUsage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  let totalTurns = 0
  const startTime = Date.now()

  // A5: Periodic heartbeat every 5s for zombie detection
  const heartbeatInterval = setInterval(() => {
    if (process.send && !abortController.signal.aborted) {
      process.send({ type: "heartbeat", turn: totalTurns, elapsed: Date.now() - startTime, tokenUsage })
    }
  }, 5000)

  // ── TAOR loop ──
  for (let turn = 0; turn < maxTurns && !abortController.signal.aborted; turn++) {
    const request = await adapter.buildRequest(
      messages,
      "",
      msg.model,
      tools.length > 0 ? tools : undefined,
    )

    const pending: { id: string; name: string; arguments: Record<string, unknown> }[] = []
    let stopReason = "end_turn"

    try {
      for await (const te of adapter.think(request, abortController.signal)) {
        if (abortController.signal.aborted) break
        switch (te.type) {
          case "tool_use":
            if (te.call) pending.push(te.call)
            break
          case "stop":
            if (te.usage) {
              tokenUsage.input += te.usage.input
              tokenUsage.output += te.usage.output
            }
            stopReason = te.reason ?? "end_turn"
            break
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) break
      throw err
    }

    // ── ACT ──
    for (const tc of pending) {
      if (abortController.signal.aborted) break
      const tool = tools.find((t) => t.name === tc.name)
      if (!tool) continue

      let toolResult: { ok: boolean; data?: unknown; error?: string }
      try {
        toolResult = await tool.execute(tc.arguments)
      } catch (e) {
        toolResult = { ok: false, error: e instanceof Error ? e.message : String(e) }
      }

      // F4 fix: use adapter's wrapToolResult to get provider-correct envelope,
      // rather than hardcoding role="tool" (OpenAI style) which breaks AnthropicAdapter.
      const wrapped = adapter.wrapToolResult(tc.id, toolResult, tc.name)
      messages.push(wrapped)
    }

    totalTurns = turn + 1
    tokenUsage.total = tokenUsage.input + tokenUsage.output

    if (process.send) {
      process.send({ type: "heartbeat", turn, elapsed: 0, tokenUsage })
    }

    if (pending.length === 0 && stopReason !== "max_tokens") break
  }

  clearInterval(heartbeatInterval) // S-1: cleanup before exit
  clearInterval(heartbeatCheck)
  return {
    ok: !abortController.signal.aborted,
    turns: totalTurns,
    tokenUsage,
    error: abortController.signal.aborted ? "Aborted" : undefined,
  }
}

// I-2: Prevent hanging on broken/non-existent module paths
function importWithTimeout(modulePath: string, timeoutMs: number): Promise<unknown> {
  return Promise.race([
    import(modulePath),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Dynamic import timed out after ${timeoutMs}ms: ${modulePath}`)),
        timeoutMs,
      ),
    ),
  ])
}
