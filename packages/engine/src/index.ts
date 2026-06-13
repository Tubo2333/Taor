// @taor/engine — aggregation package (one-stop import)

import { Harness, validateConfig } from "@taor/core"
import type { HarnessConfig, ResolvedConfig, SerializedSession } from "@taor/core"
import { AnthropicAdapter, CircuitBreakerAdapter } from "@taor/adapters"
import { ToolRegistry } from "@taor/tools"
import type { ToolInput, ToolDescriptor } from "@taor/tools"
import { PermissionEngine } from "@taor/permission"
import type { PermissionConfig } from "@taor/permission"
import { HookRegistry } from "@taor/hooks"
import type { HookInput } from "@taor/hooks"
import { SubagentCoordinator } from "@taor/subagent"
import type { SubagentSpec, SubagentHandle } from "@taor/subagent"
import { MemoryFacade } from "@taor/memory"
import type { MemoryConfig } from "@taor/memory"
import { CompressorPipeline } from "@taor/compressor"
import type { CompressorConfig } from "@taor/compressor"

// Re-export all subsystems
export { Harness, validateConfig } from "@taor/core"
export type { HarnessConfig, ResolvedConfig, SessionResult, SerializedSession, Logger, TelemetryConfig } from "@taor/core"
export type { HarnessEvent, UserDecision } from "@taor/core"
export type { HarnessContext, SessionState, TurnState, SharedCacheState, TurnContext, SessionContext } from "@taor/core"
export type { ToolCall, Observation, HarnessError, TokenUsage, Artifact, Unsubscribe, TurnRecord, CompressLevel } from "@taor/core"

export { defineTool, tool, Tool, ToolRegistry } from "@taor/tools"
export type { ToolDescriptor, ToolResult, ToolContext, JSONSchema, PermissionHint, RiskLevel, RetryPolicy } from "@taor/tools"

export { AnthropicAdapter, OpenaiAdapter, DeepSeekAdapter } from "@taor/adapters"
export type { LLMAdapter, AdapterFeature, ThinkEvent, ParsedToolCall, ModelInfo } from "@taor/adapters"

export { PermissionEngine } from "@taor/permission"
export type { PermissionConfig, PermissionRule, PermissionVerdict, PermissionLevel } from "@taor/permission"

export { HookRegistry } from "@taor/hooks"
export type { HookName, HookHandlerMap, HookRegistration, HookInput, ErrorRecovery } from "@taor/hooks"

export { SubagentCoordinator, SubagentWorker } from "@taor/subagent"
export type { SubagentSpec, SubagentHandle, SubagentResult, SubagentError, SubagentStatus } from "@taor/subagent"

export { MemoryFacade, InMemoryStore, JsonStore, SqliteStore } from "@taor/memory"
export type { MemoryConfig, MemoryStoreConfig, MemoryStore, MemoryEntry } from "@taor/memory"

export { CompressorPipeline } from "@taor/compressor"
export type { CompressorConfig, CompressStrategy, CompressedContext } from "@taor/compressor"

/**
 * createHarness — recommended entry point.
 *
 * Validates config, instantiates adapter + registry, creates Harness.
 * This is the factory function users should call instead of `new Harness()`.
 *
 * ## Dependency inversion contract matrix
 *
 * `@taor/core` uses structural interfaces (IAdapter/IToolRegistry/ToolDef/
 * ToolExecResult/ThinkEvent) to avoid circular project references. The `as any`
 * cast below bridges the structural types to their canonical definitions.
 *
 * If any canonical interface adds a required field or method, the structural
 * counterpart in `harness.ts` MUST be updated simultaneously.
 *
 * ```
 * ┌──────────────────────┬─────────────────────────────────┐
 * │ Harness (structural) │ Real (canonical)                │
 * ├──────────────────────┼─────────────────────────────────┤
 * │ IAdapter             │ LLMAdapter (@taor/adapters)  │
 * │ IToolRegistry        │ ToolRegistry (@taor/tools)   │
 * │ ToolDef              │ ToolDescriptor (@taor/tools) │
 * │ ToolExecResult       │ ToolResult (@taor/tools)     │
 * │ ThinkEvent (local)   │ ThinkEvent (@taor/adapters)  │
 * └──────────────────────┴─────────────────────────────────┘
 * ```
 *
 * **Checklist when changing any canonical interface:**
 * 1. Update the corresponding structural interface in harness.ts
 * 2. Run `npm run typecheck` — the `as any` cast won't catch mismatches
 * 3. Run `npm run build` — engine package must compile
 * 4. Run engine integration smoke test
 */
