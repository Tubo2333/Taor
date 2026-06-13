#!/usr/bin/env node
// @harness/cli — Harness Engine command-line interface

import { createHarness } from "@harness/engine"

const command = process.argv[2] ?? "help"

async function main() {
  try {
    switch (command) {
      case "run": {
        const prompt = process.argv[3]
        if (!prompt) {
          console.error("Usage: harness run <prompt>")
          process.exit(1)
        }
        console.log(`[harness] Starting agent with prompt: "${prompt}"`)

        const harness = createHarness({
          model: "claude-sonnet-4-6",
          tools: [],
          session: { maxTurns: 3 },
        })
        harness.start(prompt)
        for await (const event of harness) {
          if (event.type === "thought") {
            const content = (event as any).content?.slice(0, 200) ?? ""
            if (content) console.log(`💭 ${content}`)
          } else if (event.type === "turn-ended") {
            console.log("✅ Turn complete")
          } else if (event.type === "tool-call") {
            console.log(`🔧 Tool call: ${(event as any).tool}`)
          }
        }
        console.log("Session finished. Token usage:", harness.tokenUsage.total)
        break
      }

      case "config": {
        const template = {
          model: "claude-sonnet-4-6",
          tools: [],
          session: { maxTurns: 100 },
          permission: { defaultLevel: "ask" },
          memory: {
            user: { backend: "json", path: "./data/memory/user.json" },
            project: { backend: "json", path: "./data/memory/project.json" },
            session: { backend: "memory" },
          },
          compressor: { triggerThreshold: 100_000, targetThreshold: 50_000 },
        }
        console.log(JSON.stringify(template, null, 2))
        break
      }

      case "tool": {
        const name = process.argv[3] ?? "MyTool"
        const template = `import { defineTool } from "@harness/tools"

export const ${name} = defineTool({
  name: "${name}",
  description: "TODO: describe what this tool does",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(params) {
    // TODO: implement
    return { ok: true, data: params }
  },
})`
        console.log(template)
        break
      }

      default:
        console.log(`Harness Engine CLI v0.1

Usage:
  harness run <prompt>     Run an agent session
  harness config           Generate a config template
  harness tool [name]      Scaffold a new tool
  harness help             Show this help`)
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main().catch(console.error)
