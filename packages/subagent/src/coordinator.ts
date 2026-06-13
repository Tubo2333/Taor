// @harness/subagent — SubagentCoordinator (spawn + lifecycle)

import type { Logger } from "@harness/core"
import type { ToolDescriptor, ToolInput } from "@harness/tools"
import type { SubagentSpec, SubagentHandle } from "./types.js"
import { SubagentHandleImpl } from "./handle.js"
import { SubagentWorker } from "./worker.js"
import { ProcessWorker } from "./process-worker.js"

// ═══════════════════════════════════════════════════════════════════
// ─── Structural interfaces — avoids importing @harness/adapters ───
// ═══════════════════════════════════════════════════════════════════

interface CoordinatorAdapter {
  readonly provider: string
  buildRequest(
    messages: unknown[],
    systemPrompt: string,
    model: string,
    tools?: CoordinatorTool[],
  ): Promise<unknown>
  think(
    request: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<
    {
      type: string
      content?: string
      call?: { id: string; name: string; arguments: Record<string, unknown> }
      reason?: string
      usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total?: number }
    },
    void,
    void
  >
}

interface CoordinatorTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(params: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }>
}

// ═══════════════════════════════════════════════════════════════════
// ─── Defaults ───
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_MODEL = "default"

// ═══════════════════════════════════════════════════════════════════
// ─── SubagentCoordinator ───
// ═══════════════════════════════════════════════════════════════════

export class SubagentCoordinator {
  private adapter: CoordinatorAdapter
  private registry: {
    list(): CoordinatorTool[]
    get(name: string): CoordinatorTool | undefined
  }
  private logger: Logger
  private model: string
  private hookRegistry?: { execute(hook: string, ...args: unknown[]): Promise<unknown[]> }
  private adapterModulePath?: string

