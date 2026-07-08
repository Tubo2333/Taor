// @taor/adapters — OpenAICompatibleAdapter (abstract base, TG4)
//
// All OpenAI-compatible providers (OpenAI, DeepSeek, etc.) share the same
// REST API shape: POST /v1/chat/completions with SSE streaming. This base
// class encapsulates the shared logic. Subclasses only define:
//   - `provider` string
//   - `static requiredEnvVars`
//   - Default `baseURL`, `model`
//   - Model catalog (MODEL_CATALOG)

import { createRequire } from "node:module"
import type {
  LLMAdapter,
  AdapterFeature,
  ModelInfo,
  RequestOptions,
  ThinkEvent,
  ParsedToolCall,
  AdapterRequest,
  StopReason,
} from "./types.js"
import type {
  TurnContext,
  HarnessError,
  TokenUsage,
  Message,
} from "@taor/core"
import type { ToolDescriptor, ToolResult } from "@taor/tools"

// ═══════════════════════════════════════════════════════════════════
// ─── Types (OpenAI-specific, not in public API) ───
// ═══════════════════════════════════════════════════════════════════

type OpenAIMessageParam =
  | { role: "system"; content: string }
  | { role: "user"; content: OpenAIContentBlock[] }
  | { role: "assistant"; content: OpenAIContentBlock[]; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

type OpenAIContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }

interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface OpenAIToolDef {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

// ═══════════════════════════════════════════════════════════════════
// ─── Default Model Info ───
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_MODEL_INFO: ModelInfo = {
  id: "unknown",
  provider: "openai",
  maxInputTokens: 128_000,
  maxOutputTokens: 8_000,
  supportsThinking: false,
  supportsVision: false,
  supportsPromptCaching: false,
  supportsToolUse: true,
  costPer1kInput: 0,
  costPer1kOutput: 0,
}

// ═══════════════════════════════════════════════════════════════════
// ─── Stop Reason Mapping ───
// ═══════════════════════════════════════════════════════════════════

function mapStopReason(raw: string | null): StopReason {
  switch (raw) {
    case "stop":
      return "end_turn"
    case "length":
      return "max_tokens"
    case "tool_calls":
      return "tool_use"
    case "content_filter":
      return "refusal"
    default: {
      console.warn(
        `[OpenAICompatibleAdapter] Unknown finish reason: "${raw}". ` +
          `Falling back to "unknown". This may indicate a new API ` +
          `feature — consider updating the StopReason mapping.`,
      )
      return "unknown"
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// ─── Message Conversion ───
// ═══════════════════════════════════════════════════════════════════

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

function convertMessages(
  messages: Message[],
): OpenAIMessageParam[] {
  const result: OpenAIMessageParam[] = []

  for (const msg of messages) {
    if (msg.role === "system") {
      // OpenAI: system messages are in the messages array (not a top-level param).
      const textParts: string[] = []
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text)
        } else {
          console.warn(
            `[OpenAICompatibleAdapter] Non-text content block (type: "${block.type}") ` +
              `in a system-role message will be ignored — ` +
              `OpenAI API only accepts text in system messages.`,
          )
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "system", content: textParts.join("\n\n") })
      }
    } else if (msg.role === "user") {
      const blocks: OpenAIContentBlock[] = []
      for (const block of msg.content) {
        if (block.type === "text") {
          blocks.push({ type: "text", text: block.text })
        } else if (block.type === "image") {
          if (!SUPPORTED_IMAGE_TYPES.has(block.source.media_type)) {
            throw new Error(
              `[OpenAICompatibleAdapter] Unsupported image MIME type: "${block.source.media_type}". ` +
                `OpenAI supports: ${[...SUPPORTED_IMAGE_TYPES].join(", ")}.`,
            )
          }
          blocks.push({
            type: "image_url",
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          })
        } else if (block.type === "tool_result") {
          result.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: block.content,
          })
        }
      }
      if (blocks.length > 0) {
        result.push({ role: "user" as const, content: blocks })
      }
    } else if (msg.role === "assistant") {
      const blocks: OpenAIContentBlock[] = []
      const toolCalls: OpenAIToolCall[] = []
      for (const block of msg.content) {
        if (block.type === "text") {
          blocks.push({ type: "text", text: block.text })
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          })
        }
      }
      const entry: { role: "assistant"; content: OpenAIContentBlock[]; tool_calls?: OpenAIToolCall[] } = {
        role: "assistant",
        content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
      }
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls
      }
      result.push(entry)
    }
  }

  return result
}

// ═══════════════════════════════════════════════════════════════════
// ─── Tool Conversion ───
// ═══════════════════════════════════════════════════════════════════

