// @harness/core — HarnessContext (3-layer scope) and all sub-types

import type { TokenUsage, CompressLevel, SessionStatus } from "./types.js"

// ─── Message types (used by TurnState) ───

export interface Message {
  role: "system" | "user" | "assistant" | "tool"
  content: MessageContent[]
}

export type MessageContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }

// ─── ToolCall (runtime tracking) ───

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  status: "pending" | "running" | "done" | "error"
  startedAt: number
  retries: number
}

// ─── Observation (TAOR O-phase output) ───

export interface Observation {
  turnId: string
  toolResults: ToolCallResult[]
  newMessages: Message[]
  tokenUsage: TokenUsage
  compressedAt: CompressLevel | null
}

export interface ToolCallResult {
  call: ToolCall
  result: unknown  // ToolResult — circular import avoided, typed as unknown here
}

// ─── HarnessError ───

export interface HarnessError {
  code: string
  message: string
  source: "adapter" | "tool" | "harness" | "subagent" | "compressor" | "hooks" | "memory"
  recoverable: boolean
  cause?: unknown
  timestamp: number
}

// ─── 3-layer context ───

export interface SessionState {
  id: string
  workDir: string
  model: string
  startedAt: number
  status: SessionStatus
  tokenUsage: TokenUsage
  turnCount: number
}

export interface TurnState {
  id: string
  index: number
  messages: Message[]
  /** Readonly — tools must not mutate the pending call map */
  pendingToolCalls: ReadonlyMap<string, Readonly<ToolCall>>
  lastObservation: Observation | null
  compressedAt: CompressLevel | null
}

export interface SharedCacheState {
  projectRoot: string
  projectConfig: Record<string, unknown> | null
  loadedResources: Map<string, unknown>
}

export interface HarnessContext {
  session: SessionState
  turn: TurnState
  shared: SharedCacheState
}

// ─── Context aliases ───

/** Session-level hook context (no active turn) */
export type SessionContext = Omit<HarnessContext, "turn">

/** Turn-level hook / adapter / compressor context (full HarnessContext) */
export type TurnContext = HarnessContext
