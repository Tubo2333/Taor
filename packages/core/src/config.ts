// @harness/core — HarnessConfig type + defaults + validation
//
// NOTE: AdapterConstructor and ToolInput are defined in ./unresolved.js to avoid
// circular deps (@harness/adapters → @harness/core, @harness/tools → @harness/core).
// They will be re-exported from their canonical packages once implementation is complete.

import type {
  AdapterConstructor,
  CircuitBreakerConfig,
  CompressorConfig,
  HookInput,
  MCPServerConfig,
  MemoryConfig,
  PermissionConfig,
  SubagentConfig,
  ToolInput,
} from "./unresolved.js"

// ─── Logger ───

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

// ─── Telemetry ───

export interface TelemetryConfig {
  enabled: boolean
  endpoint?: string
  sampleRate?: number
  attributes?: Record<string, string>
}

// ─── HarnessConfig ───

export interface HarnessConfig {
  // Required
  model: string
  tools: ToolInput[]

  // Session
  session?: {
    id?: string
    workDir?: string
    resumeFrom?: string
    maxTurns?: number
    timeout?: number
    /** Internal event queue capacity. Default 256. */
    eventQueueCapacity?: number
  }

  // LLM Adapter
  adapter?: AdapterConstructor

  // Subsystem overrides
  memory?: Partial<MemoryConfig>
  compressor?: Partial<CompressorConfig>
  permission?: Partial<PermissionConfig>
  subagent?: Partial<SubagentConfig>
  hooks?: HookInput[]

  // Observability
  logger?: Logger
  trace?: boolean
  telemetry?: TelemetryConfig

  // MCP servers (GAP-6)
  mcp?: MCPServerConfig[]

  // Circuit breaker (GAP-7)
  circuitBreaker?: CircuitBreakerConfig | false
}

// ─── ResolvedConfig (HarnessConfig with all defaults filled) ───

/**
 * Fully-resolved configuration produced by `validateConfig()`.
 *
 * All optional fields have been filled with their defaults.
 * The Harness constructor accepts this type — it never reads
 * `HarnessConfig` directly.
 */
export interface ResolvedConfig {
  model: string
  tools: ToolInput[]

  session: {
    id: string
    workDir: string
    resumeFrom: string | undefined
    maxTurns: number
    timeout: number
    eventQueueCapacity: number
  }

  adapter: AdapterConstructor | undefined
  memory: Partial<MemoryConfig>
  compressor: Partial<CompressorConfig>
  permission: Partial<PermissionConfig>
  subagent: Partial<SubagentConfig>
  hooks: HookInput[]

  logger: Logger
  trace: boolean
  telemetry: TelemetryConfig | undefined
  mcp: MCPServerConfig[]
  circuitBreaker: CircuitBreakerConfig | false | undefined
}

// ─── Defaults ───

export const DEFAULTS = {
  session: {
    maxTurns: 100,
    timeout: Infinity,
    eventQueueCapacity: 256,
  },
  permission: {
    defaultLevel: "ask" as const,
    approvalTimeout: 120,
  },
  trace: false,
} as const

/** Console-based logger used when no custom logger is provided. */
const CONSOLE_LOGGER: Logger = {
  debug(message, ...args) { console.debug(`[Harness:debug] ${message}`, ...args) },
  info(message, ...args)  { console.info(`[Harness:info] ${message}`, ...args) },
  warn(message, ...args)  { console.warn(`[Harness:warn] ${message}`, ...args) },
  error(message, ...args) { console.error(`[Harness:error] ${message}`, ...args) },
}

// ─── Validation ───

/** Valid permission levels for the permission engine. */
const VALID_PERMISSION_LEVELS = new Set([
  "deny",
  "boundary",
  "allow",
  "ask",
])

/** Valid permission modes (interactive / non-interactive / custom). */
const VALID_PERMISSION_MODES = new Set([
  "interactive",
  "non-interactive",
  "custom",
])

/**
 * Validate and resolve a HarnessConfig.
 *
 * Performs:
 * 1. Required-field checks (`model` must be non-empty, `tools` must be an array)
 * 2. Range validation (`maxTurns > 0`, `timeout > 0`, `sampleRate` 0–1, etc.)
 * 3. Enum validation (`permission.defaultLevel`)
 * 4. Default filling for all optional fields
 *
 * Returns a fully-resolved `ResolvedConfig` that the `Harness` constructor
 * can use directly without further validation.
 *
 * @throws {Error} if any validation rule is violated.
 */
