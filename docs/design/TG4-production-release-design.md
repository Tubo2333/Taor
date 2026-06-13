# TG4 — Taor Production Release Design

> **Status**: DRAFT for cross-review
> **Based on**: TG0→TG3 + 2 architecture reviews, 3 commits deep (`ccd7c16`)
> **Target**: npm public release `@taor/*` v0.2.0 — production-grade open-source
> **Design principle**: Every gap has a design. No gap closed without a design.

---

## §0.  Current State Baseline

### 0.1  What we have (fully verified)

| Layer | Artifact | LoC | Status |
|-------|----------|-----|--------|
| Core | TAOR loop (AsyncGenerator), config validation, event emitter, session lifecycle | ~1900 | ✅ 3 CRITICAL reviews passed |
| Tools | `defineTool()`/`tool()`/`class Tool`, ToolRegistry (2-phase commit), Zod→JSONSchema | ~1200 | ✅ |
| Adapters | AnthropicAdapter (streaming, retry with AbortSignal, model catalog, token counting) | ~730 | ✅ |
| Permission | 4-tier engine, @resource constraints, glob matching | ~450 | ✅ |
| Hooks | 13-point lifecycle, priority execution, ErrorRecovery (4 strategies) | ~400 | ✅ |
| Subagent | inline + process isolation, orphan detection (IPC disconnect + heartbeat timeout), zombie detection | ~1200 | ✅ |
| Memory | 3-layer × 3 backend (InMemory/JSON/SQLite), TTL with periodic cleanup, pagination | ~500 | ✅ |
| Compressor | 5-layer pipeline (trim→summarize→chunk→embed→truncate), cache, trigger threshold | ~250 | ✅ |
| Engine | `createHarness()`, 7-structural-interface wiring, adapter subclass detection | ~210 | ✅ |
| CLI | `harness run/config/tool`, try-catch, clean errors | ~95 | ✅ |
| Tests | 17 smoke tests (16 integration + 1 IPC) | ~200 | ✅ |
| Docs | README, Quickstart, Deployment, 7 API refs, CHANGELOG | ~800 | ✅ |
| CI | `.github/workflows/ci.yml` (push/PR, Node 22, build+typecheck+test) | ~20 | ⚠️  pre-existing TS6310 |
| Docker | `Dockerfile` (node:22-alpine, layer-cache optimized) | ~13 | ⚠️  not tested |
| Interface guard | `interface-conformance.check.ts` (4/7 subsystems compile-checked) | ~65 | ✅ |

### 0.2  What we deliberately lack (by design)

| Item | Reason |
|------|--------|
| 3/7 interface conformance checks (Permission/Hooks/Subagent) | Their canonical types use mapped generics / strict overloads structurally incompatible with the loose `(...args: unknown[])` signatures needed for dependency inversion. The `as any` bridge is the intentional mechanism. |
| `ToolDef.parameters` as typed JSONSchema | Dependency inversion: `@taor/core` cannot import from `@taor/tools`. `object` is the loosest compatible structural type. |
| Workflow engine (DAG/step/resume) | Out of scope for v0.2.0. Taor is a runtime, not a workflow orchestrator. |
| Dev UI / Studio | Out of scope for v0.2.0. CLI + logs are the MVP debugging surface. |

### 0.3  Pain points confirmed by external review

| # | Pain | Status |
|---|------|--------|
| 1 | `process.exit()` in library code | ✅ Fixed (C1) |
| 2 | `deserialize()` undefined adapter injection | ✅ Fixed (C2) |
| 3 | Inconsistent null-guard patterns across 7 subsystems | ✅ Fixed (C3) |
| 4 | `withRetry` ignoring AbortSignal during backoff | ✅ Fixed (H1) |
| 5 | TTL timer blocking process exit | ✅ Fixed (H2) |
| 6 | No compile-time interface drift detection | ✅ Partially fixed (H3, 4/7 covered) |
| 7 | Silent tool path skip in process isolation | ✅ Fixed (H4) |
| 8 | Fragile `===` adapter comparison | ✅ Fixed (H5) |
| 9 | Public setter on adapter/registry (inconsistent) | ✅ Fixed (M-NEW-1) |

---

## §1.  Target State Definition

### 1.1  npm Release Definition

```
npm install @taor/engine @taor/adapters @taor/tools
```

This command must result in a working agent runtime that:
- Runs the TAOR loop with zero errors
- Works with at least two LLM providers (Anthropic + OpenAI)
- Has clear error messages for all common misconfiguration
- Passes CI on every push (Node 20, 22, 24 on ubuntu-latest)
- Has npm provenance attestation
- Has `npm audit` passing at `--audit-level=high`

### 1.2  v0.2.0 Scope

| # | Feature | Priority | Rationale |
|---|---------|----------|-----------|
| 1 | OpenAI adapter (complete) | 🔴 P0 | Single-provider framework = non-viable product |
| 2 | CI green (fix TS6310) | 🔴 P0 | Broken CI = amateur signal |
| 3 | Integration test suite (≥20 cases) | 🔴 P0 | Currently 17 smoke tests, zero TAOR-loop E2E tests |
| 4 | npm publish readiness | 🔴 P0 | metadata, provenance, audit |
| 5 | OpenTelemetry tracing | 🟠 P1 | Production observability baseline |
| 6 | MCP consumer support | 🟡 P2 | Ecosystem interop |
| 7 | Circuit breaker on LLM calls | 🟡 P2 | Resilience for production traffic |
| 8 | Test coverage ≥60% on core paths | 🟠 P1 | Industry minimum |
| 9 | DeepSeek adapter (complete) | 🟢 P3 | 3rd provider, lower priority |
| 10 | Real-world example agent | 🟢 P3 | Onboarding signal |
| 11 | API documentation for new features | 🔴 P0 | Every new public API must be documented |

### 1.3  Explicit Non-Goals for v0.2.0

- **Workflow engine** (Mastra-like DAG/step/resume). Harness is a runtime, not an orchestrator. Users compose workflows externally.
- **Multi-agent orchestration** (swarm/debate/hierarchy). `harness.spawn()` supports independent subagent parallelism, NOT agent-to-agent communication, result aggregation, or workflow orchestration. Those belong to the workflow engine category.
- **Dev UI / Studio**. CLI + OpenTelemetry = sufficient MVP debugging surface.
- **RAG / vector memory**. Memory layer has 3 backends; semantic search is an add-on, not core.
- **Eval framework**. Important but orthogonal. Recommend users use Braintrust / LangSmith / custom evals.
- **Python bindings / dual-language**. TypeScript only.
- **Browser bundle**. Node.js only for v0.2.0.
- **SOC 2 compliance**. Relevant for enterprise but not an OSS framework concern.

