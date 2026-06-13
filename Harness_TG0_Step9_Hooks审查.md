# Taor — TG0 Step 9 @taor/hooks Adversarial Review

> **审查人视角**：独立架构审计师。审查 HookRegistry 实现、TAOR 7 个集成点、API 规范符合度。
> **审查日期**：2026-06-12
> **审查范围**：`packages/hooks/src/registry.ts` (314行) + `harness.ts` 7 个 TAOR 集成点 + `engine/index.ts` 注入 + `types.ts` (13 hook points)
> **前序审查**：76 条已闭环。本审查不重复。

---

## 🔴 致命

无。

---

## 🟡 重要

### I-1. `afterThink` 返回值被丢弃 — API §9.3 规范与实现分歧

**文件**：`packages/core/src/harness.ts:579-586`

```typescript
// ── afterThink hook: handlers can inspect/modify think events ──
if (this.hookRegistry) {
    await this.hookRegistry.execute(
        "afterThink",
        ctx,
        thinkEvents as unknown[],    // ← 传入可变数组引用
    )
    // BUG: 返回值未赋值。handler 只能通过 thinkEvents 引用传递副作用来修改。
    // 纯函数式 handler（return filteredEvents）完全不生效。
}
```

API §9.3 明确说：**"afterThink：返回值覆盖 events；返回 void = 不修改。"** `HookHandlerMap.afterThink` 的类型签名是 `Promise<ThinkEvent[] | void>`。当前实现中 handler 的 `return events.filter(...)` 静默不生效——只有 mutate `thinkEvents` 数组引用才能产生效果。交付总结 R2 已标记。

**影响**：hook 作者按类型签名写纯函数式返回 → 静默失败，无任何错误或警告。

**修正**：捕获返回值并应用最后一个非 void 的结果：
```typescript
const afterResults = await this.hookRegistry.execute(
    "afterThink", ctx, thinkEvents as unknown[],
)
// Apply the last non-void ThinkEvent[] from handlers
for (const r of afterResults) {
    if (Array.isArray(r)) {
        // Replace thinkEvents contents in-place (preserves reference)
        thinkEvents.length = 0
        thinkEvents.push(...r)
    }
}
```
注意：修改后的 `thinkEvents` 对 `pendingToolCalls` 的提取不生效（提取在 THINK phase 流式消费中已完成）。加注释标注此限制：
```typescript
// TG0 limitation: pendingToolCalls are extracted during THINK streaming,
// before afterThink runs. If a handler filters out tool_use events, the
// ACT phase will still execute the original tool calls.
```

✅ **已修复**：`harness.ts:580-597` — 捕获 `afterResults`，遍历取最后非 void 的 `Array.isArray(r)` 结果，通过 `thinkEvents.length=0; thinkEvents.push(...r)` 原地替换。加 TG0 限制注释（pendingToolCalls 已提取，无法撤销）。

---

### I-2. `onError` handler 的 ErrorRecovery 返回值被丢弃 — 恢复策略未实现

**文件**：`packages/core/src/harness.ts:922-938`

```typescript
if (this.hookRegistry) {
    const results = await this.hookRegistry.execute(
        "onError",
        { session: this.sessionState, shared: { ... } },
        harnessError,
    )
    // TG0: collect ErrorRecovery actions but don't act on them.
    void results   // ← 完全丢弃。retry/skip_turn/abort/ignore 全部不生效
}
```

`onError` handler 可以返回 `{ action: "retry" }` 或 `{ action: "skip_turn" }` 等 ErrorRecovery 动作（API §9.3 定义了 4 种）。TG0 全部丢弃——`onError` hook 降级为纯通知，零恢复能力。

用户写 `onError: async (ctx, err) => { if (isRecoverable(err)) return { action: "retry" } }` → 完全无效且无警告。

**修正**（TG0 最小改动）：至少告知用户恢复逻辑不生效：
```typescript
const recoveryActions = results.filter(
    r => r && typeof r === "object" && "action" in (r as Record<string, unknown>)
)
if (recoveryActions.length > 0) {
    this.config.logger.warn(
        `[Harness] onError hook returned ${recoveryActions.length} ErrorRecovery action(s), ` +
        `but TG0 does not implement error recovery. Actions ignored. ` +
        `TG1 will support retry/skip_turn/abort/ignore.`
    )
}
```

