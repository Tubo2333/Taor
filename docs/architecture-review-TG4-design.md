# Architecture Review: TG4 Production Release Design

**Review date**: 2026-06-13
**Reviewer**: 独立 TypeScript AI Agent 框架架构专家（零项目上下文）
**Scope**: `docs/design/TG4-production-release-design.md` — 953 行设计文档
**Verdict**: **APPROVE_WITH_FIXES** — 5 Blocking 修复后即可进入 Phase 0

---

## §A. 完整性 — 10 Gaps 是否足够？

### 遗漏的关键 Gap

**C1 (CRITICAL) — 缺少新功能 API 文档计划**

v0.2.0 新增：2 个 package (`telemetry`, `mcp`)、1 个 adapter (`openai`)、1 个 decorator (`CircuitBreaker`)、1 个重构 (`OpenAI-compatible base`)。当前 `docs/api/` 有 7 个文件覆盖 TG3 子系统——所有新功能需要同等 API 文档。

**修复**: 新增 **GAP-11 (P0): API 文档更新**，2h 工作量。

| 新功能 | 文档文件 | 内容 |
|--------|---------|------|
| OpenAI adapter | `docs/api/openai-adapter.md` | 构造、model catalog、env key、与 Anthropic 切换 |
| OpenTelemetry | `docs/api/telemetry.md` | 安装、配置 exporter、span 结构、sampling |
| MCP | `docs/api/mcp.md` | 配置 MCP server、工具发现、stdio vs SSE |
| Circuit Breaker | `docs/api/circuit-breaker.md` | 状态机、配置、集成方式 |
| DeepSeek adapter | `docs/api/deepseek-adapter.md` | 构造、model catalog、与 OpenAI 的差异 |

+ 更新 `docs/README.md` 索引 + `CHANGELOG.md` v0.2.0 条目。

---

## §B. 设计合理性

### C2 (CRITICAL) — `createHarness` 的 env key 检查硬编码 adapter 类型

**当前设计** (§GAP-2 "Files changed"): "add OpenAI key check (parallel to Anthropic check)"。`createHarness` 用 `instanceof AnthropicAdapter` 判断需要哪个 env var。Anthropic + OpenAI + DeepSeek 三个 adapter 会导致 if-else 链。

**修复**: Adapter 声明自己需要的 env var，`createHarness` 通用检查。

```typescript
// packages/adapters/src/types.ts — 加在 LLMAdapter 接口旁
export interface LLMAdapterConstructor {
  new(opts?: { apiKey?: string; baseURL?: string; model?: string }): LLMAdapter
  /** Env vars required by this adapter. createHarness() checks these before construction. */
  readonly requiredEnvVars?: string[]
}
```

```typescript
// packages/adapters/src/anthropic.ts
export class AnthropicAdapter implements LLMAdapter {
  static readonly requiredEnvVars = ["ANTHROPIC_API_KEY"]
  // ...
}

// packages/adapters/src/openai.ts
export class OpenaiAdapter extends OpenAICompatibleAdapter {
  static readonly requiredEnvVars = ["OPENAI_API_KEY"]
  // ...
}

// packages/adapters/src/deepseek.ts
export class DeepSeekAdapter extends OpenAICompatibleAdapter {
  static readonly requiredEnvVars = ["DEEPSEEK_API_KEY"]
  // ...
}
```

```typescript
// packages/engine/src/index.ts — createHarness 中替换硬编码检查:
const AdapterCtor = (config.adapter ?? AnthropicAdapter) as typeof AnthropicAdapter
const requiredVars = (AdapterCtor as any).requiredEnvVars as string[] | undefined
if (requiredVars) {
  for (const v of requiredVars) {
    if (!process.env[v]) {
      throw new Error(
        `${v} environment variable is required for ${AdapterCtor.name}. ` +
        `Get your key and set it:\n  export ${v}=...`
      )
    }
  }
}
```