---

## §2.  Architecture Decisions (Immutable for TG4)

### AD-1. Dependency Inversion Is Preserved

`@taor/core` MUST NOT runtime-import from any sibling package. All cross-package communication goes through structural interfaces in `harness.ts`. The `as any` bridge in `createHarness()` is the **only** place where structural ↔ canonical type bridging occurs.

**Why**: This is the foundational architecture decision of the project. Breaking it creates circular project references that TypeScript composite builds cannot resolve.

**Enforcement**: `interface-conformance.check.ts` + code review. Any PR that adds `import from "@taor/adapters"` to `packages/core/src/` is rejected.

### AD-2. Every Adapter Follows the Same Pattern

OpenAI, DeepSeek, and future adapters MUST implement the identical `LLMAdapter` interface with the identical streaming pattern:

```
buildRequest() → think() [AsyncGenerator<ThinkEvent>] → formatToolResult() → wrapToolResult()
```

Each adapter is a self-contained module with:
- Model catalog (static `Record<string, ModelInfo>`)
- `static readonly requiredEnvVars: string[]` (declared env vars for `createHarness()` automatic validation)
- `withRetry()` (identical signature across adapters)
- `convertTool()`, `convertMessages()`, `mapStopReason()` (provider-specific)
- `normalizeError()` (provider-specific error → HarnessError)

**Internal implementation pattern**: Interface is unified (`LLMAdapter`), but internal organization may vary by API family. Anthropic-family adapters use self-contained implementation (~730 lines). OpenAI-compatible adapters use a shared `OpenAICompatibleBase` abstract class with thin provider subclasses (model catalog + defaults only). Both patterns are valid under AD-2.

**Why**: Adapter is the most frequently implemented interface. Inconsistency here cascades to every downstream subsystem.

### AD-3. Optional Dependencies Use Dynamic Import

Packages that depend on heavy native bindings (better-sqlite3, @opentelemetry/api) MUST:
1. Declare them in `optionalDependencies`
2. Use `createRequire` / dynamic `import()` with try-catch
3. Fall back gracefully with a descriptive console.error
4. Never crash the process on missing optional dependency

**Why**: Established pattern from SqliteStore. Prevents "it works on my machine" failures.

### AD-4. No `process.exit()` in Library Code — Ever

Only CLI entry points may call `process.exit()`. Library code throws. Framework code returns errors.

**Why**: C1 was the most severe finding in review #1. Already fixed. This is now an **immutable rule**.

### AD-5. Test Infrastructure Is Not an Afterthought

Every new subsystem or adapter ships with:
1. Unit tests (vitest) for pure logic
2. Integration test (createHarness + mock adapter) for TAOR loop paths
3. A smoke marker (`it("should not throw", ...)`) for basic construction

Tests live in `tests/` at the root (not per-package), using vitest workspaces if needed.

**Why**: TG0→TG3 treated testing as optional. TG4 makes it a first-class deliverable.

---

## §3.  Gap-by-Gap Design

---

### GAP-1 (P0): CI Green — Fix TS6310 Composite Project Typecheck

**Root cause**: `tsc --build --noEmit` is semantically incompatible with TypeScript composite project references. When `--build` is used, referenced projects MUST emit declaration files (`.d.ts`) for upstream consumers. `--noEmit` prevents this, causing TS6310 on every referenced project.

The root `package.json` has:
```json
"typecheck": "tsc --build --noEmit"
```

**Design**: Split type-checking into two modes.

**Solution**: Modify root `package.json` scripts:

```json
"typecheck": "tsc --noEmit",
"typecheck:build": "tsc --build --noEmit"
```

Where `tsc --noEmit` (without `--build`) runs type-checking on the root tsconfig which references all projects via `references`. This works because without `--build`, TypeScript treats it as a single-project check with project references treated as type-only.

Wait — this doesn't work either. `tsc --noEmit` with `references` in tsconfig doesn't actually type-check the referenced projects.

**Actual solution**: Per-package typecheck, not composite:

```json
// Root package.json
"typecheck": "for pkg in packages/*/; do (cd $pkg && npx tsc --noEmit) || exit 1; done"
```

Or better, create a root-level `tsconfig.typecheck.json` that includes all source files without composite mode:

```json
// tsconfig.typecheck.json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "composite": false,
    "noEmit": true
  },
  "include": ["packages/*/src/**/*.ts"]
}
```

```json
// package.json
"typecheck": "tsc --project tsconfig.typecheck.json"
```

