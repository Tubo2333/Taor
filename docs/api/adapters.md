# Adapters API Reference

> `LLMAdapter` interface — the contract every LLM provider adapter must implement.
> Currently implemented: Anthropic, OpenAI, DeepSeek.

## `LLMAdapter` Interface

```typescript
interface LLMAdapter {
  readonly provider: string
  readonly version: string

  getModelInfo(model: string): ModelInfo
  supports(feature: AdapterFeature, model?: string): boolean

  buildRequest(ctx: TurnContext, opts: RequestOptions): Promise<AdapterRequest>
  think(request: AdapterRequest, signal: AbortSignal): AsyncGenerator<ThinkEvent>

  parseToolCalls(raw: unknown): ParsedToolCall[]
  formatToolResult(callId: string, result: ToolResult): unknown
  wrapToolResult(callId: string, result: ToolResult, toolName?: string): Message

  countTokens(messages: Message[]): number
  countRequestTokens(request: AdapterRequest): number
  normalizeError(error: unknown): HarnessError
}
```

## Built-in Adapters

| Adapter | Provider | Status | Docs |
|---------|----------|--------|------|
| `AnthropicAdapter` | Anthropic (Claude) | ✅ Complete (TG0) | See harness.md |
| `OpenaiAdapter` | OpenAI (GPT) | ✅ Complete (TG4) | [openai-adapter.md](./openai-adapter.md) |
| `DeepSeekAdapter` | DeepSeek | ✅ Complete (TG4) | [deepseek-adapter.md](./deepseek-adapter.md) |
| `CircuitBreakerAdapter` | Decorator | ✅ Complete (TG4) | [circuit-breaker.md](./circuit-breaker.md) |

## `requiredEnvVars` Convention

Every adapter declares its required environment variables as a static property:

```typescript
AnthropicAdapter.requiredEnvVars  // → ["ANTHROPIC_API_KEY"]
OpenaiAdapter.requiredEnvVars     // → ["OPENAI_API_KEY"]
DeepSeekAdapter.requiredEnvVars   // → ["DEEPSEEK_API_KEY"]
```

`createHarness()` reads this before construction — no hardcoded adapter names in the engine.

## Implementing a Custom Adapter

### Option A: Extend `OpenAICompatibleAdapter` (recommended for OpenAI-compatible APIs)

```typescript
import { OpenAICompatibleAdapter } from "@harness/adapters"

export class MyAdapter extends OpenAICompatibleAdapter {
  static readonly requiredEnvVars = ["MY_API_KEY"]
  readonly provider = "my-provider"

  protected MODEL_CATALOG = {
    "my-model": { id: "my-model", provider: "my-provider", ... },
  }

  constructor(opts?) {
    super({
      apiKey: opts?.apiKey ?? process.env.MY_API_KEY ?? "",
      baseURL: opts?.baseURL ?? "https://api.example.com/v1",
      model: opts?.model ?? "my-model",
      providerName: "my-provider",
    })
  }
}
```

### Option B: Implement `LLMAdapter` directly (for non-OpenAI-compatible APIs)

See the AnthropicAdapter source (`packages/adapters/src/anthropic.ts`) as a reference implementation.

## Adapter Features

```typescript
type AdapterFeature =
  | "streaming"
  | "thinking"
  | "tool-use"
  | "parallel-tool-calls"
  | "vision"
  | "prompt-caching"
  | "computer-use"
```

## `ThinkEvent` Union

```typescript
type ThinkEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_use"; call: { id: string; name: string; arguments: Record<string, unknown> } }
  | { type: "stop"; reason: StopReason; usage: TokenUsage }
  | { type: "error"; error: HarnessError }
```

## `ModelInfo`

```typescript
interface ModelInfo {
  id: string
  provider: string
  maxInputTokens: number
  maxOutputTokens: number
  supportsThinking: boolean
  supportsVision: boolean
  supportsPromptCaching: boolean
  supportsToolUse: boolean
  costPer1kInput: number
  costPer1kOutput: number
}
```
