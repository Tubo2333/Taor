# Architecture Review: TG4 Design v2 — Review #2 修复验证

**Review date**: 2026-06-13
**Reviewer**: 同一架构专家（第二次审查，可对比 v1）
**Scope**: `git diff 996fc04..c7e556e` — TG4 设计文档 +374/−98 行
**Verdict**: **APPROVE** — 免修进入 Phase 0，6 Non-blocking 顺手处理

---

## 修复验证：19/19 全部通过

### Blocking（5/5 ✅）

| ID | 修复项 | 验证 |
|----|--------|------|
| C1 | 新增 GAP-11 文档计划 | §3 + §1.2 #11，5 新 + 4 更新，2h |
| C2 | `static requiredEnvVars` | AD-2 + GAP-2 + GAP-9，createHarness 通用循环 |
| H1 | OpenAI delta 修正 | `delta.tool_calls` + `tc.index`，finish_reason 时 emit |
| H2 | Base class 先写 + 回归 | GAP-9 步骤 1→5，Gate 0 含 3 adapter smoke |
| H3 | MCP 进程清理 | AbortSignal + process.exit + disconnect kill |

### HIGH Non-blocking（4/4 ✅）

| ID | 修复项 | 验证 |
|----|--------|------|
| H4 | OTEL Hook 实现 | `createOtelHooks()`，零 harness.ts 改动 |
| H5 | CB 自动包装 | `circuitBreaker?: Config \| false` |

### MEDIUM（4/4 + AD-2 ✅）

| ID | 修复项 | 验证 |
|----|--------|------|
| M1 | 40-45h | §4 Total |
| M2 | Phase 并行 | wall-clock 15-20h |
| M3 | CI [20,22,24] | GAP-1 |
| M4 | retry:2 | GAP-8 |
| M5 | Multi-agent 非目标 | §1.3 + §8 |
| — | AD-2 补充 | "Internal implementation pattern" |

### LOW（4/4 ✅）

L1 `abstract provider` / L2 `--workspaces` / L3 OTEL exporter / L4 README 三步

---

## 本轮新发现（6 项，全部 Non-blocking）

### M-NEW-1. OTEL Hook `spans` Map 内存累积

**文件**: §3 GAP-5 `createOtelHooks()` 伪代码

`new Map<string, Span>()` 在 `.end()` 后没有 `.delete()`。100 轮 session → ~400 残留 Span。

**修复**: 每个 `after*` hook 加 `.delete(key)`：

```typescript
{ hook: "afterThink", priority: 0, handler: async (ctx, events) => {
  const span = spans.get(ctx.turn.id)
  span?.end()
  spans.delete(ctx.turn.id)  // ← 加这行
}},
{ hook: "afterAct", priority: 0, handler: async (ctx, call, result) => {
  const span = spans.get(call.id)
  span?.setAttribute("ok", result.ok)
  span?.end()
  spans.delete(call.id)  // ← 加这行
}},
{ hook: "afterCompress", priority: 0, handler: async (ctx, event) => {
  spans.get("compress")?.end()
  spans.delete("compress")  // ← 加这行
}},
```

---

### M-NEW-2. GAP-2 "Files changed" 误含 deepseek.ts

**文件**: §3 GAP-2

GAP-2 (Phase 0) 列出 `deepseek.ts — extends base, ~50 lines`。但 DeepSeek 是 GAP-9 (Phase 3)。跨 Phase 混淆。

**修复**: GAP-2 "Files changed" 删除 deepseek.ts 那行。GAP-9 已有。

---

### L-NEW-1. OTEL 缺 Session 级根 Span

**文件**: §3 GAP-5

无 `onSessionStart`/`onSessionEnd` hook → 所有 span 扁平，无父子层级。

**修复**: 追加 2 个 hook（可选但建议）：

```typescript
{ hook: "onSessionStart", handler: async (ctx) => {
  const span = tracer.startSpan("Session")
  span.setAttribute("sessionId", ctx.session.id)
  spans.set("session", span)
}},
{ hook: "onSessionEnd", handler: async (ctx, result) => {
  spans.get("session")?.end()
}},
```

---

### L-NEW-2. OTEL Span 属性稀疏

当前只有 `turnIndex`、`tool.name`、`ok`。缺 `model`、`tokenUsage`、`turnCount`。

**修复**: 丰富属性——hook args 中 `ctx` 和 `result` 已含这些数据。

---

### L-NEW-3. GAP-11 遗漏 2 个需更新文档

**修复**: "Updated existing docs" 追加：
- `docs/api/harness.md` — 新增 `circuitBreaker` 和 `mcp` 配置字段
- `docs/api/tools.md` — 补充 MCP 作为工具源

---

### L-NEW-4. OTEL error span 无父关联

`onError` 创建的 error span 与当前 turn 的 THINK span 无父子关系。

**修复**: `onError` handler 中，若 `spans` 有当前 turn span，用 OTEL `context.with()` 设父子。

---

## 修改清单

6 项全部 Non-blocking，总工时 <1h：

| ID | 文件/章节 | 修改内容 |
|----|----------|---------|
| M-NEW-1 | §3 GAP-5 | 3 个 `after*` hook 加 `.delete(key)` |
| M-NEW-2 | §3 GAP-2 | "Files changed" 删除 `deepseek.ts` 行 |
| L-NEW-1 | §3 GAP-5 | 追加 `onSessionStart`/`onSessionEnd` hook |
| L-NEW-2 | §3 GAP-5 | span 属性加 `model`/`tokenUsage`/`turnCount` |
| L-NEW-3 | §3 GAP-11 | "Updated existing docs" 加 `harness.md` + `tools.md` |
| L-NEW-4 | §3 GAP-5 | `onError` handler 加 OTEL context 父关联注释 |