**Tradeoff**: Loses per-package isolation in type-checking. All source files are type-checked as a single compilation unit, which means `@taor/core` files WILL see `@taor/adapters` types during typecheck. This is actually **desirable** for catching interface drift (H3's goal).

**Files changed**:
- `tsconfig.typecheck.json` (new)
- `package.json` (scripts.typecheck)
- `.github/workflows/ci.yml` — update matrix to `[20, 22, 24]`

**Verification**: `npm run typecheck` exits 0 with zero TS errors. CI matrix passes on all 3 Node versions.

---

### GAP-2 (P0): OpenAI Adapter — Complete Implementation

**Design**: Mirror AnthropicAdapter exactly, adapting for OpenAI's API differences.

**OpenAI SDK**: `openai` v5.x (latest stable). Declared as `optionalDependencies` in `@taor/adapters/package.json`, falling back to dynamic import with clear error.

**Model Catalog**:
```typescript
const MODEL_CATALOG: Record<string, ModelInfo> = {
  "gpt-5": {
    id: "gpt-5", provider: "openai",
    maxInputTokens: 200_000, maxOutputTokens: 128_000,
    supportsThinking: true, supportsVision: true,
    supportsPromptCaching: true, supportsToolUse: true,
    costPer1kInput: 0.00125, costPer1kOutput: 0.010,
  },
  "gpt-4.1": {
    id: "gpt-4.1", provider: "openai",
    maxInputTokens: 1_000_000, maxOutputTokens: 32_000,
    supportsThinking: false, supportsVision: true,
    supportsPromptCaching: true, supportsToolUse: true,
    costPer1kInput: 0.002, costPer1kOutput: 0.008,
  },
  "gpt-4.1-mini": { /* ... */ },
  "gpt-4.1-nano": { /* ... */ },
}
```

**Key differences from Anthropic adapter**:

| Concern | Anthropic | OpenAI |
|---------|-----------|--------|
| SDK import | `@anthropic-ai/sdk` default export | `openai` named `OpenAI` |
| API key env var | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` |
| Streaming param | `stream: true` in `create()` | `stream: true` in `chat.completions.create()` |
| System prompt | Top-level `system` param in `create()` | `{ role: "system", content: "..." }` in messages array |
| Thinking | `thinking: { type: "enabled", budget_tokens: N }` | Not natively supported; use `reasoning_effort` param or omit |
| Tool format | `{ name, description, input_schema }` | `{ type: "function", function: { name, description, parameters } }` |
| SSE events | `message_start/delta/stop` | `chat.completion.chunk` with `delta` |
| Stop reason | `end_turn/max_tokens/tool_use/refusal` | `stop/length/tool_calls/content_filter` |
| Image type | JPEG/PNG/GIF/WebP | JPEG/PNG/GIF/WebP (same) |
| Token counting | `messages.countTokens()` via SDK | `chat.completions.create()` returns `usage` |

**Stream consumption** (OpenAI-specific — note `delta.tool_calls` not `delta.type`):
```typescript
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta
  // Text content — delta.content field, not delta.type
  if (delta?.content) {
    yield { type: "text", content: delta.content }
  }
  // Tool calls — use index for parallel tool call tracking
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const index = tc.index  // parallel tool call key
      const acc = toolBlocks.get(index) ?? {
        id: tc.id ?? "",
        name: tc.function?.name ?? "",
        json: "",
      }
      acc.json += tc.function?.arguments ?? ""
      toolBlocks.set(index, acc)
      // tool_use event yielded on content_block_stop (when finish_reason arrives)
    }
  }
  // Stop reason
  if (chunk.choices[0]?.finish_reason) {
    // Emit accumulated tool use events before stop
    for (const [index, acc] of toolBlocks) {
      yield { type: "tool_use", call: { id: acc.id, name: acc.name, arguments: JSON.parse(acc.json) } }
      toolBlocks.delete(index)
    }
    yield { type: "stop", reason: mapStopReason(chunk.choices[0]!.finish_reason!), usage }
  }
}
```

**Error mapping**:
```typescript
// OpenAI SDK throws APIError subclasses
if (error instanceof OpenAI.APIError) {
  // status: 401/429/500 etc.
  // code: "insufficient_quota", "rate_limit_exceeded", etc.
}
```

**Retry**: Identical `withRetry()` pattern with AbortSignal support. Same retry conditions (429, 5xx, network errors).

**Constructor pattern**:
```typescript
constructor(opts?: {
  apiKey?: string
  baseURL?: string
  model?: string
}) {
  const apiKey = opts?.apiKey ?? process.env["OPENAI_API_KEY"] ?? ""
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY environment variable is required. " +
      "Get your key at https://platform.openai.com/ and set it."
    )
  }
  this.apiKey = apiKey
  this.baseURL = opts?.baseURL
  this.model = opts?.model ?? "gpt-4.1"
}
```

**Adapter env var declaration** (C2 — generic env check):
```typescript
// Each adapter declares required env vars as a static property.
// createHarness() reads this before construction — no hardcoded adapter names.
export class OpenaiAdapter extends OpenAICompatibleAdapter {
  static readonly requiredEnvVars = ["OPENAI_API_KEY"]
  // ...
}
export class AnthropicAdapter implements LLMAdapter {
  static readonly requiredEnvVars = ["ANTHROPIC_API_KEY"]
  // ...
}
export class DeepSeekAdapter extends OpenAICompatibleAdapter {
  static readonly requiredEnvVars = ["DEEPSEEK_API_KEY"]
  // ...
}
```

In `createHarness()`:
```typescript
const AdapterCtor = (config.adapter ?? AnthropicAdapter) as typeof AnthropicAdapter
const requiredVars = (AdapterCtor as any).requiredEnvVars as string[] | undefined
if (requiredVars) {
  for (const v of requiredVars) {
    if (!process.env[v]) {
      throw new Error(`${v} environment variable is required. Get your key and set it.`)
    }
  }
}
```

**Files changed**:
- `packages/adapters/src/openai-compatible-base.ts` (new, ~600 lines — abstract base with shared OpenAI logic)
- `packages/adapters/src/openai.ts` — extends base, ~120 lines
- `packages/adapters/src/anthropic.ts` — add `static readonly requiredEnvVars`
- `packages/adapters/package.json` — add `"openai": "^5.0.0"` to optionalDependencies
- `packages/engine/src/index.ts` — replace hardcoded env check with generic `static requiredEnvVars` loop
- `packages/core/src/env.ts` — update comment

**Verification**:
- `OPENAI_API_KEY="" node -e "..."` → clear error message
- `ANTHROPIC_API_KEY="" node -e "..."` → clear error message
- Smoke test with mock HTTP (vitest mock of `openai` SDK)

---

### GAP-3 (P0): Integration Test Suite

**Current state**: 17 smoke tests in `tests/smoke.test.ts`. These test construction + subsystem injection + basic MockAdapter lifecycle. Missing:
- Turn boundary behavior (what happens between turns)
- Tool execution paths (think→tool_use→act→observe)
- Error recovery in TAOR loop
- Permission approval flow (approval-required → user decision → continue)
- Compressor triggering at token threshold
- Session serialization/deserialization round-trip
- Multiple turns with tool calls
- Abort during various phases

**Design**: Structured integration test taxonomy.

**Test file**: `tests/integration/taor-lifecycle.test.ts`

**Test matrix**:

| # | Test | What it validates |
|---|------|-------------------|
| IT-1 | Basic turn lifecycle | turn-started → thinking → thought → turn-ended sequence |
| IT-2 | Tool execution path | adapter yields tool_use → ACT executes → tool-result → turn-ended |
| IT-3 | Multiple turns | 3 consecutive turns produce correct turn indices |
| IT-4 | Stop after text-only turn | model returns text (no tool calls) → loop terminates |
| IT-5 | Permission approval flow | approval-required event → inject {type:"allow"} → tool executes |
| IT-6 | Permission deny flow | approval-required event → inject {type:"deny"} → tool blocked |
| IT-7 | Error recovery: retry | adapter throws recoverable error → think retries (up to 3) |
| IT-8 | Error recovery: skip_turn | onError hook returns {action:"skip_turn"} → turn skipped |
| IT-9 | Error recovery: abort | onError hook returns {action:"abort"} → session aborted |
| IT-10 | Session abort mid-turn | harness.abort() during THINK → loop stops cleanly |
| IT-11 | Session kill | harness.kill() → immediate stop, no buffered events |
| IT-12 | Session pause/resume | pause() → turn completes → no new turn until resume() |
| IT-13 | Compressor trigger | totalTokens > triggerThreshold → compressed event emitted |
| IT-14 | Serialize/deserialize round-trip | serialize at turn boundary → createHarness with snapshot → resume |
| IT-15 | Max turns limit | session.maxTurns=2 → exactly 2 turns then done |
| IT-16 | Subagent spawn (inline) | harness.spawn() → subagent completes → subagent-result event |
| IT-17 | Memory set/get/delete | harness.memory.session.set() → get() returns value |
| IT-18 | Hook execution order | register 2 hooks (priority 10 and 5) → verify execution order |
| IT-19 | Adapter error event | adapter throws non-recoverable error → error event emitted |
| IT-20 | CLI run smoke | `harness run "test"` → exits 0 with expected output |

**Mock adapter enhancements**: The existing `MockAdapter` in `smoke.test.ts` needs to be extended to support:
- Tool call simulation (specify which tools to "call" in mock)
- Error injection (throw on Nth think call)
- Token usage reporting (configurable)
- Multi-turn scenarios (different responses per turn)

**Shared test fixtures**: Extract `MockAdapter` into `tests/fixtures/mock-adapter.ts`.

**Files changed**:
- `tests/fixtures/mock-adapter.ts` (new — extracted from smoke.test.ts)
- `tests/integration/taor-lifecycle.test.ts` (new — IT-1 through IT-15)
- `tests/integration/subagent.test.ts` (new — IT-16)
- `tests/integration/memory.test.ts` (new — IT-17)
- `tests/integration/hooks.test.ts` (new — IT-18)
- `tests/smoke.test.ts` (refactor — use shared MockAdapter)

**Verification**: `npm run test` passes all tests, including new integration tests. Test count ≥ 35.

---

### GAP-4 (P0): npm Publish Readiness

**Current state**: All packages have `"version": "0.1.0"`, `"private": false` (removed in TG2), correct `exports`/`main`/`types` fields, and `.npmignore` files. But missing:
- `repository`, `keywords`, `license` fields in package.json
- npm provenance setup
- Pre-publish verification script
- `npm audit` gate

**Design**: Publish pipeline with defense-in-depth.

**Package metadata** (each `packages/*/package.json`):
```json
{
  "repository": {
    "type": "git",
    "url": "https://github.com/Tubo2333/taor"
  },
  "keywords": ["ai", "agent", "llm", "claude", "gpt", "typescript", "taor"],
  "license": "MIT",
  "publishConfig": {
    "access": "public",
    "provenance": true
  }
}
```

**Root package.json** additions:
```json
{
  "repository": "https://github.com/Tubo2333/taor",
  "author": "Tubo2333",
  "license": "MIT",
  "engines": { "node": ">=20.0.0" }
}
```

**Pre-publish checklist script** (`scripts/prepublish.sh` — run in CI before publish):
```bash
#!/bin/bash
set -e
echo "=== Build ===" && npm run build
echo "=== Typecheck ===" && npm run typecheck
echo "=== Test ===" && npm run test
echo "=== Audit ===" && npm audit --audit-level=high
echo "=== Pack dry-run ==="
for pkg in packages/*/; do
  (cd "$pkg" && npm pack --dry-run 2>&1 | grep -q "total files" && echo "  $pkg: OK") || exit 1
