// @harness/compressor/strategies — 5-layer cheap-first compression
//
// TG0: trim + truncate are fully implemented.
//      summarize / chunk / embed are stubs (require LLM adapter / embedding model).
//
// Pipeline order (cheapest first):
//   trim → summarize → chunk → embed → truncate

import type { CompressLevel, TurnContext, Message } from "@harness/core"
import type { CompressStrategy, CompressedContext } from "../types.js"

// ═══════════════════════════════════════════════════════════════════
// ─── Utility ───
// ═══════════════════════════════════════════════════════════════════

/** Rough token count: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Estimate tokens for a list of messages, covering all 4 MessageContent types:
 * text, tool_use, tool_result, and image (skipped).
 *
 * Used by pipeline.ts (trigger/check) and all strategies for consistent counts.
 */
export function messagesToTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "text") {
        total += estimateTokens(block.text)
      } else if (block.type === "tool_use") {
        total += estimateTokens(JSON.stringify(block.input))
      } else if (block.type === "tool_result") {
        // tool_result.content is always string in TG0 (Anthropic format)
        total += estimateTokens(block.content as string)
      }
      // image: skip — base64 data not counted per-token by any provider
    }
  }
  return total
}

// ═══════════════════════════════════════════════════════════════════
// ─── Layer 1: trim ───
// ═══════════════════════════════════════════════════════════════════

/**
 * Trim — remove whitespace-only and empty messages.
 * Cheapest layer. 5-15% savings on verbose outputs.
 */
export const trim: CompressStrategy = {
  name: "trim",
  level: "trim" as CompressLevel,
  estimatedSavings: 0.1,
  async compress(
    ctx: TurnContext,
    _opts: { targetTokens: number },
  ): Promise<CompressedContext> {
    // F-1: use block.type === "tool_use", not "tool_use" in block
    const filtered = ctx.turn.messages.filter((msg) =>
      msg.content.some(
        (block) =>
          (block.type === "text" && block.text.trim().length > 0) ||
          block.type === "tool_use" ||
          block.type === "tool_result",
      ),
    )
    const tokenCount = messagesToTokens(filtered)
    return { messages: filtered, tokenCount, level: "trim", strategy: "trim" }
  },
}

// ═══════════════════════════════════════════════════════════════════
// ─── Layer 2: summarize ───
// ═══════════════════════════════════════════════════════════════════

/**
 * Summarize — LLM-based condensation.
 * TG0 stub: returns identity. TG1: replaced by createSummarize(adapter).
 */
export const summarize: CompressStrategy = {
  name: "summarize",
  level: "summarize" as CompressLevel,
  estimatedSavings: 0.5,
  async compress(
    ctx: TurnContext,
    _opts: { targetTokens: number },
  ): Promise<CompressedContext> {
    const tokenCount = messagesToTokens(ctx.turn.messages)
    return {
      messages: ctx.turn.messages,
      tokenCount,
      level: "summarize",
      strategy: "summarize",
    }
  },
}

/**
 * Create a real summarize strategy backed by an LLM adapter.
 *
 * The adapter must support reentrant think() calls (AnthropicAdapter does —
 * each think() creates a new HTTP client). The strategy builds a
 * condensation prompt from the context messages, calls the LLM, and
 * replaces the context with a single concise summary message.
 */
export function createSummarize(adapter: SummarizeAdapter, signal?: AbortSignal): CompressStrategy {
  return {
    name: "summarize",
    level: "summarize" as CompressLevel,
    estimatedSavings: 0.5,
    async compress(
      ctx: TurnContext,
      _opts: { targetTokens: number },
    ): Promise<CompressedContext> {
      try {
        // Build summarization prompt from existing messages
        const textBlocks: string[] = []
        for (const msg of ctx.turn.messages) {
          for (const block of msg.content) {
            if (block.type === "text") {
              textBlocks.push(block.text)
            } else if (block.type === "tool_use") {
              // I-3: Include tool calls in the summary context
              textBlocks.push(`[Tool call: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})]`)
            } else if (block.type === "tool_result") {
              textBlocks.push(`[Tool result: ${(block as { content: string }).content.slice(0, 200)}]`)
            }
          }
        }

        const conversationText = textBlocks.join("\n\n")
        if (conversationText.length < 500) {
          // Too short to summarize — return identity
          return {
            messages: ctx.turn.messages,
            tokenCount: messagesToTokens(ctx.turn.messages),
            level: "summarize",
            strategy: "summarize",
          }
        }

        const summaryPrompt = `Condense the following conversation into a concise summary (max 500 words). Preserve key facts, decisions, tool results, and action items. Omit redundant exchanges.

Conversation:
${conversationText.slice(0, 16_000)}`

        const request = await adapter.buildRequest(
          [{ role: "user", content: [{ type: "text", text: summaryPrompt }] }],
          "You are a context compressor. Summarize concisely.",
          ctx.session.model,
        )

        let summaryText = ""
        // I-4: Use parent signal if provided, otherwise create a new one
        const thinkSignal = signal ?? new AbortController().signal

        for await (const te of adapter.think(request as never, thinkSignal)) {
          if (te.type === "text" && te.content) {
            summaryText += te.content
          }
          if (te.type === "stop") break
        }

        if (!summaryText.trim()) {
          return {
            messages: ctx.turn.messages,
            tokenCount: messagesToTokens(ctx.turn.messages),
            level: "summarize",
            strategy: "summarize",
          }
        }

        // Replace context with summary
        const summaryMessage: Message = {
          role: "user",
          content: [{ type: "text", text: `[Context Summary]\n${summaryText}` }],
        }
        // Keep the last message (latest user prompt) + summary
        const lastMsg = ctx.turn.messages[ctx.turn.messages.length - 1]
        const condensed = lastMsg ? [summaryMessage, lastMsg] : [summaryMessage]
        const tokenCount = messagesToTokens(condensed)

        return { messages: condensed, tokenCount, level: "summarize", strategy: "summarize" }
      } catch {
        // LLM call failed — return identity (don't break the pipeline)
        return {
          messages: ctx.turn.messages,
          tokenCount: messagesToTokens(ctx.turn.messages),
          level: "summarize",
          strategy: "summarize",
        }
      }
    },
  }
}

