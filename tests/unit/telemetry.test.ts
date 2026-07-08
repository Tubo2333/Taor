/**
 * Telemetry — OTEL Hooks Unit Test (GAP-5, Gate 1)
 *
 * Verifies createOtelHooks() produces correct hook registrations for all 5 span types.
 * Uses a mock tracer to record span lifecycle without full OTEL SDK dependency.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { createOtelHooks } from "@taor/telemetry"
import type { Tracer, Span, SpanAttributes } from "@opentelemetry/api"
import { context as otelContext } from "@opentelemetry/api"
import type { HookInput } from "@taor/hooks"

// ═══════════════════════════════════════════════════════════════════
// ─── Mock Tracer — records span lifecycle ───
// ═══════════════════════════════════════════════════════════════════

interface RecordedSpan {
  name: string
  attributes: Map<string, unknown>
  parentContext?: unknown
  ended: boolean
}

class MockSpan implements Span {
  private _ended = false
  private _attributes = new Map<string, unknown>()
  private _events: Array<{ name: string; attributes?: SpanAttributes }> = []

  constructor(
    public name: string,
    _options?: unknown,
    _parentContext?: unknown,
  ) {}

  spanContext() {
    return {
      traceId: "trace-1",
      spanId: `span-${Math.random().toString(36).slice(2, 8)}`,
      traceFlags: 1,
      isRemote: false,
    }
  }

  setAttribute(key: string, value: unknown) {
    this._attributes.set(key, value)
    return this
  }
  setAttributes(attributes: SpanAttributes) {
    for (const [k, v] of Object.entries(attributes)) {
      this._attributes.set(k, v)
    }
    return this
  }
  addEvent(name: string, attributes?: SpanAttributes) {
    this._events.push({ name, attributes })
    return this
  }
  recordException(_exception: unknown) { return this }
  setStatus(_status: unknown) { return this }
  updateName(_name: string) { return this }

  end() {
    this._ended = true
  }

  isRecording() { return !this._ended }

  // Introspection helpers for testing
  get attributes() { return new Map(this._attributes) }
  get ended() { return this._ended }
  get events() { return [...this._events] }
}

class MockTracer implements Tracer {
  spans: MockSpan[] = []

  startSpan(name: string, options?: unknown, context?: unknown): Span {
    const span = new MockSpan(name, options, context)
    // Apply attributes from options (OTEL SDK passes { attributes: {...} })
    const opts = options as { attributes?: Record<string, unknown> } | undefined
    if (opts?.attributes) {
      for (const [k, v] of Object.entries(opts.attributes)) {
        span.setAttribute(k, v)
      }
    }
    this.spans.push(span)
    return span
  }

  startActiveSpan<F extends (span: Span) => unknown>(_name: string, _fn: F): ReturnType<F> {
    throw new Error("startActiveSpan not used in tests")
  }
}

// ═══════════════════════════════════════════════════════════════════
// ─── Tests ───
// ═══════════════════════════════════════════════════════════════════

describe("GAP-5 / Gate 1: OTEL Hooks", () => {
  let tracer: MockTracer
  let hooks: HookInput[]

  beforeEach(() => {
    tracer = new MockTracer()
    hooks = createOtelHooks(tracer as unknown as Tracer)
  })

  // ── Test 1: Structure ──

  it("should return 9 hook registrations (4 span pairs + 1 error)", () => {
    expect(hooks).toHaveLength(9)
  })

  it("should have all required hook names", () => {
    const hookNames = new Set(hooks.map((h: any) => h.hook))
    expect(hookNames.has("onSessionStart")).toBe(true)
    expect(hookNames.has("onSessionEnd")).toBe(true)
    expect(hookNames.has("beforeThink")).toBe(true)
    expect(hookNames.has("afterThink")).toBe(true)
    expect(hookNames.has("beforeAct")).toBe(true)
    expect(hookNames.has("afterAct")).toBe(true)
    expect(hookNames.has("onError")).toBe(true)
    expect(hookNames.has("beforeCompress")).toBe(true)
    expect(hookNames.has("afterCompress")).toBe(true)
  })

  it("every hook registration should have a handler function", () => {
    for (const h of hooks) {
      const handler = (h as any).handler ?? (h as any).handlers?.[0]?.handler
      expect(handler).toBeInstanceOf(Function)
    }
  })

  // ── Test 2: Session span lifecycle ──

  it("should create and end a Session span", async () => {
    const onStart = hooks.find((h: any) => h.hook === "onSessionStart") as any
    const onEnd = hooks.find((h: any) => h.hook === "onSessionEnd") as any

    // Simulate session start
    const sessionCtx = { session: { id: "s-1", model: "test-model" } }
    await onStart.handler(sessionCtx)

    expect(tracer.spans.length).toBe(1)
    const sessionSpan = tracer.spans[0]!
    expect(sessionSpan.name).toBe("Session")
    expect(sessionSpan.attributes.get("sessionId")).toBe("s-1")
    expect(sessionSpan.attributes.get("model")).toBe("test-model")
    expect(sessionSpan.ended).toBe(false)

    // Simulate session end
    const resultCtx = {
      session: sessionCtx.session,
      status: "completed",
      turns: 3,
      tokenUsage: { total: 150 },
    }
    await onEnd.handler(sessionCtx, resultCtx)

    expect(sessionSpan.ended).toBe(true)
    expect(sessionSpan.attributes.get("status")).toBe("completed")
    expect(sessionSpan.attributes.get("turns")).toBe(3)
    expect(sessionSpan.attributes.get("totalTokens")).toBe(150)
  })

  // ── Test 3: THINK span lifecycle ──

  it("should create and end a THINK span per turn", async () => {
    const beforeThink = hooks.find((h: any) => h.hook === "beforeThink") as any
    const afterThink = hooks.find((h: any) => h.hook === "afterThink") as any

    const turnCtx = {
      turn: { id: "turn-1", index: 0 },
      session: { model: "test", turnCount: 1 },
    }

    await beforeThink.handler(turnCtx)
    expect(tracer.spans.length).toBe(1)
    expect(tracer.spans[0]!.name).toBe("THINK")
    expect(tracer.spans[0]!.attributes.get("turnIndex")).toBe(0)
    expect(tracer.spans[0]!.attributes.get("model")).toBe("test")
    expect(tracer.spans[0]!.ended).toBe(false)

    await afterThink.handler(turnCtx, [{ type: "text", content: "hello" }])
    expect(tracer.spans[0]!.ended).toBe(true)
  })

  // ── Test 4: Tool span lifecycle ──

  it("should create and end a tool:<name> span per tool call", async () => {
    const beforeAct = hooks.find((h: any) => h.hook === "beforeAct") as any
    const afterAct = hooks.find((h: any) => h.hook === "afterAct") as any

    // beforeAct handler receives (ctx, call) — call is the second arg
    const call = { id: "call-1", name: "read_file" }
    await beforeAct.handler({}, call)
    expect(tracer.spans.length).toBe(1)
    expect(tracer.spans[0]!.name).toBe("tool:read_file")
    expect(tracer.spans[0]!.attributes.get("tool.name")).toBe("read_file")
    expect(tracer.spans[0]!.ended).toBe(false)

    // afterAct handler receives (ctx, call, result) — call and result are 2nd/3rd args
    const result = { ok: true, meta: { duration: 42 } }
    await afterAct.handler({}, call, result)
    expect(tracer.spans[0]!.ended).toBe(true)
    expect(tracer.spans[0]!.attributes.get("ok")).toBe(true)
    expect(tracer.spans[0]!.attributes.get("duration")).toBe(42)
  })

  // ── Test 5: Error span ──

  it("should create an error span with exception", async () => {
    // First create a turn span so error can link to it
    const beforeThink = hooks.find((h: any) => h.hook === "beforeThink") as any
    const onError = hooks.find((h: any) => h.hook === "onError") as any

    const turnCtx = {
      turn: { id: "turn-err", index: 0 },
      session: { model: "test", turnCount: 1 },
    }
    await beforeThink.handler(turnCtx)

    // Now trigger error
    const errCtx = { turn: { id: "turn-err" } }
    const error = new Error("Something went wrong")
    await onError.handler(errCtx, error)

    // Second span should be the error span
    const errorSpan = tracer.spans.find((s) => s.name === "error")
    expect(errorSpan).toBeDefined()
    expect(errorSpan!.ended).toBe(true)
  })

  // ── Test 6: Compressor span lifecycle ──

  it("should create and end a compress span", async () => {
    const beforeCompress = hooks.find((h: any) => h.hook === "beforeCompress") as any
    const afterCompress = hooks.find((h: any) => h.hook === "afterCompress") as any

    await beforeCompress.handler({}, "moderate")
    expect(tracer.spans.length).toBe(1)
    expect(tracer.spans[0]!.name).toBe("compress")
    expect(tracer.spans[0]!.ended).toBe(false)

    await afterCompress.handler({}, {
      beforeTokens: 5000,
      afterTokens: 3000,
      savingsPercent: 40,
    })
    expect(tracer.spans[0]!.ended).toBe(true)
    expect(tracer.spans[0]!.attributes.get("beforeTokens")).toBe(5000)
    expect(tracer.spans[0]!.attributes.get("afterTokens")).toBe(3000)
    expect(tracer.spans[0]!.attributes.get("savingsPercent")).toBe(40)
  })

  // ── Test 7: Full session simulation ──

  it("should handle a full 2-turn session lifecycle", async () => {
    const onStart = hooks.find((h: any) => h.hook === "onSessionStart") as any
    const onEnd = hooks.find((h: any) => h.hook === "onSessionEnd") as any
    const beforeThink = hooks.find((h: any) => h.hook === "beforeThink") as any
    const afterThink = hooks.find((h: any) => h.hook === "afterThink") as any
    const beforeAct = hooks.find((h: any) => h.hook === "beforeAct") as any
    const afterAct = hooks.find((h: any) => h.hook === "afterAct") as any

    // Session start
    await onStart.handler({ session: { id: "full-1", model: "test" } })

    // Turn 1: think + tool call
    await beforeThink.handler({ turn: { id: "t1", index: 0 }, session: { model: "test", turnCount: 1 } })
    // beforeAct handler receives (ctx, call) — call is direct, not nested
    await beforeAct.handler({}, { id: "c1", name: "grep" })
    await afterAct.handler({}, { id: "c1", name: "grep" }, { ok: true, meta: { duration: 10 } })
    await afterThink.handler({ turn: { id: "t1", index: 0 }, session: { model: "test", turnCount: 2 } }, [])

    // Turn 2: think only
    await beforeThink.handler({ turn: { id: "t2", index: 1 }, session: { model: "test", turnCount: 2 } })
    await afterThink.handler({ turn: { id: "t2", index: 1 }, session: { model: "test", turnCount: 3 } }, [])

    // Session end
    await onEnd.handler(
      { session: { id: "full-1", model: "test" } },
      { status: "completed", turns: 2, tokenUsage: { total: 300 } },
    )

    // Verify span counts
    const names = tracer.spans.map((s) => s.name)
    expect(names).toContain("Session")
    expect(names.filter((n) => n === "THINK").length).toBe(2)
    expect(names.filter((n) => n === "tool:grep").length).toBe(1)

    // All spans should be ended
    for (const span of tracer.spans) {
      expect(span.ended, `Span "${span.name}" should be ended`).toBe(true)
    }
  })

  // ── Test 8: Returns valid HookInput[] ──

  it("should return valid HookInput array compatible with createHarness", () => {
    // Every hook registration must have: hook name + handler
    for (const h of hooks) {
      const hook = h as any
      expect(hook).toBeDefined()
      // HookInput can be a single registration or an array
      const items = Array.isArray(hook) ? hook : [hook]
      for (const item of items) {
        expect(item.hook).toBeTruthy()
        const handler = item.handler ?? item.handlers?.[0]?.handler
        expect(handler).toBeInstanceOf(Function)
      }
    }
  })
})