done
echo "=== ALL CHECKS PASSED ==="
```

**CI publish workflow** (`.github/workflows/publish.yml`):
```yaml
name: Publish
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write   # Required for npm provenance
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22", registry-url: "https://registry.npmjs.org" }
      - run: npm ci
      - run: bash scripts/prepublish.sh
      - run: npm publish --workspaces --provenance  # atomic: all-or-nothing
```

**Package publish order** (dependency-respecting):
```
1. core        (no deps)
2. tools       (depends on core)
3. adapters    (depends on core, tools)
4. permission  (depends on core, tools)
5. hooks       (depends on core, adapters, tools)
6. memory      (depends on core)
7. compressor  (depends on core, adapters)
8. subagent    (depends on core, tools)
9. engine      (depends on all above)
10. cli        (depends on engine)
```

**Files changed**:
- All `packages/*/package.json` — add repository/keywords/license/publishConfig
- `package.json` — add repository/author
- `scripts/prepublish.sh` (new)
- `.github/workflows/publish.yml` (new)
- `.github/workflows/ci.yml` — add `npm audit --audit-level=high` step

**Verification**: `bash scripts/prepublish.sh` exits 0.

---

### GAP-5 (P1): OpenTelemetry Tracing

**Design**: Optional telemetry, implemented via the existing Hook system — ZERO changes to the TAOR loop.

**Architecture decision** (H4 review fix): OpenTelemetry is an **observation layer** realized through hooks, not direct TAOR loop instrumentation. The 13-point hook system already fires at every phase boundary. OTEL spans map 1:1 to hook points.

**Why hooks instead of direct TAOR loop integration?**
- `runTAOR()` is already ~600 lines. Adding span start/end at every phase boundary would push it past 700.
- Hooks are the existing extension mechanism for phase-boundary logic.
- The Hook-based span timing is ~1ms less precise than direct integration — negligible for 99% of observability use cases.

**Implementation**: New package `@taor/telemetry` (optional, per AD-3).

```
@taor/telemetry
├── src/
│   ├── index.ts          — public API
│   └── otel-hooks.ts     — `createOtelHooks(tracer)` → HookInput[]
```

**Core design** — `createOtelHooks()`:
```typescript
// @taor/telemetry/src/otel-hooks.ts
import type { HookInput } from "@taor/hooks"
import type { Tracer, Span } from "@opentelemetry/api"
import { context } from "@opentelemetry/api"

export function createOtelHooks(tracer: Tracer): HookInput[] {
  const spans = new Map<string, Span>()
  return [
    // Session root span
    { hook: "onSessionStart", handler: async (ctx) => {
      const span = tracer.startSpan("Session")
      span.setAttribute("sessionId", ctx.session.id)
      span.setAttribute("model", ctx.session.model)
      spans.set("session", span)
    }},
    { hook: "onSessionEnd", handler: async (ctx, result) => {
      const span = spans.get("session")
      span?.setAttribute("status", result.status)
      span?.setAttribute("turns", result.turns)
      span?.setAttribute("totalTokens", result.tokenUsage.total)
      span?.end()
      spans.delete("session")
    }},

    // THINK phase
    { hook: "beforeThink", priority: 1000, handler: async (ctx) => {
      const span = tracer.startSpan("THINK", { attributes: {
        turnIndex: ctx.turn.index, model: ctx.session.model,
      }})
      spans.set(ctx.turn.id, span)
    }},
    { hook: "afterThink", priority: 0, handler: async (ctx, events) => {
      const span = spans.get(ctx.turn.id)
      span?.setAttribute("turnCount", ctx.session.turnCount)
      span?.end()
      spans.delete(ctx.turn.id)  // M-NEW-1: prevent Map memory leak
    }},

    // ACT phase — per-tool spans
    { hook: "beforeAct", priority: 1000, handler: async (ctx, call) => {
      const span = tracer.startSpan(`tool:${call.name}`)
      span.setAttribute("tool.name", call.name)
      spans.set(call.id, span)
    }},
    { hook: "afterAct", priority: 0, handler: async (ctx, call, result) => {
      const span = spans.get(call.id)
      span?.setAttribute("ok", result.ok)
      span?.setAttribute("duration", result.meta?.duration ?? 0)
      span?.end()
      spans.delete(call.id)  // M-NEW-1
    }},

    // Error span — L-NEW-4: linked to current turn span via OTEL context
    { hook: "onError", priority: 1000, handler: async (ctx, error) => {
      // If a turn span is active, make it the parent via context.with()
      const turnSpan = spans.get(ctx.turn?.id ?? "")
      const parentCtx = turnSpan
        ? context.active().setValue(context.active().getValue(Symbol.for("OpenTelemetry Context Key")), turnSpan)
        : context.active()
      const span = tracer.startSpan("error", {}, parentCtx)
      span.recordException(new Error(error.message))
      span.end()
    }},

    // Compressor span
    { hook: "beforeCompress", priority: 1000, handler: async (ctx, level) => {
      const span = tracer.startSpan("compress")
      spans.set("compress", span)
    }},
    { hook: "afterCompress", priority: 0, handler: async (ctx, event) => {
      const span = spans.get("compress")
      span?.setAttribute("beforeTokens", event.beforeTokens)
      span?.setAttribute("afterTokens", event.afterTokens)
      span?.setAttribute("savingsPercent", event.savingsPercent)
      span?.end()
      spans.delete("compress")  // M-NEW-1
    }},
  ]
}
```

**User integration** — zero TAOR loop changes:
```typescript
import { createOtelHooks } from "@taor/telemetry"
import { trace } from "@opentelemetry/api"

const tracer = trace.getTracer("harness-agent")
const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [],
  hooks: [...createOtelHooks(tracer)],
})
```

**Production exporter**: Users configure OTLP exporter via standard OTEL env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`). Harness does not prescribe an exporter — the `Tracer` is user-provided.

**Files changed**:
- `packages/telemetry/package.json` (new)
- `packages/telemetry/src/index.ts` (new)
- `packages/telemetry/src/otel-hooks.ts` (new — ~100 lines)

**Verification**: Create Harness with `createOtelHooks(tracer)` + console exporter → run basic session → verify spans printed.

---

### GAP-6 (P2): MCP Consumer Support

**Design**: MCP (Model Context Protocol) allows Harness agents to discover and call tools from external MCP servers. This is a **tool source**, not a new subsystem.

**Architecture**: New package `@taor/mcp` that implements:
1. An MCP client (using `@modelcontextprotocol/sdk`)
2. A bridge that converts MCP tools into `ToolDescriptor[]` compatible with `ToolRegistry`

```
┌─────────────────────────────────┐
│         Harness Agent           │
│  ┌───────────────────────────┐  │
│  │     ToolRegistry           │  │
│  │  ┌──────────┐ ┌────────┐  │  │
│  │  │defineTool│ │MCPTool │  │  │
│  │  │  tools   │ │bridge  │  │  │
│  │  └──────────┘ └───┬────┘  │  │
│  └───────────────────┼───────┘  │
│                      │          │
└──────────────────────┼──────────┘
                       │ stdio/SSE
               ┌───────▼──────┐
               │  MCP Server  │
               │  (external)  │
               └──────────────┘
```

**MCPToolBridge**: Wraps an MCP client connection. On `connect()`:
1. Calls `tools/list` to discover available tools
2. Converts each MCP tool schema (JSON Schema) to `ToolDescriptor`
3. `execute()` → calls `tools/call` on the MCP server
4. On `disconnect()` → removes all tools from registry

**H3 review fix — process cleanup**: The MCP bridge MUST clean up child processes on harness abort/crash. Design:

```typescript
// @taor/mcp — MCPToolBridge
export class MCPToolBridge {
  private client: Client
  private descriptors: ToolDescriptor[] = []
  private abortController?: AbortController
  private childProcess?: ChildProcess

  async connect(config: MCPServerConfig): Promise<ToolDescriptor[]> {
    this.abortController = new AbortController()
    // 1. Create transport (stdio spawns child process, or SSE connects to URL)
    // 2. Connect client with AbortSignal
    // 3. Discover tools via tools/list
    // 4. Convert to ToolDescriptors
    // 5. Register process.on("exit") cleanup: kill child process on harness exit
    process.on("exit", () => this.disconnect())
    // 6. Return for ToolRegistry.register()
  }

  async disconnect(): Promise<void> {
    this.abortController?.abort()     // cancel pending MCP requests
    this.childProcess?.kill("SIGTERM") // clean up stdio child process
    await this.client.close()
    for (const desc of this.descriptors) {
      this.registry?.remove(desc.name)  // unregister tools
    }
  }
}
```

This prevents MCP server zombie processes when the harness process crashes or is killed.

**MCP server config**:
```typescript
interface MCPServerConfig {
  name: string           // friendly name
  command?: string       // for stdio transport
  args?: string[]
  url?: string           // for SSE transport
  timeout?: number       // tool call timeout
}
```

**Integration with createHarness**: User passes MCP config to `createHarness()`:
```typescript
const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [myTool],
  mcp: [
    { name: "filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
  ],
})
```

`createHarness()` initializes MCP bridges, discovers tools, and registers them into the ToolRegistry before returning.

**Files changed**:
- `packages/mcp/package.json` (new)
- `packages/mcp/src/index.ts` (new)
- `packages/mcp/src/bridge.ts` (new)
- `packages/mcp/src/types.ts` (new)
- `packages/core/src/unresolved.ts` — add `MCPConfig` stub
- `packages/engine/src/index.ts` — MCP initialization in createHarness

**Verification**: Integration test with a mock MCP server (in-process stdio) that exposes one tool → agent calls it.

---

### GAP-7 (P2): Circuit Breaker

**Design**: Decorator pattern wrapping LLMAdapter. Resides in `@taor/adapters`.

**States**: CLOSED → OPEN → HALF_OPEN → CLOSED (standard 3-state breaker).

```
CLOSED ──[N failures in window]──→ OPEN
OPEN   ──[timeout elapsed]───────→ HALF_OPEN
HALF_OPEN ──[success]────────────→ CLOSED
HALF_OPEN ──[failure]────────────→ OPEN
```

**Configuration**:
```typescript
interface CircuitBreakerConfig {
  failureThreshold: number     // failures before opening (default: 5)
  recoveryTimeout: number      // ms before trying half-open (default: 30_000)
  halfOpenMaxRequests: number  // max requests in half-open (default: 1)
  windowDuration: number       // sliding window for failure counting (default: 60_000)
}
```

**Implementation**: `CircuitBreakerAdapter` implements `LLMAdapter`, wraps any `LLMAdapter`:

```typescript
export class CircuitBreakerAdapter implements LLMAdapter {
  constructor(
    private inner: LLMAdapter,
    private config: CircuitBreakerConfig = DEFAULTS,
  ) {}

  async *think(request: AdapterRequest, signal: AbortSignal): AsyncGenerator<ThinkEvent> {
    if (this.state === "OPEN") {
      if (Date.now() - this.openedAt < this.config.recoveryTimeout) {
        throw new CircuitBreakerOpenError(this.config.recoveryTimeout)
      }
      this.state = "HALF_OPEN"
    }

    try {
      yield* this.inner.think(request, signal)
      this.onSuccess()
    } catch (err) {
      this.onFailure()
      throw err
    }
  }
  // ... delegate all other methods to inner
}
```

**Why a decorator?** Not a separate subsystem. The circuit breaker is an adapter concern — it sits between the TAOR loop and the LLM provider. Decorator pattern preserves the `LLMAdapter` interface without changing Harness core.

**H5 review fix — auto-wrap via HarnessConfig**: Manual wrapping is verbose. `HarnessConfig` gets an optional field that `createHarness()` auto-wraps:

```typescript
// HarnessConfig addition:
circuitBreaker?: CircuitBreakerConfig | false  // false = explicit opt-out
```

```typescript
// createHarness() auto-wrapping:
const rawAdapter = new AdapterCtor({ model: resolved.model })
const adapter = resolved.circuitBreaker !== false && resolved.circuitBreaker
  ? new CircuitBreakerAdapter(rawAdapter, resolved.circuitBreaker)
  : rawAdapter
```

User usage (80% case — one line):
```typescript
createHarness({
  model: "claude-sonnet-4-6",
  circuitBreaker: { failureThreshold: 5 },  // auto-wrapped
})
```

Manual wrapping still supported for full control:
```typescript
createHarness({
  adapter: (opts) => new CircuitBreakerAdapter(new AnthropicAdapter(opts), { failureThreshold: 10 }),
  circuitBreaker: false,  // disable auto-wrap
})
```

**Files changed**:
- `packages/adapters/src/circuit-breaker.ts` (new)
- `packages/adapters/src/index.ts` — export CircuitBreakerAdapter
- `packages/adapters/src/types.ts` — add CircuitBreakerConfig type

**Verification**: Unit test: inject failures → verify breaker opens → wait → verify half-open → success → verify closed.

---

### GAP-8 (P1): Test Coverage ≥60% on Core Paths

**Design**: vitest coverage with c8 provider. Target: 60% line coverage on packages/core/src/harness.ts, packages/engine/src/index.ts, packages/adapters/src/anthropic.ts.

**Configuration** (`vitest.config.ts`):
```typescript
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    retry: 2,  // M3: mitigate CI flakiness from timeouts/race conditions
    coverage: {
      provider: "v8",
      include: [
        "packages/core/src/harness.ts",
        "packages/core/src/config.ts",
        "packages/engine/src/index.ts",
        "packages/adapters/src/anthropic.ts",
        "packages/adapters/src/openai.ts",
      ],
      thresholds: {
        lines: 60,
        branches: 50,
        functions: 60,
        statements: 60,
      },
    },
  },
})
```

**CI integration**: Add `npm run test:coverage` step in CI (non-blocking initially, informational only until thresholds are met).

**Verification**: `npm run test:coverage` reports ≥60% line coverage on specified paths.

---

### GAP-9 (P3): DeepSeek Adapter — Complete Implementation

**Design** (H2 review fix — base class FIRST, then subclasses):

**Implementation order**:
1. Write `openai-compatible-base.ts` (abstract class, ~600 lines) — ALL shared logic
2. Write `openai.ts` (extends base, ~120 lines — just defaults + model catalog)
3. Write `deepseek.ts` (extends base, ~50 lines — just defaults + model catalog)
4. Test both subclasses together to validate base class correctness
5. Regression test: AnthropicAdapter still compiles (no base class extraction damage)

This order is critical: extracting base class AFTER writing openai.ts is a refactoring operation with risk of introducing bugs. Writing base class FIRST is a design operation — safer.

```
packages/adapters/src/
├── openai-compatible-base.ts  (NEW — abstract, ~600 lines, ALL shared logic)
├── openai.ts                  (extends base, ~120 lines, defaults + model catalog)
├── deepseek.ts                (extends base, ~50 lines, defaults + model catalog)
└── anthropic.ts               (unchanged — different API shape)
```

**Base class** (`OpenAICompatibleAdapter`):
```typescript
export abstract class OpenAICompatibleAdapter implements LLMAdapter {
  abstract readonly provider: string
  static readonly requiredEnvVars: string[]  // set by subclass

  constructor(protected config: {
    apiKey: string
    baseURL: string
    model: string
  }) {
    if (!config.apiKey) throw new Error(/* ... */)
  }

  // All the shared logic: buildRequest, think, formatToolResult, etc.
  // Subclass only sets provider + default config values.
}
```

**Subclass example**:
```typescript
// openai.ts
export class OpenaiAdapter extends OpenAICompatibleAdapter {
  static readonly requiredEnvVars = ["OPENAI_API_KEY"]
  readonly provider = "openai"

