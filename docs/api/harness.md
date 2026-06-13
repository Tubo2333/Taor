# Harness API Reference

> Main Harness class — all public methods, getters, and lifecycle.

## `createHarness(config, snapshot?)`

Factory function. Creates and configures a full Harness instance with all subsystems wired.

```typescript
import { createHarness } from "@harness/engine"

const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [],
  session: { maxTurns: 3 },
})
```

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `config` | `HarnessConfig` | Yes | Full session configuration |
| `snapshot` | `SerializedSession` | No | Resume from a serialized session |

---

## `harness.start(prompt)`

Set the initial prompt. The TAOR loop begins on the first `next()` call.

```typescript
harness.start("What is the capital of France?")
```

---

## `harness.next(decision?)`

AsyncGenerator protocol — pull the next event. Pass a `UserDecision` to respond to an `approval-required` event.

```typescript
for await (const event of harness) {
  if (event.type === "approval-required") {
    harness.next({ type: "allow", callId: event.callId })
  }
}
```

---

## `harness.spawn(spec)`

Spawn a sub-agent. Returns a `SubagentHandle`.

```typescript
const handle = await harness.spawn({
  description: "Research subtask",
  prompt: "Find all references to PD-L1",
  isolation: "inline",
  maxTurns: 5,
})
const result = await handle.done()
```

---

## `harness.serialize()`

Serialize the session to a storable snapshot. Must not be called while the TAOR loop is running.

```typescript
const snapshot = harness.serialize()
// Save snapshot to disk...
```

---

## `Harness.deserialize(data, config)`

Static method — reconstruct a Harness session from a snapshot. Adapter and registry are injected post-construction by `createHarness()`.

---

## Getters

| Getter | Type | Description |
|--------|------|-------------|
| `state` | `SessionState` | Current session state (id, status, model, tokenUsage, turnCount) |
| `turns` | `TurnRecord[]` | All completed turn records |
| `tokenUsage` | `TokenUsage` | Aggregated token usage (input, output, cacheRead, cacheWrite, total) |
| `isRunning` | `boolean` | Whether the TAOR loop is currently running |
| `metrics` | `object` | Aggregated runtime metrics (sessionId, status, turns, tokenUsage, toolCalls, uptime, errors) |
| `hooks` | `IHookRegistry` | Injected hook registry |
| `permission` | `IPermissionEngine` | Injected permission engine |
| `memory` | `IMemoryFacade` | Injected memory facade |
| `compressor` | `ICompressorPipeline` | Injected compressor pipeline |

---

## Control Methods

| Method | Description |
|--------|-------------|
| `abort(reason?)` | Signal the TAOR loop to stop gracefully |
| `kill()` | Force-kill the TAOR loop immediately |
| `pause()` | Pause at the next turn boundary |
| `resume()` | Resume a paused session |

---

## Configuration Fields

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Model ID (e.g., `"claude-sonnet-4-6"`, `"gpt-4.1"`) |
| `tools` | `ToolInput[]` | Tool definitions |
| `adapter` | `AdapterConstructor` | LLM adapter class (default: `AnthropicAdapter`) |
| `session` | `Partial<SessionConfig>` | maxTurns, eventQueueCapacity, id |
| `permission` | `Partial<PermissionConfig>` | defaultLevel, rules |
| `hooks` | `HookInput[]` | Lifecycle hook registrations |
| `memory` | `Partial<MemoryConfig>` | user/project/session backends |
| `compressor` | `Partial<CompressorConfig>` | triggerThreshold, targetThreshold |
| `subagent` | `object` | adapterModulePath for process isolation |
| `circuitBreaker` | `CircuitBreakerConfig \| false` | ✅ Auto-wrap adapter with 3-state breaker |
| `mcp` | `MCPServerConfig[]` | ✅ Two-step async init — see [mcp.md](./mcp.md) |

## Lifecycle Events

| Event Type | When |
|------------|------|
| `turn-started` | New turn begins |
| `thinking` | THINK phase starts |
| `thought` | Text or thinking content chunk |
| `tool-call` | Tool execution begins |
| `tool-result` | Tool execution completes |
| `approval-required` | Tool needs user approval |
| `blocked` | Tool blocked by permission or user |
| `compressed` | Context compressed at turn boundary |
| `turn-ended` | Turn completes |
| `error` | Error event |
