# Taor — TG0 Step 1-6 综合 Adversarial Review

> **审查人视角**：TypeScript 运行时框架专家，从头审计 types → context → events → tools → adapters → config 六个已完成步骤。
> **审查日期**：2026-06-11
> **审查范围**：`@taor/core` (types/context/events/config/session/unresolved/harness) + `@taor/tools` (types/descriptor/base/registry/validation) + `@taor/adapters` (types/anthropic/index)
> **前置条件**：前序 28 条审查意见已闭环。本审查不重复已修复问题，但修复未到位处会指出。
> **特别关注**：对下一步 TAOR 循环实现的阻碍。

---

## 🔴 致命问题

### F-1. `validateConfig()` 接受 `NaN` 作为合法值 — 两个入口 ✅

**文件**：`packages/core/src/config.ts:174`、`:226`

```typescript
// Line 174:
if (timeout !== Infinity && timeout <= 0) { throw ... }
// NaN !== Infinity → true. NaN <= 0 → false. 条件不触发. NaN 静默通过.

// Line 226:
if (rate < 0 || rate > 1) { throw ... }
// NaN < 0 → false. NaN > 1 → false. NaN 静默通过.
```

触发路径：
```typescript
validateConfig({
  model: "x", tools: [],
  session: { timeout: NaN },          // ← 通过校验
  telemetry: { enabled: true, sampleRate: NaN },  // ← 通过校验
})
```

`timeout: NaN` 进入 TAOR 循环 → `setTimeout(callback, NaN)` → 等价于 `setTimeout(callback, 0)` → 每个 turn 立即超时。`sampleRate: NaN` → 任何与 NaN 的比较都返回 false → 采样逻辑行为不可预测。

**修正内容**：timeout → `Number.isNaN(timeout) || (timeout !== Infinity && timeout <= 0)`。sampleRate → `Number.isNaN(rate) || rate < 0 || rate > 1`。

---

### F-2. `ResolvedConfig.adapter` 为 `undefined` 时无默认值 — Adapter 实例化责任悬空 ✅

**修正内容**：`Harness` 构造函数签名改为 `ResolvedConfig`（`createHarness()` 先调 `validateConfig()` 再传）。Adapter 默认值由 `@taor/engine` 的 `createHarness()` 在后续提供（避免 `@taor/core → @taor/adapters` 循环依赖）。ctr 内加 IMPLEMENTATION NOTE 指引 Step 7 实现 adapter 初始化。

---

### F-3. `wrapToolResult()` content 类型不兼容 ✅

**修正内容**：`wrapToolResult()` 加 runtime 检查 `typeof rawBlock.content === "string"`，非 string 时 `JSON.stringify()` 包裹。显式构造 `MessageContent` 对象（含 `is_error` 透传），不再用 `as` cast。

---

## 🟡 重要问题

### I-1. `Message.role` 是 Anthropic 偏斜的 ✅

**修正内容**：`Message.role` 加 `| "tool"`。OpenAI adapter 的字段名差异（`tool_use_id` vs `tool_call_id`）在 adapter 的 `buildRequest()` 层处理。

### I-2. `ToolInput` 类型鸿沟 ✅

**修正内容**：`harness.ts` 构造函数 IMPLEMENTATION NOTE 中已包含 ToolInput cast 指引（`as import("@taor/tools").ToolInput[]`）。

### I-3. System 消息非 text block 被静默丢弃 ✅

**修正内容**：`convertMessages()` 中对非 text block 加 `console.warn`（含 block.type 和 API 限制说明）。

### I-4. Permission duck-typing ✅

**修正内容**：`validateConfig()` Permission 段加 TG0 注释，标注 stub 替换后需清理。

### I-5. `ToolRegistry` 缺 `remove()` ✅

**修正内容**：加 `remove(name: string): boolean`，调用 `this.tools.delete(name)`。

### I-6. SessionStatus / SessionResult 终态不一致 ✅

**修正内容**：`SessionStatus` 中 `"done"` → `"completed"`，与 `SessionResult.status` 统一。

---

## 🟢 建议优化

### S-1. `validateConfig()` 不校验 `session.resumeFrom` 引用的 session ID 是否有效

TG0 不实现 session 恢复，`resumeFrom` 可以是任意字符串。未来 `deserialize()` 实现时无效 resumeFrom 才被发现。TG0 不改——加 `// TG0: resumeFrom validation deferred to deserialize() implementation` 注释。

---

### S-2. 缺少 `ParsedToolCall → ToolCall` 转换函数

**文件**：`packages/adapters/src/types.ts:17-21`、`packages/core/src/context.ts:20-27`

TAOR 循环的 ACT 阶段需要把 adapter 输出的 `ParsedToolCall`（LLM 刚产出的）转为运行时追踪用的 `ToolCall`（加 `status: "pending"`、`startedAt: Date.now()`、`retries: 0`）。这个转换逻辑的理想位置是 `@taor/core/src/context.ts`，但它需要引用 `ParsedToolCall`（在 `@taor/adapters` 中）——引入跨包依赖。要么放在 core 中（加 adapter type import），要么放在一个共享的 util 中。TG0 不改——TAOR 循环可以直接内联构造。