删除 `validateEnv()` 中只检查 `ANTHROPIC_API_KEY` 的硬编码逻辑（或将其改为接受参数）。

---

### H1 (HIGH) — OpenAI 流式 tool call delta 结构描述错误

**当前设计** (§GAP-2 流消费伪代码):
```typescript
switch (chunk.choices[0]?.delta?.type) {  // ← 不存在 delta.type
  case "tool_call": accumulate partial JSON
}
```

OpenAI 的流式 delta 不通过 `delta.type` 区分——`delta.content` (text) 和 `delta.tool_calls` (tool calls) 是 delta 对象上的不同字段。

**修复**: 更新设计文档的伪代码:

```typescript
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta
  // Text content
  if (delta?.content) {
    yield { type: "text", content: delta.content }
  }
  // Tool calls — use index for parallel tool call tracking
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const index = tc.index  // ← 并行 tool call 追踪 key
      const acc = toolBlocks.get(index) ?? { id: tc.id ?? "", name: tc.function?.name ?? "", json: "" }
      acc.json += tc.function?.arguments ?? ""
      toolBlocks.set(index, acc)
      // 当 tool call 完成时（finish_reason === "tool_calls"）yield tool_use event
    }
  }
  // Stop reason
  if (chunk.choices[0]?.finish_reason) {
    yield { type: "stop", reason: mapStopReason(chunk.choices[0].finish_reason), usage }
  }
}
```

---

### H4 (HIGH) — OTEL 直接集成 TAOR loop 会污染 harness.ts

`runTAOR()` 当前 ~600 行。直接加 `this._telemetry?.startSpan(...)` / `span.end()` 在 phase 边界会使方法更长更难维护。

**替代方案（推荐）**: 用 existing Hook 系统实现 OTEL，零 TAOR loop 改动:

```typescript
// @taor/telemetry/src/otel-hooks.ts
import type { HookInput } from "@taor/hooks"
import type { Tracer } from "@opentelemetry/api"

export function createOtelHooks(tracer: Tracer): HookInput[] {
  const spans = new Map<string, Span>()
  return [
    { hook: "beforeThink", priority: 1000, handler: async (ctx) => {
      const span = tracer.startSpan("THINK", { attributes: { turnIndex: ctx.turn.index } })
      spans.set(ctx.turn.id, span)
    }},
    { hook: "afterThink", priority: 0, handler: async (ctx, events) => {
      spans.get(ctx.turn.id)?.end()
    }},
    { hook: "beforeAct", priority: 1000, handler: async (ctx, call) => {
      const span = tracer.startSpan(`tool:${call.name}`)
      spans.set(call.id, span)
    }},
    { hook: "afterAct", priority: 0, handler: async (ctx, call, result) => {
      const span = spans.get(call.id)
      span?.setAttribute("ok", result.ok)
      span?.end()
    }},
    { hook: "onError", priority: 1000, handler: async (ctx, error) => {
      const span = tracer.startSpan("error")
      span.recordException(new Error(error.message))
      span.end()
    }},
  ]
}
```

用户使用:
```typescript
const harness = createHarness({
  model: "claude-sonnet-4-6",
  hooks: [...createOtelHooks(tracer)],
})
```

**权衡**: Hook-based span 的 start/end 时间点比直接集成略不精确（hook 在 TAOR 逻辑之前/之后执行，而非 exactly at boundary）。对于 99% 的可观测性场景，这个精度损失是可接受的。如果需要微秒精度 timing，再用直接集成。

---

### H5 (HIGH) — Circuit breaker 集成 UX 需要手动包装

当前设计需要用户写 `adapter: (opts) => new CircuitBreakerAdapter(new AnthropicAdapter(opts))`。

**替代方案**: `HarnessConfig` 加可选字段，`createHarness` 自动包装:

```typescript
// HarnessConfig 新增:
circuitBreaker?: CircuitBreakerConfig | false  // false = 显式禁用
```

