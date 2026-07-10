// @taor/telemetry — createOtelHooks (TG4)
//
// OpenTelemetry tracing via the existing Hook system — ZERO changes to TAOR loop.
// Each hook point starts/stops an OTEL span. Users pass in their own Tracer;
// Harness does not prescribe an exporter — standard OTEL env vars control export.

import type { HookInput } from "@taor/hooks"
import type { Tracer, Span } from "@opentelemetry/api"
import { trace, context as otelContext } from "@opentelemetry/api"

/**
 * Create OpenTelemetry hook registrations for every TAOR phase boundary.
 *
 * Span structure:
 * - `Session`      — onSessionStart → onSessionEnd (root)
 * - `THINK`        — beforeThink → afterThink (per turn)
 * - `tool:<name>`  — beforeAct → afterAct (per tool call)
 * - `compress`     — beforeCompress → afterCompress
 * - `error`        — onError (linked to current turn span)
 *
 * @param tracer — user-provided OTEL tracer (e.g. `trace.getTracer("my-agent")`)
 * @returns HookRegistration[] ready for `createHarness({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * import { createOtelHooks } from "@taor/telemetry"
 * import { trace } from "@opentelemetry/api"
 *
 * const harness = createHarness({
 *   model: "claude-sonnet-4-6",
 *   tools: [],
 *   hooks: [...createOtelHooks(trace.getTracer("harness-agent"))],
 * })
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createOtelHooks(tracer: Tracer): HookInput {
  const spans = new Map<string, Span>()

  const registrations = [
    // ═══════════════════════════════════════════════════════════════
    // ─── Session root span ───
    // ═══════════════════════════════════════════════════════════════
    {
      hook: "onSessionStart" as const,
      handler: async (ctx: any) => {
        const span = tracer.startSpan("Session")
        span.setAttribute("sessionId", ctx.session.id)
        span.setAttribute("model", ctx.session.model)
        spans.set("session", span)
      },
    },
    {
      hook: "onSessionEnd" as const,
      handler: async (ctx: any, result: any) => {
        const span = spans.get("session")
        if (span) {
          span.setAttribute("status", result.status)
          span.setAttribute("turns", result.turns)
          span.setAttribute("totalTokens", result.tokenUsage?.total ?? 0)
          span.end()
          spans.delete("session")
        }
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // ─── THINK phase ───
    // ═══════════════════════════════════════════════════════════════
    {
      hook: "beforeThink" as const,
      priority: 1000,
      handler: async (ctx: any) => {
        const span = tracer.startSpan("THINK", {
          attributes: { turnIndex: ctx.turn.index, model: ctx.session.model },
        })
        spans.set(ctx.turn.id, span)
      },
    },
    {
      hook: "afterThink" as const,
      priority: 0,
      handler: async (ctx: any, _events: any) => {
        const span = spans.get(ctx.turn.id)
        if (span) {
          span.setAttribute("turnCount", ctx.session.turnCount)
          span.end()
          spans.delete(ctx.turn.id)
        }
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // ─── ACT phase — per-tool spans ───
    // ═══════════════════════════════════════════════════════════════
    {
      hook: "beforeAct" as const,
      priority: 1000,
      handler: async (ctx: any, call: any) => {
        const span = tracer.startSpan(`tool:${call.name}`)
        span.setAttribute("tool.name", call.name)
        spans.set(call.id, span)
      },
    },
    {
      hook: "afterAct" as const,
      priority: 0,
      handler: async (ctx: any, call: any, result: any) => {
        const span = spans.get(call.id)
        if (span) {
          span.setAttribute("ok", result.ok)
          span.setAttribute("duration", result.meta?.duration ?? 0)
          span.end()
          spans.delete(call.id)
        }
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // ─── Error span ───
    // ═══════════════════════════════════════════════════════════════
    {
      hook: "onError" as const,
      priority: 1000,
      handler: async (ctx: any, error: any) => {
        const turnSpan = spans.get(ctx.turn?.id ?? "")
        const parentCtx = turnSpan
          ? trace.setSpan(otelContext.active(), turnSpan)
          : otelContext.active()
        const span = tracer.startSpan("error", {}, parentCtx)
        span.recordException(error instanceof Error ? error : new Error(error.message ?? String(error)))
        span.end()
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // ─── Compressor span ───
    // ═══════════════════════════════════════════════════════════════
    {
      hook: "beforeCompress" as const,
      priority: 1000,
      handler: async (ctx: any, _level: any) => {
        const span = tracer.startSpan("compress")
        spans.set("compress", span)
      },
    },
    {
      hook: "afterCompress" as const,
      priority: 0,
      handler: async (ctx: any, event: any) => {
        const span = spans.get("compress")
        if (span) {
          span.setAttribute("beforeTokens", event.beforeTokens)
          span.setAttribute("afterTokens", event.afterTokens)
          span.setAttribute("savingsPercent", event.savingsPercent)
          span.end()
          spans.delete("compress")
        }
      },
    },
  ]

  return registrations
}
