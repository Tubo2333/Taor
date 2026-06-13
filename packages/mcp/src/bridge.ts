// @harness/mcp — MCPToolBridge: connect, discover, execute, cleanup
//
// Wraps the @modelcontextprotocol/sdk Client to convert MCP server tools into
// ToolDescriptor[] compatible with ToolRegistry. Handles process lifecycle
// (spawn on connect, kill on disconnect/exit) and AbortSignal propagation.

import type { ToolDescriptor } from "@harness/tools"
import type { MCPServerConfig, MCPConnectResult } from "./types.js"

// ─── Lazy MCP SDK imports (AD-3: heavy optional dependency) ───

// We use dynamic import() for the MCP SDK because it's a heavy dependency
// (~1 MB). The SDK is installed when users `npm install @harness/mcp`.
// We cache the imports after first use for performance.

interface McpClient {
  connect(transport: McpTransport): Promise<void>
  request(params: { method: string; params?: Record<string, unknown> }, options?: { signal?: AbortSignal }): Promise<unknown>
  close(): Promise<void>
}

interface McpTransport {
  start(): Promise<void>
  close(): Promise<void>
}

interface McpClientConstructor {
  new (info: { name: string; version: string }, options?: { capabilities?: Record<string, unknown> }): McpClient
}

interface McpStdioParams {
  command: string
  args?: string[]
  env?: Record<string, string>
  stderr?: string | number
  cwd?: string
}

interface McpStdioConstructor {
  new (params: McpStdioParams): McpTransport
}

interface McpSseOptions {
  eventSourceInit?: Record<string, unknown>
  requestInit?: Record<string, unknown>
}

interface McpSseConstructor {
  new (url: URL, opts?: McpSseOptions): McpTransport
}

let _Client: McpClientConstructor | null = null
let _StdioClientTransport: McpStdioConstructor | null = null
let _SSEClientTransport: McpSseConstructor | null = null

async function loadMcpSdk() {
  if (_Client && _StdioClientTransport && _SSEClientTransport) return

  try {
    const clientMod = await import("@modelcontextprotocol/sdk/client")
    _Client = (clientMod as unknown as { Client: McpClientConstructor }).Client

    const stdioMod = await import("@modelcontextprotocol/sdk/client/stdio.js")
    _StdioClientTransport = (stdioMod as unknown as { StdioClientTransport: McpStdioConstructor }).StdioClientTransport

    const sseMod = await import("@modelcontextprotocol/sdk/client/sse.js")
    _SSEClientTransport = (sseMod as unknown as { SSEClientTransport: McpSseConstructor }).SSEClientTransport
  } catch (err) {
    throw new Error(
      `MCPToolBridge: @modelcontextprotocol/sdk is required for MCP support.\n` +
        `Install it with:\n` +
        `  npm install @modelcontextprotocol/sdk\n` +
        `Or:\n` +
        `  npm install @harness/mcp\n\n` +
        `Original error: ${(err as Error).message}`,
    )
  }
}

// ─── Internal state ───

type BridgeState = "disconnected" | "connecting" | "connected" | "disconnecting"

/**
 * MCPToolBridge — connects to an MCP server and exposes its tools as ToolDescriptors.
 *
 * ## Lifecycle
 *
 * ```
 * const bridge = new MCPToolBridge({ name: "my-server", command: "npx", args: [...] })
 * const tools = await bridge.connect()
 * registry.register(tools)           // register discovered tools
 * const result = await tools[0].execute({ ... })  // calls MCP tools/call
 * await bridge.disconnect()          // cleanup
 * ```
 *
 * ## Process cleanup (H3 review fix)
 *
 * - `process.on("exit")` handler kills any stdio child process on harness exit.
 * - `AbortSignal` propagates harness abort/crash to pending MCP requests.
 * - `disconnect()` is idempotent — safe to call multiple times.
 *
 * ## Transport selection
 *
 * - If `config.command` is set → stdio transport (spawn child process)
 * - Otherwise, if `config.url` is set → SSE transport (connect to URL)
 * - At least one must be specified.
 */
export class MCPToolBridge {
  private config: MCPServerConfig
  private state: BridgeState = "disconnected"
  private descriptors: ToolDescriptor[] = []
  private abortController: AbortController | null = null
  private client: McpClient | null = null
  private transport: McpTransport | null = null
  private exitHandler: (() => void) | null = null

  constructor(config: MCPServerConfig) {
    if (!config.command && !config.url) {
      throw new Error(
        `MCPToolBridge: server "${config.name}" must specify either "command" (stdio) or "url" (SSE).`,
      )
    }
    this.config = {
      timeout: 30_000,
      ...config,
    }
  }