✅ **已修复**：`harness.ts:947-962` — 替换 `void results` 为 `recoveryActions` 检测 + `logger.warn`。开发者写 `return { action: "retry" }` 时会在控制台看到警告。

---

### I-3. `beforeThink` ctx merge 使用浅展开 — 嵌套对象被整体替换

**文件**：`packages/core/src/harness.ts:465-469`

```typescript
for (const r of results) {
    if (r && typeof r === "object") {
        ctx = { ...ctx, ...(r as Record<string, unknown>) } as typeof ctx
    }
}
```

`{ ...ctx, ...r }` 是**浅合并**。如果 handler 返回部分 `shared` 对象（如 `{ shared: { loadedResources: new Map([...]) } }`），则 `shared.projectRoot` 和 `shared.projectConfig` 被覆盖丢失。`TurnContext = { session, turn, shared }`，当 `r` 被展开，三个顶层 key 被整体替换。

handler 的正确写法是返回**完整** TurnContext：`{ ...ctx, shared: { ...ctx.shared, loadedResources: new Map([...]) } }`。但 TypeScript 类型擦除后不会阻止错误的部分返回。

**修正**：在钩子调用点的 for-loop 上方加注释：
```typescript
// IMPORTANT: handlers must return the FULL TurnContext (not a partial).
// The spread `{ ...ctx, ...r }` is SHALLOW at the top level.
// A return of `{ shared: { loadedResources: ... } }` will LOSE
// shared.projectRoot and shared.projectConfig.
// Correct: return { ...ctx, shared: { ...ctx.shared, loadedResources: ... } }
```

✅ **已修复**：`harness.ts:464-469` — 在 `for (const r of results)` 前加浅合并注释，明确说明 handler 须返回完整 TurnContext，部分返回会丢失嵌套字段。

---

### I-4. `IHookRegistry` structural interface 类型擦除比 `IPermissionEngine` 更激进 — 需文档化

**文件**：`packages/core/src/harness.ts:141-142`

```typescript
interface IHookRegistry {
    execute(hook: string, ...args: unknown[]): Promise<unknown[]>
}
```

对比 Step 8 的 `IPermissionEngine` 保留了 `IPermissionVerdict` 结构化类型。Step 9 的 `IHookRegistry` 完全擦除为 `hook: string` + `args: unknown[]` → `Promise<unknown[]>`。调用方传错参数（如 `execute("beforeThink", 42)`）编译器不报错。

这是有意的 tradeoff——13 个 hook 点各有不同签名，structural interface 无法表达 `HookName → 参数类型` 映射而不引入 `@taor/hooks` 的类型依赖。但应与 Step 8 contract matrix 模式一致地文档化。交付总结 R3 已标记。

**修正**：在 `IHookRegistry` 上方加 hook 参数矩阵注释：
```typescript
/**
 * Hook point parameter matrix (keep in sync with @taor/hooks HookHandlerMap):
 *
 * | Hook              | Args                                   | Return       |
 * |-------------------|----------------------------------------|--------------|
 * | onSessionStart    | SessionContext                         | void         |
 * | onSessionEnd      | SessionContext, SessionResult          | void         |
 * | beforeThink       | TurnContext                            | TurnContext|void |
 * | afterThink        | TurnContext, ThinkEvent[]              | ThinkEvent[]|void |
 * | beforeAct         | TurnContext, ToolCall                  | ToolCall|void|null |
 * | afterAct          | TurnContext, ToolCall, ToolResult      | void         |
 * | afterObserve      | TurnContext, Observation               | Observation|void |
 * | onError           | SessionContext, HarnessError           | ErrorRecovery|void |
 * | beforeCompress    | TurnContext, CompressLevel             | void         |
 * | afterCompress     | TurnContext, CompressedEvent           | void         |
 * | beforeSpawn       | SubagentSpec                           | SubagentSpec|void |
 * | afterSpawnResult  | SubagentHandle, SubagentResult         | void         |
 */
```

