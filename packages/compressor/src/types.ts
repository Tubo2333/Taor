// @taor/compressor — type definitions

import type { CompressLevel, TurnContext } from "@taor/core"
import type { AdapterConstructor } from "@taor/adapters"

export interface CompressorConfig {
  /** Compression strategies in priority order (cheap → expensive) */
  pipeline: CompressStrategy[]

  /** Token threshold that triggers compression */
  triggerThreshold: number

  /** Target token count after compression */
  targetThreshold: number

  /** Max compression attempts before hard truncation */
  maxAttempts: number

  /** Cache compression results to avoid re-compressing identical content */
  cacheResults: boolean

  /**
   * LLM adapter for summarize/embed strategies.
   * Default = reuse main LLMAdapter (requires reentrant think() support).
   * Provide an independent adapter to avoid contention with the TAOR THINK phase.
   */
  adapter?: AdapterConstructor
}

export interface CompressStrategy {
  name: string
  level: CompressLevel
  /** Estimated savings ratio (0-1), used to select strategy */
  estimatedSavings: number
  compress(ctx: TurnContext, opts: { targetTokens: number }): Promise<CompressedContext>
}

export interface CompressedContext {
  messages: import("@taor/core").Message[]
  tokenCount: number
  level: CompressLevel
  strategy: string
}