  /**
   * Connect to the MCP server and discover tools.
   *
   * Dynamically imports @modelcontextprotocol/sdk (heavy dependency).
   * If the SDK is not installed, throws with a clear installation message.
   *
   * @returns Discovered tools as ToolDescriptor[] ready for ToolRegistry.register().
   */
  async connect(): Promise<ToolDescriptor[]> {
    if (this.state === "connected" || this.state === "connecting") {
      throw new Error(
        `MCPToolBridge: server "${this.config.name}" is already connected or connecting.`,
      )
    }

    this.state = "connecting"
    this.abortController = new AbortController()

    try {
      await loadMcpSdk()

      // Create transport
      if (this.config.command) {
        this.transport = new (_StdioClientTransport!)({
          command: this.config.command,
          args: this.config.args,
          env: this.config.env,
        })
      } else if (this.config.url) {
        this.transport = new (_SSEClientTransport!)(new URL(this.config.url))
      }

      // Create MCP client and connect
      this.client = new (_Client!)({
        name: "harness-mcp-bridge",
        version: "0.1.0",
      })

      // Connect with timeout
      const connectPromise = this.client.connect(this.transport!)
      const timeoutMs = this.config.timeout ?? 30_000
      await withTimeout(
        connectPromise,
        timeoutMs,
        `MCPToolBridge: connection to "${this.config.name}" timed out after ${timeoutMs}ms`,
      )

      // Discover tools via tools/list
      const toolsResult = (await this.client.request(
        { method: "tools/list" },
        { signal: this.abortController.signal },
      )) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }

      const rawTools = toolsResult?.tools ?? []

      // Convert MCP tool schemas to ToolDescriptor[]
      this.descriptors = rawTools.map((t) => this.convertMcpTool(t))

      // Register process.on("exit") cleanup (H3 review fix)
      this.exitHandler = () => {
        this.disconnect().catch(() => {
          // During exit, cleanup failures are non-recoverable — suppress
        })
      }
      process.on("exit", this.exitHandler)

      this.state = "connected"
      return this.descriptors
    } catch (err) {
      this.state = "disconnected"
      // Clean up partial resources on connect failure
      await this.cleanupResources()
      throw err
    }
  }

  /**
   * Execute an MCP tool by name.
   *
   * @param name - Tool name (must have been discovered via connect()).
   * @param args - Tool arguments (will be JSON-serialized).
   * @returns The tool execution result from the MCP server.
   */
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.state !== "connected" || !this.client || !this.abortController) {
      throw new Error(
        `MCPToolBridge: cannot execute "${name}" — bridge is not connected (state: ${this.state}).`,
      )
    }

    const timeoutMs = this.config.timeout ?? 30_000

    const callPromise = this.client.request(
      {
        method: "tools/call",
        params: { name, arguments: args },
      },
      { signal: this.abortController.signal },
    )

    return withTimeout(
      callPromise,
      timeoutMs,
      `MCPToolBridge: tool "${name}" call timed out after ${timeoutMs}ms`,
    )
  }

  /**
   * Disconnect from the MCP server.
   *
   * - Aborts pending requests
   * - Closes the MCP client
   * - Removes exit handler
   *
   * Idempotent — safe to call multiple times.
   */
  async disconnect(): Promise<void> {
    if (this.state === "disconnected" || this.state === "disconnecting") {
      return
    }

    this.state = "disconnecting"

    // Abort pending MCP requests
    this.abortController?.abort()

    // Clean up transport + client
    await this.cleanupResources()

    // Remove exit handler
    if (this.exitHandler) {
      process.removeListener("exit", this.exitHandler)
      this.exitHandler = null
    }

    // Clear descriptors
    this.descriptors = []
    this.abortController = null
    this.state = "disconnected"
  }

  /**
   * Get the list of ToolDescriptors discovered from this MCP server.
   */
  get tools(): ToolDescriptor[] {
    return [...this.descriptors]
  }

  /**
   * Current connection state.
   */
  get connectionState(): BridgeState {
    return this.state
  }

  /**
   * Server name from config.
   */
  get serverName(): string {
    return this.config.name
  }

  /**
   * Get a summary of the connection result.
   */
  getConnectResult(): MCPConnectResult {
    return {
      serverName: this.config.name,
      toolCount: this.descriptors.length,
      toolNames: this.descriptors.map((d) => d.name),
    }
  }

  // ─── Private helpers ───

  /**
   * Convert an MCP tool schema to a ToolDescriptor.
   *
   * The MCP tool's inputSchema is a JSON Schema (Draft-07), compatible with
   * ToolDescriptor.parameters (also JSONSchema from @harness/tools).
   */
  private convertMcpTool(raw: {
    name: string
    description?: string
    inputSchema?: Record<string, unknown>
  }): ToolDescriptor {
    return {
      name: raw.name,
      description: raw.description ?? `MCP tool: ${raw.name}`,
      parameters: (raw.inputSchema ?? { type: "object", properties: {} }) as ToolDescriptor["parameters"],
      execute: async (params: unknown, _ctx?: unknown) => {
        const result = await this.execute(raw.name, params as Record<string, unknown>)
        // Wrap MCP result in ToolResult format
        const content = (result as { content?: Array<{ type: string; text?: string }> })?.content
        const textContent = content?.find((c) => c.type === "text")?.text ?? JSON.stringify(result)
        return {
          ok: true as const,
          data: textContent,
          meta: { duration: 0 },
        }
      },
      permissions: ["subprocess"],
      risk: "medium" as const,
    }
  }

  /**
   * Clean up transport, client resources.
   * Does NOT throw — all errors are caught and suppressed.
   */
  private async cleanupResources(): Promise<void> {
    // Close MCP client
    if (this.client) {
      try {
        await this.client.close()
      } catch {
        // Client may already be closed — ignore
      }
      this.client = null
    }

    this.transport = null
  }
}

// ═══════════════════════════════════════════════════════════════════
// ─── Helpers ───
// ═══════════════════════════════════════════════════════════════════

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms),
    ),
  ])
}
