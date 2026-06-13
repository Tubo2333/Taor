/**
 * MCP Consumer Support — Integration Tests (GAP-6)
 *
 * Tests MCPToolBridge lifecycle: construction → connect (tools/list) → execute (tools/call) → disconnect.
 * Uses mocked MCP SDK to avoid spawning real processes.
 */

import { describe, it, expect, beforeAll, afterAll, vi, type MockInstance } from "vitest"

// ═══════════════════════════════════════════════════════════════════
// ─── Mock MCP SDK ───
// ═══════════════════════════════════════════════════════════════════

// Mock MCP client instance with controllable behavior
let mockClientInstance: {
  connect: ReturnType<typeof vi.fn>
  request: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} | null = null

let mockTransportInstance: {
  start: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} | null = null

// Track SDK import calls
let sdkImportCount = 0
let stdioImportCount = 0
let sseImportCount = 0

// Create fresh mock instances before each test module
function createMockInstances() {
  mockClientInstance = {
    connect: vi.fn().mockResolvedValue(undefined),
    request: vi.fn().mockResolvedValue({
      tools: [
        {
          name: "mock_search",
          description: "Search mock data",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
            },
            required: ["query"],
          },
        },
        {
          name: "mock_read",
          description: "Read mock file",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
            },
            required: ["path"],
          },
        },
      ],
    }),
    close: vi.fn().mockResolvedValue(undefined),
  }

  mockTransportInstance = {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

// Mock the MCP SDK modules
vi.mock("@modelcontextprotocol/sdk/client", () => ({
  Client: vi.fn().mockImplementation(() => mockClientInstance),
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => mockTransportInstance),
}))

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn().mockImplementation(() => mockTransportInstance),
}))

// ═══════════════════════════════════════════════════════════════════
// ─── Tests ───
// ═══════════════════════════════════════════════════════════════════

