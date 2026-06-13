// @harness/subagent — type definitions

import type { TokenUsage, Artifact, Unsubscribe } from "@harness/core"
import type { ToolInput } from "@harness/tools"
import type { z } from "zod"

export type SubagentStatus = "pending" | "starting" | "running" | "done" | "error" | "aborted"

export interface SubagentSpec {
  description: string
  prompt: string
  /**
   * Available tools. Default = inherit all parent tools (excluding subagent:deny).
   *
   * **Isolation restriction**: `process`/`worktree` isolation only accepts
   * `class extends Tool` defined in importable modules. `defineTool()` closures
   * cannot be serialized via IPC and will throw at spawn() time.
   */
  tools?: ToolInput[]
  model?: string
  isolation?: "inline" | "process" | "worktree"
  schema?: z.ZodType
  maxTurns?: number
  timeout?: number
}

export interface SubagentHandle {
  readonly id: string
  readonly description: string
  status: SubagentStatus

  started(): Promise<void>
  done(): Promise<SubagentResult>
  abort(reason?: string): void

  on(event: "started", handler: () => void): Unsubscribe
  on(event: "done", handler: (result: SubagentResult) => void): Unsubscribe
  on(event: "error", handler: (error: SubagentError) => void): Unsubscribe
  on(event: "heartbeat", handler: (h: SubagentHeartbeat) => void): Unsubscribe
  on(event: "status-change", handler: (from: SubagentStatus, to: SubagentStatus) => void): Unsubscribe
}

export interface SubagentResult {
  ok: boolean
  data?: unknown
  turns: number
  tokenUsage: TokenUsage
  artifacts?: Artifact[]
  error?: string
}

export interface SubagentError {
  code: "startup_failed" | "timeout" | "max_turns" | "execution_error" | "aborted"
  message: string
  subagentId: string
}

export interface SubagentHeartbeat {
  subagentId: string
  turnIndex: number
  elapsed: number
  tokenUsage: TokenUsage
}
