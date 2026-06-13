// @taor/core — unresolved type placeholders
//
// These types belong to other @taor/* packages. They are stubbed here to
// avoid circular dependencies (@taor/adapters and @taor/tools depend on
// @taor/core, but HarnessConfig in core needs to reference their types).
//
// **Design tradeoff (accepted)**: HarnessConfig does NOT perform deep type
// validation on subsystem configs at the TypeScript level. Runtime validation
// is performed by each subsystem's constructor (ToolRegistry, PermissionEngine,
// MemoryFacade, etc.). This means `tools: [42]` will not produce a TS error
// but will throw at ToolRegistry.register() time.

// ─── From @taor/adapters ───
/** @deprecated Stub — canonical type is in @taor/adapters. Not deeply validated here; runtime check at adapter construction. */
export type AdapterConstructor = new (opts?: Record<string, unknown>) => unknown

// ─── From @taor/tools ───
/** @deprecated Stub — canonical type is `ToolDescriptor | (new (...args) => Tool)` in @taor/tools. Not deeply validated here; runtime check at ToolRegistry.register(). */
export type ToolInput = unknown

// ─── From @taor/permission ───
/** @deprecated Stub — canonical type is `PermissionConfig` in @taor/permission. Step 8 implemented. Runtime duck-typing in config.ts is kept for TG0; remove when core can import from @taor/permission directly. */
export interface PermissionConfig {
  mode?: "interactive" | "non-interactive" | "custom"
  rules?: { level: string; pattern: string; reason?: string }[]
  defaultLevel?: "deny" | "boundary" | "allow" | "ask"
  allowlist?: { level: string; pattern: string; reason?: string }[]
  denylist?: { level: string; pattern: string; reason?: string }[]
  nonInteractiveDefault?: "allow" | "deny"
  approvalTimeout?: number
}
export type PermissionLevel = "deny" | "boundary" | "allow" | "ask"

// ─── From @taor/hooks ───
/** @deprecated Stub — canonical type is `Partial<HookHandlerMap> | HookRegistration[]` in @taor/hooks. */
export type HookInput = unknown

// ─── From @taor/subagent ───
/** @deprecated Stub — canonical type is in @taor/subagent. */
export interface SubagentConfig {
  adapterModulePath?: string
}

// ─── From @taor/memory ───
/** @deprecated Stub — canonical type is in @taor/memory. */
export interface MemoryConfig {}

// ─── From @taor/compressor ───
/** @deprecated Stub — canonical type is in @taor/compressor. */
export interface CompressorConfig {}

// ─── From @taor/mcp ───
/** @deprecated Stub — canonical type is in @taor/mcp. */
export interface MCPServerConfig {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  timeout?: number
}

// ─── From @taor/adapters (circuit breaker) ──
/** @deprecated Stub — canonical type is in @taor/adapters. */
export interface CircuitBreakerConfig {
  failureThreshold?: number
  recoveryTimeout?: number
  halfOpenMaxRequests?: number
  windowDuration?: number
}

// ─── Re-exports (to be resolved) ───
export type { SessionState } from "./context.js"
export type { TurnRecord } from "./types.js"