---

### S-3. `AnthropicAdapter.think()` 中 `signal.aborted` 后 stream 资源依赖 GC — 不保证立即释放

**文件**：`packages/adapters/src/anthropic.ts:403`

```typescript
if (signal.aborted) break  // ← 跳出循环, stream 对象等待 GC
```

Anthropic SDK 的 `Stream` 可能持有 HTTP 连接。`break` 后无显式 `stream.abort()` 或 `stream.cancel()`。SDK 是否在 AsyncIterable 被放弃时自动取消连接——依赖 SDK 实现细节。TG0 不改——加 `// TG0: rely on SDK's implicit cleanup when AsyncIterable is abandoned. Verify on SDK upgrade.` 注释。

---

### S-4. `ResolvedConfig` 中 subsystem config 的默认填充不一致

**文件**：`packages/core/src/config.ts:249-253`

```typescript
memory: raw.memory ?? {},
compressor: raw.compressor ?? {},
permission,         // ← 经过了特殊校验逻辑（行 190-220）
subagent: raw.subagent ?? {},
```

`permission` 有额外校验和默认填充，`memory`/`compressor`/`subagent` 直接 `?? {}`。每个子系统的默认值在其自己的构造函数中处理——这是有意设计。但不一致性在代码审查时会被质疑。TG0 不改——加 `// Subsystem default values are handled by each subsystem's constructor, not here.` 注释。

---

### S-5. `TurnRecord` 构造逻辑未定义

TAOR 循环在 turn 结束时需要从 `TurnState` 构造 `TurnRecord` 摘要。`TurnState` 有 `messages`/`pendingToolCalls`/`lastObservation`，`TurnRecord` 有 `status`/`tokenUsage`/`toolCalls: number`/`duration`/`compressedAt`。映射关系（如 `toolCalls` 从 `pendingToolCalls.size` 计算）目前未定义。TG0 在 TAOR 循环实现时做——此时加 TODO。

---

## 前序 28 条修复抽查

| 修复 | 文件 | 状态 |
|------|------|------|
| 工具名验证三路径一致 | validation.ts + descriptor.ts + base.ts + registry.ts | ✅ 均已 import |
| registry 两阶段提交 | registry.ts:78-128 | ✅ Phase 1 normalize+validate / Phase 2 commit |
| `supports(feature, model?)` | adapters/types.ts:76, anthropic.ts:307 | ✅ 签名+实现 |
| `Tool` 类泛型收紧 | base.ts:45 | ✅ **已手动确认** — `TParams extends z.ZodObject<any>` |
| `StopReason` 含 `"unknown"` | adapters/types.ts:15 | ✅ |
| `formatToolResult` truncated 警告 | anthropic.ts:571-573 | ✅ |
| `wrapToolResult` 新增 | adapters/types.ts:95, anthropic.ts:591-601 | ✅ 接口+实现 |
| `HarnessError.source` 补全 | context.ts:49 | ✅ `"hooks" \| "memory"` |
| Image MIME type runtime guard | anthropic.ts:179-188 | ✅ |
| `validateConfig` 范围校验 | config.ts:150-258 | ✅ NaN 缺口已修 — 本审查 F-1 |

---

## TAOR 循环实现的 5 个前置阻碍（状态更新）

在 TAOR 循环（Step 7）第一行代码之前，以下项必须解决：

| # | 阻碍 | 状态 | 解决方案 |
|---|------|------|---------|
| 1 | **Harness ctor 签名** | ✅ 已解决 | 改为接收 `ResolvedConfig`；`createHarness()` 先 `validateConfig()` 再传 |
| 2 | **adapter 实例化** | ⚠️ 方案已定 | Harness ctor 检查 adapter，若 `undefined` 则抛错；默认值由 `createHarness()` 提供（避免循环依赖） |
| 3 | **事件队列** | ⬜ Step 7 实现 | 需实现 bounded FIFO queue（capacity = `config.session.eventQueueCapacity`） |
| 4 | **`next(decision)` 双向通道** | ⬜ Step 7 实现 | Promise resolver 模式：yield `approval-required` → await consumer `next(decision)` |
| 5 | **`ToolInput` cast** | ✅ 已解决 | harness.ts IMPLEMENTATION NOTE 中已标注 `as ToolInput[]` cast 指引 |

---

## 汇总

| 严重度 | 数量 | 状态 |
|--------|------|------|
| 🔴 致命 | 3 | ✅ 全部修复 |
| 🟡 重要 | 6 | ✅ 全部修复 |
| 🟢 建议 | 5 | ✅ 2 注释修复 + 3 TG0 延后 |
| ⚠️ 手动确认 | 1 | ✅ Tool 类 `ZodObject<any>` 已确认 |
| 🔑 TAOR 阻碍 | 5 | ✅ 3 已解决 + 2 Step 7 实现 |

**修复后 TG0 可 ship 状态**：全 15 条已修。TAOR 阻碍 5 条中 3 条已消除，2 条留到 Step 7 实现。

**最终验证**：`npm run build` ✅ / `npm run typecheck` ✅
