# Taor — TG0 Step 7 TAOR 核心引擎 Adversarial Review

> **审查人视角**：TypeScript 并发系统专家。1033 行 TAOR 核心引擎是框架心脏，也是单线程 JS 并发最密集的区域。审查重点是 Promise 调度边界上的竞态。
> **审查日期**：2026-06-11
> **审查范围**：`harness.ts` (1033行) + `engine/src/index.ts` (64行) + 全部上游 6 步代码
> **前序审查**：47 条已闭环。本审查不重复。

---

## 🔴 致命问题

### F-1. `abort()` 在 TAOR 循环等待审批时造成死锁 ✅

**修正内容**：`abort()` 在设置 `isLoopDone` 前 resolve decisionResolve（`{ type: "deny", callId: "__aborted__" }`），解除 TAOR 循环的 `await waitForDecision()` 死锁。`return()` 和 `throw()` 同步修复。`kill()` 改为 resolve-then-null（F-3 联动）。

---

### F-2. `return()` 未清空事件队列 — AsyncGenerator 协议违反 ✅

**修正内容**：`return()` 和 `throw()` 中加 `this.eventQueue.length = 0`，确保后续 `next()` 调用不返回残留事件。

---

### F-3. `kill()` 主动置空 `decisionResolve` ✅

**修正内容**：`kill()` 改为先 resolve decisionResolve（`{ type: "deny", callId: "__killed__" }`）再置 null，与 F-1 一致。不再直接置 null。

---

### F-4. `return()` 和 `throw()` 不等待 loopPromise ✅

**修正内容**：`return()` 和 `throw()` 在 `abortController.abort()` 后加 `if (this.loopPromise) { try { await this.loopPromise } catch {} }`，确保 TAOR 循环完全停止后再返回 done result。依赖 F-1/F-3 先修（已修）。

---

## 🟡 重要问题

### I-1. pushEvent 无反压 ✅

**修正内容**：TG0 最小方案：capacity 满时 `logger.warn` + `eventQueue.shift()` drop oldest。JSDoc 标注 TG0 behavior + TG1 改进计划。

### I-2. stop_reason 被丢弃 ✅

**修正内容**：THINK phase 捕获 `stopReason` 变量（含 cache tokens）。终止条件改为 `pendingToolCalls.length === 0 && stopReason !== "max_tokens"`。`max_tokens` 截断时自动继续下一 turn。

### I-3. cache tokens 归零 ✅

**修正内容**：THINK phase 捕获 `turnCacheRead`/`turnCacheWrite`；透传到 Observation、TurnRecord、totalTokens。缓存节省量完全可见。

### I-4. Observation.newMessages 始终空数组 ✅

**修正内容**：OBSERVE phase 收集 `const newMessages: Message[] = []`，同时赋值给 `observation.newMessages` 和追加 `this.messages`。

### I-5. abort 后覆盖已完成状态 ✅

**修正内容**：`abort()` 开头加 `if (this.isLoopDone) return` early return，保护已完成会话不被误标记。

### I-6. start 静默覆盖 ✅

**修正内容**：`start()` 加双重 guard：循环已运行时抛错，prompt 覆盖时 `logger.warn`。

### I-7. as any cast 需文档化 ✅

**修正内容**：`createHarness()` JSDoc 加完整依赖反转契约矩阵（5 对 structural↔canonical 类型对应 + 变更 checklist）。

---

## 🟢 建议优化

### S-1. maxTokens 死代码 ✅

**修正内容**：直接 `maxTokens: undefined` + TG1 comment。

### S-2. pause 不实际暂停 ✅

**修正内容**：`runTAOR()` 的 for-turn 循环开头加 `while (status === "paused" && !aborted) { await sleep(100) }`。Turn 边界挂起，匹配 API 设计规范。

### S-3. OpenAI/DeepSeek stub 误导 ✅

**修正内容**：`openai.ts` 和 `deepseek.ts` 从 re-export AnthropicAdapter 改为抛错构造函数。用户误用时立即在构造期报错，而非发送到错误 API。

### S-4. currentTurn! guard ✅

**修正内容**：`buildTurnContext()` 入口加 `if (!this.currentTurn) throw new Error(...)`，消除裸 `!`。

### S-5. turnCount 一致性

TG0 延后。加注释说明 abort mid-tool 时的语义。TG1 将 turnHistory push 移到 turn 开始处。

---

## 前序 47 条修复抽查

| 修复 | 文件 | 状态 |
|------|------|------|
| F-1 NaN 校验 | config.ts:174 | ✅ `Number.isNaN()` 已加 |
| F-2 adapter 默认值 + ctor 签名 | harness.ts:211, engine/index.ts:44-50 | ✅ `ResolvedConfig` + injection |
| F-3 wrapToolResult content | anthropic.ts:591-601 | ✅ runtime typeof string check |
| `Tool` 类 `ZodObject<any>` | base.ts:45 | ✅ 已确认 |
| `SessionStatus."completed"` | types.ts:42 | ✅ 已统一 |
| registry 两阶段提交 | registry.ts:78-128 | ✅ Phase 1/2 |
| `supports(feature, model?)` | adapters/types.ts:76 | ✅ |

---

## 汇总

| 严重度 | 数量 | 状态 |
|--------|------|------|
| 🔴 致命 | 4 | ✅ 全部修复 |
| 🟡 重要 | 7 | ✅ 全部修复 |
| 🟢 建议 | 5 | ✅ 4 修复 + 1 延后 (S-5) |

**修复后 TAOR 可 ship 状态**：全部 4 致命 + 7 重要 + 4 建议已修。TAOR 循环的并发安全路径（审批等待 × 中断方法）全部修复，AsyncGenerator 协议合规。S-5（turnCount）记入 TG1。

**最终验证**：`npm run build` ✅ / `npm run typecheck` ✅
