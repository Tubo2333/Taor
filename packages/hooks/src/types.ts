// @taor/hooks — hook type definitions

import type {
  SessionContext,
  TurnContext,
  HarnessError,
  CompressLevel,
} from "@taor/core"
import type { SessionResult } from "@taor/core"
import type { ToolCall } from "@taor/core"
import type { ThinkEvent } from "@taor/adapters"
import type { ToolResult } from "@taor/tools"
import type { Observation } from "@taor/core"

// ─── Error recovery ───

export type ErrorRecovery =
  | { action: "retry" }
  | { action: "skip_turn" }
  | { action: "abort"; reason: string }
  | { action: "ignore" }

// ─── Subagent references (imported lazily to avoid circular deps) ───

interface SubagentSpec {
  description: string
  prompt: string
}

interface SubagentHandle {
  id: string
  description: string
}

interface SubagentResult {
  ok: boolean
}

// ─── Hook handler map ───

export interface HookHandlerMap {
  // Session
  onSessionStart: (ctx: SessionContext) => Promise<void>
  onSessionEnd: (ctx: SessionContext, result: SessionResult) => Promise<void>

  // Turn
  beforeThink: (ctx: TurnContext) => Promise<TurnContext | void>
  afterThink: (ctx: TurnContext, events: ThinkEvent[]) => Promise<ThinkEvent[] | void>
  beforeAct: (ctx: TurnContext, call: ToolCall) => Promise<ToolCall | void>
  afterAct: (ctx: TurnContext, call: ToolCall, result: ToolResult) => Promise<void>
  afterObserve: (ctx: TurnContext, observation: Observation) => Promise<Observation | void>

  // Compress
  beforeCompress: (ctx: TurnContext, level: CompressLevel) => Promise<void>
  afterCompress: (ctx: TurnContext, event: import("@taor/core").CompressedEvent) => Promise<void>

  // Error
  onError: (ctx: SessionContext, error: HarnessError) => Promise<ErrorRecovery | void>

  // Sub-agent
  beforeSpawn: (spec: SubagentSpec) => Promise<SubagentSpec | void>
  afterSpawnResult: (handle: SubagentHandle, result: SubagentResult) => Promise<void>
}

export type HookName = keyof HookHandlerMap

export interface HookRegistration {
  hook: HookName
  handler: HookHandlerMap[HookName]
  priority?: number
  once?: boolean
  name?: string
}

export type HookInput = Partial<HookHandlerMap> | HookRegistration[]
