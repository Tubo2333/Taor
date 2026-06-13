/**
 * Minimal Taor example — no real LLM needed.
 * Run: npx tsx examples/basic.ts
 */
import { createHarness } from "@taor/engine"

// Inline mock adapter — just echoes back
class EchoAdapter {
  readonly provider = "echo"
  getModelInfo() { return { id: "echo", maxInputTokens: 1000, maxOutputTokens: 500 } }
  async buildRequest() { return {} }
  async *think() {
    yield { type: "text", content: "Hello! I'm a mock agent. This shows the TAOR loop is working." }
    yield { type: "stop", reason: "end_turn" as const, usage: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0 } }
  }
  formatToolResult(_id: string, r: any) { return r.ok ? JSON.stringify(r.data) : r.error }
  wrapToolResult(id: string, r: any) { return { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: id, content: String(r.data ?? r.error ?? "") }] } }
  normalizeError(e: any) { return { code: "error", message: String(e), source: "adapter" as const, recoverable: false, timestamp: Date.now() } }
  countTokens() { return 10 }
}

async function main() {
  const harness = createHarness({ model: "echo", tools: [], adapter: EchoAdapter as any })
  harness.start("Hello!")
  console.log("TAOR loop started. Events:")
  for await (const event of harness) {
    const { type, ...rest } = event as any
    console.log(`  [${type}]`, Object.keys(rest).join(", ") || "(no data)")
  }
  console.log("Done. Turns:", harness.turns.length, "Tokens:", harness.tokenUsage.total)
}

main().catch(console.error)
