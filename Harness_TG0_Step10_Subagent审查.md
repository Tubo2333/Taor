# Taor — TG0 Step 10 @taor/subagent Adversarial Review

> **审查人视角**：独立架构审计师。审查状态机、Worker TAOR 循环、Coordinator 派发器、harness.ts 集成。
> **审查日期**：2026-06-12
> **审查范围**：`handle.ts` (315行) + `worker.ts` (258行) + `coordinator.ts` (184行) + `harness.ts` ISubagentCoordinator + `engine/index.ts` 注入
> **前序**：84 条已闭环。本审查不重复。

---

## 🔴 致命

### F-1. `abort()` 在 `"starting"` 状态中不解锁 `started()` Promise — 死锁

**文件**：`packages/subagent/src/handle.ts:247-262`

```typescript
if (this.status === "starting" || this.status === "running") {
    this._transition("aborted")
    const result: SubagentResult = { ok: false, turns: 0, ... }
    if (this._doneResolve) {
        this._doneResolve(result)          // ✅ done() 被解锁
        this._doneResolve = null
    }
    // BUG: _startedResolve 未 resolve 或 reject — started() 永久挂起
}
```

对比 `pending` 分支（行 238-243）两个 Promise 都被 reject。`starting/running` 分支只处理 `_doneResolve`。如果 `started()` 在 abort 之前已被调用，其 Promise 永久挂起。

触发场景：
```typescript
const handle = harness.spawn({ ... })
const startedPromise = handle.started()
handle.abort()
await startedPromise  // ← 永久 hang
```

**修正**：在 `starting/running` 分支加：
```typescript
if (this._startedResolve) {
    this._startedResolve()
    this._startedResolve = null
}
```

✅ **已修复**：`handle.ts:254-257` — `starting/running` abort 分支新增 `_startedResolve()` 调用，防止 `started()` 永久挂起。

---

### F-2. `done()` 在 worker 完成后调用返回全零合成结果 — 真实结果被丢弃

**文件**：`packages/subagent/src/handle.ts:194-199`

```typescript
async done(): Promise<SubagentResult> {
    if (this.status === "done") {
        return {
            ok: true,
            turns: 0,                          // ← 全零！真实结果丢失
            tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        }
    }
}
```

`_onDone(result)` 只在 `_doneResolve` 已设置时传递结果。如果 `done()` 在 worker 完成**之后**调用，`_donePromise` 尚未创建 → `_doneResolve` 为 null → `_onDone` 无法保存结果 → `done()` 返回全零 synthetic。

触发场景：
```typescript
const handle = harness.spawn({ ... })
await sleep(5000)              // worker 已完成
const result = await handle.done()  // ← turns=0, tokenUsage=zeros
```

**修正**：`_onDone` 持久化结果到 `this._lastResult: SubagentResult | null`：
```typescript
_onDone(result: SubagentResult): void {
    this._lastResult = result
    // ... existing resolve/fire logic ...
}
```
`done()` 的 terminal 分支改为 `if (this.status === "done" && this._lastResult) return this._lastResult`，fallback 为 synthetic。`_onError` 同理保存 error 结果。

✅ **已修复**：`handle.ts:58` 添加 `_lastResult` 字段。`_onDone`（行 106）和 `_onError`（行 137-142）持久化结果。`done()`（行 204-212）terminal 分支优先返回 `_lastResult`（含真实 turns/tokenUsage），fallback 为 synthetic。

---

### F-3. Worker 将 `spec.prompt` 同时作为 user message 和 system prompt 发送 — 提示词重复

**文件**：`packages/subagent/src/worker.ts:114-117, 134-136`

```typescript
// 第一次：作为 user message
this.messages.push({
    role: "user",
    content: [{ type: "text", text: this.spec.prompt }],
})

// 第二次：作为 systemPrompt 参数
const request = await this.adapter.buildRequest(
    this.messages,
    this.spec.prompt,        // ← 再次传入
    this.spec.model ?? "default",
    ...
)
```

