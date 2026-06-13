# Taor — TG0 Step 12 @taor/compressor Adversarial Review

> **审查人视角**：独立架构审计师。审查 5 层管道、trim/truncate 实现、pipeline 循环逻辑。
> **审查日期**：2026-06-12
> **审查范围**：`strategies/index.ts` (191行) + `pipeline.ts` (155行) + `types.ts` + harness.ts ICompressorPipeline + engine/index.ts 注入
> **前序**：105 条已闭环。本审查不重复。

---

## 🔴 致命

### F-1. `trim` 策略用 `"tool_use" in block` 而非 `block.type === "tool_use"` — 所有工具消息被静默删除

**文件**：`packages/compressor/src/strategies/index.ts:49-55`

```typescript
const filtered = ctx.turn.messages.filter((msg) =>
    msg.content.some(
        (block) =>
            ("text" in block && typeof block.text === "string" && block.text.trim().length > 0) ||
            ("tool_use" in block) ||    // ← BUG: "tool_use" 不是 block 的 key
            ("tool_result" in block),   // ← BUG: 同上
    ),
)
```

`MessageContent = { type: "tool_use", id, name, input }`。`"tool_use" in block` 检查的是 block 是否有名为 `"tool_use"` 的 key——永远 false（key 是 `type`/`id`/`name`/`input`，value `"tool_use"` 在 `type` 字段中）。`some()` 对任何 tool_use/tool_result 消息返回 false → **trim 将所有工具调用消息从压缩后的上下文中删除**。数据破坏。

**修正**：
```typescript
(block.type === "tool_use") ||
(block.type === "tool_result"),
```

✅ **已修复**：`strategies/index.ts:66-67` — `"tool_use" in block` → `block.type === "tool_use"`，`"tool_result" in block` → `block.type === "tool_result"`。

---

### F-2. `messagesToTokens` / `estimateTokens` 只统计 text block — 系统性 token 低估

**文件**：`packages/compressor/src/strategies/index.ts:21-31`、`packages/compressor/src/pipeline.ts:128-138`

```typescript
// strategies.ts — messagesToTokens()
if ("text" in block && typeof block.text === "string") {
    total += estimateTokens(block.text)
}
// tool_use.input (JSON arguments) → 完全不统计
// tool_result.content (string) → 不统计（key 是 "content" 不是 "text"）

// pipeline.ts — estimateTokens()
const text = (block as any).text as string | undefined
if (text) total += Math.ceil(text.length / 4)
// 同上——只访问 .text 属性
```

工具调用密集的对话中 `tool_use.input`（JSON 参数）和 `tool_result.content`（大段文本/文件内容）可能是最大的 token 消费者。当前实现将它们完全排除在估算之外。

**影响链**：
1. `triggerThreshold` → 用低估的 token 数判断是否触发压缩 → 该触发时不触发 → 上下文溢出 API limit
2. truncate 的 `tokenCount -=` → 只减 text block 的 token → 删工具消息后计数器不动 → 过度压缩
3. cache fingerprint → tool 消息贡献 `0` → 不同工具调用的上下文有相同 cache key → 错误命中

**修正**：`messagesToTokens()` 扩展为覆盖全部 4 种 MessageContent 变体，放在 `strategies/index.ts` 中导出，pipeline.ts 和 truncate 减法使用同一实现：

```typescript
export function messagesToTokens(messages: Message[]): number {
    let total = 0
    for (const msg of messages) {
        for (const block of msg.content) {
            if (block.type === "text") {
                total += estimateTokens(block.text)
            } else if (block.type === "tool_use") {
                total += estimateTokens(JSON.stringify(block.input))
            } else if (block.type === "tool_result") {
                total += estimateTokens(block.content)
            }
            // image: skip (base64 data not counted per-token by any provider)
        }
    }
    return total
}
```

`pipeline.ts:estimateTokens` 替换为调用 `messagesToTokens`。truncate 减法同步扩展。

✅ **已修复**：`strategies/index.ts:30-46` — `messagesToTokens()` 重写为覆盖 4 种 MessageContent 类型（text/tool_use/tool_result/image），导出供 pipeline 和 truncate 使用。`pipeline.ts:78` 替换 `this.estimateTokens()` 为 `messagesToTokens()`。`strategies/index.ts:177` truncate 减法改为 `messagesToTokens([removed])`。

---

## 🟡 重要

