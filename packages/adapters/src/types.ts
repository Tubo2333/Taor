// @harness/adapters — LLMAdapter interface + shared types

import type { TurnContext, HarnessError, TokenUsage, Message } from "@harness/core"
import type { ToolDescriptor, ToolResult } from "@harness/tools"

export type AdapterFeature =
  | "streaming"
  | "thinking"
  | "tool-use"
  | "parallel-tool-calls"
  | "vision"
  | "prompt-caching"
  | "computer-use"

export type StopReason = "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "refusal" | "unknown"

export interface ParsedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type ThinkEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_use"; call: ParsedToolCall }
  | { type: "stop"; reason: StopReason; usage: TokenUsage }
  | { type: "error"; error: HarnessError }

export interface ModelInfo {
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

export interface RequestOptions {
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  thinking?: { budgetTokens: number }
  tools?: ToolDescriptor[]
}

/** Provider-specific request — upper layers do not inspect its structure */
export type AdapterRequest = unknown

export type AdapterConstructor = new (opts?: Record<string, unknown>) => LLMAdapter

/**
 * LLM Adapter interface.
 *
 * ## Concurrency safety
 *
 * If Compressor reuses the main adapter (default), think() may be called
 * concurrently from the TAOR main loop's THINK phase AND the Compressor's
 * summarize strategy. Implementations MUST support reentrant calls —
 * i.e., multiple independent AsyncGenerators active simultaneously.
 * The simplest approach: create a fresh HTTP client per think() invocation.
 * If the provider has concurrency limits, use CompressorConfig.adapter to
 * inject a separate adapter, or use a semaphore for rate limiting.
 */
export interface LLMAdapter {
  readonly provider: string
  readonly version: string

  getModelInfo(model: string): ModelInfo
  supports(feature: AdapterFeature, model?: string): boolean

  buildRequest(ctx: TurnContext, opts: RequestOptions): Promise<AdapterRequest>
  think(request: AdapterRequest, signal: AbortSignal): AsyncGenerator<ThinkEvent>

  parseToolCalls(rawResponse: unknown): ParsedToolCall[]
  formatToolResult(callId: string, result: ToolResult): unknown
  /**
   * Wrap a formatted tool result content block into a complete Message
   * that can be appended to the conversation.
   *
   * Different providers require different outer message envelopes:
   * - Anthropic: `{ role: "user", content: [toolResultBlock] }`
   * - OpenAI:   `{ role: "tool", tool_call_id, content: "..." }`
   *
   * TAOR loop calls this instead of formatToolResult() to get a
   * provider-agnostic Message — no provider-specific wrapping logic
   * leaks into the harness core.
   */
  wrapToolResult(callId: string, result: ToolResult, toolName?: string): Message

  countTokens(messages: import("@harness/core").Message[]): number
  countRequestTokens(request: AdapterRequest): number

  normalizeError(error: unknown): HarnessError
}