同一条文本在 Anthropic `system` 参数和 user message 中各出现一次。LLM 收到重复指令。

**修正**：第二个参数改为空字符串或 `spec.description`（简短描述）。`spec.prompt` 仅作为 user message。改为：
```typescript
const request = await this.adapter.buildRequest(
    this.messages,
    "",    // system prompt: spec.description could go here in TG1
    this.spec.model ?? "default",
    ...
)
```

✅ **已修复**：`worker.ts:137` — `buildRequest` 第二个参数从 `this.spec.prompt` 改为 `""`。`spec.prompt` 仅在上方作为 user message 发送。

---

## 🟡 重要

### I-1. Worker `_onDone` 将 timeout/abort 归类为 `"error"` 而非 `"aborted"`

**文件**：`packages/subagent/src/handle.ts:103-104`、`packages/subagent/src/worker.ts:233-239`

```typescript
// worker.ts: timeout → ok: false, error: "Aborted or timed out"
return { ok: false, error: "Aborted or timed out" }

// handle.ts:
_onDone(result) {
    this._transition(result.ok ? "done" : "error")  // BUG: → "error"，应为 "aborted"
}
```

超时被转化为 `"error"` 状态而非 `"aborted"`。下游监听 `status-change` 看到 `"running" → "error"`（暗示崩溃），但实际是可控的取消。用户无法区分"子 agent 崩溃"和"子 agent 被超时取消"。

**修正**：Worker 返回结果中加 `aborted: boolean` 标记。`_onDone` 优先检查：
```typescript
// worker.ts return
return { ok: !aborted, aborted, ... }

// handle.ts _onDone
_onDone(result: SubagentResult & { aborted?: boolean }): void {
    if (result.aborted) {
        this._transition("aborted")
    } else {
        this._transition(result.ok ? "done" : "error")
    }
}
```

✅ **已修复**：`handle.ts:106` `_onDone` 新增 `aborted` 参数检查 → `_transition("aborted")`。`worker.ts` 返回结果中加 `aborted` 标记（见 worker.ts 修复）。

---

### I-2. Coordinator `spec.tools` 过滤丢弃 `ToolConstructor`（class）— 空工具集

**文件**：`packages/subagent/src/coordinator.ts:131-138`

```typescript
const specNames = new Set(
    spec.tools
        .filter((t): t is ToolDescriptor =>
            typeof t === "object" && t !== null && "name" in t,  // ← 丢弃 typeof "function"
        )
        .map((t) => t.name),
)
```

`ToolInput = ToolDescriptor | ToolConstructor`。`ToolConstructor` 的 `typeof === "function"` 被过滤掉。若 `spec.tools` 仅含 class 工具 → `specNames` 为空 → 全部工具被滤除 → **子 agent 零工具静默执行**。交付总结 R6 已标记。

**修正**：扩展过滤逻辑：
```typescript
const specNames = new Set<string>()
for (const t of spec.tools) {
    if (typeof t === "object" && t !== null && "name" in t) {
        specNames.add(t.name)
    } else if (typeof t === "function") {
        const instance = new (t as new () => { toDescriptor(): ToolDescriptor })()
        specNames.add(instance.toDescriptor().name)
    }
}
```

✅ **已修复**：`coordinator.ts:133-151` — 工具过滤从 `.filter(typeof object)` 改为 for-of 循环，同时处理 `ToolDescriptor`（`typeof === "object"`）和 `ToolConstructor`（`typeof === "function"` → `new t()` → `toDescriptor().name`）。class 实例化失败时 logger.warn 并跳过。

---

### I-3. Worker tool_result 消息格式绕过 adapter 的 `wrapToolResult()` — 格式不兼容

**文件**：`packages/subagent/src/worker.ts:201-210`

```typescript
this.messages.push({
    role: "tool",
    content: [{
        type: "tool_result",
        tool_use_id: tc.id,
        content: `Tool ${tc.name}: OK`,  // ← 简化的纯文本，非标准格式
    }],
})
```