### I-1. `pipeline.ts.estimateTokens` 与 `strategies.ts.messagesToTokens` 是两套不同逻辑

**文件**：`packages/compressor/src/pipeline.ts:128-138` vs `strategies/index.ts:21-31`

Pipeline 用 `(block as any).text`（访问 `.text` 属性），Strategies 用 `"text" in block`（`in` 检查）。同一上下文得出不同 token 计数——pipeline 决定是否触发压缩用一个数字，strategies 内部用另一个数字。

**修正**：F-2 统一函数后，pipeline.ts 删掉私有 `estimateTokens`，改为 `import { messagesToTokens } from "./strategies/index.js"`。

✅ **已修复**（随 F-2）：`pipeline.ts` 导入 `messagesToTokens`，删除私有 `estimateTokens`。同一实现用于 trigger check + 所有策略。

---

### I-2. truncate 的 `tokenCount -=` 减法只处理 text block — 与 F-2 同根因

**文件**：`packages/compressor/src/strategies/index.ts:168-174`

```typescript
for (const block of removed.content) {
    if ("text" in block && typeof block.text === "string") {
        tokenCount -= estimateTokens(block.text)
    }
}
```

删除 tool_use 消息（含大型 JSON input）→ `tokenCount` 不下降 → truncate 认为仍需继续删除 → 过度压缩。删除 tool_result 消息同理。

**修正**：F-2 统一后使用同一 `messagesToTokens` 函数：`tokenCount -= messagesToTokens([removed])`。

✅ **已修复**（随 F-2）：`strategies/index.ts:177` — 从手动的 `for (block of removed.content)` 改为 `tokenCount -= messagesToTokens([removed])`，统一覆盖所有 block 类型。

---

### I-3. truncate `messages.length > 2` 强制保留首尾 — 极短上下文 guarantee 失效

**文件**：`packages/compressor/src/strategies/index.ts:165`

```typescript
while (tokenCount > opts.targetTokens && messages.length > 2) { ... }
```

messages 只有 2 条且仍超标（user prompt 100k + assistant 50k）→ 不删任何消息 → 返回超标结果。Force truncate guarantee 被打破。交付总结 R4 已标记。

**修正**：TG0 不改——2 条消息场景物理上无法安全压缩。加注释标注限制：
```typescript
// TG0 limitation: with only 2 messages and still over target, compression
// physically cannot reach target without losing context. TG1: apply
// per-message summarization as fallback.
```

✅ **已修复（注释）**：`strategies/index.ts:168-170` — truncate 的 while 条件上方加 TG0 限制注释。

---

### I-4. `pipeline.ts.cacheKey` 指纹仅用最后 5 条消息的文本长度 — 碰撞风险

**文件**：`packages/compressor/src/pipeline.ts:140-147`

```typescript
private cacheKey(messages: ..., target: number): string {
    const hashes = messages
        .slice(-5)
        .map((m) => m.content.map((b) => (b.text as any)?.length ?? 0).join(","))
        .join("|")
    return `${hashes}:${target}`
}
```

- `"The result is 42"` 和 `"The result is 43"` → 相同长度 → 相同 key → 错误命中
- tool_use/tool_result 块 → 所有消息对指纹贡献 `0`
- 两条长度相同内容不同的消息交换顺序 → 相同 key

**修正**（TG0 最小改动）：在长度指纹基础上加首条和末条消息第一个 text block 的前 64 字符 hash：
```typescript
const firstText = firstBlock?.text?.slice(0, 64) ?? ""
const lastText = lastBlock?.text?.slice(0, 64) ?? ""
return `${firstText}|${lastText}|${messages.length}|${target}`
```

✅ **已修复**：`pipeline.ts:131-146` — `cacheKey` 改用首+末 text 前 64 字符 + message 数量 + target 联合做 key，替代仅长度指纹。

---

### I-5. `ICompressorPipeline` structural interface 缺少 `clearCache()` 方法

**文件**：`packages/core/src/harness.ts:234-238`

`CompressorPipeline` 有 `clearCache(): void`（pipeline.ts:152-154），但 `ICompressorPipeline` 未声明。用户通过 `harness.compressor.clearCache()` 调用时类型报错。

**修正**：`ICompressorPipeline` 加 `clearCache(): void`。

✅ **已修复**：`harness.ts:234-238` — `ICompressorPipeline` 新增 `clearCache(): void` 方法。

---

## 🟢 建议优化

