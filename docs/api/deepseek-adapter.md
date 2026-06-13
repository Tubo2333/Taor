# DeepSeek Adapter API Reference

> `DeepSeekAdapter` — DeepSeek API via `OpenAICompatibleAdapter` base class.
> DeepSeek uses the OpenAI-compatible `/v1/chat/completions` REST shape.

## Quick Start

```bash
export DEEPSEEK_API_KEY=sk-...   # Get from https://platform.deepseek.com/
```

```typescript
import { createHarness, DeepSeekAdapter } from "@taor/engine"

const harness = createHarness({
  model: "deepseek-chat",
  tools: [],
  adapter: DeepSeekAdapter,
})
```

## Constructor

```typescript
new DeepSeekAdapter(opts?: {
  apiKey?: string        // Default: process.env.DEEPSEEK_API_KEY
  baseURL?: string       // Default: "https://api.deepseek.com/v1"
  model?: string         // Default: "deepseek-chat"
})
```

## Model Catalog

| Model | Input | Output | Thinking | Tool Use | Cost (1k in/out) |
|-------|-------|--------|----------|----------|-------------------|
| `deepseek-chat` | 128k | 8k | — | ✅ | $0.00027 / $0.0011 |
| `deepseek-reasoner` | 128k | 32k | ✅ | — | $0.00055 / $0.00219 |

## OpenAI Compatibility Notes

DeepSeek's API is largely OpenAI-compatible with these differences:

| Feature | OpenAI | DeepSeek |
|---------|--------|----------|
| Vision | ✅ | — |
| Prompt caching | ✅ | — |
| Reasoning | `reasoning_effort` | Native (deepseek-reasoner) |
| Base URL | `api.openai.com/v1` | `api.deepseek.com/v1` |

The `OpenAICompatibleAdapter` base class handles these differences transparently.

## Environment Variable Check

`DeepSeekAdapter` declares `static readonly requiredEnvVars = ["DEEPSEEK_API_KEY"]`. `createHarness()` validates this before construction.
