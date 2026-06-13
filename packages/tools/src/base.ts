// @harness/tools — Tool abstract base class

import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"
import type {
  JSONSchema,
  ToolDescriptor,
  ToolResult,
  ToolContext,
  PermissionHint,
  RiskLevel,
  RetryPolicy,
  ApprovalPredicate,
} from "./types.js"
import { validateToolName } from "./validation.js"

/**
 * Tool abstract class — for complex tools with state, hooks, or lifecycle.
 *
 * Three ways to define a tool (all normalize to ToolDescriptor):
 * 1. `defineTool({...})` — factory, 90% of use cases
 * 2. `tool(name, desc, schema, fn)` — ultra-compact shorthand
 * 3. `class extends Tool` — full OOP, for ecosystem plugins
 *
 * ## Lifecycle hooks (called in this order)
 *
 * ```
 * onBeforeExecute(params, ctx)
 *   → execute(params, ctx)
 *     → onAfterExecute(params, result, ctx)   [on success]
 *     → onError(params, error, ctx)            [on error]
 * ```
 *
 * ## Validation boundary
 *
 * Same as `defineTool()`: `toDescriptor()` wraps `execute` and hooks
 * to accept `unknown` params (the `ToolDescriptor` contract). The cast
 * from `unknown → z.infer<TParams>` is NOT validated at runtime here —
 * the TAOR loop's ACT phase is responsible for JSON Schema validation
 * before calling `execute()`.
 *
 * @typeParam TParams - Must be a `z.ZodObject` (same constraint as `defineTool()`).
 *   This ensures `toDescriptor()` always produces a `type: "object"` JSON Schema,
 *   which is required by Anthropic/OpenAI tool-calling APIs.
 * @typeParam TResult - Return type of execute()'s data field
 */
export abstract class Tool<
  TParams extends z.ZodObject<any> = z.ZodObject<any>,
  TResult = unknown,
> {
  abstract name: string
  abstract description: string
  abstract parameters: TParams

  permissions?: PermissionHint[]
  risk?: RiskLevel = "medium"
  timeout?: number
  retry?: RetryPolicy
  requiresApproval?: boolean | ApprovalPredicate

  /** Core tool logic. Subclasses must implement. */
  abstract execute(
    params: z.infer<TParams>,
    ctx: ToolContext,
  ): Promise<ToolResult<TResult>>

  /** Called before execute. Override to add setup logic (e.g., ensure DB connection). */
  onBeforeExecute?(
    _params: z.infer<TParams>,
    _ctx: ToolContext,
  ): Promise<void> {
    return Promise.resolve()
  }

  /** Called after a successful execute. Override for cleanup or audit logging. */
  onAfterExecute?(
    _params: z.infer<TParams>,
    _result: ToolResult<TResult>,
    _ctx: ToolContext,
  ): Promise<void> {
    return Promise.resolve()
  }

  /** Called when execute throws. Override to transform errors into ToolResult. */
  onError?(
    _params: z.infer<TParams>,
    _error: Error,
    _ctx: ToolContext,
  ): Promise<ToolResult<never>> {
    return Promise.resolve({
      ok: false,
      error: "Unknown error",
      code: "unknown",
      recoverable: false,
    })
  }

  /**
   * Serialize to ToolDescriptor for the ToolRegistry.
   *
   * Converts the Zod `parameters` schema to JSON Schema via zod-to-json-schema
   * (stripping the `$schema` marker for clean LLM API payloads), then wraps
   * all methods to accept `unknown` params (the ToolDescriptor contract).
   *
   * ## Hook serialization
   *
   * Only hooks that the subclass has **overridden** are included in the
   * descriptor. We detect overrides by comparing the instance method
   * reference against `Tool.prototype` — if they differ, the subclass
   * provided a custom implementation.
   *
   * The default no-op hooks on `Tool.prototype` have runtime bodies
   * (they return `Promise.resolve()`), so `Tool.prototype.onBeforeExecute`
   * is always a function at runtime. The `?` in the declaration affects
   * only the TypeScript type (`| undefined`) — it does not affect the
   * prototype's runtime existence.
   */
  toDescriptor(): ToolDescriptor {
    // Fast-fail: validate name before any conversion work (aligns with
    // defineTool() behavior — all three tool definition paths now validate
    // names at their entry point).
    validateToolName(this.name)

    const raw = zodToJsonSchema(this.parameters) as Record<string, unknown>
    delete raw.$schema
    const jsonSchema = raw as JSONSchema

    const descriptor: ToolDescriptor = {
      name: this.name,
      description: this.description,
      parameters: jsonSchema,
      // SAFETY: TAOR loop must validate params before calling execute().
      execute: (params: unknown, ctx: ToolContext) =>
        this.execute(params as z.infer<TParams>, ctx),
      permissions: this.permissions,
      risk: this.risk,
      timeout: this.timeout,
      retry: this.retry,
      requiresApproval: this.requiresApproval,
    }

    // ── Hook serialization ──
    //
    // We capture the instance hook into a local variable first.
    // The `hook && hook !== Tool.prototype.XXX` double-check pattern:
    // 1. `hook &&` — narrows away `undefined` (TypeScript sees `?` as `| undefined`)
    // 2. `!== Tool.prototype.XXX` — detects subclass override
    //
    // After the guard, `hook` is known non-undefined, so we can call it
    // without `!` assertion. The `as z.infer<TParams>` cast bridges the
    // `unknown → TParams` gap (same validation-boundary contract as `defineTool()`).

    // onBeforeExecute
    const beforeHook = this.onBeforeExecute
    if (beforeHook && beforeHook !== Tool.prototype.onBeforeExecute) {
      descriptor.onBeforeExecute = (params: unknown, ctx: ToolContext) =>
        beforeHook(params as z.infer<TParams>, ctx)
    }

    // onAfterExecute
    const afterHook = this.onAfterExecute
    if (afterHook && afterHook !== Tool.prototype.onAfterExecute) {
      descriptor.onAfterExecute = (
        params: unknown,
        result: ToolResult,
        ctx: ToolContext,
      ) =>
        afterHook(
          params as z.infer<TParams>,
          result as ToolResult<TResult>,
          ctx,
        )
    }

    // onError
    const errorHook = this.onError
    if (errorHook && errorHook !== Tool.prototype.onError) {
      descriptor.onError = (
        params: unknown,
        error: Error,
        ctx: ToolContext,
      ) => errorHook(params as z.infer<TParams>, error, ctx)
    }

    return descriptor
  }
}
