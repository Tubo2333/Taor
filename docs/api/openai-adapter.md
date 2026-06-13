# OpenAI Adapter API Reference

> `OpenaiAdapter` — OpenAI chat completions API via `OpenAICompatibleAdapter` base class.

## Quick Start

```bash
export OPENAI_API_KEY=sk-...   # Get from https://platform.openai.com/api-keys
```

```typescript
import { createHarness, OpenaiAdapter } from "@taor/engine"

const harness = createHarness({
  model: "gpt-4.1",
  tools: [],
  adapter: OpenaiAdapter,
})
```

## Switching from Anthropic

Replace the adapter and model:

```typescript
// Anthropic
createHarness({ model: "claude-sonnet-4-6", tools: [] })

// OpenAI
createHarness({ model: "gpt-4.1", tools: [], adapter: OpenaiAdapter })
```

All other config (tools, hooks, memory, permission, compressor) remains identical.

## Constructor

```typescript
new OpenaiAdapter(opts?: {
  apiKey?: string        // Default: process.env.OPENAI_API_KEY
  baseURL?: string       // Default: "https://api.openai.com/v1"
  model?: string         // Default: "gpt-4.1"
})
```

If `OPENAI_API_KEY` is not set, `createHarness()` throws a clear error before constructing the adapter.

## Model Catalog

| Model | Input | Output | Thinking | Vision | Prompt Caching | Cost (1k in/out) |
|-------|-------|--------|----------|--------|---------------|-------------------|
| `gpt-5` | 200k | 128k | ✅ | ✅ | ✅ | $0.00125 / $0.01 |
| `gpt-4.1` | 1M | 32k | — | ✅ | ✅ | $0.002 / $0.008 |
| `gpt-4.1-mini` | 1M | 16k | — | ✅ | ✅ | $0.0004 / $0.0016 |
| `gpt-4.1-nano` | 1M | 16k | — | ✅ | ✅ | $0.0001 / $0.0004 |

Costs are approximate (2026-06). Check [OpenAI pricing](https://platform.openai.com/docs/pricing) for updates.

## Features

| Feature | Supported |
|---------|-----------|
| Streaming | ✅ (all models) |
| Parallel tool calls | ✅ |
| Vision (images) | ✅ (JPEG, PNG, GIF, WebP) |
| Prompt caching | ✅ |
| Computer use | — |

## Key Differences from AnthropicAdapter

| Concern | Anthropic | OpenAI |
|---------|-----------|--------|
| System prompt | Top-level `system` param | `{ role: "system", ...}` in messages array |
| Streaming events | `content_block_start/delta/stop` | `delta.content` + `delta.tool_calls` |
| Tool format | `{ name, description, input_schema }` | `{ type: "function", function: {...} }` |
| Tool result wrapper | `{ role: "user", content: [...]}` | `{ role: "tool", tool_call_id, content }` |
| Stop reasons | `end_turn/max_tokens/tool_use/refusal` | `stop/length/tool_calls/content_filter` |
| Thinking | `thinking.budget_tokens` | `reasoning_effort: "high" \| "medium"` |

## Environment Variable Check

`OpenaiAdapter` declares `static readonly requiredEnvVars = ["OPENAI_API_KEY"]`. `createHarness()` validates this before construction — no hardcoded adapter-specific logic in the engine.

## Extending

To add a new OpenAI-compatible provider, extend `OpenAICompatibleAdapter`:

```typescript
import { OpenAICompatibleAdapter } from "@taor/adapters"

export class MyAdapter extends OpenAICompatibleAdapter {
  static readonly requiredEnvVars = ["MY_API_KEY"]
  readonly provider = "my-provider"

  constructor(opts?) {
    super({
      apiKey: opts?.apiKey ?? process.env.MY_API_KEY ?? "",
      baseURL: opts?.baseURL ?? "https://api.my-provider.com/v1",
      model: opts?.model ?? "my-model",
      providerName: "my-provider",
    })
  }
}
```

See [adapters.md](./adapters.md) for the full `LLMAdapter` interface specification.