describe("GAP-6: MCP Consumer Support", () => {
  beforeAll(() => {
    createMockInstances()
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  // ── Test 1: Construction validation ──

  describe("MCPToolBridge — construction", () => {
    it("should reject config with neither command nor url", async () => {
      const { MCPToolBridge } = await import("@harness/mcp")

      expect(() => {
        new MCPToolBridge({ name: "bad-server" } as any)
      }).toThrow(/must specify either "command" \(stdio\) or "url" \(SSE\)/)
    })

    it("should construct successfully with command (stdio)", async () => {
      const { MCPToolBridge } = await import("@harness/mcp")

      const bridge = new MCPToolBridge({
        name: "test-stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-test"],
      })

      expect(bridge.serverName).toBe("test-stdio")
      expect(bridge.connectionState).toBe("disconnected")
      expect(bridge.tools).toEqual([])
    })

    it("should construct successfully with url (SSE)", async () => {
      const { MCPToolBridge } = await import("@harness/mcp")

      const bridge = new MCPToolBridge({
        name: "test-sse",
        url: "http://localhost:3001/sse",
      })

      expect(bridge.serverName).toBe("test-sse")
      expect(bridge.connectionState).toBe("disconnected")
    })
  })

  // ── Test 2: connect() discovers tools ──

  describe("MCPToolBridge — connect (tools/list)", () => {
    it("should discover 2 tools from mock MCP server", async () => {
      createMockInstances()
      const { MCPToolBridge } = await import("@harness/mcp")

      const bridge = new MCPToolBridge({
        name: "mock-stdio",
        command: "mock-cmd",
        args: [],
      })

      const tools = await bridge.connect()

      // Verify tools were discovered
      expect(tools).toHaveLength(2)
      expect(tools.map((t) => t.name).sort()).toEqual(["mock_read", "mock_search"])

      // Verify each tool descriptor has required fields
      for (const tool of tools) {
        expect(tool.name).toBeTruthy()
        expect(tool.description).toBeTruthy()
        expect(tool.parameters).toBeDefined()
        expect(tool.execute).toBeInstanceOf(Function)
        expect(tool.permissions).toBeDefined()
        expect(tool.risk).toBeDefined()
      }

      // Verify state transition
      expect(bridge.connectionState).toBe("connected")

      // Verify connect result
      const result = bridge.getConnectResult()
      expect(result.serverName).toBe("mock-stdio")
      expect(result.toolCount).toBe(2)

      // Clean up
      await bridge.disconnect()
    })

    it("should throw if connect() called twice", async () => {
      createMockInstances()
      const { MCPToolBridge } = await import("@harness/mcp")

      const bridge = new MCPToolBridge({
        name: "double-connect",
        command: "mock-cmd",
      })

      await bridge.connect()

      await expect(bridge.connect()).rejects.toThrow(/already connected/)

      await bridge.disconnect()
    })

    it("should register process.on('exit') cleanup handler", async () => {
      createMockInstances()
      const { MCPToolBridge } = await import("@harness/mcp")

      const bridge = new MCPToolBridge({
        name: "exit-cleanup",
        command: "mock-cmd",
      })

      // Verify listener count before connect
      const listenersBefore = process.listenerCount("exit")

      await bridge.connect()

      // Verify listener was added
      expect(process.listenerCount("exit")).toBe(listenersBefore + 1)

      await bridge.disconnect()

      // Verify listener was removed
      expect(process.listenerCount("exit")).toBe(listenersBefore)
    })
  })

  // ── Test 3: execute() calls tools/call ──

  describe("MCPToolBridge — execute (tools/call)", () => {
    it("should call tools/call with correct params", async () => {
      createMockInstances()
      const { MCPToolBridge } = await import("@harness/mcp")

      // Configure mock to return a specific tool result
      mockClientInstance!.request.mockResolvedValue({
        content: [{ type: "text", text: "Search result: found 42 items" }],
      })

      const bridge = new MCPToolBridge({
        name: "exec-test",
        command: "mock-cmd",
      })

      await bridge.connect()

      const result = await bridge.execute("mock_search", { query: "test" })

      // Verify request was made
      expect(mockClientInstance!.request).toHaveBeenCalledWith(
        {
          method: "tools/call",
          params: { name: "mock_search", arguments: { query: "test" } },
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )

      // Verify result structure
      expect(result).toBeDefined()

      await bridge.disconnect()
    })

    it("should throw if execute() called before connect()", async () => {
      const { MCPToolBridge } = await import("@harness/mcp")

      const bridge = new MCPToolBridge({
        name: "not-connected",
        command: "mock-cmd",
      })

      await expect(
        bridge.execute("some-tool", { key: "value" }),
      ).rejects.toThrow(/not connected/)
    })
  })

  // ── Test 4: ToolDescriptor.execute() integration ──

  describe("MCPToolBridge — ToolDescriptor.execute()", () => {
    it("should wrap MCP result in ToolResult format via ToolDescriptor.execute()", async () => {
      createMockInstances()
      const { MCPToolBridge } = await import("@harness/mcp")

      // request is called twice: first for tools/list (connect), then for tools/call (execute).
      // Return different responses based on the method.
      mockClientInstance!.request.mockImplementation(
        (params: { method: string; params?: Record<string, unknown> }) => {
          if (params.method === "tools/list") {
            return Promise.resolve({
              tools: [
                { name: "mock_search", description: "Search", inputSchema: {} },
                { name: "mock_read", description: "Read", inputSchema: {} },
              ],
            })
          }
          if (params.method === "tools/call") {
            return Promise.resolve({
              content: [{ type: "text", text: "File contents: Hello World" }],
            })
          }
          return Promise.resolve({})
        },
      )

      const bridge = new MCPToolBridge({
        name: "wrap-test",
        command: "mock-cmd",
      })

      const tools = await bridge.connect()
      const readTool = tools.find((t) => t.name === "mock_read")!

      // Execute via the ToolDescriptor's execute function
      const result = await readTool.execute({ path: "/test.txt" }) as any

      // Verify ToolResult format
      expect(result.ok).toBe(true)
      expect(result.data).toBe("File contents: Hello World")
      expect(result.meta).toBeDefined()

      await bridge.disconnect()
    })
  })

  // ── Test 5: disconnect() idempotency ──

  describe("MCPToolBridge — disconnect", () => {
    it("should be idempotent (safe to call multiple times)", async () => {
      createMockInstances()
      const { MCPToolBridge } = await import("@harness/mcp")

      const bridge = new MCPToolBridge({
        name: "idempotent",
        command: "mock-cmd",
      })

      await bridge.connect()

      // First disconnect
      await bridge.disconnect()
      expect(bridge.connectionState).toBe("disconnected")

      // Second disconnect should not throw
      await bridge.disconnect()
      expect(bridge.connectionState).toBe("disconnected")

      // Third disconnect should not throw
      await bridge.disconnect()
      expect(bridge.connectionState).toBe("disconnected")
    })

    it("should clear tools after disconnect", async () => {
      createMockInstances()
      const { MCPToolBridge } = await import("@harness/mcp")

      const bridge = new MCPToolBridge({
        name: "clear-tools",
        command: "mock-cmd",
      })

      await bridge.connect()
      expect(bridge.tools.length).toBeGreaterThan(0)

      await bridge.disconnect()
      expect(bridge.tools).toEqual([])
    })
  })

  // ── Test 6: Error handling — connect timeout ──

  describe("MCPToolBridge — error handling", () => {
    it("should throw on connect timeout", async () => {
      createMockInstances()
      const { MCPToolBridge } = await import("@harness/mcp")

      // Mock connect to hang forever (simulating timeout)
      mockClientInstance!.connect.mockImplementation(
        () => new Promise(() => {}), // never resolves
      )

      const bridge = new MCPToolBridge({
        name: "timeout-test",
        command: "mock-cmd",
        timeout: 100, // short timeout for test
      })

      await expect(bridge.connect()).rejects.toThrow(/timed out/)

      // State should be reset after failure
      expect(bridge.connectionState).toBe("disconnected")
    })
  })
})
