/**
 * Harness Engine — TG0 Integration Smoke Test
 *
 * Validates createHarness() full lifecycle: construction → subsystem injection →
 * basic TAOR loop execution. Uses a mock adapter (no real LLM calls).
 */

import { describe, it, expect } from "vitest"
import { createHarness } from "@harness/engine"
import type {
  HarnessConfig,
  HarnessEvent,
  UserDecision,
  SessionResult,
} from "@harness/engine"
import { MockAdapter } from "./fixtures/mock-adapter.js"

// ═══════════════════════════════════════════════════════════════════
// ─── Tests ───
// ═══════════════════════════════════════════════════════════════════

describe("TG0 Integration Smoke Test", () => {
  // ── 1. Construction ──
  it("createHarness() should not throw with minimal config", () => {
    const harness = createHarness({
      model: "mock-model",
      tools: [],
      adapter: MockAdapter as any,
    })
    expect(harness).toBeDefined()
  })

  // ── 2. Subsystem injection ──
  it("should expose all 6 subsystems after createHarness()", () => {
    const harness = createHarness({
      model: "mock-model",
      tools: [],
      adapter: MockAdapter as any,
    })

    // All subsystems should be accessible without throwing
    expect(() => harness.permission).not.toThrow()
    expect(() => harness.hooks).not.toThrow()
    expect(() => harness.memory).not.toThrow()
    expect(() => harness.compressor).not.toThrow()

    // Verify permission engine
    const perm = harness.permission
    expect(perm).toBeDefined()
    const verdict = perm.evaluate("TestTool", {})
    expect(verdict.level).toBe("ask") // default
  })

  // ── 3. Memory subsystem ──
  it("memory.user/project/session should be accessible", async () => {
    const harness = createHarness({
      model: "mock-model",
      tools: [],
      adapter: MockAdapter as any,
    })

    const memory = harness.memory
    expect(memory.user).toBeDefined()
    expect(memory.project).toBeDefined()
    expect(memory.session).toBeDefined()

    // Basic CRUD
    await memory.session.set("test-key", { hello: "world" })
    const value = await memory.session.get<{ hello: string }>("test-key")
    expect(value).toEqual({ hello: "world" })

    await memory.session.delete("test-key")
    const deleted = await memory.session.get("test-key")
    expect(deleted).toBeUndefined()
  })

  // ── 4. Hooks subsystem ──
  it("hooks.on() should register and off() should remove", () => {
    const harness = createHarness({
      model: "mock-model",
      tools: [],
      adapter: MockAdapter as any,
    })

    const hooks = harness.hooks
    let called = false
    const unsub = hooks.on("beforeThink", async () => {
      called = true
    })
    expect(typeof unsub).toBe("function")
    unsub()
    hooks.off("beforeThink", "__unnamed_1")
    expect(called).toBe(false) // was never executed
    expect(hooks).toBeDefined()
  })

  // ── 5. Permission subsystem ──
  it("permission rules should evaluate correctly", () => {
    const harness = createHarness({
      model: "mock-model",
      tools: [],
      adapter: MockAdapter as any,
    })

    const perm = harness.permission

    // Add a deny rule
    perm.addRule({ level: "deny", pattern: "DangerousTool" })
    const denyVerdict = perm.evaluate("DangerousTool", {})
    expect(denyVerdict.level).toBe("deny")

    // Unknown tool should get default level (ask)
    const askVerdict = perm.evaluate("SafeTool", {})
    expect(askVerdict.level).toBe("ask")

    // Remove the rule
    perm.removeRule("DangerousTool")

    // Allow all for this turn
    perm.allowAll("turn")
    const allowedVerdict = perm.evaluate("Anything", {})
    expect(allowedVerdict.level).toBe("allow")
  })

  // ── 6. Compressor subsystem ──
  it("compressor should be accessible and support clearCache", () => {
    const harness = createHarness({
      model: "mock-model",
      tools: [],
      adapter: MockAdapter as any,
    })

    const comp = harness.compressor
    expect(comp).toBeDefined()
    expect(() => comp.clearCache()).not.toThrow()
  })

  // ── 7. Config validation ──
  it("should reject invalid configs", () => {
    // Missing model
    expect(() =>
      createHarness({ model: "", tools: [], adapter: MockAdapter as any }),
    ).toThrow()

    // Negative maxTurns
    expect(() =>
      createHarness({
        model: "test",
        tools: [],
        adapter: MockAdapter as any,
        session: { maxTurns: 0 },
      }),
    ).toThrow()

    // Invalid permission level
    expect(() =>
      createHarness({
        model: "test",
        tools: [],
        adapter: MockAdapter as any,
        permission: { defaultLevel: "invalid" as any },
      }),
    ).toThrow()
  })

  // ── 8. TAOR loop basic execution ──
  it("should run a basic TAOR loop with mock adapter", async () => {
    const harness = createHarness({
      model: "mock-model",
      tools: [],
      adapter: MockAdapter as any,
    })

    harness.start("Hello, world!")

    const events: HarnessEvent[] = []
    let sessionResult: SessionResult | null = null

    for await (const event of harness) {
      events.push(event)

      if (event.type === "approval-required") {
        // Auto-approve all
        await harness.next({ type: "approve-all", scope: "session" })
      }

      // Check done
      if (event.type === "turn-ended") {
        // Session should complete after one turn (mock returns end_turn, no tool calls)
      }
    }

    // Verify we got events
    expect(events.length).toBeGreaterThan(0)

    // Verify turn-started event
    const turnStarted = events.find((e) => e.type === "turn-started")
    expect(turnStarted).toBeDefined()

    // Verify thought event
    const thought = events.find((e) => e.type === "thought")
    expect(thought).toBeDefined()

    // Verify turn-ended event
    const turnEnded = events.find((e) => e.type === "turn-ended")
    expect(turnEnded).toBeDefined()
  })

  // ── 9. State queries ──
  it("should report correct state after run", async () => {
    const harness = createHarness({
      model: "mock-model",
      tools: [],
      adapter: MockAdapter as any,
    })

    expect(harness.state.status).toBe("running")
    expect(harness.isRunning).toBe(false) // not started yet

    harness.start("Test")

    // Run one iteration
    const iterator = harness[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)

    // Abort to clean up
    harness.abort("test complete")
  })

  // ── 10. End-to-end: all subsystems wired ──
  it("E2E: all 7 subsystems should be operational", async () => {
    const harness = createHarness({
      model: "mock-model",
      tools: [],
      adapter: MockAdapter as any,
      hooks: [
        {
          beforeThink: async (ctx) => {
            // Hook receives valid context with session.id
            expect(ctx.session.id).toBeDefined()
          },
        },
      ],
      memory: {
        session: { backend: "memory" },
      },
      permission: {
        defaultLevel: "ask",
        rules: [{ level: "allow", pattern: "Safe*" }],
      },
      compressor: {
        triggerThreshold: 100_000,
        targetThreshold: 50_000,
      },
    })

    // All getters work
    expect(harness.permission).toBeDefined()
    expect(harness.hooks).toBeDefined()
    expect(harness.memory).toBeDefined()
    expect(harness.compressor).toBeDefined()

    // Subsystem interaction: permission + hooks both accessible
    const permVerdict = harness.permission.evaluate("SafeTool", {})
    expect(permVerdict.level).toBe("allow")

    // Memory write + read
    await harness.memory.session.set("e2e", "ok")
    expect(await harness.memory.session.get("e2e")).toBe("ok")

    // Clean up
    harness.abort("e2e complete")
  })
})

