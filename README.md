# Harness Engine

> TypeScript AI Agent Runtime — TAOR Loop + 6 Pluggable Subsystems

[![Build](https://img.shields.io/badge/build-passing-brightgreen)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)]()
[![Lines](https://img.shields.io/badge/lines-~8,600-blue)]()

## Quick Start

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # Get from https://console.anthropic.com/
npm install @harness/engine @harness/adapters @harness/tools
```

```typescript
import { createHarness } from "@harness/engine"

const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [],
})

harness.start("Hello, world!")
for await (const event of harness) {
  console.log(event.type)
}
```

## Architecture

```
                  TAOR Loop (think → act → observe)
                              │
    ┌─────────┬─────────┬─────┼─────┬──────────┬──────────┐
    │         │         │     │     │          │          │
 Permission  Hooks  Subagent  │  Memory  Compressor  Adapter
  (4-tier) (13 pts) (inline/  │ (3-layer (5-layer)  (Anthropic)
                   process)   │  +3 BE)
                          Tools
                    (defineTool/Tool)
```

## Packages

| Package | Description | v0.2.0 |
|---------|-------------|--------|
| `@harness/engine` | Aggregation entry point (`createHarness`) | ✅ |
| `@harness/core` | TAOR loop, config, events, types | ✅ |
| `@harness/adapters` | LLM adapters (Anthropic + OpenAI + DeepSeek) | ✅ NEW |
| `@harness/tools` | Tool definition + registry | ✅ |
| `@harness/permission` | 4-tier (deny/boundary/allow/ask) | ✅ |
| `@harness/hooks` | 13-point lifecycle hooks | ✅ |
| `@harness/subagent` | Inline + process sub-agents | ✅ |
| `@harness/memory` | 3-layer memory (user/project/session) | ✅ |
| `@harness/compressor` | 5-layer context compression | ✅ |
| `@harness/cli` | CLI: harness run/config/tool | ✅ NEW |
| `@harness/telemetry` | OpenTelemetry hooks (OTLP/console) | ✅ NEW |
| `@harness/mcp` | MCP consumer — external tool servers | ✅ NEW |

## v0.2.0

| Feature | Status |
|---------|--------|
| OpenAI adapter (GPT-5, GPT-4.1, GPT-4.1-mini, GPT-4.1-nano) | ✅ |
| DeepSeek adapter (deepseek-chat, deepseek-reasoner) | ✅ |
| CI green (Node 20/22/24) | ✅ |
| Integration tests (45 tests) | ✅ |
| npm publish readiness | ✅ |
| API docs (14 docs) | ✅ |
| OpenTelemetry tracing | ✅ |
| Circuit breaker (3-state, decorator pattern) | ✅ |
| MCP consumer support (stdio/SSE, two-step init) | ✅ |
| Code reviewer example (3 tools + HITL + budget hook) | ✅ |
| Tests (154 tests, 8 files) | ✅ |

## Build

```bash
npm install
npm run build        # composite TypeScript build
npm run typecheck    # strict type checking
npm run test         # vitest smoke tests
```

## License

MIT
