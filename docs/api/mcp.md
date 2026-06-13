# MCP Consumer API Reference

> `@taor/mcp` — Model Context Protocol consumer. Discover and call tools from external MCP servers (stdio/SSE). MCP is a **tool source**, not a new subsystem.

## Quick Start

```bash
npm install @taor/mcp
```

```typescript
import { createHarness } from "@taor/engine"
import { MCPToolBridge } from "@taor/mcp"

// Step 1: Create harness (sync)
const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [],
})

// Step 2: Connect to MCP server (async)
const bridge = new MCPToolBridge({
  name: "filesystem",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
})

const tools = await bridge.connect()
harness.tools.register(tools)
```

## Architecture

MCP is a **tool source**, not a new subsystem. An MCP bridge converts MCP server tools into `ToolDescriptor[]` compatible with `ToolRegistry`:

```
         Harness Agent
  ┌───────────────────────────┐
  │     ToolRegistry           │
  │  ┌──────────┐ ┌────────┐  │
  │  │defineTool│ │MCPTool │  │
  │  │  tools   │ │bridge  │  │
  │  └──────────┘ └───┬────┘  │
  └───────────────────┼───────┘
                      │ stdio/SSE
              ┌───────▼──────┐
              │  MCP Server  │
              │  (external)  │
              └──────────────┘
```

## `MCPToolBridge`

The main class. Connects to an MCP server, discovers tools, and converts them for ToolRegistry.

### Constructor

```typescript
import { MCPToolBridge } from "@taor/mcp"

new MCPToolBridge(config: MCPServerConfig)
```

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<ToolDescriptor[]>` | Connect to MCP server, discover tools via `tools/list` |
| `execute(name, args)` | `Promise<unknown>` | Call an MCP tool via `tools/call` |
| `disconnect()` | `Promise<void>` | Abort requests, close client, remove exit handler (idempotent) |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `tools` | `ToolDescriptor[]` | Copy of discovered tools |
| `connectionState` | `"disconnected" \| "connecting" \| "connected" \| "disconnecting"` | Current state |
| `serverName` | `string` | Server name from config |

### `getConnectResult()`

```typescript
bridge.getConnectResult()
// → { serverName: "filesystem", toolCount: 5, toolNames: ["read_file", "write_file", ...] }
```

## `MCPServerConfig`

Configuration for one MCP server connection:

```typescript
interface MCPServerConfig {
  /** Friendly name for this MCP server */
  name: string
  /** Command to spawn for stdio transport (e.g., "npx", "node") */
  command?: string
  /** Arguments for the stdio command */
  args?: string[]
  /** Environment variables for the stdio child process */
  env?: Record<string, string>
  /** URL for SSE transport (e.g., "http://localhost:3001/sse") */
  url?: string
  /** Tool call timeout in milliseconds (default: 30_000) */
  timeout?: number
}
```

At least one of `command` (stdio) or `url` (SSE) must be specified. When both are present, `command` takes precedence.

### Config Table

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | Yes | — | Friendly name, used in tool attribution |
| `command` | `string` | No | — | Executable for stdio transport |
| `args` | `string[]` | No | `[]` | Arguments for the command |
| `env` | `Record<string, string>` | No | `process.env` | Environment variables for child process |
| `url` | `string` | No | — | SSE endpoint URL |
| `timeout` | `number` | No | `30000` | Tool call + connect timeout (ms) |

## Transport Selection

- **Stdio** (`command` set): Spawns a child process, communicates via stdin/stdout JSON-RPC.
- **SSE** (`url` set): Connects to an HTTP SSE endpoint. Requires the MCP server to be already running.

## Process Cleanup (H3 Review Fix)

The MCP bridge handles cleanup at multiple levels:

1. **`disconnect()`**: Aborts pending MCP requests, closes the client, removes the exit handler. **Idempotent** — safe to call multiple times.
2. **`process.on("exit")`**: Automatic cleanup handler registered on `connect()`. Kills stdio child processes on harness exit.
3. **`AbortSignal`**: All MCP requests are bound to an `AbortController`. On disconnect, all pending requests are cancelled.

This prevents MCP server zombie processes when the harness process crashes or is killed.

## Two-Step Initialization

`createHarness()` is synchronous but MCP requires async initialization. The two-step pattern gives you full control:

```typescript
// Step 1: Create harness (sync)
const harness = createHarness({ model: "...", tools: [...staticTools] })

// Step 2: Connect MCP servers (async, each independently)
const bridges = await Promise.all(
  mcpConfigs.map(async (cfg) => {
    const bridge = new MCPToolBridge(cfg)
    const tools = await bridge.connect()
    harness.tools.register(tools)
    return bridge  // keep reference for later disconnect
  })
)

// Step 3: Clean up on shutdown
await Promise.all(bridges.map((b) => b.disconnect()))
```

## Multiple MCP Servers

```typescript
const filesystemBridge = new MCPToolBridge({
  name: "filesystem",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
})

const githubBridge = new MCPToolBridge({
  name: "github",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
})

const allTools = [
  ...(await filesystemBridge.connect()),
  ...(await githubBridge.connect()),
]
harness.tools.register(allTools)
```

## Error Handling

```typescript
try {
  const tools = await bridge.connect()
} catch (err) {
  if ((err as Error).message.includes("timed out")) {
    console.error("MCP server not responding — check if it's running")
  } else if ((err as Error).message.includes("@modelcontextprotocol/sdk")) {
    console.error("MCP SDK not installed. Run: npm install @modelcontextprotocol/sdk")
  }
}
```

## Optional Dependency (AD-3)

`@taor/mcp` has `@modelcontextprotocol/sdk` as a regular dependency. If you install `@taor/mcp`, the SDK comes with it. `MCPToolBridge` uses dynamic `import()` to load the SDK lazily on first `connect()` call — if the SDK is not available, it throws a clear error with installation instructions.

## Type Exports

```typescript
import { MCPToolBridge } from "@taor/mcp"
import type { MCPServerConfig, MCPConnectResult } from "@taor/mcp"
```

See [tools.md](./tools.md) for the `ToolDescriptor` and `ToolRegistry` API.
