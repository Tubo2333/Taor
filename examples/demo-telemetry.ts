/**
 * examples/demo-telemetry.ts — Taor + OpenTelemetry + Jaeger
 *
 * Same permission-showcase flow as demo.ts, but every TAOR phase is traced
 * via OpenTelemetry and exported to Jaeger for visualization.
 *
 * Quick start:
 *   docker compose -f docker-compose.telemetry.yml up -d
 *   npx tsx examples/demo-telemetry.ts
 *   open http://localhost:16686  → search service "taor" → click a trace
 *
 * Even without Jaeger, spans still fire — the OTLP exporter just
 * drops them silently (no crash).
 */

import { Harness, validateConfig } from "@taor/core";
import { initTracer, getTracer, createOtelHooks, shutdownTracer } from "@taor/telemetry";
import { PermissionEngine } from "@taor/permission";
import { HookRegistry } from "@taor/hooks";

// ═══════════════════════════════════════════════════════════════
// Same mock adapter + tools as demo.ts (abbreviated)
// ═══════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ShowcaseAdapter {
  readonly provider = "showcase-telemetry";
  private turnCount = 0;

  getModelInfo() {
    return { id: "showcase", maxInputTokens: 16000, maxOutputTokens: 4000 };
  }
  async buildRequest(ctx: any) {
    return { messages: ctx.turn.messages };
  }

  async *think(_request: unknown, _signal: AbortSignal) {
    this.turnCount++;
    if (this.turnCount === 1) {
      await sleep(300);
      yield {
        type: "text" as const,
        content: "Reading server configuration to understand the deployment target...",
      };
      await sleep(400);
      yield {
        type: "tool_use" as const,
        call: { id: "call_001", name: "ReadFile", arguments: { path: "/etc/secrets.env" } },
      };
      yield {
        type: "stop" as const,
        reason: "end_turn",
        usage: { input: 120, output: 35, cacheRead: 0, cacheWrite: 0 },
      };
    } else if (this.turnCount === 2) {
      await sleep(300);
      yield {
        type: "text" as const,
        content: "Path blocked. Switching to /app/config.json",
      };
      await sleep(400);
      yield {
        type: "tool_use" as const,
        call: { id: "call_002", name: "ReadFile", arguments: { path: "/app/config.json" } },
      };
      yield {
        type: "stop" as const,
        reason: "end_turn",
        usage: { input: 200, output: 40, cacheRead: 0, cacheWrite: 0 },
      };
    } else {
      await sleep(300);
      yield {
        type: "text" as const,
        content: "Config loaded. Deploy complete. ✅",
      };
      yield {
        type: "stop" as const,
        reason: "end_turn",
        usage: { input: 300, output: 75, cacheRead: 0, cacheWrite: 0 },
      };
    }
  }

  formatToolResult(_id: string, r: any) {
    return r.ok ? JSON.stringify(r.data) : `DENIED: ${r.error}`;
  }
  wrapToolResult(id: string, r: any) {
    return {
      role: "user" as const,
      content: [{ type: "tool_result" as const, tool_use_id: id, content: r.ok ? JSON.stringify(r.data) : `DENIED: ${r.error}` }],
    };
  }
  normalizeError(e: any) {
    return { code: "error", message: String(e), source: "adapter" as const, recoverable: false, timestamp: Date.now() };
  }
  countTokens() { return 10; }
}

const readFileTool = {
  name: "ReadFile",
  description: "Read a file from the filesystem. @resource file",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Absolute file path" } },
    required: ["path"],
  },
  risk: "high" as const,
  async execute(params: any, _ctx: any) {
    await sleep(200);
    const path = params.path as string;
    if (path.startsWith("/etc/") || path.includes("secrets") || path.includes(".env")) {
      return { ok: false, error: `Access denied: "${path}" is in a protected zone`, code: "RESOURCE_DENIED", recoverable: false, meta: { duration: 5 } };
    }
    return { ok: true, data: { path, content: '{"host":"0.0.0.0","port":8080}', bytes: 42 }, meta: { duration: 45 } };
  },
};

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  // ── Init OTEL ──
  initTracer("taor");
  console.log("🔭 OpenTelemetry tracer initialized (OTLP → localhost:4317)");

  // ── Build harness ──
  const config = validateConfig({
    model: "showcase",
    tools: [readFileTool] as any,
    permission: {
      mode: "interactive" as const,
      defaultLevel: "ask" as const,
      rules: [{
        level: "boundary" as const,
        pattern: "ReadFile",
        resourceConstraints: {
          paramAnnotation: "file" as const,
          denylist: ["/etc/**", "/root/**", "**/secrets**", "**/.env**"],
          allowlist: ["/app/**", "/home/**", "/tmp/**"],
        },
        reason: "File access restricted by resource boundary",
      }],
    },
    // ★ The key line: inject OTEL hooks alongside business hooks
    hooks: [
      ...createOtelHooks(getTracer()),
      {
        name: "audit-logger",
        hooks: ["afterAct"],
        handler: async (_ctx: any, call: any, result: any) => {
          const icon = result?.ok ? "OK" : "BLOCKED";
          console.log(`  [audit] ${call?.name}(${call?.arguments?.path}) → ${icon}`);
        },
      },
    ],
  });

  const mockRegistry = {
    _tools: new Map<string, any>(),
    register(inputs: any[]) { for (const t of inputs) this._tools.set(t.name, t); },
    get(name: string) { return this._tools.get(name); },
    list() { return [...this._tools.values()]; },
    get size() { return this._tools.size; },
    remove(name: string) { return this._tools.delete(name); },
    clear() { this._tools.clear(); },
  };
  mockRegistry.register(config.tools);

  const harness = new Harness(config, new ShowcaseAdapter() as any, mockRegistry as any);

  harness.setPermission(new PermissionEngine(config.permission as any, mockRegistry.list() as any) as any);
  harness.setHooks(new HookRegistry(config.hooks as any) as any);

  // ── Run ──
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Taor + OpenTelemetry · Trace Showcase      ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  harness.start("Read the server config and deploy the monitoring agent.");

  let turnNum = 0;
  for await (const event of harness) {
    switch (event.type) {
      case "turn-started":
        turnNum++;
        console.log(`── Turn ${turnNum} ──`);
        break;
      case "thought":
        console.log(`  💭 ${(event as any).content}`);
        break;
      case "tool-call":
        console.log(`  🔧 ${(event as any).tool}(${(event as any).params?.path})`);
        break;
      case "tool-result":
        console.log(`  ${(event as any).ok ? "✅" : "🛑"} ${(event as any).duration}ms`);
        break;
      case "turn-ended":
        console.log(`  ⏱️  ${(event as any).tokenUsage?.total ?? 0} tokens\n`);
        break;
    }
  }

  console.log(`Done. ${harness.turns.length} turns, ${harness.tokenUsage.total} tokens.`);

  // ── View traces ──
  console.log("\n── View Traces ──");
  console.log("1. Open http://localhost:16686");
  console.log('2. Search service "taor"');
  console.log("3. Click a trace → see THINK / tool:ReadFile / OBSERVE spans\n");

  await shutdownTracer();
}

main().catch((err) => {
  console.error("Demo failed:", err.message);
  process.exit(1);
});
