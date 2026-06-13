// @harness/core — unresolved type placeholders
//
// These types belong to other @harness/* packages. They are stubbed here to
// avoid circular dependencies (@harness/adapters and @harness/tools depend on
// @harness/core, but HarnessConfig in core needs to reference their types).
//
// **Design tradeoff (accepted)**: HarnessConfig does NOT perform deep type
// validation on subsystem configs at the TypeScript level. Runtime validation
// is performed by each subsystem's constructor (ToolRegistry, PermissionEngine,
// MemoryFacade, etc.). This means `tools: [42]` will not produce a TS error
// but will throw at ToolRegistry.register() time.

// ─── From @harness/adapters ───
/** @deprecated Stub — canonical type is in @harness/adapters. Not deeply validated here; runtime check at adapter construction. */
export type AdapterConstructor = new (opts?: Record<string, unknown>) => unknown

// ─── From @harness/tools ───
/** @deprecated Stub — canonical type is `ToolDescriptor | (new (...args) => Tool)` in @harness/tools. Not deeply validated here; runtime check at ToolRegistry.register(). */
export type ToolInput = unknown

// ─── From @harness/permission ───
/** @deprecated Stub — canonical type is `PermissionConfig` in @harness/permission. Step 8 implemented. Runtime duck-typing in config.ts is kept for TG0; remove when core can import from @harness/permission directly. */
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

// ─── From @harness/hooks ───
/** @deprecated Stub — canonical type is `Partial<HookHandlerMap> | HookRegistration[]` in @harness/hooks. */
export type HookInput = unknown

// ─── From @harness/subagent ───
/** @deprecated Stub — canonical type is in @harness/subagent. */
export interface SubagentConfig {
  adapterModulePath?: string
}

// ─── From @harness/memory ───
/** @deprecated Stub — canonical type is in @harness/memory. */
export interface MemoryConfig {}

// ─── From @harness/compressor ───
/** @deprecated Stub — canonical type is in @harness/compressor. */
export interface CompressorConfig {}

// ─── From @harness/mcp ───
/** @deprecated Stub — canonical type is in @harness/mcp. */
export interface MCPServerConfig {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  timeout?: number
}

// ─── From @harness/adapters (circuit breaker) ──
/** @deprecated Stub — canonical type is in @harness/adapters. */
export interface CircuitBreakerConfig {
  failureThreshold?: number
  recoveryTimeout?: number
  halfOpenMaxRequests?: number
  windowDuration?: number
}

// ─── Re-exports (to be resolved) ───
export type { SessionState } from "./context.js"
export type { TurnRecord } from "./types.js"
