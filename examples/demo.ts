/**
 * examples/demo.ts — Taor Agent Runtime Showcase (~45s)
 *
 * Demonstrates: TAOR loop, permission engine, tool execution, lifecycle hooks.
 * No external API key needed — uses an inline mock adapter.
 *
 * Run: npx tsx examples/demo.ts
 */

import { Harness, validateConfig } from "@taor/core";

// ─── Helper: pauses between events so the viewer can follow along ───
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════
// 1. Mock LLM Adapter — simulates a model that thinks and calls tools
// ═══════════════════════════════════════════════════════════════

class ShowcaseAdapter {
  readonly provider = "showcase-demo";
  private turnCount = 0;

  getModelInfo() {
    return { id: "showcase", maxInputTokens: 16000, maxOutputTokens: 4000 };
  }

  async buildRequest(ctx: any) {
    return { messages: ctx.turn.messages };
  }

  async *think(_request: unknown, signal: AbortSignal) {
    this.turnCount++;

    if (this.turnCount === 1) {
      // Turn 1: Model reads a protected file → permission engine blocks it
      await sleep(400); // simulate API latency
      yield {
        type: "text" as const,
        content: "Reading server configuration to understand the deployment target...",
      };

      await sleep(600); // model "decides" which tool to call
      yield {
        type: "tool_use" as const,
        call: {
          id: "call_001",
          name: "ReadFile",
          arguments: { path: "/etc/secrets.env" },
        },
      };

      yield {
        type: "stop" as const,
        reason: "end_turn",
        usage: { input: 120, output: 35, cacheRead: 0, cacheWrite: 0 },
      };
    } else if (this.turnCount === 2) {
      // Turn 2: After block, model tries an allowed path (learned from error)
      await sleep(300);
      yield {
        type: "text" as const,
        content: "Path blocked by permission engine. Switching to allowed path: /app/config.json",
      };

      await sleep(500);
      yield {
        type: "tool_use" as const,
        call: {
          id: "call_002",
          name: "ReadFile",
          arguments: { path: "/app/config.json" },
        },
      };

      yield {
        type: "stop" as const,
        reason: "end_turn",
        usage: { input: 200, output: 40, cacheRead: 0, cacheWrite: 0 },
      };
    } else {
      // Turn 3: Task complete — no more tool calls
      await sleep(300);
      yield {
        type: "text" as const,
        content: "Config loaded. Permission engine blocked 1 unsafe access.\nDeploy complete. ✅",
      };

      yield {
        type: "stop" as const,
        reason: "end_turn",
        usage: { input: 300, output: 75, cacheRead: 0, cacheWrite: 0 },
      };
    }
  }

  formatToolResult(_id: string, r: any) {
    return r.ok ? JSON.stringify(r.data) : `❌ DENIED: ${r.error}`;
  }

  wrapToolResult(id: string, r: any) {
    return {
      role: "user" as const,
      content: [{
        type: "tool_result" as const,
        tool_use_id: id,
        content: r.ok ? JSON.stringify(r.data) : `❌ DENIED: ${r.error}`,
      }],
    };
  }

  normalizeError(e: any) {
    return {
      code: "error", message: String(e),
      source: "adapter" as const, recoverable: false, timestamp: Date.now(),
    };
  }

  countTokens() { return 10; }
}

// ═══════════════════════════════════════════════════════════════
// 2. Mock tools
// ═══════════════════════════════════════════════════════════════

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
    const path = params.path as string;
    await sleep(500); // simulate disk I/O
    if (path.startsWith("/etc/") || path.includes("secrets") || path.includes(".env")) {
      return {
        ok: false,
        error: `Access denied: "${path}" is in a protected zone`,
        code: "RESOURCE_DENIED",
        recoverable: false,
        meta: { duration: 3 },
      };
    }
    return {
      ok: true,
      data: { path, content: '{"host":"0.0.0.0","port":8080}', bytes: 42 },
      meta: { duration: 87 },
    };
  },
};

