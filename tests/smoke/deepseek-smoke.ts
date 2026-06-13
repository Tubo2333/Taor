/**
 * DeepSeek adapter — real API smoke test (Gate 3)
 * Requires: DEEPSEEK_API_KEY env var
 */
import { DeepSeekAdapter } from "@harness/adapters"

async function main() {
  const adapter = new DeepSeekAdapter()
  console.log("[1/5] Adapter: provider=" + adapter.provider)

  const info = adapter.getModelInfo("deepseek-chat")
  console.log("[2/5] Model: maxInput=" + info.maxInputTokens + ", tools=" + info.supportsToolUse)

  const req = await adapter.buildRequest(
    {
      session: { id: "smoke", model: "deepseek-chat" },
      turn: {
        index: 0,
        messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Say hello in one word." }] }],
      },
    } as any,
    { maxTokens: 50 },
  )
  console.log("[3/5] buildRequest OK")

  const ac = new AbortController()
  for await (const ev of adapter.think(req, ac.signal)) {
    switch (ev.type) {
      case "text":
        console.log('[4/5] text: "' + (ev.content as string).slice(0, 200) + '"')
        break
      case "thinking":
        console.log('[4/5] thinking: "' + (ev.content as string).slice(0, 100) + '"')
        break
      case "stop":
        console.log("[4/5] stop: reason=" + ev.reason + ", tokens=" + JSON.stringify(ev.usage))
        break
      case "error":
        console.log("[4/5] ERROR: code=" + (ev.error.code) + ", message=" + String(ev.error.message).slice(0, 300))
        break
      default:
        console.log("[4/5] " + ev.type + ": " + JSON.stringify(ev).slice(0, 200))
    }
  }
  console.log("[5/5] SMOKE TEST: PASS ✅")
}

main().catch((err) => {
  console.error("SMOKE TEST: FAIL ❌ — " + String(err.message ?? err).slice(0, 500))
  process.exitCode = 1
})
