// @taor/tools — defineTool() factory + tool() shorthand

import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"
import type {
  JSONSchema,
  ToolDescriptor,
  ToolResult,
  PermissionHint,
  RiskLevel,
  RetryPolicy,
  ApprovalPredicate,
  ToolContext,
} from "./types.js"
import { validateToolName } from "./validation.js"

// ─── Internal: Zod → clean JSONSchema ───

/**
 * Convert a Zod schema to our JSONSchema format.
 *
 * Strips the `$schema` marker that `zod-to-json-schema` emits by default
 * (Draft-07 URI string). This keeps the schema payload clean for LLM
 * API serialization where the `$schema` field is unused and adds noise
 * to serialized request bodies.
 */
function zodToCleanJsonSchema(schema: z.ZodType): JSONSchema {
  const raw = zodToJsonSchema(schema) as Record<string, unknown>
  // zod-to-json-schema default output includes $schema — strip it.
  delete raw.$schema
  return raw as JSONSchema
}

// ═══════════════════════════════════════════════════════════════════
// ─── Overload signatures ───
// ═══════════════════════════════════════════════════════════════════

/**
 * Zod overload — full type inference on params.
 *
 * `parameters` is a **ZodObject** schema (produced by `z.object({...})`).
 * This is validated at compile time: `T extends z.ZodObject<any>` rejects
 * `z.string()`, `z.union()`, and other non-object schemas that would
 * produce invalid LLM tool-calling input_schema.
 *
 * The Zod schema is auto-converted to JSON Schema via `zod-to-json-schema`
 * at registration time. `params` in execute/hooks gets the exact
 * `z.infer<T>` type.
 *
 * **IMPORTANT — Validation boundary**: The `unknown → z.infer<T>` cast
 * in the execute wrapper is NOT validated at runtime. The TAOR loop's
 * ACT phase MUST validate `params` against `parameters` (JSON Schema)
 * before calling `execute()`. This is a hard safety requirement, not
 * an optional optimization.
 *
 * @typeParam T — Must be a `z.ZodObject` (or subclass like `.extend()`/`.merge()`).
 *   Use the JSON Schema overload if you need refinements, transforms, or
 *   non-object Zod types.
 *
 * This is the recommended path for 90% of tools.
 */
export function defineTool<T extends z.ZodObject<any>>(def: {
  name: string
  description: string
  parameters: T
  permissions?: PermissionHint[]
  risk?: RiskLevel
  timeout?: number
  retry?: RetryPolicy
  requiresApproval?: boolean | ApprovalPredicate
  execute: (params: z.infer<T>, ctx: ToolContext) => Promise<ToolResult>
  onBeforeExecute?: (params: z.infer<T>, ctx: ToolContext) => Promise<void>
  onAfterExecute?: (
    params: z.infer<T>,
    result: ToolResult,
    ctx: ToolContext,
  ) => Promise<void>
  onError?: (
    params: z.infer<T>,
    error: Error,
    ctx: ToolContext,
  ) => Promise<ToolResult<never>>
}): ToolDescriptor

/**
 * JSON Schema overload — no Zod dependency.
 *
 * `parameters` is a raw JSONSchema object, passed through as-is.
 * `params` in execute/hooks is `Record<string, unknown>` (untyped).
 *
 * Use this when:
 * - Integrating with external JSON Schema sources
 * - Using Zod refinements/transforms that aren't `ZodObject` subclasses
 * - You don't want a Zod dependency
 */