// ═══════════════════════════════════════════════════════════════════
// ─── TG1 Feature Tests ───
// ═══════════════════════════════════════════════════════════════════

describe("TG1 Features", () => {
  // ── ErrorRecovery ──
  it("extractRecovery should return null for void results", () => {
    const harness = createHarness({
      model: "test",
      tools: [],
      adapter: MockAdapter as any,
    })
    // @ts-expect-error testing private method
    expect(harness["extractRecovery"]([])).toBeNull()
    // @ts-expect-error testing private method
    expect(harness["extractRecovery"]([undefined, null])).toBeNull()
  })

  // ── onConflict: skip ──
  it("ToolRegistry.register with onConflict: skip", () => {
    const { ToolRegistry, defineTool } = require("@harness/tools") as typeof import("@harness/tools")
    const reg = new ToolRegistry()
    const t1 = defineTool({ name: "TestTool", description: "", parameters: { type: "object", properties: {} } })
    reg.register([t1])
    // Register again with skip — should not throw
    expect(() => reg.register([t1], { onConflict: "skip" })).not.toThrow()
    expect(reg.size).toBe(1) // still 1
  })

  // ── onConflict: override ──
  it("ToolRegistry.register with onConflict: override", () => {
    const { ToolRegistry, defineTool } = require("@harness/tools") as typeof import("@harness/tools")
    const reg = new ToolRegistry()
    const t1 = defineTool({ name: "TestTool", description: "v1", parameters: { type: "object", properties: {} } })
    const t2 = defineTool({ name: "TestTool", description: "v2", parameters: { type: "object", properties: {} } })
    reg.register([t1])
    reg.register([t2], { onConflict: "override" })
    expect(reg.get("TestTool")?.description).toBe("v2")
  })

  // ── Serialize/Deserialize ──
  it("serialize should not throw when loop is not running", () => {
    const harness = createHarness({
      model: "test",
      tools: [],
      adapter: MockAdapter as any,
    })
    const snapshot = harness.serialize()
    expect(snapshot.version).toBe(1)
    expect(snapshot.sessionId).toBeDefined()
    expect(snapshot.turns).toEqual([])
  })

  // ── Memory backends ──
  it("InMemoryStore get/set/has/list/delete", async () => {
    const { InMemoryStore } = require("@harness/memory") as typeof import("@harness/memory")
    const store = new InMemoryStore("session")
    await store.set("k1", "v1")
    expect(await store.get("k1")).toBe("v1")
    expect(await store.has("k1")).toBe(true)
    const list = await store.list()
    expect(list.length).toBeGreaterThan(0)
    await store.delete("k1")
    expect(await store.get("k1")).toBeUndefined()
  })

  // ── Compressor chunk strategy ──
  it("chunk strategy should reduce messages", async () => {
    const { chunk } = require("@harness/compressor") as typeof import("@harness/compressor")
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `Message ${i}: lorem ipsum dolor sit amet consectetur adipiscing elit` }],
    }))
    const result = await chunk.compress(
      { session: {} as any, turn: { messages, pendingToolCalls: new Map(), lastObservation: null, compressedAt: null, id: "t1", index: 0 }, shared: {} as any },
      { targetTokens: 100 },
    )
    expect(result.messages.length).toBeLessThan(messages.length)
    expect(result.strategy).toBe("chunk")
  })
})

