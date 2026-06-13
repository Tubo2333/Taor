# Quick Start

## 1. Install

```bash
npm install @harness/engine @harness/adapters @harness/tools
```

## 2. Set API Key

Choose your provider:

```bash
# Anthropic (Claude)
export ANTHROPIC_API_KEY=sk-ant-...   # https://console.anthropic.com/

# OpenAI (GPT)
export OPENAI_API_KEY=sk-...          # https://platform.openai.com/api-keys

# DeepSeek
export DEEPSEEK_API_KEY=sk-...        # https://platform.deepseek.com/
```

## 2a. Switch Provider

```typescript
import { OpenaiAdapter, DeepSeekAdapter } from "@harness/engine"

// Use OpenAI
createHarness({ model: "gpt-4.1", adapter: OpenaiAdapter, tools: [] })

// Use DeepSeek
createHarness({ model: "deepseek-chat", adapter: DeepSeekAdapter, tools: [] })

// Default (Anthropic — no adapter needed)
createHarness({ model: "claude-sonnet-4-6", tools: [] })
```

## 3. Define Your First Tool

```typescript
import { defineTool } from "@harness/tools"

const greet = defineTool({
  name: "greet",
  description: "Greet a person by name",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name to greet" },
    },
    required: ["name"],
  },
  async execute(params) {
    return { ok: true, data: `Hello, ${params.name}!` }
  },
})
```

## 4. Create and Run Your First Agent

```typescript
import { createHarness } from "@harness/engine"

const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [greet],
  session: { maxTurns: 5 },
})

harness.start("Greet John and explain what you're doing.")

for await (const event of harness) {
  if (event.type === "thought") {
    console.log("💭", (event as any).content)
  }
  if (event.type === "tool-call") {
    console.log("🔧 Calling:", (event as any).tool)
  }
  if (event.type === "turn-ended") {
    console.log("✅ Turn complete")
  }
}

console.log("Session done. Tokens:", harness.tokenUsage.total)
```

## 5. Full Working Example (20 lines)

```typescript
import { createHarness } from "@harness/engine"

const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [],
  session: { maxTurns: 3 },
})

harness.start("What is 2+2? Answer in one word.")

for await (const event of harness) {
  if (event.type === "thought") console.log((event as any).content)
}

console.log("Done — tokens used:", harness.tokenUsage.total)
```

## 6. Add Circuit Breaker (Production Safety)

```typescript
import { createHarness } from "@harness/engine"

const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [greet],
  circuitBreaker: { failureThreshold: 5 },  // auto-wrap
})
```

See [circuit-breaker.md](./api/circuit-breaker.md) for full API.

## 7. Add MCP Tools (External Tool Servers)

```bash
npm install @harness/mcp
```

```typescript
import { MCPToolBridge } from "@harness/mcp"

const bridge = new MCPToolBridge({
  name: "filesystem",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
})

const tools = await bridge.connect()
harness.tools.register(tools)
```

See [mcp.md](./api/mcp.md) for full API.

## Next Steps

- Add [permission rules](./api/permission.md) to control what the agent can do
- Add [hooks](./api/hooks.md) to inject custom logic
- Add [telemetry](./api/telemetry.md) for OpenTelemetry tracing
- Use [memory](./api/memory.md) to persist user preferences
- Read the [full API reference](./api/harness.md)
