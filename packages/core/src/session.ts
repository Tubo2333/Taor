// @harness/core — session lifecycle + SessionResult + SerializedSession

import type { TokenUsage, Artifact, CompressLevel } from "./types.js"
import type { Message } from "./context.js"

// ─── SessionResult (AsyncGenerator TReturn) ───

/**
 * SessionResult — the TReturn (done-value) of Harness's AsyncGenerator.
 * When the generator completes, { done: true, value: SessionResult }.
 * Not yielded as a HarnessEvent — consumers using for await...of should
 * query harness.state / harness.tokenUsage after the loop ends.
 */
export interface SessionResult {
  sessionId: string
  status: "completed" | "aborted" | "error" | "blocked" | "timeout"
  turns: number
  tokenUsage: TokenUsage
  finalMessage: string
  /** Artifacts recursively include sub-agent outputs */
  artifacts: Artifact[]
}

// ─── SerializedSession (cross-session resume, v2) ───

/**
 * Serializable session snapshot.
 * Only valid at turn boundaries — cannot serialize mid-THINK/ACT/OBSERVE.
 * Non-serializable parts (adapter, tool instances) are re-injected via config in deserialize().
 */
export interface SerializedSession {
  version: number
  sessionId: string
  model: string
  workDir: string
  startedAt: number
  tokenUsage: TokenUsage
  turnCount: number
  turns: SerializedTurn[]
  memorySnapshots: {
    user: Record<string, unknown>
    project: Record<string, unknown>
  }
}

export interface SerializedTurn {
  id: string
  index: number
  messages: Message[]
  tokenUsage: TokenUsage
  compressedAt: CompressLevel | null
}