// ═══════════════════════════════════════════════════════════════
// 3. Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  // ── Header ──
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   Taor · Agent Runtime  ·  Permission Showcase   ║");
  console.log("║          github.com/Tubo2333/taor               ║");
  console.log("╚══════════════════════════════════════════════════╝");

  await sleep(800);

  // ── Config ──
  const config = validateConfig({
    model: "showcase",
    tools: [readFileTool] as any,
    permission: {
      mode: "interactive",
      defaultLevel: "ask",
      rules: [{
        level: "boundary",
        pattern: "ReadFile",
        resourceConstraints: {
          paramAnnotation: "file",
          denylist: ["/etc/**", "/root/**", "**/secrets**", "**/.env**"],
          allowlist: ["/app/**", "/home/**", "/tmp/**"],
        },
        reason: "File access restricted by resource boundary",
      }],
    },
    hooks: [{
      name: "audit-logger",
      hooks: ["afterAct"],
      handler: async (_ctx: any, call: any, result: any) => {
        const icon = result?.ok ? "✅" : "🛑";
        console.log(`  [hook:afterAct] ${icon} ${call?.name} → ${result?.ok ? "PASS" : "BLOCKED"}`);
      },
    }],
  });

  // ── Tool registry (satisfies IToolRegistry structural interface) ──
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

  // ── Inject permission engine + hook registry ──
  const { PermissionEngine } = await import("@taor/permission");
  const { HookRegistry } = await import("@taor/hooks");

  const toolDescs = mockRegistry.list();
  harness.setPermission(new PermissionEngine(config.permission as any, toolDescs as any) as any);
  harness.setHooks(new HookRegistry(config.hooks as any) as any);

  // ── Start ──
  console.log("\n⚡ Initializing TAOR loop...");
  await sleep(500);
  console.log("🔒 Permission rules loaded:");
  console.log("   ReadFile → BLOCK /etc/** /root/** **/secrets** **/.env**");
  console.log("   ReadFile → ALLOW /app/** /home/** /tmp/**");
  console.log("🔌 Adapter connected: showcase-demo");
  console.log("🪝 Hook registered: audit-logger (afterAct)");
  await sleep(700);

  console.log("\n──────────────────────────────────────────────────");
  console.log('  PROMPT: "Read the server config and deploy."');
  console.log("──────────────────────────────────────────────────\n");

  harness.start("Read the server config and deploy the monitoring agent.");

  let turnNum = 0;
  for await (const event of harness) {
    switch (event.type) {
      case "turn-started":
        turnNum++;
        await sleep(200);
        console.log(`── Turn ${turnNum} · THINK ──`);
        break;

      case "thought":
        console.log(`  💭 ${(event as any).content}`);
        break;

      case "tool-call":
        await sleep(200);
        console.log(`\n  ⚡ ACT: ${(event as any).tool}("${(event as any).params?.path}")`);
        break;

      case "blocked":
        console.log(`  🛑 PERMISSION DENIED → ${(event as any).reason}`);
        break;

      case "approval-required":
        console.log(`  🔐 Permission check: ${(event as any).tool} (risk: ${(event as any).risk})`);
        await sleep(300);
        // Auto-approve — in production, a user would see a prompt here
        console.log(`  ✓ Auto-approved (interactive mode would prompt user)`);
        harness.next({ type: "approve-once", callId: (event as any).callId });
        break;

      case "tool-result":
        await sleep(200);
        if ((event as any).ok) {
          console.log(`\n  📊 OBSERVE: success · ${(event as any).duration}ms`);
        } else {
          console.log(`\n  ❌ OBSERVE: blocked · ${(event as any).duration}ms`);
        }
        break;

      case "turn-ended":
        await sleep(300);
        console.log(`  ⏱️  turn done · ${(event as any).tokenUsage?.total ?? 0} tokens\n`);
        break;

      case "compressed":
        console.log(`  📦 Context compressed: ${(event as any).beforeTokens} → ${(event as any).afterTokens} tokens`);
        break;

      case "error":
        console.log(`  💥 ERROR: ${(event as any).error?.message}`);
        break;
    }
  }

  // ── Session summary ──
  await sleep(500);
  console.log("═══════════════════════════════════════════════════");
  console.log("  Session Complete");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Turns     : ${harness.turns.length}`);
  console.log(`  Tool calls: ${harness.metrics.toolCalls}`);
  console.log(`  Tokens    : ${harness.tokenUsage.total}`);
  console.log(`  Status    : ${harness.state.status}`);
  console.log(`  Uptime    : ${harness.metrics.uptime}ms`);
  console.log(`  Errors    : ${harness.metrics.errors}`);
  console.log("═══════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("Demo failed:", err.message);
  process.exit(1);
});