✅ **已修复**：`harness.ts:135-170` — IHookRegistry JSDoc 新增 13 行参数矩阵表（Hook / Args / Return），标注与 `@taor/hooks HookHandlerMap` 保持同步。

---

### I-5. Constructor 中 hook 注册失败静默吞入 — 用户可能不知道 hooks 未激活

**文件**：`packages/hooks/src/registry.ts:269-275`

```typescript
try {
    this.on(reg.hook, reg.handler as any, { ... })
} catch (err) {
    logger?.warn(
        `[HookRegistry] Failed to register "${reg.hook}" handler: ...`
    )
}
```

如果 `HookRegistration[]` 路径传入 `handler` 不是函数，`this.on()` 的 `handler as any` cast 会让非函数值绕过编译期检查 → `this.on()` 成功注册了一个不可调用的 entry → `execute()` 时 `entry.handler(...args)` 抛 `TypeError: handler is not a function` → 被收集为错误 → 触发 `fireOnError`。错误发生在运行时而非注册时，排查困难。

**修正**：`register()` 方法入口加：
```typescript
if (typeof reg.handler !== "function") {
    throw new TypeError(
        `HookRegistry: handler for hook "${reg.hook}" must be a function, got ${typeof reg.handler}`
    )
}
```

✅ **已修复**：`registry.ts:259-266` — `register()` 入口添加 `typeof reg.handler !== "function"` 检查，非函数立即抛 TypeError（被现有 try-catch 捕获并 logger.warn），避免静默注册不可调用 entry 到 execute 时才失败。

---

## 🟢 建议优化

### S-1. `afterObserve` 修改 observation 后 `turnRecord.tokenUsage` 未同步

**文件**：`packages/core/src/harness.ts:843-869`

```typescript
// afterObserve 修改 observation（可能改了 tokenUsage）
observation = r as Observation

// 但 turnRecord 使用独立计算的 turnTokenUsage（不受 handler 影响）
const turnRecord: TurnRecord = {
    tokenUsage: turnTokenUsage,  // ← 不用 observation.tokenUsage
}
```

如果 handler 修改了 observation 的 token 计数，turnRecord 不会反映修改。

**修正**：`turnRecord.tokenUsage` 改用 `observation.tokenUsage`：
```typescript
tokenUsage: observation.tokenUsage,
```

✅ **已修复**：`harness.ts:901` — `turnRecord.tokenUsage` 从 `turnTokenUsage` 改为 `observation.tokenUsage`。afterObserve handler 对 observation 的 token 修改现在会反映在 turn 记录中。

---

### S-2. `fireOnError` 传 `{ session: null, turn: null, shared: null }` 作为 SessionContext

**文件**：`packages/hooks/src/registry.ts:305`

```typescript
await entry.handler({ session: null, turn: null, shared: null }, errors[0]!)
```

`SessionContext = { session: SessionState, shared: SharedCacheState }`。传入 `null` 不满足类型（通过 `entry.handler(...args: unknown[])` 绕过）。`onError` handler 如果解构 `ctx.session.id` 会 `TypeError`。

这种情况只在 `fireOnError` 路径触发（handler 执行内部的错误积累触发 onError 连锁调用）——此时真实的 SessionContext 不可用。TG0 不改——加注释标注限制：
```typescript
// TG0 limitation: fireOnError is called from within execute() error collection
// where SessionContext is unavailable. Pass null-ish context.
```

✅ **已修复（注释）**：`registry.ts:312-319` — 增强注释说明 null ctx 绕过类型系统、handler 解构 `ctx.session.id` 会 TypeError、真实 onError 调用（harness.ts catch 块）有完整 SessionContext。添加 `as any` 绕过 TS 类型检查（类型系统不允许传 null 给 SessionContext）。

---

### S-3. `beforeAct` 的 `effectiveCall` 修改未写回 `pendingToolCalls`

**文件**：`packages/core/src/harness.ts:688-715`

