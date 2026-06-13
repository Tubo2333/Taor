# Hooks API Reference

> 13-point lifecycle hook system with priority execution and short-circuit.

## Hook Points

| Hook | Phase | Args | Return | Description |
|------|-------|------|--------|-------------|
| `onSessionStart` | Session | `SessionContext` | `void` | Fires when TAOR loop starts |
| `onSessionEnd` | Session | `SessionContext, SessionResult` | `void` | Fires when TAOR loop ends |
| `beforeThink` | THINK | `TurnContext` | `TurnContext\|void` | Modify context before LLM call |
| `afterThink` | THINK | `TurnContext, ThinkEvent[]` | `ThinkEvent[]\|void` | Inspect/modify think events |
| `beforeAct` | ACT | `TurnContext, ToolCall` | `ToolCall\|void\|null` | Modify or cancel tool call |
| `afterAct` | ACT | `TurnContext, ToolCall, ToolResult` | `void` | Post-execution audit |
| `afterObserve` | OBSERVE | `TurnContext, Observation` | `Observation\|void` | Modify observation |
| `onError` | Error | `SessionContext, HarnessError` | `ErrorRecovery\|void` | Error recovery action |
| `beforeCompress` | Compress | `TurnContext, CompressLevel` | `void` | Pre-compression hook |
| `afterCompress` | Compress | `TurnContext, CompressedEvent` | `void` | Post-compression hook |
| `beforeSpawn` | Subagent | `SubagentSpec` | `SubagentSpec\|void` | Modify subagent spec |
| `afterSpawnResult` | Subagent | `SubagentHandle, SubagentResult` | `void` | Subagent result handler |

---

## Registering Hooks

```typescript
import { HookRegistry } from "@taor/hooks"

const hooks = new HookRegistry([
  {
    hook: "beforeAct",
    handler: async (ctx, call) => {
      console.log(`About to execute: ${call.name}`)
      // Return null to cancel
    },
    priority: 10,
  },
])
```

---

## Configuration via createHarness

```typescript
const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [],
  hooks: [
    {
      hook: "onError",
      handler: async (ctx, error) => {
        if (error.code === "rate_limited") {
          return { action: "retry" }
        }
      },
    },
  ],
})
```

---

## Error Recovery Actions

| Action | Effect |
|--------|--------|
| `"retry"` | Retry the failed operation (up to 3 times for THINK, 3 times per tool) |
| `"skip_turn"` | Skip the current turn, continue to next |
| `"abort"` | Abort the entire session |
| `"ignore"` | Ignore the error, continue as normal |

---

## Hook Execution Order

1. Hooks are sorted by `priority` (higher = earlier)
2. Same-priority hooks execute in registration order
3. Each hook receives the result of previous hooks (for mutable return types)
4. `null` return from `beforeAct` cancels the tool call
