/**
 * Real Anthropic-powered agent example.
 * Prerequisites: export ANTHROPIC_API_KEY=sk-ant-...
 * Run: npx tsx examples/real.ts
 */
import { createHarness } from "@harness/engine"

async function main() {
  const harness = createHarness({
    model: "claude-sonnet-4-6",
    tools: [],
    session: { maxTurns: 3 },
  })
  harness.start("What is the capital of France? Answer in one sentence.")
  console.log("Agent thinking...")
  for await (const event of harness) {
    if (event.type === "thought") console.log("💭", (event as any).content?.slice(0, 120))
    if (event.type === "turn-ended") console.log("✅ Turn complete")
  }
  console.log("Answer received. Token usage:", harness.tokenUsage.total)
}

main().catch(console.error)