/** Minimal adapter interface for summarize strategy. */
interface SummarizeAdapter {
  buildRequest(
    messages: Message[],
    systemPrompt: string,
    model: string,
  ): Promise<unknown>
  think(
    request: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<{ type: string; content?: string }, void, void>
}

// ═══════════════════════════════════════════════════════════════════
// ─── Layer 3: chunk ───
// ═══════════════════════════════════════════════════════════════════

/**
 * Chunk — split context into turn-pair chunks, keep most relevant by keyword overlap.
 */
export const chunk: CompressStrategy = {
  name: "chunk",
  level: "chunk" as CompressLevel,
  estimatedSavings: 0.6,
  async compress(
    ctx: TurnContext,
    opts: { targetTokens: number },
  ): Promise<CompressedContext> {
    const messages = ctx.turn.messages
    if (messages.length <= 4) {
      return { messages, tokenCount: messagesToTokens(messages), level: "chunk", strategy: "chunk" }
    }

    // Split into pairs: [user, assistant], [user, assistant], ...
    const chunks: Message[][] = []
    for (let i = 0; i < messages.length - 1; i += 2) {
      chunks.push([messages[i]!, messages[i + 1]!])
    }
    if (messages.length % 2 === 1) {
      chunks.push([messages[messages.length - 1]!])
    }

    // Score: keyword overlap with last chunk
    const lastText = chunks[chunks.length - 1]!
      .flatMap((m) => m.content)
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text.toLowerCase())
      .join(" ")

    const keywords = new Set(lastText.split(/\s+/).filter((w) => w.length > 3))

    const scored = chunks.map((chunk, i) => {
      const chunkText = chunk
        .flatMap((m) => m.content)
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text.toLowerCase())
        .join(" ")
      let score = 0
      for (const word of chunkText.split(/\s+/)) {
        if (keywords.has(word)) score++
      }
      return { chunk, score, index: i }
    })

    // Keep last chunk + top N by score, up to target tokens
    const kept: Message[] = []
    // Always keep the last chunk
    scored.sort((a, b) => b.score - a.score || b.index - a.index)
    for (const { chunk } of scored) {
      const candidate = [...kept, ...chunk]
      if (messagesToTokens(candidate) > opts.targetTokens && kept.length > 0) break
      kept.push(...chunk)
    }

    const tokenCount = messagesToTokens(kept)
    return { messages: kept, tokenCount, level: "chunk", strategy: "chunk" }
  },
}

// ═══════════════════════════════════════════════════════════════════
// ─── Layer 4: embed ───
// ═══════════════════════════════════════════════════════════════════

/**
 * Embed — vector-based semantic retrieval.
 * TG0 stub: requires embedding model + vector store.
 * Returns original messages unchanged.
 */
export const embed: CompressStrategy = {
  name: "embed",
  level: "embed" as CompressLevel,
  estimatedSavings: 0.7,
  async compress(
    ctx: TurnContext,
    _opts: { targetTokens: number },
  ): Promise<CompressedContext> {
    // TG0 stub: requires vector store + embedding model. Returns identity.
    const tokenCount = messagesToTokens(ctx.turn.messages)
    return {
      messages: ctx.turn.messages,
      tokenCount,
      level: "embed",
      strategy: "embed",
    }
  },
}

// ═══════════════════════════════════════════════════════════════════
// ─── Layer 5: truncate ───
// ═══════════════════════════════════════════════════════════════════

/**
 * Truncate — remove oldest messages until under targetTokens.
 * Most expensive (lossy). Always reaches target.
 */
export const truncate: CompressStrategy = {
  name: "truncate",
  level: "truncate" as CompressLevel,
  estimatedSavings: 1.0,
  async compress(
    ctx: TurnContext,
    opts: { targetTokens: number },
  ): Promise<CompressedContext> {
    const messages = [...ctx.turn.messages]
    let tokenCount = messagesToTokens(messages)

    // TG0 limitation: with only 2 messages (e.g., user prompt + assistant)
    // and still over target, compression physically cannot reach target
    // without losing context. TG1: apply per-message summarization as fallback.
    while (tokenCount > opts.targetTokens && messages.length > 2) {
      // Keep the first message (user prompt) and last message (latest response)
      const removed = messages.splice(1, 1)[0]
      if (removed) {
        // F-2: use unified messagesToTokens for accurate subtraction
        tokenCount -= messagesToTokens([removed])
      }
    }

    return { messages, tokenCount, level: "truncate", strategy: "truncate" }
  },
}

// ═══════════════════════════════════════════════════════════════════
// ─── Pipeline array (cheapest → most expensive) ───
//
// maxAttempts limits non-truncate strategy executions. Stubs (summarize/
// chunk/embed) count as attempts — they do cost CPU cycles even in TG0.
// TG1: skip stubs when they have no implementation or lazy-evaluate them.
// ═══════════════════════════════════════════════════════════════════

export const DEFAULT_STRATEGIES: CompressStrategy[] = [
  trim,
  summarize,
  chunk,
  embed,
  truncate,
]