```typescript
// createHarness 中:
const rawAdapter = new AdapterCtor({ model: resolved.model })
const adapter = resolved.circuitBreaker !== false && resolved.circuitBreaker
  ? new CircuitBreakerAdapter(rawAdapter, resolved.circuitBreaker)
  : rawAdapter
```

用户使用:
```typescript
createHarness({
  model: "claude-sonnet-4-6",
  circuitBreaker: { failureThreshold: 5 },  // 自动包装
})
```

这保留了手动包装的能力（传 `circuitBreaker: false` + 自己的 adapter factory），同时为 80% 的用户提供了一行配置。

---

### H2 (HIGH) — GAP-9 base class 提取有重构风险

当前设计路径: 先写完 `openai.ts` (600 行) → 再 extract 到 `openai-compatible-base.ts` → 再写 `deepseek.ts`。

**风险**: 提取 base class 是重构操作——移动 600 行代码、重命名引用、重新测试。如果 `openai.ts` 在提取前已经通过测试，提取后可能引入 bug。

**修复**: 调整实现顺序 —— **先写 base class，再写 OpenAI subclass**:

1. 写 `openai-compatible-base.ts` (抽象类，~600 行)
2. 写 `openai.ts` (extends base，只设 defaults，~120 行)
3. 写 `deepseek.ts` (extends base，只设 defaults，~50 行)
4. 测试 OpenAI + DeepSeek subclass 同时验证 base class 正确性

**额外**: Gate 0 新增——AnthropicAdapter mock 单元测试确保 adapter 类型定义未被 base class 提取破坏。

---

## §C. 架构一致性

### AD-2 补充建议

AD-2 要求 "Every adapter follows the same pattern"。当前 AnthropicAdapter 是自包含单体（730 行），OpenAI 系列是 base class + 2 层继承（600+120+50 行）。两者在 `LLMAdapter` 接口层面一致，但内部实现模式不同。这不违反 AD-2，但文档应明确。

**修复**: AD-2 补充一句：
> *接口统一（LLMAdapter），实现可根据 provider API 族选择 self-contained（Anthropic 系）或 base-class（OpenAI-compatible 系）模式。*

---

## §D. 可行性 — 时间估计修正

| Gap | 设计估计 | 修正估计 | 原因 |
|-----|---------|---------|------|
| GAP-1 | 0.5h | 1h | CI matrix 加 Node 20/24 |
| GAP-2 | 4h | 6-8h | 流式 tool call 细节 + 所有 OpenAI 错误码映射 |
| GAP-3 | 6h | 8-10h | 20 tests + MockAdapter 提取 + 4 test files |
| GAP-4 | 0.75h | 1h | 10 个 package.json |
| GAP-5 | 4h | 3h | 用 Hook 方案（推荐）减少耗时 |
| GAP-6 | 6h | 6h | — |
| GAP-7 | 2h | 2h | — |
| GAP-8 | 3h | 3-5h | 取决于现有覆盖率 |
| GAP-9 | 3h | 5-6h | Base class 先写策略（更安全但略多） |
| GAP-10 | 3h | 3h | — |
| GAP-11 (新) | — | 2h | API 文档 |
| **总计** | **~32h** | **~40-45h** | |

### 并行化建议

Phase 内放宽为并行：

```
Phase 0: GAP-1 ∥ GAP-2 ∥ GAP-3 ∥ GAP-4 ∥ GAP-11  (所有 P0 并行)
Phase 1: GAP-5 ∥ GAP-8                               (OTEL 和 coverage 互不依赖)
Phase 2: GAP-6 ∥ GAP-7                               (MCP 和 CB 互不依赖)
Phase 3: GAP-9 → GAP-10                              (DeepSeek 依赖 GAP-2 完成，但可提前写 base class)
```

---

## §E. 风险补充

