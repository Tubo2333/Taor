// @harness/mcp — MCP server configuration types

/**
 * MCP server transport configuration.
 *
 * At least one of `command` (stdio) or `url` (SSE) must be specified.
 * When both are present, `command` takes precedence (stdio transport).
 */
export interface MCPServerConfig {
  /** Friendly name for this MCP server. Used in tool source attribution. */
  name: string
  /** Command to spawn for stdio transport (e.g., "npx", "node", "python"). */
  command?: string
  /** Arguments for the stdio command. */
  args?: string[]
  /** Environment variables for the stdio child process. */
  env?: Record<string, string>
  /** URL for SSE transport (e.g., "http://localhost:3001/sse"). */
  url?: string
  /** Tool call timeout in milliseconds (default: 30_000). */
  timeout?: number
}

/**
 * Result of connecting to an MCP server and discovering tools.
 */
export interface MCPConnectResult {
  /** Server name from config. */
  serverName: string
  /** Number of tools discovered. */
  toolCount: number
  /** Tool names discovered. */
  toolNames: string[]
}
