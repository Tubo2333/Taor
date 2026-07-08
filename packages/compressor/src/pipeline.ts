// @taor/compressor — 5-layer cheap-first compression pipeline

import type { CompressorConfig, CompressStrategy, CompressedContext } from "./types.js"
import type { TurnContext } from "@taor/core"
import { DEFAULT_STRATEGIES, messagesToTokens } from "./strategies/index.js"

// ═══════════════════════════════════════════════════════════════════
// ─── Defaults ───
// ═══════════════════════════════════════════════════════════════════

const DEFAULTS: CompressorConfig = {
  pipeline: DEFAULT_STRATEGIES,
  triggerThreshold: 100_000, // tokens
  targetThreshold: 50_000,
  maxAttempts: 3,
  cacheResults: true,
}

// ═══════════════════════════════════════════════════════════════════
// ─── CompressorPipeline ───
// ═══════════════════════════════════════════════════════════════════

/**
 * CompressorPipeline — runs compression strategies in order (cheapest first).
 *
 * ## Pipeline
 *
 * ```
 * trim → summarize → chunk → embed → truncate
 * ```
 *
 * Each layer only activates if the previous layer didn't reach targetThreshold.
 * `truncate` is always last and guarantees reaching the target.
 *
 * ## Design principle
 *
 * "先便宜后贵" (cheapest first). Don't call the LLM for summarization if
 * trimming whitespace is enough. Don't embed if chunking is enough.
 *
 * ## Cache
 *
 * When `cacheResults` is true (default), identical messages+target are
 * cached so re-compression on the same context is a no-op.
 */
export class CompressorPipeline {
  private strategies: CompressStrategy[]
  readonly triggerThreshold: number
  private targetThreshold: number
  private maxAttempts: number
  private cacheResults: boolean
  private cache = new Map<string, CompressedContext>()

  constructor(config: Partial<CompressorConfig> = {}) {
    this.strategies = config.pipeline ?? DEFAULTS.pipeline
    this.triggerThreshold = config.triggerThreshold ?? DEFAULTS.triggerThreshold
    this.targetThreshold = config.targetThreshold ?? DEFAULTS.targetThreshold
    this.maxAttempts = config.maxAttempts ?? DEFAULTS.maxAttempts
    this.cacheResults = config.cacheResults ?? DEFAULTS.cacheResults
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Main ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Run the compression pipeline.
   *
   * Checks if the current context exceeds `triggerThreshold`. If not,
   * returns the original context unchanged. Otherwise, runs strategies
   * in order until the target threshold is reached or maxAttempts is
   * exhausted. `truncate` always runs last and guarantees reaching target.
   *
   * @returns CompressedContext with reduced messages and token count
   */
  async compress(ctx: TurnContext): Promise<CompressedContext> {
    const messages = ctx.turn.messages
    const currentTokens = messagesToTokens(messages)

    // Below trigger — no compression needed
    if (currentTokens <= this.triggerThreshold) {
      return { messages, tokenCount: currentTokens, level: "none", strategy: "none" }
    }

    // Check cache
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cacheKey = this.cacheKey(messages as any, this.targetThreshold)
    if (this.cacheResults) {
      const cached = this.cache.get(cacheKey)
      if (cached) return cached
    }

    let result: CompressedContext = {
      messages,
      tokenCount: currentTokens,
      level: "none",
      strategy: "none",
    }

    let attempts = 0
    for (const strategy of this.strategies) {
      if (attempts >= this.maxAttempts) break
      if (result.tokenCount <= this.targetThreshold) break

      attempts++
      result = await strategy.compress(ctx, { targetTokens: this.targetThreshold })
    }

    // Guarantee: if still over target, force truncation
    if (result.tokenCount > this.targetThreshold) {
      const lastStrategy = this.strategies[this.strategies.length - 1]
      if (lastStrategy && lastStrategy.name !== result.strategy) {
        result = await lastStrategy.compress(ctx, { targetTokens: this.targetThreshold })
      }
    }

    if (this.cacheResults) {
      this.cache.set(cacheKey, result)
    }

    return result
  }

  // ═══════════════════════════════════════════════════════════════
  // ─── Helpers ──
  // ═══════════════════════════════════════════════════════════════

  /**
   * Compute a cache key from message content.
   *
   * Uses first+last text content (first 64 chars each) + message count + target
   * to minimize collisions. Length-only fingerprints would collide on "The result
   * is 42" vs "The result is 43" (same length, different meaning).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cacheKey(messages: any[], target: number): string {
    const firstMsg = messages[0]
    const lastMsg = messages[messages.length - 1]
    const firstBlock = firstMsg?.content?.[0]
    const lastBlock = lastMsg?.content?.[lastMsg.content.length - 1]
    const firstText =
      firstBlock && "text" in firstBlock
        ? (firstBlock.text as string).slice(0, 64)
        : ""
    const lastText =
      lastBlock && "text" in lastBlock
        ? (lastBlock.text as string).slice(0, 64)
        : ""
    return `${firstText}|${lastText}|${messages.length}|${target}`
  }

  /**
   * Clear the compression cache.
   */
  clearCache(): void {
    this.cache.clear()
  }
}
