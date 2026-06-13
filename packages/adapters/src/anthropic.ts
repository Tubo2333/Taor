// @taor/adapters — AnthropicAdapter (full TG0 implementation)

import Anthropic from "@anthropic-ai/sdk"
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
// ─── Model Catalog ───
// ═══════════════════════════════════════════════════════════════════

/**
 * Known Anthropic models with capabilities.
 *
 * Costs are per 1k tokens (USD, list price as of 2026-06).
 * Approximate — update from https://www.anthropic.com/pricing.
 */
const MODEL_CATALOG: Record<string, ModelInfo> = {
  "claude-opus-4-8": {
    id: "claude-opus-4-8",
    provider: "anthropic",
    maxInputTokens: 200_000,
    maxOutputTokens: 32_000,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCaching: true,
    supportsToolUse: true,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
  },
  "claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    maxInputTokens: 200_000,
    maxOutputTokens: 16_000,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCaching: true,
    supportsToolUse: true,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    maxInputTokens: 200_000,
    maxOutputTokens: 8_000,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCaching: true,
    supportsToolUse: true,
    costPer1kInput: 0.0008,
    costPer1kOutput: 0.004,
  },
  "claude-opus-4-5": {
    id: "claude-opus-4-5",
    provider: "anthropic",
    maxInputTokens: 200_000,
    maxOutputTokens: 32_000,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCaching: true,
    supportsToolUse: true,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
  },
  "claude-sonnet-4-5": {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    maxInputTokens: 200_000,
    maxOutputTokens: 16_000,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCaching: true,
    supportsToolUse: true,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
  },
  "claude-opus-4-1": {
    id: "claude-opus-4-1",
    provider: "anthropic",
    maxInputTokens: 200_000,
    maxOutputTokens: 32_000,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCaching: true,
    supportsToolUse: true,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
  },
}