export function validateConfig(raw: HarnessConfig): ResolvedConfig {
  // ── Required fields ──

  if (!raw.model || typeof raw.model !== "string" || raw.model.trim() === "") {
    throw new Error("HarnessConfig: `model` is required and must be a non-empty string.")
  }

  if (!Array.isArray(raw.tools)) {
    throw new Error("HarnessConfig: `tools` is required and must be an array.")
  }

  // ── Session ──

  const sessionId = raw.session?.id ?? `session-${Date.now()}`
  const workDir = raw.session?.workDir ?? process.cwd()

  const maxTurns = raw.session?.maxTurns ?? DEFAULTS.session.maxTurns
  if (Number.isNaN(maxTurns) || maxTurns < 1) {
    throw new Error(
      `HarnessConfig: session.maxTurns must be >= 1, got ${maxTurns}.`,
    )
  }

  const timeout = raw.session?.timeout ?? DEFAULTS.session.timeout
  if (Number.isNaN(timeout) || (timeout !== Infinity && timeout <= 0)) {
    throw new Error(
      `HarnessConfig: session.timeout must be > 0 or Infinity, got ${timeout}.`,
    )
  }

  const eventQueueCapacity =
    raw.session?.eventQueueCapacity ?? DEFAULTS.session.eventQueueCapacity
  if (Number.isNaN(eventQueueCapacity) || eventQueueCapacity < 1) {
    throw new Error(
      `HarnessConfig: session.eventQueueCapacity must be >= 1, got ${eventQueueCapacity}.`,
    )
  }

  // ── Permission ──
  //
  // PermissionConfig has real fields in unresolved.ts (for TG0 duck-typing
  // — canonical type is in @harness/permission since Step 8).
  // `as Record<string, unknown>` casts removed since Step 8.

  const permission: Partial<PermissionConfig> = {
    ...raw.permission,
  }

  if (raw.permission?.defaultLevel !== undefined) {
    const level = raw.permission.defaultLevel
    if (!VALID_PERMISSION_LEVELS.has(level)) {
      throw new Error(
        `HarnessConfig: permission.defaultLevel must be one of ` +
          `[${[...VALID_PERMISSION_LEVELS].join(", ")}], got "${level}".`,
      )
    }
  }

  if (raw.permission?.mode !== undefined) {
    const mode = raw.permission.mode
    if (!VALID_PERMISSION_MODES.has(mode)) {
      throw new Error(
        `HarnessConfig: permission.mode must be one of ` +
          `[${[...VALID_PERMISSION_MODES].join(", ")}], got "${mode}".`,
      )
    }
  }

  if (raw.permission?.approvalTimeout !== undefined) {
    const t = raw.permission.approvalTimeout
    if (Number.isNaN(t) || t <= 0) {
      throw new Error(
        `HarnessConfig: permission.approvalTimeout must be > 0, got ${t}.`,
      )
    }
  }

  // ── Telemetry ──

  if (raw.telemetry?.sampleRate !== undefined) {
    const rate = raw.telemetry.sampleRate
    if (Number.isNaN(rate) || rate < 0 || rate > 1) {
      throw new Error(
        `HarnessConfig: telemetry.sampleRate must be between 0 and 1, got ${rate}.`,
      )
    }
  }

  // ── Assemble resolved config ──

  return {
    model: raw.model.trim(),
    tools: raw.tools,

    session: {
      id: sessionId,
      workDir,
      resumeFrom: raw.session?.resumeFrom,
      maxTurns,
      timeout,
      eventQueueCapacity,
    },

    adapter: raw.adapter,
    // Subsystem default values are handled by each subsystem's constructor
    // (e.g. MemoryFacade, CompressorPipeline), not here.
    memory: raw.memory ?? {},
    compressor: raw.compressor ?? {},
    permission,
    subagent: raw.subagent ?? {},
    hooks: raw.hooks ?? [],

    logger: raw.logger ?? CONSOLE_LOGGER,
    trace: raw.trace ?? DEFAULTS.trace,
    telemetry: raw.telemetry,
    mcp: raw.mcp ?? [],
    circuitBreaker: raw.circuitBreaker,
  }
}