  constructor(opts?: { apiKey?: string; baseURL?: string; model?: string }) {
    super({
      apiKey: opts?.apiKey ?? process.env["OPENAI_API_KEY"] ?? "",
      baseURL: opts?.baseURL ?? "https://api.openai.com/v1",
      model: opts?.model ?? "gpt-4.1",
    })
  }
}
```

**Files changed**:
- `packages/adapters/src/openai-compatible-base.ts` (new, ~600 lines — abstract base)
- `packages/adapters/src/openai.ts` — subclass (~120 lines)
- `packages/adapters/src/deepseek.ts` — subclass (~50 lines)
- `packages/adapters/src/index.ts` — export new classes

**Verification**: OpenAI smoke test + DeepSeek smoke test + Anthropic regression test (3 smoke tests total).

---

### GAP-10 (P3): Real-World Example Agent

**Design**: A concrete example that solves a real task, demonstrating the framework's capabilities.

**Suggested examples** (choose one for v0.2.0):

| Example | Complexity | Demonstrates |
|---------|------------|-------------|
| **Code Reviewer Agent** | Medium | Tools (file read/write), multi-turn, HITL approval |
| **Research Assistant** | Medium | Tools (web search, file read), subagent spawn, memory |
| **CLI Assistant** | Low | Tools (bash exec), permission boundary, compressor trigger |
| **Multi-provider Chat** | Low | OpenAI + Anthropic adapter swap, adapter comparison |

**Recommended for v0.2.0**: Code Reviewer Agent.

```
examples/code-reviewer/
├── agent.ts          — createHarness + tool definitions
├── tools/
│   ├── read-file.ts  — readFile tool
│   ├── grep.ts       — grep tool
│   └── write-file.ts — writeFile tool (requires approval)
├── hooks/
│   └── budget.ts     — token budget hook (abort if > $5)
└── README.md         — step-by-step walkthrough
```

**Files changed**: `examples/code-reviewer/*` (new directory, ~5 files).

**L4 review fix — README completion criteria**: The example's `README.md` must document three steps a new user can follow to verify success:
1. `npm install` → install dependencies
2. `npx tsx examples/code-reviewer/agent.ts --dir ./src` → run against a directory
3. Verify output: agent reads files, proposes changes with reasoning, respects HITL approval for write-file

**Verification**: Run the example against its own source directory → produces review comments in ≤3 turns.

---

### GAP-11 (P0): API Documentation for New Features

**Design**: Every new public API in v0.2.0 MUST have a corresponding `docs/api/*.md` file matching the existing 7-doc pattern. Without this, the npm publish is incomplete.

**New docs required**:

| Doc | Covers | Est. |
|-----|--------|------|
| `docs/api/openai-adapter.md` | Construction, model catalog (gpt-5, gpt-4.1, gpt-4.1-mini, gpt-4.1-nano), env key setup, switching from Anthropic | 30 min |
| `docs/api/deepseek-adapter.md` | Construction, model catalog (deepseek-chat, deepseek-reasoner), OpenAI compatibility notes | 20 min |
| `docs/api/circuit-breaker.md` | State machine (CLOSED→OPEN→HALF_OPEN), configuration, auto-wrap vs manual, error type | 30 min |
| `docs/api/telemetry.md` | `createOtelHooks()`, OTLP exporter setup, span structure, sampling config, console exporter for dev | 30 min |
| `docs/api/mcp.md` | MCP server config (stdio vs SSE), `createHarness({mcp: [...]})`, tool discovery, process cleanup | 30 min |

**Updated existing docs**:
- `README.md` — add v0.2.0 feature matrix
- `CHANGELOG.md` — add v0.2.0 entry
- `docs/quickstart.md` — add OpenAI adapter quick start
- `docs/api/harness.md` — add `circuitBreaker` and `mcp` config fields
- `docs/api/tools.md` — add MCP as a tool source
- `docs/api/adapters.md` — update to include OpenAI + DeepSeek (or create this file)

**Files changed**: `docs/api/*.md` (5 new, 6 updated).

**Verification**: Every `docs/api/*.md` file has: one-line description → type signatures → code example → configuration table.

---

## §4.  Implementation Phases

### Phase 0: Foundation (P0 only — blocks publish)

GAP-1, GAP-2, GAP-3, GAP-4, GAP-11 are all mutually independent and can run in parallel.

| Gap | Item | Est. | Depends On |
|-----|------|------|------------|
| GAP-1 | CI green (TS6310 fix + Node 20/22/24 matrix) | 1h | nothing |
| GAP-2 | OpenAI adapter (base class first) | 6-8h | nothing |
| GAP-3 | Integration test suite (IT-1 through IT-20) | 8-10h | nothing |
| GAP-4 | npm publish readiness | 1h | nothing |
| GAP-11 | API documentation (5 new + 4 updated) | 2h | nothing |

**Phase 0 gate**: CI green on Node 20/22/24 + ≥35 tests passing + OpenAI adapter smoke test + 3 adapter regression tests + 5 new API docs complete + `npm pack --dry-run` clean (12 packages).

### Phase 1: Production Hardening (P1)

GAP-5 and GAP-8 are mutually independent (OTEL via hooks doesn't need coverage data, coverage doesn't need OTEL).

| Gap | Item | Est. | Depends On |
|-----|------|------|------------|
| GAP-5 | OpenTelemetry tracing (hook-based) | 3h | Phase 0 |
| GAP-8 | Test coverage ≥60% | 3-5h | GAP-3 |

**Phase 1 gate**: Coverage report ≥60% on core paths + OTEL spans visible in console exporter.

### Phase 2: Ecosystem (P2)

GAP-6 and GAP-7 are mutually independent.

| Gap | Item | Est. | Depends On |
|-----|------|------|------------|
| GAP-6 | MCP consumer support | 6h | Phase 0 |
| GAP-7 | Circuit breaker | 2h | Phase 0 |

**Phase 2 gate**: MCP integration test passes + circuit breaker unit test passes.

### Phase 3: Polish (P3)

GAP-9 depends on the adapter base class from GAP-2 being complete. GAP-10 stands alone.

| Gap | Item | Est. | Depends On |
|-----|------|------|------------|
| GAP-9 | DeepSeek adapter (extends base class) | 5-6h | GAP-2 |
| GAP-10 | Real-world example (code reviewer) | 3h | Phase 0 |

**Phase 3 gate**: 3 adapter smoke tests pass (Anthropic + OpenAI + DeepSeek) + code reviewer example runs in ≤3 turns.

### Total: ~40-45 hours (revised from 32h per design review)

### Parallelization within phases

Phase 0 items are independent → 5 agents can work in parallel. Phases 1-3 each have 2 independent items → 2 agents per phase. With 2-5 parallel agents, wall-clock time is closer to **15-20 hours**.

---

## §5.  Package Dependency Graph (v0.2.0)

```
                         @taor/telemetry (NEW, optional)
                              ↓ (decorates)
@taor/adapters ──→ @taor/core ──→ @taor/tools
(Anthropic/OpenAI/     (TAOR loop)       (defineTool/Tool)
 DeepSeek/CB)               ↓
                    @taor/permission
                    @taor/hooks
                    @taor/memory
                    @taor/compressor
                    @taor/subagent
                         ↓
                    @taor/mcp (NEW, optional)
                         ↓
                    @taor/engine
                         ↓
                    @taor/cli
```

**New packages**: `@taor/telemetry` (P1), `@taor/mcp` (P2). Both are **optional** — not in the engine dependency tree by default.

---

## §6.  Verification Gates

Each phase has a mandatory verification gate. No phase is "done" until its gate passes.

### Gate 0 (blocks npm publish):
- [x] `npm run build` exits 0
- [x] `npm run typecheck` exits 0 (zero TS errors)
- [x] `npm run test` exits 0 (45 tests ≥ 35)
- [x] `npm audit --audit-level=high --omit=dev` exits 0 (0 production vulns)
- [x] `OPENAI_API_KEY=""` → generic env check prints clear error
- [x] `ANTHROPIC_API_KEY=""` → generic env check prints clear error
- [x] `npm pack --dry-run` shows correct files for all 12 packages
- [x] API docs: 5 new docs (openai-adapter, deepseek-adapter, circuit-breaker, telemetry, mcp) + 3 updated (README, CHANGELOG, quickstart)
- [x] CI workflow YAML verified (ci.yml: Node 20/22/24 matrix, build+typecheck+test) — pending GitHub Actions push trigger

### Gate 1 (hardening):
- [x] `npm run test:coverage` reports ≥50% lines globally (50.04%), all 3 core paths ≥60%: harness.ts 68.77%, engine/index.ts 90.41%, anthropic.ts 60.15%
- [x] OTEL hooks span lifecycle verified: 10 tests, 5 span types (Session/THINK/tool/compress/error) created+ended correctly

### Gate 2 (ecosystem):
- [x] MCP integration test: agent discovers + calls tool from mock MCP server
- [x] Circuit breaker: unit test verifies CLOSED→OPEN→HALF_OPEN→CLOSED cycle

### Gate 3 (polish):
- [x] DeepSeek adapter smoke test passes (10 unit tests + real API call: "Hello!" in 12 tokens)
- [x] Code reviewer example runs against its own source directory

---

## §7.  Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| OpenAI SDK v5 API shape differs from assumptions | Medium | High | Pin `openai@^5.0.0` + read SDK docs during implementation |
| MCP SDK unstable API | Medium | Low | Pin `@modelcontextprotocol/sdk` version, isolate behind bridge |
| OTEL dependency too heavy for some users | Low | Medium | Optional dependency + separate package (AD-3) |
| Integration tests fragile (mock complexity) | Medium | Medium | Extract MockAdapter into shared fixture, keep mocks simple |
| TS6310 fix has unexpected side effects | Low | High | Test on CI matrix (Node 20 + 22 + 24) |
| Interface drift during adapter refactor | Low | High | `interface-conformance.check.ts` catches it at compile time |
| MCP server process zombies (harness crash) | Medium | High | MCPToolBridge: AbortSignal + `process.on("exit")` kill child (H3 fix) |
| CI matrix coverage too narrow (only Node 22) | Medium | Medium | Matrix updated to `[20, 22, 24]` (M2 fix) |
| Integration tests flaky in CI (timeout/race) | Medium | Medium | vitest `retry: 2` (M3 fix) |

---

## §8.  Post-v0.2.0 Roadmap (NOT in TG4 scope)

These are documented for architectural continuity only. They are NOT commitments for v0.2.0.

| Item | Why deferred |
|------|-------------|
| Workflow engine (DAG/step/resume/version) | Different product category. Harness is a runtime, not an orchestrator. |
| Dev UI / Studio | Separate frontend project. Harness exposes APIs; UI consumes them. |
| RAG / vector memory | Semantic search in memory layer. Needs embedding adapter + vector store abstraction. |
| Eval framework | Orthogonal concern. Existing tools (Braintrust, LangSmith) are better positioned. |
| MCP Server mode | Expose Harness tools as MCP server. Inverse of GAP-6. |
| Browser bundle | ESM/CJS is sufficient. Browser requires streaming polyfills + worker isolation. |
| Multi-tenant scheduling | Enterprise feature. Requires queue, priority, rate limiting infrastructure. |
| Python bindings | Separate language = separate project. |
| interface-conformance: 6/7 coverage | Currently 4/7. Adding IPermissionEngine + ISubagentCoordinator requires relaxing their structural signatures (mapped types → looser generics). Planned for v0.3.0 when the interface pattern stabilizes. |
| Multi-agent orchestration | `harness.spawn()` supports independent subagents, NOT agent-to-agent communication, result aggregation, or DAG workflow orchestration. Full orchestration is a separate product category. |