export function defineTool(def: {
  name: string
  description: string
  parameters: JSONSchema
  permissions?: PermissionHint[]
  risk?: RiskLevel
  timeout?: number
  retry?: RetryPolicy
  requiresApproval?: boolean | ApprovalPredicate
  execute: (
    params: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>
  onBeforeExecute?: (
    params: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<void>
  onAfterExecute?: (
    params: Record<string, unknown>,
    result: ToolResult,
    ctx: ToolContext,
  ) => Promise<void>
  onError?: (
    params: Record<string, unknown>,
    error: Error,
    ctx: ToolContext,
  ) => Promise<ToolResult<never>>
}): ToolDescriptor

// ═══════════════════════════════════════════════════════════════════
// ─── Implementation ───
// ═══════════════════════════════════════════════════════════════════

/**
 * Runtime implementation.
 *
 * Dispatches based on whether `def.parameters` is a Zod schema
 * (`instanceof z.ZodType`) or a plain JSONSchema object.
 *
 * For Zod schemas: converts via `zodToCleanJsonSchema()` → JSONSchema
 *   (strips `$schema` marker for clean LLM API payloads).
 * For JSON Schema: passes through unchanged.
 *
 * All execute/hook functions are wrapped to accept `unknown` params
 * (the ToolDescriptor contract) and delegate to the typed user function.
 */
// Implementation signature: uses `any` for callback params to bridge
// the Zod (`z.infer<T>`) and JSON Schema (`Record<string, unknown>`) overloads.
// Standard TypeScript pattern — overload signatures provide type safety to callers;
// the implementation body is loosely typed and dispatches at runtime.
export function defineTool(def: {
  name: string
  description: string
  parameters: z.ZodType | JSONSchema
  permissions?: PermissionHint[]
  risk?: RiskLevel
  timeout?: number
  retry?: RetryPolicy
  requiresApproval?: boolean | ApprovalPredicate
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (params: any, ctx: ToolContext) => Promise<ToolResult>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onBeforeExecute?: (params: any, ctx: ToolContext) => Promise<void>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onAfterExecute?: (params: any, result: ToolResult, ctx: ToolContext) => Promise<void>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onError?: (
    params: any,
    error: Error,
    ctx: ToolContext,
  ) => Promise<ToolResult<never>>
}): ToolDescriptor {
  // ── Validate tool name (fast-fail before any work) ──
  validateToolName(def.name)

  // ── Convert parameters to JSONSchema ──
  const jsonSchema: JSONSchema =
    def.parameters instanceof z.ZodType
      ? zodToCleanJsonSchema(def.parameters)
      : def.parameters

  const descriptor: ToolDescriptor = {
    name: def.name,
    description: def.description,
    parameters: jsonSchema,
    // SAFETY: The TAOR loop's ACT phase MUST validate `params` against
    // `parameters` (JSON Schema) before calling execute(). The `unknown`
    // cast here is type-checked at the overload signature level for
    // `defineTool()` callers, but NOT validated at runtime in this module.
    execute: (params, ctx) => def.execute(params, ctx),
    permissions: def.permissions,
    risk: def.risk,
    timeout: def.timeout,
    retry: def.retry,
    requiresApproval: def.requiresApproval,
  }

  // Wrap optional lifecycle hooks (present only if defined in the def)
  if (def.onBeforeExecute) {
    descriptor.onBeforeExecute = (params, ctx) =>
      def.onBeforeExecute!(params, ctx)
  }
  if (def.onAfterExecute) {
    descriptor.onAfterExecute = (params, result, ctx) =>
      def.onAfterExecute!(params, result, ctx)
  }
  if (def.onError) {
    descriptor.onError = (params, error, ctx) =>
      def.onError!(params, error, ctx)
  }

  return descriptor
}

// ═══════════════════════════════════════════════════════════════════
// ─── tool() shorthand ───
// ═══════════════════════════════════════════════════════════════════

/**
 * Zod overload — ultra-compact tool definition. 4 positional args.
 *
 * Internally delegates to `defineTool()` with the Zod overload.
 * Same type inference: `z.infer<T>` flows through to execute params.
 *
 * @typeParam T — Must be a `z.ZodObject` (same constraint as `defineTool()`).
 *
 * @example
 * ```ts
 * const grep = tool(
 *   "Grep",
 *   "Search with ripgrep",
 *   z.object({ pattern: z.string(), path: z.string().optional() }),
 *   async ({ pattern, path }, ctx) => {
 *     return { ok: true, data: { pattern } }
 *   },
 *   { risk: "low", permissions: ["fs-read"] }
 * )
 * ```
 */
export function tool<T extends z.ZodObject<any>>(
  name: string,
  description: string,
  parameters: T,
  execute: (params: z.infer<T>, ctx: ToolContext) => Promise<ToolResult>,
  opts?: Pick<
    ToolDescriptor,
    "permissions" | "risk" | "timeout" | "retry" | "requiresApproval"
  >,
): ToolDescriptor

/**
 * JSON Schema overload — same ultra-compact form, no Zod.
 *
 * Use this when your parameters schema comes from an external source
 * or you don't want a Zod dependency.
 *
 * @example
 * ```ts
 * const myTool = tool(
 *   "MyTool",
 *   "Does something",
 *   { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
 *   async (params, ctx) => {
 *     return { ok: true, data: { x: params.x } }
 *   }
 * )
 * ```
 */
export function tool(
  name: string,
  description: string,
  parameters: JSONSchema,
  execute: (
    params: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>,
  opts?: Pick<
    ToolDescriptor,
    "permissions" | "risk" | "timeout" | "retry" | "requiresApproval"
  >,
): ToolDescriptor

// Implementation — delegates to defineTool()
export function tool<T extends z.ZodObject<any>>(
  name: string,
  description: string,
  parameters: T | JSONSchema,
  execute: (params: any, ctx: ToolContext) => Promise<ToolResult>,
  opts?: Pick<
    ToolDescriptor,
    "permissions" | "risk" | "timeout" | "retry" | "requiresApproval"
  >,
): ToolDescriptor {
  return defineTool({
    name,
    description,
    parameters: parameters as any, // overloads guarantee type safety
    execute: execute as any,
    ...opts,
  })
}
