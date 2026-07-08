// @taor/tools — ToolRegistry (registration + conflict detection + name validation)

import type { ToolDescriptor, ToolInput } from "./types.js"
import { validateToolName } from "./validation.js"

/**
 * ToolRegistry — validates and indexes tools.
 *
 * ## Input format
 *
 * `register()` accepts `ToolInput[]` — a mixed array of:
 * - `ToolDescriptor` objects (from `defineTool()` / `tool()`)
 * - `ToolConstructor` classes extending `Tool` — **zero-argument constructor only**
 *
 * Tool constructors are instantiated with no arguments via `new input()`.
 * Tools that need constructor parameters must be manually instantiated
 * and their `toDescriptor()` result passed to `register()` instead.
 *
 * ## Validation
 *
 * Tool names are validated against `/^[a-zA-Z0-9_-]{1,64}$/` (compatible
 * with Anthropic/OpenAI API naming rules). Invalid names are rejected at
 * registration time with a clear error message.
 *
 * ## Conflict detection
 *
 * Duplicate tool names are rejected at registration time with a hard error.
 * Tool names are the primary lookup key for LLM tool-calling.
 *
 * ## Transaction semantics
 *
 * `register()` uses a **two-phase commit**:
 * 1. **Validate phase**: normalize all inputs, validate all names,
 *    check for conflicts against both existing tools AND within the batch.
 * 2. **Commit phase**: if all validations pass, atomically insert all tools.
 *
 * If any input fails validation, the registry is **unchanged** — no tools
 * from the batch are registered.
 *
 * > **Future (TG0+):** `onConflict` option for "skip" / "override" modes
 * > in multi-plugin scenarios. See `TG0_DEFERRED.md` §阶段 2.
 *
 * ## Usage
 *
 * ```ts
 * const registry = new ToolRegistry()
 * registry.register([
 *   readFile,           // ToolDescriptor from defineTool()
 *   grep,               // ToolDescriptor from tool()
 *   DatabaseQueryTool,  // Constructor (zero-arg) → instantiated → toDescriptor()
 * ])
 * ```
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDescriptor>()

  /**
   * Register one or more tools with two-phase commit.
   *
   * Phase 1 (validate): normalize all inputs, validate all tool names,
   * and check for conflicts. Nothing is committed.
   *
   * Phase 2 (commit): all validations passed → atomically insert all tools.
   *
   * If any validation fails, the registry is unchanged — no partial
   * registration occurs.
   *
   * @throws {TypeError} if any input is neither a ToolDescriptor object nor
   *   a Tool constructor function.
   * @throws {Error} if any tool name is empty or doesn't match
   *   `/^[a-zA-Z0-9_-]{1,64}$/`.
   * @throws {Error} if any tool name conflicts with an already-registered
   *   tool or with another tool in the same batch.
   *
   * @param inputs - Mixed array of ToolDescriptor objects and Tool constructors.
   *   Constructors are called with `new` (no arguments).
   */
  register(inputs: ToolInput[], opts?: { onConflict?: "throw" | "skip" | "override" }): void {
    // ── Phase 1: Normalize + validate all inputs ──
    const descriptors: ToolDescriptor[] = []

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]

      // Guard: reject non-object, non-function inputs with a clear error
      if (typeof input === "function") {
        const instance = new input()
        descriptors.push(instance.toDescriptor())
      } else if (typeof input === "object" && input !== null) {
        descriptors.push(input as ToolDescriptor)
      } else {
        throw new TypeError(
          `ToolRegistry.register(): expected ToolDescriptor or Tool constructor ` +
            `at index ${i}, got ${typeof input}`,
        )
      }
    }

    // Validate all names first (fast-fail before any mutation)
    for (const d of descriptors) {
      validateToolName(d.name)
    }

    // B4: Check cross-conflicts with onConflict option
    const onConflict = opts?.onConflict ?? "throw"
    for (const d of descriptors) {
      if (this.tools.has(d.name)) {
        if (onConflict === "override") {
          // Remove existing — will be replaced in commit phase
          this.tools.delete(d.name)
        } else if (onConflict === "skip") {
          // Mark for removal from descriptors
          (d as unknown as { _skip?: boolean })._skip = true
        } else {
          throw new Error(
            `Tool name conflict: "${d.name}" is already registered. ` +
              `Each tool must have a unique name. Rename one of the conflicting tools and retry.`,
          )
        }
      }
    }
    // Detect within-batch duplicates
    const seen = new Set<string>()
    for (const d of descriptors) {
      if (seen.has(d.name)) {
        throw new Error(
          `Tool name conflict: "${d.name}" appears multiple times in the same ` +
            `register() call. Each tool must have a unique name.`,
        )
      }
      seen.add(d.name)
    }

    // ── Phase 2: Commit — insert non-skipped tools ──
    for (const d of descriptors) {
      if ((d as unknown as { _skip?: boolean })._skip) continue
      this.tools.set(d.name, d)
    }
  }

  /** Look up a tool by name. Returns undefined if not found. */
  get(name: string): ToolDescriptor | undefined {
    return this.tools.get(name)
  }

  /** List all registered tools in insertion order. */
  list(): ToolDescriptor[] {
    return [...this.tools.values()]
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size
  }

  /** Check if a tool name is registered. */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** Remove a single tool by name. Returns true if the tool was removed. */
  remove(name: string): boolean {
    return this.tools.delete(name)
  }

  /** Remove all registered tools. Useful for testing or reconfiguration. */
  clear(): void {
    this.tools.clear()
  }
}