  constructor(
    adapter: CoordinatorAdapter,
    registry: { list(): CoordinatorTool[]; get(name: string): CoordinatorTool | undefined },
    logger: Logger,
    model: string,
    hookRegistry?: { execute(hook: string, ...args: unknown[]): Promise<unknown[]> },
    adapterModulePath?: string,
  ) {
    this.adapter = adapter
    this.registry = registry
    this.logger = logger
    this.model = model
    this.hookRegistry = hookRegistry
    this.adapterModulePath = adapterModulePath
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Spawn ──
  // ═══════════════════════════════════════════════════════════════

  async spawn(spec: SubagentSpec): Promise<SubagentHandle> {
    const isolation = spec.isolation ?? "inline"

    // I-9: await beforeSpawn hook — handlers can modify the spec
    if (this.hookRegistry) {
      const spawnResults = await this.hookRegistry.execute("beforeSpawn", spec)
      for (const r of spawnResults) {
        if (r && typeof r === "object" && "description" in (r as Record<string, unknown>)) {
          spec = { ...spec, ...(r as Partial<SubagentSpec>) }
        }
      }
    }

    // ── Create handle ──
    const id = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const handle = new SubagentHandleImpl(id, spec.description)

    // ── Resolve tools ──
    let tools = this.registry.list()
    if (spec.tools && spec.tools.length > 0) {
      const specNames = new Set<string>()
      for (const t of spec.tools) {
        if (typeof t === "object" && t !== null && "name" in t) {
          specNames.add(t.name)
        } else if (typeof t === "function") {
          try {
            const instance = new (t as new () => { toDescriptor(): { name: string } })()
            specNames.add(instance.toDescriptor().name)
          } catch {
            this.logger.warn(
              `[SubagentCoordinator] Failed to instantiate tool class for subagent "${id}"`,
            )
          }
        }
      }
      tools = tools.filter((t) => specNames.has(t.name))
    }

    // ── Transition to starting ──
    handle._transition("starting")

    // A5: Start heartbeat watch (30s timeout for zombie detection)
    handle.startHeartbeatWatch(30_000)

    // ── Branch on isolation type ──
    if (isolation === "process") {
      await this.runProcessWorker(handle, spec, tools, id)
    } else {
      // inline (and worktree — TG1 stub: same as process)
      await this.runInlineWorker(handle, spec, tools, id)
    }

    return handle
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Inline worker ──
  // ═══════════════════════════════════════════════════════════════

  private async runInlineWorker(
    handle: SubagentHandleImpl,
    spec: SubagentSpec,
    tools: CoordinatorTool[],
    id: string,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const worker = new SubagentWorker(
      handle,
      { ...spec, model: spec.model ?? this.model },
      this.adapter as any,
      tools as any,
      this.logger,
    )

    worker
      .run()
      .then(async (result) => {
        handle._onDone(result)
        if (this.hookRegistry) {
          await this.hookRegistry.execute("afterSpawnResult", handle, result)
        }
      })
      .catch(async (err) => {
        handle._onError({
          code: "execution_error",
          message: err instanceof Error ? err.message : String(err),
          subagentId: id,
        })
        if (this.hookRegistry) {
          await this.hookRegistry.execute("onError", {
            session: { id: `subagent-${id}`, workDir: "", model: "", startedAt: Date.now(), status: "error" as const, tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, turnCount: 0 },
            shared: { projectRoot: "", projectConfig: null, loadedResources: new Map() },
          }, {
            code: "execution_error",
            message: err instanceof Error ? err.message : String(err),
            source: "subagent" as const,
            recoverable: false,
            cause: err,
            timestamp: Date.now(),
          })
        }
      })

    // Set up abort forwarding
    const origAbort = handle.abort.bind(handle)
    handle.abort = (reason?: string) => {
      worker.abort()
      origAbort(reason)
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Process worker ──
  // ═══════════════════════════════════════════════════════════════

  private async runProcessWorker(
    handle: SubagentHandleImpl,
    spec: SubagentSpec,
    // _tools not used here — tools are loaded via module path in the child process
    _tools: CoordinatorTool[],
    id: string,
  ): Promise<void> {
    if (!this.adapterModulePath) {
      handle._onError({
        code: "startup_failed",
        message: "Process isolation requires adapterModulePath in SubagentCoordinator constructor",
        subagentId: id,
      })
      return
    }

    const procWorker = new ProcessWorker(handle)

    // Extract tool module paths from spec.tools for process isolation.
    // Class-based tools must set __modulePath metadata.
    const toolModulePaths: string[] = []
    if (spec.tools) {
      for (const t of spec.tools) {
        const path = (t as any).__modulePath as string | undefined
        if (path) {
          toolModulePaths.push(path)
        } else {
          this.logger.warn(
            `[SubagentCoordinator] Tool "${(t as any).name ?? 'unknown'}" has no __modulePath — ` +
            `cannot use in process isolation. Set static __modulePath = import.meta.url on the tool class.`
          )
        }
      }
    }

    procWorker
      .run(spec, this.adapterModulePath, toolModulePaths)
      .then(async (result) => {
        handle._onDone(result)
        if (this.hookRegistry) {
          await this.hookRegistry.execute("afterSpawnResult", handle, result)
        }
      })
      .catch(async (err) => {
        // Error already reported via handle._onError in ProcessWorker
        if (this.hookRegistry) {
          await this.hookRegistry.execute("onError", {
            session: { id: `subagent-${id}`, workDir: "", model: "", startedAt: Date.now(), status: "error" as const, tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, turnCount: 0 },
            shared: { projectRoot: "", projectConfig: null, loadedResources: new Map() },
          }, {
            code: "execution_error",
            message: err instanceof Error ? err.message : String(err),
            source: "subagent" as const,
            recoverable: false,
            cause: err,
            timestamp: Date.now(),
          })
        }
      })

    // Set up abort forwarding
    const origAbort = handle.abort.bind(handle)
    handle.abort = (reason?: string) => {
      procWorker.abort()
      origAbort(reason)
    }
  }
}
