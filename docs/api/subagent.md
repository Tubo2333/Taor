# Subagent API Reference

> Spawn background agents with inline, process, or worktree isolation.

## `harness.spawn(spec)`

```typescript
const handle = await harness.spawn({
  description: "Research PD-L1 expression",
  prompt: "Search for PD-L1 expression data in TCGA",
  isolation: "inline",
  model: "claude-haiku-4-5",
  maxTurns: 10,
  timeout: 60_000,
})
```

---

## `SubagentSpec`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | `string` | Required | Human-readable task description |
| `prompt` | `string` | Required | Initial prompt for the sub-agent |
| `tools` | `ToolInput[]` | Parent's tools | Available tools (filtered) |
| `model` | `string` | Parent's model | Model override |
| `isolation` | `"inline" \| "process" \| "worktree"` | `"inline"` | Isolation mode |
| `maxTurns` | `number` | `20` | Maximum turns |
| `timeout` | `number` | `undefined` | Timeout in ms |
| `schema` | `z.ZodType` | `undefined` | Structured output schema |

---

## `SubagentHandle`

| Method/Property | Type | Description |
|-----------------|------|-------------|
| `id` | `string` | Unique subagent ID |
| `description` | `string` | Task description |
| `status` | `SubagentStatus` | Current status |
| `started()` | `Promise<void>` | Resolves when subagent starts |
| `done()` | `Promise<SubagentResult>` | Resolves when subagent completes |
| `abort(reason?)` | `void` | Abort the subagent |

```typescript
handle.on("started", () => console.log("Subagent running"))
handle.on("done", (result) => console.log("Done:", result.ok))
handle.on("error", (err) => console.error("Error:", err.message))
handle.on("heartbeat", (h) => console.log(`Turn ${h.turnIndex}, ${h.elapsed}ms`))
handle.on("status-change", (from, to) => console.log(`${from} → ${to}`))
```

---

## `SubagentResult`

```typescript
interface SubagentResult {
  ok: boolean
  data?: unknown
  turns: number
  tokenUsage: TokenUsage
  artifacts?: Artifact[]
  error?: string
}
```

---

## Isolation Modes

| Mode | Use Case | Limitations |
|------|----------|-------------|
| `inline` | Quick subtasks, shared memory | No process isolation |
| `process` | CPU-intensive, sandboxed | Only `class extends Tool` supported |
| `worktree` | Git-isolated file mutations | Requires git worktree |

---

## Lifecycle

```
spawn() → beforeSpawn hook → created (pending)
  → starting → startHeartbeatWatch
  → started → TAOR loop (running)
  → done/error/aborted
  → afterSpawnResult hook
```