### S-1. Stub 策略返回 `level: "summarize"` 但 messages 不变 — 消费者误判

**文件**：`packages/compressor/src/strategies/index.ts:71-88, 100-116, 127-143`

summarize/chunk/embed 返回 `level: "summarize"` 等标记但 messages 零变化。`afterCompress` hook 收到 `strategy: "summarize"` 但 tokenCount 未减少 → 误以为 summarize 无效或执行了但被 undo。

**修正**：stub 返回结果加注释标注 TG0 未实现。TG1 实现时确保 token recount 正确。

✅ **已修复（注释）**：`strategies/index.ts` summarize/chunk/embed 三个 stub 的返回前加 `// TG0 stub: returns identity` 注释。

---

### S-2. `maxAttempts` 语义偏差 — 不是"压缩尝试次数"而是"非强制策略尝试上限"

**文件**：`packages/compressor/src/pipeline.ts:100-107`

```typescript
for (const strategy of this.strategies) {
    if (attempts >= this.maxAttempts) break
    // ...
    attempts++
}
```

`maxAttempts=3` 意味着：最多执行 3 个策略（含 stubs），然后不管结果如何都强制 truncate。但名称暗示"尝试 3 次压缩"——实际上 stubs 也算次数。

**修正**：TG0 不改。JSDoc 加说明 `@param maxAttempts - Max non-truncate strategy executions before forcing truncation.`。

✅ **已修复（注释）**：`strategies/index.ts:185-191` — DEFAULT_STRATEGIES 上方加 JSDoc 说明 maxAttempts 语义（含 stub 计数，TG1 将跳过无实现 stub）。

---

### S-3. `DEFAULT_STRATEGIES` 中 3 个 stub 每次都做无用遍历

**文件**：`packages/compressor/src/strategies/index.ts:185-191`

summarize/chunk/embed 每个都调用 `messagesToTokens()` 做完整遍历。3 个 stub × 完整上下文遍历 = 浪费。TG0 不改——加注释标注 TG1 lazy-evaluate stub 或跳过 stubs。

✅ **TG0 不改** — 注释已在 S-2 的 DEFAULT_STRATEGIES JSDoc 中标注 TG1 优化方向。

---

## §四 5 个风险点验证

| 风险 | 描述 | 审查结论 |
|------|------|---------|
| R1 | truncate 估算基于 ~4 chars/token | ✅ 已知限制 |
| R2 | summarize/chunk/embed stubs 无日志 | ✅ **S-1** 已标注 |
| R3 | 缓存永不过期 | ✅ `clearCache()` 存在。TG1 LRU |
| R4 | truncate `messages.length > 2` 保护 | ❌ **I-3** — 极短上下文 guarantee 失效 |
| R5 | 管道未在 TAOR 循环中自动触发 | ✅ 文档化 |

---

## 质量排位（TG0 12 步最终版）

| 排位 | Step | 模块 | 评分 | 短评 |
|------|------|------|------|------|
| 1 | 8 | @taor/permission | **A** | 最高质量 |
| 2 | 7 | TAOR 核心引擎 | **A-** | 并发稳固 |
| 3 | 9 | @taor/hooks | **B+** | 泛型优雅 |
| 4 | 5 | @taor/adapters | **A-** | 完整 650 行 |
| 5 | 6 | config.ts | **B+** | NaN 全覆盖 |
| 6 | 11 | @taor/memory | **B+** | TTL/logic 正确 |
| 7 | 4 | @taor/tools | **B+** | 11 条修复稳固 |
| 8 | 10 | @taor/subagent | **B** | 3 致命已修 |
| **9** | **12** | **@taor/compressor** | **C+** | 管道逻辑正确、trigger/target/cache 机制清晰。但 **F-1 是数据破坏性 bug**（静默删除工具消息）+ **F-2 是系统性低估**（整个管道基于不准确的 token 数运行）。修完可升至 B |

---

## 汇总

| 严重度 | 数量 | 核心问题 |
|--------|------|---------|
| 🔴 致命 | 2 | trim `"tool_use" in block` 数据破坏、token 估算遗漏 tool_use/tool_result |
| 🟡 重要 | 5 | 两套 estimator、truncate 减法、极短上下文 guarantee 失效、cacheKey 碰撞、缺 clearCache |
| 🟢 建议 | 3 | stub 标记不透明、maxAttempts 语义偏差、stub 遍历浪费 |