function convertTool(descriptor: ToolDescriptor): OpenAIToolDef {
  return {
    type: "function",
    function: {
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.parameters as Record<string, unknown>,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════
// ─── Error Helpers ───
// ═══════════════════════════════════════════════════════════════════

function isRecoverableStatus(status: number): boolean {
  return status === 429 || status >= 500 || status === 408
}

function mapHttpCode(status: number): string {
  switch (status) {
    case 400:
      return "bad_request"
    case 401:
      return "unauthorized"
    case 403:
      return "forbidden"
    case 404:
      return "not_found"
    case 408:
      return "timeout"
    case 429:
      return "rate_limited"
    case 500:
      return "server_error"
    case 502:
      return "bad_gateway"
    case 503:
      return "unavailable"
    default:
      return `http_${status}`
  }
}

// ═══════════════════════════════════════════════════════════════════
// ─── OpenAICompatibleAdapter (abstract base) ───
// ═══════════════════════════════════════════════════════════════════

/**
 * Abstract base class for OpenAI-compatible providers.
 *
 * Subclasses (OpenaiAdapter, DeepSeekAdapter) define:
 * - `readonly provider`
 * - `static readonly requiredEnvVars`
 * - Constructor defaults (`apiKey`, `baseURL`, `model`)
 * - `MODEL_CATALOG` (static Record<string, ModelInfo>)
 *
 * ## Concurrency safety (reentrant)
 *
 * `think()` creates a fresh OpenAI client per invocation, ensuring
 * independent HTTP connections for concurrent TAOR + Compressor use.
 *
 * ## Streaming
 *
 * All inference uses `stream: true`. SSE chunks are parsed into
 * normalized `ThinkEvent` yields — text, tool_use, stop, error.
 */
export abstract class OpenAICompatibleAdapter implements LLMAdapter {
  abstract readonly provider: string
  readonly version = "1.0.0"

  protected apiKey: string
  protected baseURL: string
  protected model: string
  protected abstract MODEL_CATALOG: Record<string, ModelInfo>

  constructor(config: {
    apiKey: string
    baseURL: string
    model: string
    providerName: string
  }) {
    if (!config.apiKey) {
      const envVar = `${config.providerName.toUpperCase()}_API_KEY`
      throw new Error(
        `${envVar} environment variable is required. ` +
          `Get your key and set it:\n` +
          `  export ${envVar}=...\n` +
          `Or copy .env.example to .env and fill in the value.`,
      )
    }
    this.apiKey = config.apiKey
    this.baseURL = config.baseURL
    this.model = config.model
  }

  // ── Helper: create a fresh client per think() call ──

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private createClient(): any {
    // Dynamically construct the OpenAI client. This is done inline rather
    // than caching a client instance to ensure reentrant think() calls
    // use independent HTTP connections.
    //
    // F8 / EXTRA-3: createRequire(import.meta.url) may fail under ESM bundlers
    // (esbuild/webpack/tsup) that rewrite import.meta.url to undefined.
    // Current project uses only tsc (no bundler), so this is safe for now.
    // If bundler support is needed later, switch to: const {default: O} = await import("openai")
    // and make createClient() async.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const _require = createRequire(import.meta.url)
    const { default: OpenAIClient } = _require("openai") as { default: new (opts: { apiKey: string; baseURL: string }) => any }
    return new OpenAIClient({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
    })
  }

  // ── Model info ──

  getModelInfo(model: string): ModelInfo {
    const info = this.MODEL_CATALOG[model]
    if (info) return info
    return { ...DEFAULT_MODEL_INFO, id: model, provider: this.provider }
  }

  // ── Feature detection ──

  supports(feature: AdapterFeature, model?: string): boolean {
    const info = this.getModelInfo(model ?? this.model)
    switch (feature) {
      case "streaming":
        return true
      case "thinking":
        return info.supportsThinking
      case "tool-use":
        return info.supportsToolUse
      case "parallel-tool-calls":
        return true
      case "vision":
        return info.supportsVision
      case "prompt-caching":
        return info.supportsPromptCaching
      case "computer-use":
        return false
      default:
        return false
    }
  }

  // ── Build request ──

  async buildRequest(
    ctx: TurnContext,
    opts: RequestOptions,
  ): Promise<AdapterRequest> {
    const openaiMessages = convertMessages(ctx.turn.messages)

    // If the caller provides a system prompt, prepend it as a system message
    if (opts.systemPrompt) {
      // Check if there's already a system message
      const existingSys = openaiMessages.findIndex(m => m.role === "system")
      if (existingSys >= 0) {
        const sysMsg = openaiMessages[existingSys] as { role: "system"; content: string }
        sysMsg.content = opts.systemPrompt + "\n\n" + sysMsg.content
      } else {
        openaiMessages.unshift({ role: "system", content: opts.systemPrompt })
      }
    }

    const params: Record<string, unknown> = {
      model: ctx.session.model,
      max_tokens: opts.maxTokens ?? 4096,
      messages: openaiMessages,
      ...(opts.temperature !== undefined
        ? { temperature: opts.temperature }
        : {}),
      ...(opts.topP !== undefined ? { top_p: opts.topP } : {}),
      ...(opts.stopSequences?.length
        ? { stop: opts.stopSequences }
        : {}),
      ...(opts.tools?.length
        ? { tools: opts.tools.map(convertTool) }
        : {}),
    }

    // Thinking / reasoning support (OpenAI GPT-5 / o-series)
    if (opts.thinking && this.supports("thinking")) {
      params.reasoning_effort =
        opts.thinking.budgetTokens > 20_000 ? "high" : "medium"
    }

    return params as unknown as AdapterRequest
  }

  // ── Retry helper ──

  /**
   * Retry wrapper for transient failures (rate limits, server errors, network).
   * 4xx (except 429) are NOT retried — those are permanent client errors.
   * Checks AbortSignal during backoff to avoid wasted retries after abort.
   */
  protected async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 4,
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error("Aborted")
      try {
        return await fn()
      } catch (err: any) {
        if (attempt >= maxRetries) throw err
        const status = err?.status ?? err?.response?.status
        const code = err?.code ?? err?.error?.code
        // Retry on 429 (rate limit), 5xx (server error), 408 timeout, network errors
        if (
          status === 429 ||
          (status && status >= 500) ||
          status === 408 ||
          code === "ENOTFOUND" ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT"
        ) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 16000)
          console.warn(
            `[${this.provider}] Retry ${attempt + 1}/${maxRetries} after ${delay}ms (status=${status ?? code})`,
          )
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, delay)
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(t)
                reject(new Error("Aborted"))
              },
              { once: true },
            )
          })
          continue
        }
        throw err // 4xx other than 429 → no retry
      }
    }
    throw new Error("Unreachable")
  }

  // ── Think (streaming AsyncGenerator) ──

  async *think(
    request: AdapterRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ThinkEvent> {
    const params = request as unknown as Record<string, unknown>
    const client = this.createClient()

    // Track tool call JSON accumulation across streaming deltas.
    // Key = index (parallel tool call tracking).
    const toolBlocks = new Map<
      number,
      { id: string; name: string; json: string }
    >()

    let inputTokens = 0
    let outputTokens = 0
    let stopReason: StopReason = "end_turn"
    let hasYieldedStop = false

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream: AsyncIterable<any> = await this.withRetry(
        () =>
          client.chat.completions.create(
            { ...params, stream: true as const },
            { signal },
          ),
        4,
        signal,
      )

      for await (const chunk of stream) {
        if (signal.aborted) break

        const delta = chunk.choices?.[0]?.delta

        // Text content — delta.content field
        if (delta?.content) {
          yield { type: "text", content: delta.content }
        }

        // Reasoning content (o-series / GPT-5 models)
        if (delta?.reasoning_content) {
          yield { type: "thinking", content: delta.reasoning_content }
        }

        // Tool calls — accumulate by index for parallel tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index
            const acc = toolBlocks.get(index) ?? {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              json: "",
            }
            // id may come in a later chunk (first chunk sometimes only has index + name)
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name = tc.function.name
            acc.json += tc.function?.arguments ?? ""
            toolBlocks.set(index, acc)
          }
        }

        // Finish reason — emit accumulated tool calls + stop event
        if (chunk.choices?.[0]?.finish_reason) {
          stopReason = mapStopReason(chunk.choices[0]!.finish_reason!)

          // Emit accumulated tool use events BEFORE stop
          for (const [, acc] of toolBlocks) {
            if (acc.name) {
              try {
                const parsedArgs = JSON.parse(acc.json) as Record<
                  string,
                  unknown
                >
                yield {
                  type: "tool_use",
                  call: {
                    id: acc.id,
                    name: acc.name,
                    arguments: parsedArgs,
                  },
                }
              } catch {
                // JSON parse failed — yield with empty args
                yield {
                  type: "tool_use",
                  call: {
                    id: acc.id,
                    name: acc.name,
                    arguments: {},
                  },
                }
              }
            }
          }
          toolBlocks.clear()

          // Token usage from final chunk
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens
            outputTokens = chunk.usage.completion_tokens
          }

          const usage: TokenUsage = {
            input: inputTokens,
            output: outputTokens,
            cacheRead: chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0,
            cacheWrite: 0,
            total: inputTokens + outputTokens,
          }

          yield { type: "stop", reason: stopReason, usage }
          hasYieldedStop = true
        }
      }

      // Edge case: stream ended without finish_reason (network edge case).
      // F2 fix: yield any accumulated tool_use events BEFORE fallback stop,
      // otherwise they are silently discarded.
      if (!hasYieldedStop) {
        for (const [, acc] of toolBlocks) {
          if (acc.name) {
            try {
              yield {
                type: "tool_use",
                call: {
                  id: acc.id,
                  name: acc.name,
                  arguments: JSON.parse(acc.json) as Record<string, unknown>,
                },
              }
            } catch {
              yield {
                type: "tool_use",
                call: { id: acc.id, name: acc.name, arguments: {} },
              }
            }
          }
        }
        toolBlocks.clear()

        yield {
          type: "stop",
          reason: stopReason,
          usage: {
            input: inputTokens,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: inputTokens,
          },
        }
      }
    } catch (error) {
      // AbortError — caller knows they aborted, don't yield an error event
      if (signal.aborted) {
        return
      }

      yield {
        type: "error",
        error: this.normalizeError(error),
      }
    }
  }

  // ── Parse tool calls from raw response ──

  parseToolCalls(raw: unknown): ParsedToolCall[] {
    const obj = raw as
      | { choices?: { message?: { tool_calls?: OpenAIToolCall[] } }[] }
      | undefined
    if (!obj?.choices) return []

    const calls: ParsedToolCall[] = []
    for (const choice of obj.choices) {
      if (choice.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          if (tc.type === "function") {
            try {
              calls.push({
                id: tc.id,
                name: tc.function.name,
                arguments: JSON.parse(
                  tc.function.arguments,
                ) as Record<string, unknown>,
              })
            } catch {
              calls.push({
                id: tc.id,
                name: tc.function.name,
                arguments: {},
              })
            }
          }
        }
      }
    }
    return calls
  }

  // ── Format tool result ──

  /**
   * Convert our ToolResult to an OpenAI tool result string.
   *
   * OpenAI expects tool results as a string in `{ role: "tool", content: ... }`.
   * The string is typically JSON but can be plain text.
   */
  formatToolResult(_callId: string, result: ToolResult): unknown {
    if (result.ok) {
      let content =
        typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data)

      if (result.meta?.truncated) {
        content = "[Warning: tool output was truncated]\n" + content
      }

      return content
    }
    return result.error ?? "tool error"
  }

  /**
   * Wrap a tool result into a complete OpenAI Message ready for the
   * next API call.
   *
   * OpenAI uses: `{ role: "tool", tool_call_id, content: "..." }`.
   * This differs from Anthropic's `{ role: "user", content: [...] }` envelope.
   */
  wrapToolResult(
    callId: string,
    result: ToolResult,
    _toolName?: string,
  ): Message {
    const content = this.formatToolResult(callId, result) as string

    return {
      role: "tool" as const,
      content: [
        {
          type: "tool_result",
          tool_use_id: callId,
          content,
          ...(result.ok ? {} : { is_error: true }),
        },
      ],
    }
  }

  // ── Token counting (approximate, TG4) ──

  countTokens(messages: Message[]): number {
    let totalChars = 0
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === "text") {
          totalChars += block.text.length
        } else if (block.type === "tool_use") {
          try {
            totalChars += JSON.stringify(block.input).length
          } catch {
            totalChars += 100
          }
        } else if (block.type === "tool_result") {
          totalChars += block.content.length
        }
      }
    }
    return Math.ceil(totalChars / 4)
  }

  countRequestTokens(request: AdapterRequest): number {
    const params = request as Record<string, unknown>
    let totalChars = 0

    const messages = params.messages as
      | { role: string; content: unknown }[]
      | undefined
    if (messages) {
      for (const msg of messages) {
        totalChars += JSON.stringify(msg.content).length
      }
    }

    const tools = params.tools as unknown[] | undefined
    if (tools) {
      totalChars += JSON.stringify(tools).length
    }

    return Math.ceil(totalChars / 4)
  }

  // ── Error normalization ──

  /**
   * Convert provider-specific errors to framework-agnostic HarnessError.
   *
   * OpenAI SDK throws APIError subclasses (AuthenticationError,
   * RateLimitError, etc.) which all have `status` and `code` fields.
   */
  normalizeError(error: unknown): HarnessError {
    // Check for OpenAI APIError by duck-typing (avoids static import)
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      "message" in error
    ) {
      const e = error as { status: number; message: string; code?: string }
      const recoverable = isRecoverableStatus(e.status)

      return {
        code: e.code ?? mapHttpCode(e.status),
        message: e.message,
        source: "adapter",
        recoverable,
        cause: error,
        timestamp: Date.now(),
      }
    }

    if (error instanceof Error) {
      return {
        code: "unknown",
        message: error.message,
        source: "adapter",
        recoverable: false,
        cause: error,
        timestamp: Date.now(),
      }
    }

    return {
      code: "unknown",
      message: String(error),
      source: "adapter",
      recoverable: false,
      cause: error,
      timestamp: Date.now(),
    }
  }
}
