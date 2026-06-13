# Tools API Reference

> Tool definition, registration, and execution. Tools can come from three sources:
> 1. `defineTool()` / `tool()` / `class extends Tool` (static definition)
> 2. MCP servers (`MCPToolBridge` two-step async init — complete in v0.2.0)
> 3. Sub-agent spawned tools (inline isolation)

## Tool Sources

| Source | Mechanism | Status |
|--------|-----------|--------|
| Static definition | `defineTool()`, `tool()`, `class Tool` | ✅ |
| MCP servers | `MCPToolBridge` → `bridge.connect()` → `ToolDescriptor[]` (two-step async) | ✅ |
| Sub-agent | `harness.spawn()` with inline isolation | ✅ |

## Three Ways to Define a Tool

### 1. `defineTool()` (Functional)

```typescript
import { defineTool } from "@harness/tools"

const myTool = defineTool({
  name: "read_file",
  description: "Read a file from disk",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
    },
    required: ["path"],
  },
  async execute(params, ctx) {
    const content = await fs.readFile(params.path, "utf-8")
    return { ok: true, data: content }
  },
})
```

### 2. `tool()` (Decorator-style)

```typescript
import { tool } from "@harness/tools"

const myTool = tool({
  name: "search",
  description: "Search the web",
  // ...
})
```

### 3. `class extends Tool` (OO, required for process isolation)

```typescript
import { Tool } from "@harness/tools"

export class ReadFileTool extends Tool {
  // __modulePath metadata required for process isolation
  static __modulePath = import.meta.url
  // ...
}
```

---

## `ToolRegistry`

Central tool registry — manages tool lifecycle.

```typescript
const registry = new ToolRegistry()
registry.register([tool1, tool2])
registry.get("read_file")      // ToolDescriptor | undefined
registry.list()                // ToolDescriptor[]
registry.remove("read_file")   // boolean
registry.clear()               // void
```

---

## `ToolDescriptor` Type

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique tool identifier |
| `description` | `string` | Human-readable description |
| `parameters` | `JSONSchema` | Input schema (JSON Schema) |
| `execute` | `(params, ctx) => Promise<ToolResult>` | Execution function |
| `permissions` | `string[]` | Required permission tags |
| `risk` | `"low" \| "medium" \| "high"` | Risk level for permission checks |
| `requiresApproval` | `boolean \| ((params, ctx) => boolean)` | Dynamic approval requirement |
| `__modulePath`? | `string` | File path for process isolation |

---

## `ToolResult` Type

```typescript
interface ToolResult {
  ok: boolean
  data?: unknown
  error?: string
  code?: string
  recoverable?: boolean
  meta?: {
    duration: number
    truncated?: boolean
    artifacts?: string[]
  }
}
```
