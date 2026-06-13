// @harness/core — foundational types shared across all subsystems

/** Token usage tracking (compliant with Anthropic/OpenAI streaming format) */
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** File artifact produced by a tool execution */
export interface Artifact {
  /** Path relative to workDir */
  path: string
  /** Origin of the artifact */
  source: "main" | "subagent"
  subagentId?: string
  tool: string
  size: number
  /** SHA-256 hash */
  hash: string
}

/** Unsubscribe function returned by event listeners */
export type Unsubscribe = () => void

/** Summary record for a completed turn */
export interface TurnRecord {
  id: string
  index: number
  status: "completed" | "error" | "compressed" | "aborted"
  tokenUsage: TokenUsage
  toolCalls: number
  duration: number
  compressedAt: CompressLevel | null
}

/** Context compression levels (cheap → expensive) */
export type CompressLevel = "none" | "trim" | "summarize" | "chunk" | "embed" | "truncate"

export type SessionStatus = "running" | "paused" | "completed" | "aborted" | "error"

// Re-exported here because CompressLevel appears in both types.ts and context.ts
