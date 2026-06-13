/**
 * Code Reviewer Agent — GAP-10 real-world example.
 *
 * Demonstrates:
 * - Tools: read-file, grep, write-file (with HITL approval)
 * - Multi-turn: agent reads files, searches for patterns, proposes changes
 * - HITL approval: write-file requires human approval before execution
 * - Token budget hook: aborts if estimated cost exceeds $5
 *
 * ## Usage
 *
 * ```bash
 * # Install dependencies (from project root):
 * npm install
 *
 * # Run the agent against a directory:
 * npx tsx examples/code-reviewer/agent.ts --dir ./packages/core/src
 *
 * # With a custom prompt:
 * npx tsx examples/code-reviewer/agent.ts --dir ./src --prompt "Find all async functions missing try-catch"
 * ```
 *
 * ## Expected output (≤3 turns)
 *
 * 1. Agent reads key files to understand the codebase
 * 2. Agent searches for patterns (e.g., error handling gaps)
 * 3. Agent proposes changes with reasoning, respecting HITL for write-file
 *
 * Requires: ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable.
 */

import { createHarness } from "@harness/engine"
import type { HarnessEvent, UserDecision } from "@harness/engine"
import { readFileTool } from "./tools/read-file.js"
import { grepTool } from "./tools/grep.js"
import { writeFileTool } from "./tools/write-file.js"
import { createBudgetHook } from "./hooks/budget.js"

// ═══════════════════════════════════════════════════════════════════
// ─── CLI Argument parsing ───
// ═══════════════════════════════════════════════════════════════════

function parseArgs(): { dir: string; prompt?: string; model: string; maxTurns: number } {
  const args = process.argv.slice(2)
  const result = {
    dir: "./src",
    prompt: undefined as string | undefined,
    model: "claude-sonnet-4-6",
    maxTurns: 3,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--dir":
        result.dir = args[++i] ?? "./src"
        break
      case "--prompt":
        result.prompt = args[++i]
        break
      case "--model":
        result.model = args[++i] ?? "claude-sonnet-4-6"
        break
      case "--turns":
        result.maxTurns = parseInt(args[++i] ?? "3", 10)
        break
      case "--help":
        console.log(`
Code Reviewer Agent — v0.2.0

Usage: npx tsx examples/code-reviewer/agent.ts [options]

Options:
  --dir <path>     Directory to review (default: ./src)
  --prompt <str>   Custom review prompt
  --model <name>   LLM model to use (default: claude-sonnet-4-6)
  --turns <n>      Max turns (default: 3)
  --help           Show this help

Examples:
  npx tsx examples/code-reviewer/agent.ts --dir ./packages/core/src
  npx tsx examples/code-reviewer/agent.ts --dir ./src --prompt "Find SQL injection risks"
  npx tsx examples/code-reviewer/agent.ts --dir ./src --model gpt-5
`)
        process.exit(0)
    }
  }

  return result
}

// ═══════════════════════════════════════════════════════════════════
// ─── Main ───
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const { dir, prompt, model, maxTurns } = parseArgs()

  console.log(`╔══════════════════════════════════════════════════════╗`)
  console.log(`║  Code Reviewer Agent — Harness Engine v0.2.0        ║`)
  console.log(`╠══════════════════════════════════════════════════════╣`)
  console.log(`║  Model:     ${model.padEnd(42)}║`)
  console.log(`║  Directory: ${dir.padEnd(42)}║`)
  console.log(`║  Max turns: ${String(maxTurns).padEnd(42)}║`)
  console.log(`║  Tools:     read_file, grep, write_file (HITL)      ║`)
  console.log(`╚══════════════════════════════════════════════════════╝\n`)

  const budgetHook = createBudgetHook()

  // Build the harness with code reviewer tools
  const harness = createHarness({
    model,
    tools: [readFileTool, grepTool, writeFileTool],
    hooks: [budgetHook],
    session: {
      maxTurns,
    },
    permission: {
      defaultLevel: "ask", // HITL: ask for approval on write_file
    },
  })

  const reviewPrompt =
    prompt ??
    `You are a code reviewer. Review the code in the "${dir}" directory.

Your task:
1. Use \`grep\` to search for common issues (missing error handling, TODO markers, any types, console.log statements)
2. Use \`read_file\` to read interesting files you find
3. For each issue found, explain:
   - What the issue is
   - Why it matters
   - A specific suggestion for fixing it
4. If you find trivial fixes, use \`write_file\` to propose the fix (requires human approval)

Focus on: error handling, type safety, code clarity, and potential bugs.
Complete your review in 3 turns maximum. Be concise but thorough.`

  console.log("Starting code review...\n")
  harness.start(reviewPrompt)

  // Track what happens
  let turnCount = 0
  let toolCalls = 0
  const toolNames = new Set<string>()

  for await (const event of harness) {
    switch (event.type) {
      case "thought":
        console.log(
          `💭 ${event.content.slice(0, 200)}${event.content.length > 200 ? "..." : ""}`,
        )
        break

      case "tool-call":
        toolCalls++
        toolNames.add(event.tool)
        console.log(`🔧 Calling: ${event.tool}`)
        break

      case "tool-result":
        console.log(
          `   ${event.ok ? "✅" : "❌"} ${event.tool} (${event.duration}ms)${event.truncated ? " [truncated]" : ""}`,
        )
        break

      case "approval-required":
        console.log(`⏳ Approval required for ${event.tool}: ${event.reason}`)
        // Auto-approve in non-interactive mode (no TTY)
        if (!process.stdin.isTTY) {
          console.log(`   → Auto-denying (non-interactive mode). Use TTY for HITL.`)
        }
        break

      case "turn-ended":
        turnCount++
        console.log(
          `\n--- Turn ${turnCount}/${maxTurns} complete (${event.tokenUsage.input} in / ${event.tokenUsage.output} out) ---\n`,
        )
        break
    }
  }

  // ── Summary ──
  console.log(`\n${"=".repeat(60)}`)
  console.log(`Review complete.`)
  console.log(`  Turns:      ${turnCount}`)
  console.log(`  Tool calls: ${toolCalls} (${[...toolNames].join(", ")})`)
  console.log(`  Token usage: input=${harness.tokenUsage.input}, output=${harness.tokenUsage.output}`)
  console.log(`${"=".repeat(60)}`)
}

main().catch((err) => {
  console.error("Code reviewer failed:", err.message)
  process.exitCode = 1
})