// TODO(mono-D3): Add integration smoke test — `createHarness({model, tools:[]})` must not throw.
export function createHarness(
  config: HarnessConfig,
  snapshot?: SerializedSession,
): Harness {
  // P0-1 / H5 / GAP-2: Validate required env vars before constructing any adapter.
  // Each adapter declares `static readonly requiredEnvVars: string[]`.
  // createHarness() reads this before construction — no hardcoded adapter names.
  const AdapterCtor = ((config.adapter ?? AnthropicAdapter) as typeof AnthropicAdapter)
  const requiredVars = (AdapterCtor as any).requiredEnvVars as string[] | undefined
  if (requiredVars) {
    const missing: string[] = []
    for (const v of requiredVars) {
      if (!process.env[v]) {
        missing.push(v)
      }
    }
    if (missing.length > 0) {
      throw new Error(
        missing.map(v => `${v} environment variable is required.`).join("\n") +
        "\nGet your API key from your provider and set it:\n" +
        `  export ${missing[0]}=...\n` +
        "Or copy .env.example to .env and fill in the value."
      )
    }
  }

  const resolved = validateConfig(config)

  // Instantiate adapter (default: AnthropicAdapter if none provided).
  // AdapterCtor already resolved above (P0-1 env check).
  let adapter = new AdapterCtor({ model: resolved.model })

  // ── Circuit breaker auto-wrap (GAP-7) ──
  // Auto-wraps the adapter when HarnessConfig.circuitBreaker is set.
  // Set circuitBreaker: false to explicitly opt out.
  if (resolved.circuitBreaker !== false && resolved.circuitBreaker !== undefined) {
    adapter = new CircuitBreakerAdapter(adapter as any, resolved.circuitBreaker) as any as typeof adapter
  }

  // Build tool registry.
  // Cast needed:
  // - resolved.tools is unknown[] (ToolInput stubbed as unknown)
  // - Harness constructor uses structural interfaces (IAdapter/IToolRegistry)
  //   to avoid circular project references. AnthropicAdapter + ToolRegistry
  //   satisfy these interfaces structurally.
  const registry = new ToolRegistry()
  registry.register(resolved.tools as ToolInput[])

  // ── MCP initialization (GAP-6) ──
  // MCP initialization is asynchronous (spawns child processes / SSE connections).
  // createHarness() is synchronous by design. Users configure MCP servers via
  // the two-step pattern:
  //
  //   const harness = createHarness({ model: "...", tools: [...] })
  //   const bridge = new MCPToolBridge({ name: "my-server", command: "npx", args: [...] })
  //   const tools = await bridge.connect()
  //   harness.tools.register(tools)
  //
  // If MCP servers are listed in HarnessConfig.mcp, we throw early with a clear
  // error directing users to the two-step pattern.
  if (resolved.mcp.length > 0) {
    throw new Error(
      `HarnessConfig: MCP servers configured but createHarness() is synchronous.\n` +
        `MCP initialization is asynchronous (it spawns child processes / connects to servers).\n` +
        `Use the two-step initialization pattern:\n\n` +
        `  import { createHarness } from "@taor/engine"\n` +
        `  import { MCPToolBridge } from "@taor/mcp"\n\n` +
        `  const harness = createHarness({ model: "...", tools: [...] })\n` +
        `  const bridge = new MCPToolBridge({ name: "my-server", command: "npx", args: [...] })\n` +
        `  const tools = await bridge.connect()\n` +
        `  harness.tools.register(tools)\n`,
    )
  }

  // If snapshot provided, deserialize session state with adapter + registry
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const harness = snapshot
    ? Harness.deserialize(snapshot as any, resolved, adapter as any, registry as any)
    : new Harness(resolved, adapter as any, registry as any)

  // Build permission engine.
  // ResolvedConfig.permission is Partial<PermissionConfig> where PermissionConfig
  // is stubbed as {} in @taor/core's unresolved.ts. The real type is in
  // @taor/permission. We cast through unknown to bridge the stub/real gap.
  //
  // Tool descriptors are extracted from the registry for @resource annotation
  // lookup within the permission engine. `list()` returns ToolDescriptor[] —
  // the explicit type annotation is self-documenting, not a cast.
  const toolDescriptors: ToolDescriptor[] = registry.list()
  const permEngine = new PermissionEngine(
    resolved.permission as unknown as Partial<PermissionConfig>,
    toolDescriptors,
  )

  // Inject permission engine — cast needed because Harness uses structural
  // IPermissionEngine (to avoid circular deps on @taor/permission).
  // PermissionEngine satisfies IPermissionEngine structurally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  harness.setPermission(permEngine as any)

  // Build hook registry from config.
  // ResolvedConfig.hooks is HookInput[] — the real type lives in @taor/hooks.
  const hookRegistry = new HookRegistry(
    resolved.hooks as unknown as HookInput[],
  )

  // Inject hook registry — cast needed because Harness uses structural
  // IHookRegistry (to avoid circular deps on @taor/hooks).
  // HookRegistry satisfies IHookRegistry structurally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  harness.setHooks(hookRegistry as any)

  // Build subagent coordinator.
  // TG0: inline isolation only. The coordinator holds references to the
  // parent's adapter and tool registry for spawning inline sub-agents.
  // Pass hookRegistry for beforeSpawn/afterSpawnResult hooks (I-4).
  // F-1: Pass adapterModulePath from config for process/worktree isolation
  const subagentModulePath = (resolved.subagent as Record<string, unknown>).adapterModulePath as string | undefined
  const subagentCoordinator = new SubagentCoordinator(
    adapter as any,
    registry as any,
    resolved.logger,
    resolved.model,
    hookRegistry as any,
    subagentModulePath,
  )

  // Inject subagent coordinator — cast needed because Harness uses structural
  // ISubagentCoordinator (to avoid circular deps on @taor/subagent).
  // SubagentCoordinator satisfies ISubagentCoordinator structurally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  harness.setSubagent(subagentCoordinator as any)

  // Build memory facade.
  // ResolvedConfig.memory is Partial<MemoryConfig> (stubbed as {} in core).
  // The real type is in @taor/memory.
  const memoryFacade = new MemoryFacade(
    resolved.memory as unknown as Partial<MemoryConfig>,
  )

  // Inject memory facade — cast needed because Harness uses structural
  // IMemoryFacade (to avoid circular deps on @taor/memory).
  // MemoryFacade satisfies IMemoryFacade structurally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  harness.setMemory(memoryFacade as any)

  // Build compressor pipeline.
  // ResolvedConfig.compressor is Partial<CompressorConfig> (stubbed in core).
  const compressorPipeline = new CompressorPipeline(
    resolved.compressor as unknown as Partial<CompressorConfig>,
  )

  // Inject compressor — cast needed because Harness uses structural
  // ICompressorPipeline (to avoid circular deps on @taor/compressor).
  // CompressorPipeline satisfies ICompressorPipeline structurally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  harness.setCompressor(compressorPipeline as any)

  return harness
}