const DEFAULT_MODEL_INFO: ModelInfo = {
  id: "unknown",
  provider: "anthropic",
  maxInputTokens: 200_000,
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
    case "end_turn":
      return "end_turn"
    case "max_tokens":
      return "max_tokens"
    case "tool_use":
      return "tool_use"
    case "stop_sequence":
      return "stop_sequence"
    case "refusal":
      return "refusal"
    default: {
      console.warn(
        `[AnthropicAdapter] Unknown stop reason: "${raw}". ` +
          `Falling back to "unknown". This may indicate a new Anthropic API ` +
          `feature — consider updating the StopReason mapping.`,
      )
      return "unknown"
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// ─── Message Conversion ───
// ═══════════════════════════════════════════════════════════════════

/**
 * Image MIME types supported by Anthropic's API.
 * @see https://docs.anthropic.com/en/docs/build-with-claude/vision
 */
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

function convertMessages(
  messages: Message[],
): { systemPrompt: string; anthropicMessages: Anthropic.MessageParam[] } {
  const systemParts: string[] = []
  const anthropicMessages: Anthropic.MessageParam[] = []

  for (const msg of messages) {
    if (msg.role === "system") {
      for (const block of msg.content) {
        if (block.type === "text") {
          systemParts.push(block.text)
        } else {
          // Anthropic API only accepts text in the `system` parameter.
          // Non-text blocks (image, tool_use, tool_result) are silently
          // dropped — warn the user so they know why their content is missing.
          console.warn(
            `[AnthropicAdapter] Non-text content block (type: "${block.type}") ` +
              `in a system-role message will be ignored — ` +
              `Anthropic API only accepts text in the system parameter.`,
          )
        }
      }
    } else if (msg.role === "tool") {
      // F3 fix: handle role="tool" messages (OpenAI style).
      // Anthropic API has no "tool" role — tool results must be in user-role
      // envelopes: { role: "user", content: [toolResultBlock] }.
      // Rewrap tool_result blocks from a tool-role message as a user-role message.
      const toolBlocks = msg.content.filter(b => b.type === "tool_result")
      if (toolBlocks.length > 0) {
        anthropicMessages.push({
          role: "user",
          content: toolBlocks as Anthropic.ContentBlockParam[],
        })
      }
    } else {
      // Runtime guard: validate image MIME types against Anthropic's supported set.
      // Our `MessageContent` uses `media_type: string` (wider than Anthropic's
      // `"image/jpeg" | "image/png" | "image/gif" | "image/webp"`).
      for (const block of msg.content) {
        if (
          block.type === "image" &&
          !SUPPORTED_IMAGE_TYPES.has(block.source.media_type)
        ) {
          throw new Error(
            `[AnthropicAdapter] Unsupported image MIME type: "${block.source.media_type}". ` +
              `Anthropic supports: ${[...SUPPORTED_IMAGE_TYPES].join(", ")}.`,
          )
        }
      }
      anthropicMessages.push({
        role: msg.role as "user" | "assistant",
        content: msg.content as Anthropic.ContentBlockParam[],
      })
    }
  }

  return {
    systemPrompt: systemParts.join("\n\n"),
    anthropicMessages,
  }
}

// ═══════════════════════════════════════════════════════════════════
// ─── Tool Conversion ───
// ═══════════════════════════════════════════════════════════════════

function convertTool(descriptor: ToolDescriptor): Anthropic.Tool {
  // TG0: Our JSONSchema (Draft-07 superset with anyOf/oneOf/$ref)
  // is cast to Anthropic's InputSchema ({[k:string]: unknown}).
  // Structurally compatible — but complex schemas (nested $ref, allOf
  // with if/then) have not been validated against the live API.
  // TG1: add integration tests with real Anthropic API calls.
  return {
    name: descriptor.name,
    description: descriptor.description,
    input_schema: descriptor.parameters as Anthropic.Tool.InputSchema,
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
// ─── AnthropicAdapter ───
// ═══════════════════════════════════════════════════════════════════

/**
 * Anthropic Messages API adapter.
 *
 * ## Concurrency safety (reentrant)
 *
 * `think()` creates a fresh Anthropic client per invocation. This ensures
 * independent HTTP connections and avoids shared state between the TAOR
 * main loop's THINK phase and the Compressor's summarize strategy.
 *
 * ## Streaming
 *
 * All inference uses the streaming endpoint (`stream: true`). The
 * `RawMessageStreamEvent` SSE stream is parsed into normalized
 * `ThinkEvent` yields — text, thinking, tool_use, stop, error.
 */
export class AnthropicAdapter implements LLMAdapter {
  static readonly requiredEnvVars = ["ANTHROPIC_API_KEY"]
  readonly provider = "anthropic"
  readonly version = "2025-01-01"

  private apiKey: string
  private baseUrl: string | undefined
  private model: string

  constructor(opts?: {
    apiKey?: string
    baseUrl?: string
    model?: string
  }) {
    const apiKey = opts?.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? ""
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is required. " +
        "Get your key at https://console.anthropic.com/ and set it:\n" +
        "  export ANTHROPIC_API_KEY=sk-ant-...\n" +
        "Or copy .env.example to .env and fill in the value."
      )
    }
    this.apiKey = apiKey
    this.baseUrl = opts?.baseUrl
    this.model = opts?.model ?? "claude-sonnet-4-6"
  }

  // ── Helper: create a fresh client per think() call ──

  private createClient(): Anthropic {
    return new Anthropic({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
    })
  }

  // ── Model info ──

  getModelInfo(model: string): ModelInfo {
    return MODEL_CATALOG[model] ?? { ...DEFAULT_MODEL_INFO, id: model }
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
        return this.model.includes("opus") || this.model.includes("sonnet")
      default:
        return false
    }
  }

  // ── Build request ──

  async buildRequest(
    ctx: TurnContext,
    opts: RequestOptions,
  ): Promise<AdapterRequest> {
    const { systemPrompt, anthropicMessages } = convertMessages(
      ctx.turn.messages,
    )

    const system = opts.systemPrompt
      ? [opts.systemPrompt, systemPrompt].filter(Boolean).join("\n\n")
      : systemPrompt || undefined

    const params: Anthropic.MessageCreateParams = {
      model: ctx.session.model,
      max_tokens: opts.maxTokens ?? 4096,
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(opts.temperature !== undefined
        ? { temperature: opts.temperature }
        : {}),
      ...(opts.topP !== undefined ? { top_p: opts.topP } : {}),
      ...(opts.stopSequences?.length
        ? { stop_sequences: opts.stopSequences }
        : {}),
      ...(opts.tools?.length
        ? { tools: opts.tools.map(convertTool) }
        : {}),
      ...(opts.thinking
        ? {
            thinking: {
              type: "enabled" as const,
              budget_tokens: opts.thinking.budgetTokens,
            },
          }
        : {}),
    }

    return params as unknown as AdapterRequest
  }

  // ── Retry helper ──

  /**
   * Retry wrapper for transient failures (rate limits, server errors, network).
   * 4xx (except 429) are NOT retried — those are permanent client errors.
   * Checks AbortSignal during backoff to avoid wasted retries after abort.
   */
  private async withRetry<T>(
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
        if (status === 429 || (status && status >= 500) || status === 408
            || code === "ENOTFOUND" || code === "ECONNRESET" || code === "ETIMEDOUT") {
          const delay = Math.min(1000 * Math.pow(2, attempt), 16000)
          console.warn(`[AnthropicAdapter] Retry ${attempt + 1}/${maxRetries} after ${delay}ms (status=${status ?? code})`)
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, delay)
            signal?.addEventListener("abort", () => {
              clearTimeout(t)
              reject(new Error("Aborted"))
            }, { once: true })
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
    const params = request as unknown as Anthropic.MessageCreateParams
    const client = this.createClient()

    // Track tool call JSON accumulation across streaming deltas.
    // Key = content block index (handles parallel tool calls).
    const toolBlocks = new Map<
      number,
      { id: string; name: string; json: string }
    >()

    let inputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let stopReason: StopReason = "end_turn"
    let hasYieldedStop = false

    try {
      // Use the streaming endpoint with retry for transient failures.
      // The Anthropic SDK's `create()` with `stream: true` returns
      // `Stream<RawMessageStreamEvent>` which is AsyncIterable.
      const stream = await this.withRetry(
        () => client.messages.create(
          { ...params, stream: true as const },
          { signal },
        ),
        4,
        signal,
      )

      // TG0: rely on SDK's implicit cleanup when AsyncIterable is abandoned
      // (break/return). Verify stream disposal behavior on SDK upgrade.
      for await (const event of stream) {
        if (signal.aborted) break

        switch (event.type) {
          case "message_start": {
            const usage = event.message.usage
            inputTokens = usage.input_tokens
            cacheReadTokens = usage.cache_read_input_tokens ?? 0
            cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
            break
          }

          case "content_block_start": {
            const block = event.content_block
            if (block.type === "tool_use") {
              toolBlocks.set(event.index, {
                id: block.id,
                name: block.name,
                json: "",
              })
            }
            break
          }

          case "content_block_delta": {
            const delta = event.delta

            if (delta.type === "text_delta") {
              yield { type: "text", content: delta.text }
            } else if (delta.type === "thinking_delta") {
              yield { type: "thinking", content: delta.thinking }
            } else if (delta.type === "input_json_delta") {
              const acc = toolBlocks.get(event.index)
              if (acc) {
                acc.json += delta.partial_json
              }
            }
            // citations_delta and signature_delta are ignored for TG0
            break
          }

          case "content_block_stop": {
            const acc = toolBlocks.get(event.index)
            if (acc) {
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
                yield {
                  type: "tool_use",
                  call: {
                    id: acc.id,
                    name: acc.name,
                    arguments: {},
                  },
                }
              }
              toolBlocks.delete(event.index)
            }
            break
          }

          case "message_delta": {
            stopReason = mapStopReason(event.delta.stop_reason)
            const outputTokens = event.usage.output_tokens

            const usage: TokenUsage = {
              input: inputTokens,
              output: outputTokens,
              cacheRead: cacheReadTokens,
              cacheWrite: cacheWriteTokens,
              total: inputTokens + outputTokens,
            }

            yield { type: "stop", reason: stopReason, usage }
            hasYieldedStop = true
            break
          }

          case "message_stop": {
            // TG0: if message_delta was skipped (network edge case),
            // output tokens are unknown — reported as 0.
            if (!hasYieldedStop) {
              yield {
                type: "stop",
                reason: stopReason,
                usage: {
                  input: inputTokens,
                  output: 0,
                  cacheRead: cacheReadTokens,
                  cacheWrite: cacheWriteTokens,
                  total: inputTokens,
                },
              }
            }
            break
          }
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

  /**
   * Extract ParsedToolCall[] from an Anthropic ContentBlock[].
   *
   * Used for non-streaming responses (e.g., from cache replay or
   * synthetic messages). For streaming, tool calls are parsed
   * inline in think() via content_block_start/delta/stop events.
   */
  parseToolCalls(raw: unknown): ParsedToolCall[] {
    if (!Array.isArray(raw)) return []

    const calls: ParsedToolCall[] = []
    for (const block of raw as Anthropic.ContentBlock[]) {
      if (block.type === "tool_use") {
        calls.push({
          id: block.id,
          name: block.name,
          arguments: (block.input as Record<string, unknown>) ?? {},
        })
      }
    }
    return calls
  }

  // ── Format tool result ──

  /**
   * Convert our ToolResult to Anthropic's tool_result content block.
   *
   * Anthropic expects: { type: "tool_result", tool_use_id, content, is_error? }
   * where content is a string (text result) or array of content blocks.
   */
  formatToolResult(callId: string, result: ToolResult): unknown {
    const base: Anthropic.ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: callId,
    }

    if (result.ok) {
      let content =
        typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data)

      // If the tool output was truncated, prepend a warning so the LLM
      // knows the data is incomplete and can adjust its reasoning.
      if (result.meta?.truncated) {
        content = "[Warning: tool output was truncated]\n" + content
      }

      base.content = content
    } else {
      base.content = result.error
      base.is_error = true
    }

    return base
  }

  /**
   * Wrap a tool result into a complete Anthropic Message ready for the
   * next API call.
   *
   * Anthropic requires tool results to be wrapped in a user-role message
   * envelope: `{ role: "user", content: [toolResultBlock] }`.
   */
  wrapToolResult(
    callId: string,
    result: ToolResult,
    _toolName?: string,
  ): import("@taor/core").Message {
    const rawBlock = this.formatToolResult(callId, result) as Anthropic.ToolResultBlockParam

    // Guarantee content is a string — MessageContent.tool_result.content
    // is typed as `string`. Anthropic's SDK allows `string | ContentBlock[]`,
    // so we normalize: arrays → JSON.stringify, strings pass through.
    const content =
      typeof rawBlock.content === "string"
        ? rawBlock.content
        : JSON.stringify(rawBlock.content)

    const block: import("@taor/core").MessageContent = {
      type: "tool_result",
      tool_use_id: callId,
      content,
      ...(rawBlock.is_error ? { is_error: true } : {}),
    }

    return {
      role: "user",
      content: [block],
    }
  }

  // ── Token counting (approximate, TG0) ──

  /**
   * Approximate token count from internal Message[].
   *
   * Rough heuristic: ~4 characters per token. For precise counts,
   * call Anthropic's count_tokens endpoint.
   *
   * TG0: approximate. TG1+: call messages.countTokens() via SDK.
   */
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
            // block.input may be non-serializable in edge cases
            // (binary data, circular refs). Fall back to estimate.
            totalChars += 100
          }
        } else if (block.type === "tool_result") {
          totalChars += block.content.length
        }
      }
    }
    // Rough heuristic (~4 chars per token). TG0: approximate.
    // TG1+: call Anthropic's messages.countTokens() for precision.
    return Math.ceil(totalChars / 4)
  }

  /**
   * Approximate token count from an already-built request.
   */
  countRequestTokens(request: AdapterRequest): number {
    const params = request as Anthropic.MessageCreateParams
    let totalChars = 0

    if ("system" in params && params.system) {
      totalChars +=
        typeof params.system === "string"
          ? params.system.length
          : JSON.stringify(params.system).length
    }

    for (const msg of params.messages) {
      if (typeof msg.content === "string") {
        totalChars += msg.content.length
      } else {
        for (const block of msg.content) {
          totalChars += JSON.stringify(block).length
        }
      }
    }

    if ("tools" in params && params.tools) {
      totalChars += JSON.stringify(params.tools).length
    }

    return Math.ceil(totalChars / 4)
  }

  // ── Error normalization ──

  /**
   * Convert provider-specific errors to framework-agnostic HarnessError.
   *
   * Anthropic SDK throws APIError subclasses (AuthenticationError,
   * RateLimitError, etc.) which all extend Anthropic.APIError.
   */
  normalizeError(error: unknown): HarnessError {
    if (error instanceof Anthropic.APIError) {
      const recoverable = isRecoverableStatus(error.status)

      return {
        code: mapHttpCode(error.status),
        message: error.message,
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