### 新增风险项（补入 §7）

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| MCP server 进程残留 (harness crash) | Medium | High | MCPToolBridge 加 `AbortSignal` + `process.on("exit")` kill child |
| CI matrix 版本覆盖不足 (仅 Node 22) | Medium | Medium | GAP-1 更新 matrix 为 `[20, 22, 24]` |
| 集成测试在 CI 脆弱 (timeout/race) | Medium | Medium | vitest `retry: 2` |
| npm publish 非原子 (部分成功) | Low | Medium | `npm publish --workspaces` |

---

## §F. 非目标补充

§1.3 追加一条显式非目标：

> - **Multi-agent orchestration** (swarm/debate/hierarchy). 当前 `harness.spawn()` 支持独立 subagent 并行，不支持 agent 间通信、结果聚合、workflow 编排。属于 workflow engine 范畴。

---

## §G. 修改清单

### Blocking（Phase 0 前必须完成设计修改）

| ID | 严重级 | 修改内容 | 涉及文档章节 |
|----|--------|---------|-------------|
| **C1** | CRITICAL | 新增 GAP-11 (API 文档更新)，2h 工作量 | 新增 §3 |
| **C2** | CRITICAL | Adapter 声明 `static requiredEnvVars: string[]`，createHarness 通用 env 检查，替代硬编码 | §3 GAP-2, packages/engine/src/index.ts |
| **H1** | HIGH | 修正 OpenAI stream tool call delta 结构描述（`delta.tool_calls` 而非 `delta.type`） | §3 GAP-2 伪代码 |
| **H2** | HIGH | GAP-9 实现顺序改为"先 base class 后 subclass"；Gate 0 加 AnthropicAdapter 回归测试 | §3 GAP-9, §6 Gate 0 |
| **H3** | HIGH | MCPToolBridge 加进程清理设计（AbortSignal + disconnect → kill child） | §3 GAP-6 |

### Non-blocking（实现中处理）

| ID | 严重级 | 修改内容 | 涉及文档章节 |
|----|--------|---------|-------------|
| **H4** | HIGH | OTEL 改为 Hook 实现（`createOtelHooks(tracer)`），零 TAOR loop 改动 | §3 GAP-5 |
| **H5** | HIGH | `HarnessConfig.circuitBreaker?: CircuitBreakerConfig \| false`，createHarness 自动包装 | §3 GAP-7 |
| **M1** | MEDIUM | 工作量估计更新为 40-45h，Phase 内并行化 | §4 |
| **M2** | MEDIUM | CI matrix 加 Node 20, 24 | §3 GAP-1, .github/workflows/ci.yml |
| **M3** | MEDIUM | vitest `retry: 2` 配置 | §3 GAP-3 |
| **M4** | MEDIUM | AD-2 补充说明两种内部实现模式可并存 | §2 AD-2 |
| **M5** | MEDIUM | §1.3 追加 multi-agent orchestration 非目标 + §8 追加 interface-conformance 6/7 roadmap | §1.3, §8 |
| **L1** | LOW | DeepSeekAdapter `provider` 改为 base class `abstract readonly provider` | §3 GAP-9 |
| **L2** | LOW | npm publish 改为 `npm publish --workspaces` 原子发布 | §3 GAP-4 |
| **L3** | LOW | OTEL 文档补充生产 exporter 配置说明（OTLP endpoint） | §3 GAP-5 |
| **L4** | LOW | Code reviewer 示例定义 README 完成标准（install→run→output 三步走） | §3 GAP-10 |

---

## 总体评价

**Verdict: APPROVE_WITH_FIXES**

设计质量 80/100。核心架构判断全部正确：OTEL 独立包、MCP 为工具源、CB 为 decorator、base class 方案。10 个 Gap 覆盖了发布必需能力的 80%。主要扣分在：文档计划缺失、env 抽象不可扩展、OpenAI delta 结构错误、重构风险未管理。

5 个 Blocking 修复预计 3-4 小时设计修改——完成后即可进入 Phase 0 实现。
