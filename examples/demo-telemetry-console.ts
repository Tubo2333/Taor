/**
 * examples/demo-telemetry-console.ts — Taor + OpenTelemetry (Console)
 *
 * Same as demo-telemetry.ts but prints traces to stdout — no Jaeger needed.
 * Screenshot the console output for your portfolio.
 *
 * Run: pnpm exec tsx examples/demo-telemetry-console.ts
 */

import { Harness, validateConfig } from "@taor/core";
import { createOtelHooks } from "@taor/telemetry";
import { PermissionEngine } from "@taor/permission";
import { HookRegistry } from "@taor/hooks";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-base";

// ── Init OTEL with Console exporter ──
const provider = new BasicTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
provider.register();
const tracer = trace.getTracer("taor");
console.log("🔭 OpenTelemetry tracing → stdout\n");

// ── Mock adapter + tool (same as demo.ts) ──
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ShowcaseAdapter {
  readonly provider = "showcase";
  private turnCount = 0;
  getModelInfo() { return { id: "showcase", maxInputTokens: 16000, maxOutputTokens: 4000 }; }
  async buildRequest(ctx: any) { return { messages: ctx.turn.messages }; }
  async *think(_request: unknown, _signal: AbortSignal) {
    this.turnCount++;
    if (this.turnCount === 1) {
      await sleep(300);
      yield { type: "text" as const, content: "Reading server configuration..." };
      await sleep(400);
      yield { type: "tool_use" as const, call: { id: "call_001", name: "ReadFile", arguments: { path: "/etc/secrets.env" } } };
      yield { type: "stop" as const, reason: "end_turn", usage: { input: 120, output: 35, cacheRead: 0, cacheWrite: 0 } };
    } else if (this.turnCount === 2) {
      await sleep(300);
      yield { type: "text" as const, content: "Path blocked. Switching to /app/config.json" };
      await sleep(400);
      yield { type: "tool_use" as const, call: { id: "call_002", name: "ReadFile", arguments: { path: "/app/config.json" } } };
      yield { type: "stop" as const, reason: "end_turn", usage: { input: 200, output: 40, cacheRead: 0, cacheWrite: 0 } };
    } else {
      await sleep(300);
      yield { type: "text" as const, content: "Config loaded. Deploy complete." };
      yield { type: "stop" as const, reason: "end_turn", usage: { input: 300, output: 75, cacheRead: 0, cacheWrite: 0 } };
    }
  }
  formatToolResult(_id: string, r: any) { return r.ok ? JSON.stringify(r.data) : `DENIED: ${r.error}`; }
  wrapToolResult(id: string, r: any) { return { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: id, content: r.ok ? JSON.stringify(r.data) : `DENIED: ${r.error}` }] }; }
  normalizeError(e: any) { return { code: "error", message: String(e), source: "adapter" as const, recoverable: false, timestamp: Date.now() }; }
  countTokens() { return 10; }
}

const readFileTool = {
  name: "ReadFile", description: "Read a file. @resource file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  risk: "low" as const,
  async execute(params: any, _ctx: any) {
    await sleep(200);
    const path = params.path as string;
    if (path.startsWith("/etc/") || path.includes("secrets") || path.includes(".env")) {
      return { ok: false, error: `Access denied`, code: "RESOURCE_DENIED", recoverable: false, meta: { duration: 5 } };
    }
    return { ok: true, data: { path, content: '{"host":"0.0.0.0","port":8080}' }, meta: { duration: 45 } };
  },
};

async function main() {
  const config = validateConfig({
    model: "showcase", tools: [readFileTool] as any,
    permission: {
      mode: "interactive" as const, defaultLevel: "allow" as const,
      rules: [{ level: "boundary" as const, pattern: "ReadFile", resourceConstraints: { paramAnnotation: "file" as const, denylist: ["/etc/**", "**/secrets**", "**/.env**"], allowlist: ["/app/**"] }, reason: "Resource boundary" }],
    },
    hooks: [
      createOtelHooks(tracer),
      { afterAct: async (_ctx: any, call: any, result: any) => { console.log(`  [audit] ${call?.name}(${call?.arguments?.path}) → ${result?.ok ? "OK" : "BLOCKED"}`); } },
    ],
  });

  const mockRegistry = { _tools: new Map<string, any>(), register(inputs: any[]) { for (const t of inputs) this._tools.set(t.name, t); }, get(name: string) { return this._tools.get(name); }, list() { return [...this._tools.values()]; }, get size() { return this._tools.size; }, remove(name: string) { return this._tools.delete(name); }, clear() { this._tools.clear(); } };
  mockRegistry.register(config.tools);

  const harness = new Harness(config, new ShowcaseAdapter() as any, mockRegistry as any);
  harness.setPermission(new PermissionEngine(config.permission as any, mockRegistry.list() as any) as any);
  harness.setHooks(new HookRegistry(config.hooks as any) as any);

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Taor + OpenTelemetry · Console Trace        ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("  (Spans print to stdout below)\n");

  harness.start("Read the server config and deploy.");

  let turnNum = 0;
  for await (const event of harness) {
    switch (event.type) {
      case "turn-started": turnNum++; console.log(`── Turn ${turnNum} ──`); break;
      case "thought": console.log(`  💭 ${(event as any).content}`); break;
      case "tool-call": console.log(`  🔧 ${(event as any).tool}(${(event as any).params?.path})`); break;
      case "tool-result": console.log(`  ${(event as any).ok ? "✅" : "🛑"} ${(event as any).duration}ms`); break;
      case "turn-ended": console.log(`  ⏱️  ${(event as any).tokenUsage?.total ?? 0} tokens\n`); break;
    }
  }

  console.log(`\nDone. ${harness.turns.length} turns, ${harness.metrics.toolCalls} tool calls, ${harness.tokenUsage.total} tokens.`);

  await provider.shutdown();
}

main().catch((err) => { console.error("Demo failed:", err.message); process.exit(1); });