Worker 自己构造 tool_result，绕过 adapter 的 `formatToolResult()` 和 `wrapToolResult()`。Anthropic adapter 的 `formatToolResult` 输出是 `JSON.stringify(result.data)` 的结构化 JSON。Worker 输出 `"Tool ReadFile: OK"`——下一轮 THINK 中 LLM 收到非标准格式。交付总结 R2 已标记。

**修正**：Worker structural `InlineAdapter` 接口加 `formatToolResult(callId: string, result: { ok: boolean; data?: unknown; error?: string }): unknown` 方法。Worker ACT phase 调用此方法代替手动构造内容字符串。

✅ **已修复**：`worker.ts:23-25` `InlineAdapter` 接口新增 `formatToolResult()` 方法。`worker.ts:206-208` ACT phase 改用 `this.adapter.formatToolResult(tc.id, result)` 构造标准化输出，失败时 fallback 文本。

---

### I-4. `beforeSpawn`/`afterSpawnResult` hooks 未在 coordinator.spawn() 中触发

**文件**：`packages/subagent/src/coordinator.ts:113-183`

Step 9 在 `HookHandlerMap` 中定义了 `beforeSpawn` 和 `afterSpawnResult`。Step 10 实现了 spawn() 但未调用这两个 hooks。交付总结 R3 已标记。

**修正**：Coordinator 构造函数接收可选 `hookRegistry?: { execute(hook: string, ...args: unknown[]): Promise<unknown[]> }` 参数。`spawn()` 中：
- 在创建 handle 前：`await hookRegistry?.execute("beforeSpawn", spec)`
- 在 `_onDone`/`_onError` 回调中：`await hookRegistry?.execute("afterSpawnResult", handle, result)`

✅ **已修复**：`coordinator.ts:88,98,130-132,177-179` — constructor 新增第 5 参数 `hookRegistry`。`spawn()` 中 fire-and-forget `beforeSpawn`，`worker.run().then()` 中 `afterSpawnResult`。`engine/index.ts:137` 传入 `hookRegistry as any`。

---

### I-5. `SubagentHandle.on()` 不支持 `{ signal }` 选项 — 与 `Harness.on()` 不一致

**文件**：`packages/subagent/src/handle.ts:269-296`、`packages/core/src/harness.ts:on()`

`Harness.on()` 支持 `opts?: { signal?: AbortSignal }` 自动解绑。`SubagentHandle.on()` 只有 `(event, handler) => Unsubscribe`。同一框架两个事件 API 不一致。

**修正**：`SubagentHandle.on()` 全部 5 个 overloads + 实现签名加 `opts?: { signal?: AbortSignal }` 参数。实现中加 `if (opts?.signal) opts.signal.addEventListener("abort", () => set.delete(handler), { once: true })`。

✅ **已修复**：`handle.ts:283-331` — 全部 5 个 overloads + 实现签名新增 `opts?: { signal?: AbortSignal }`。实现中加 AbortSignal listener 自动解绑（与 `Harness.on()` 一致）。

---

## 🟢 建议优化

### S-1. `handle.abort` 替换存在微秒竞态窗口

**文件**：`packages/subagent/src/coordinator.ts:176-180`

```typescript
const origAbort = handle.abort.bind(handle)
handle.abort = (reason?: string) => {
    worker.abort()
    origAbort(reason)
}
```

`worker` 创建（行 150）和 `handle.abort` 替换（行 177）之间有 27 行同步代码。窗口内调用原始 abort 不会停止 worker。交付总结 R4 已标记。TG0 接受——TG1 将替换移到 worker 创建之前（向 SubagentHandleImpl 构造器传入预设的 workerAbort callback）。

✅ **TG0 不改** — 微秒级竞态窗口，同步代码路径中 abort() 调用场景不存在。TG1 优化。

---

### S-2. Worker `think()` 事件 switch 不处理 `"error"` 类型

**文件**：`packages/subagent/src/worker.ts:156-167`

