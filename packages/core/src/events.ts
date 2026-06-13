// @taor/core — HarnessEvent union type (14 variants)

import type { TokenUsage, Artifact, CompressLevel } from "./types.js"
import type { HarnessError } from "./context.js"

// ─── Session-level ───

export interface SessionStartedEvent {
  type: "started"
  sessionId: string
  model: string
  workDir: string
  tools: string[]
  timestamp: number
}

// ─── Turn-level ───

export interface TurnStartedEvent {
  type: "turn-started"
  turnId: string
  turnIndex: number
  timestamp: number
}

export interface ThinkingEvent {
  type: "thinking"
  turnId: string
  model: string
  timestamp: number
}

export interface ThoughtEvent {
  type: "thought"
  turnId: string
  content: string
  kind: "text" | "thinking"
  timestamp: number
}

export interface ToolCallEvent {
  type: "tool-call"
  turnId: string
  callId: string
  tool: string
  params: Record<string, unknown>
  risk: "low" | "medium" | "high"
  timestamp: number
}

export interface ToolResultEvent {
  type: "tool-result"
  turnId: string
  callId: string
  tool: string
  ok: boolean
  duration: number
  truncated?: boolean
  timestamp: number
}

export interface ApprovalRequiredEvent {
  type: "approval-required"
  turnId: string
  callId: string
  tool: string
  params: Record<string, unknown>
  risk: "low" | "medium" | "high"
  reason: string
  /** Time-to-live in seconds. 0 = never timeout. */
  ttl: number
  timestamp: number
}

export interface TurnEndedEvent {
  type: "turn-ended"
  turnId: string
  turnIndex: number
  tokenUsage: TokenUsage
  duration: number
  compressed: boolean
}

// ─── System events ───

export interface CompressedEvent {
  type: "compressed"
  turnId: string
  level: CompressLevel
  beforeTokens: number
  afterTokens: number
  savingsPercent: number
  strategy: string
  timestamp: number
}

export interface SubagentSpawnedEvent {
  type: "subagent-spawned"
  parentTurnId: string
  subagentId: string
  description: string
  isolation: "inline" | "process" | "worktree"
  timestamp: number
}

export interface SubagentResultEvent {
  type: "subagent-result"
  parentTurnId: string
  subagentId: string
  ok: boolean
  turns: number
  tokenUsage: TokenUsage
  timestamp: number
}

export interface HeartbeatEvent {
  type: "heartbeat"
  turnId: string
  elapsed: number
  toolRunning?: string
  timestamp: number
}

export interface ErrorEvent {
  type: "error"
  turnId?: string
  error: HarnessError
}

export interface BlockedEvent {
  type: "blocked"
  turnId: string
  callId: string
  tool: string
  level: "deny" | "boundary" | "allow" | "ask"
  reason: string
  timestamp: number
}

// ─── Union ───

/**
 * HarnessEvent — all events yielded by the AsyncGenerator main channel.
 * SessionResult is the TReturn (done-value) of the generator, NOT in this union.
 */
export type HarnessEvent =
  | SessionStartedEvent
  | TurnStartedEvent
  | ThinkingEvent
  | ThoughtEvent
  | ToolCallEvent
  | ToolResultEvent
  | ApprovalRequiredEvent
  | TurnEndedEvent
  | CompressedEvent
  | SubagentSpawnedEvent
  | SubagentResultEvent
  | HeartbeatEvent
  | ErrorEvent
  | BlockedEvent

// ─── UserDecision (injected via harness.next()) ───

export type UserDecision =
  | { type: "approve"; callId: string }
  | { type: "deny"; callId: string; reason?: string }
  | { type: "approve-all"; scope: "turn" | "session" }
  | { type: "interject"; message: string }
  | { type: "start"; prompt: string }