```typescript
let effectiveCall = { ...tc }
// beforeAct hooks 修改 effectiveCall → callRecord 使用 effectiveCall ✅
// 但 this.pendingToolCalls 中的原始 tc 未更新
```

`pendingToolCalls` 中的原始 tool call 未反映 afterAct 的修改。TG0 中 `pendingToolCalls` 在 ACT phase 后不再被读取——不影响功能。如果将来有代码在 ACT 后遍历 `pendingToolCalls`，会有不一致。

**修正**：TG0 不改。加注释：
```typescript
// TG0: pendingToolCalls retains the original call arguments — effectiveCall
// overrides are reflected in callRecord and tool execution but not in
// the pendingToolCalls array. This is fine because pendingToolCalls is not
// read after ACT phase.
```

✅ **已修复（注释）**：`harness.ts:751-754` — 在 effectiveCall 修改块后添加注释，说明原始 `tc` 在 `pendingToolCalls` 中未更新，但 ACT phase 后不再读取该数组。

---

### S-4. `beforeAct` 取消检测用 `results.some(r => r === null)` — 严格相等

**文件**：`packages/core/src/harness.ts:697`

```typescript
const cancelled = results.some((r) => r === null)
```

使用 `=== null` 严格相等。如果 handler 返回 `undefined`（`return;` 无显式值），它不等于 `null`，不会被当作取消。这是正确的——`return;` 等于 `return undefined` = "void / no change"；`return null` = "cancel"。语义精确。✅

---

### S-5. `onSessionStart` 在 turn 循环之前调用 — 行为正确

**文件**：`packages/core/src/harness.ts:399-409`

`onSessionStart` 在 `pendingPrompt` 处理后、第一个 turn 开始前调用。只触发一次。与 API 文档 "会话开始时" 的语义完全一致。✅

---

## §四 6 个风险点验证

| 风险 | 描述 | 审查结论 |
|------|------|---------|
| R1 | beforeThink ctx merge 策略 | ✅ 审查 I-3。浅合并，handler 须返回完整 ctx |
| R2 | afterThink 返回值未使用 | ❌ **存在 bug** → 审查 I-1 |
| R3 | IHookRegistry 过于宽泛 | ✅ 审查 I-4。已文档化 |
| R4 | fireOnError SessionContext 为 null | ✅ 审查 S-2。TG0 限制 |
| R5 | 4 个 hook 点未集成 | ✅ 延后 Step 10/12。不是遗漏 |
| R6 | afterThink 无法撤销已发射事件 | ✅ 架构固有。审查 I-1 已标注限制 |

---

## 质量排位（TG0 9 步）

| 排位 | Step | 模块 | 评分 | 短评 |
|------|------|------|------|------|
| 1 | 8 | @taor/permission | **A** | 匹配算法与 API §8.4 完全对应，依赖反转干净 |
| 2 | 7 | TAOR 核心引擎 | **A-** | AsyncGenerator 协议正确，并发路径稳固 |
| **3** | **9** | **@taor/hooks** | **B+** | execute() 泛型签名优雅，错误隔离正确，优先级排序正确。afterThink 返回值丢弃 (I-1) + onError 恢复未实现 (I-2) 拖分。修完可升 A- |
| 4 | 5 | @taor/adapters | **A-** | 650 行完整 Anthropic 实现 |
| 5 | 6 | config.ts | **B+** | NaN 全覆盖，子配置默认不一致 |
| 6 | 4 | @taor/tools | **B+** | 三路径定义，11 条审查后稳固 |

---

## 汇总

| 严重度 | 数量 | 核心问题 |
|--------|------|---------|
| 🔴 致命 | 0 | — |
| 🟡 重要 | 5 | afterThink 返回值丢弃（API 规范分歧）、onError 恢复策略未实现、beforeThink 浅合并文档化、IHookRegistry 擦除文档化、构造注册失败静默 |
| 🟢 建议 | 5 | afterObserve→turnRecord tokenUsage 不同步、fireOnError null ctx、effectiveCall 未写回 pendingToolCalls、cancel 检测正确性验证、集成点顺序验证 |