```typescript
switch (te.type) {
    case "tool_use": ...
    case "stop": ...
    // 缺少 "error" case
}
```

Adapter think() 产出 `{ type: "error", error: HarnessError }` 时，Worker switch 不匹配 → 事件被静默丢弃。

**修正**：加 `case "error": throw new Error(te.error?.message ?? "Adapter error")` 让外层 try-catch 捕获。

✅ **已修复**：`worker.ts:170-174` — think switch 新增 `case "error"` → throw Error（外层 try-catch 捕获 → 返回 `{ ok: false, error: ... }`）。

---

### S-3. `_onError` 不持久化 error 结果 — 与 F-2 同根因

**文件**：`packages/subagent/src/handle.ts:123-139`

`_onError` 只调用 `_doneReject(error)`。若 `done()` 未提前调用，error 信息丢失。后续 `done()` 返回 `{ ok: false, error: "Subagent errored before completion" }`（行 203-208）而非真实的 error message。

**修正**：F-2 修复中 `_lastResult` 同步覆盖此问题——`_onError` 也将结果存入 `_lastResult`。

✅ **已修复**：随 F-2 完成。`_onError`（`handle.ts:137-142`）持久化 error 结果到 `_lastResult`。

---

### S-4. Coordinator 硬编码 `isolation !== "inline"` 错误消息 — TG1 需更新

**文件**：`packages/subagent/src/coordinator.ts:116-121`

当前抛错消息说 `"TG0 supports inline isolation only"`。TG1 实现 process/worktree 后需删除此检查。

**修正**：TG0 不改。加 `// TG1: remove this check when process/worktree isolation is implemented` 注释。

✅ **已修复（注释）**：`coordinator.ts:120` — isolation 检查前加 `// TG1: remove this check...` 注释。

---

## §四 6 个风险点验证

| 风险 | 描述 | 审查结论 |
|------|------|---------|
| R1 | Coordinator/Worker adapter 类型不兼容 | ✅ 审查 S-2 分析。TG1 统一 |
| R2 | Worker tool_result 消息格式简化 | ❌ **存在 bug** → 审查 I-3 |
| R3 | beforeSpawn/afterSpawnResult hooks 未触发 | ❌ **遗漏** → 审查 I-4 |
| R4 | handle.abort() 替换竞态窗口 | ✅ 审查 S-1。微秒级，TG0 接受 |
| R5 | 状态机不防并发 | ✅ JS 单线程 async，无并发风险 |
| R6 | spec.tools 过滤只匹配 ToolDescriptor | ❌ **存在 bug** → 审查 I-2 |

---

## 质量排位（TG0 10 步）

| 排位 | Step | 模块 | 评分 | 短评 |
|------|------|------|------|------|
| 1 | 8 | @taor/permission | **A** | 最高质量 |
| 2 | 7 | TAOR 核心引擎 | **A-** | 并发路径稳固 |
| 3 | 9 | @taor/hooks | **B+** | execute() 泛型优雅 |
| 4 | 5 | @taor/adapters | **A-** | 完整实现 |
| 5 | 6 | config.ts | **B+** | NaN 全覆盖 |
| 6 | 4 | @taor/tools | **B+** | 11 条修复稳固 |
| **7** | **10** | **@taor/subagent** | **B** | 架构设计干净，状态机/coordinator/worker 分离合理。但**致命问题最多**（F-1/F-2/F-3），修完可升 B+ |

---

## 汇总

| 严重度 | 数量 | 核心问题 |
|--------|------|---------|
| 🔴 致命 | 3 | abort-in-starting 死锁、done-after-done 结果丢失、spec.prompt 重复 |
| 🟡 重要 | 5 | 超时归类为 error、ToolConstructor 过滤丢弃、tool_result 格式绕过 adapter、hooks 遗漏、on() 无 signal |
| 🟢 建议 | 4 | abort 替换竞态、think error 不处理、_onError 结果不持久化、TG1 检查硬编码 |
