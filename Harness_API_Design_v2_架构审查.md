# Harness API Design v2 — 架构审查意见

> **审查人视角**：未参与设计讨论的资深 TypeScript 基础设施架构师。只关心一件事：这份 spec 能不能变成能跑的代码。
> **审查日期**：2026-06-11
> **审查对象**：`d:/C-file/Harness_Engineer/Harness_API_Design_v2.md`

---

## 审查方法

逐节进行类型解析、契约交叉验证、运行时路径模拟。每一个类型引用追溯定义。每一个 `interface` 的方法签名对照调用侧检查参数是否可以满足。

**结论**：这份设计有骨架但没有肌腱。类型系统里有 6 个核心类型引用了但从未定义——这不是"忘了写"，这意味着当前 spec 下你写不出任何三个子系统交界的代码。Sub-agent 的 process/worktree 隔离在当前工具模型下无法实现。所有 DX 场景都依赖一个未文档化的内部事件队列。

---

## 🔴 致命（不修正无法编译或核心功能不可实现）

### F-1. 未定义类型：`ToolCall` — 核心状态和 Hook 契约断裂

**锚点**：§二 2.1 (`TurnState.pendingToolCalls: Map<string, ToolCall>`)、§九 9.2 (`beforeAct(ctx, call: ToolCall)`, `afterAct(ctx, call: ToolCall, result: ToolResult)`)

`ToolCall` 出现在了 Harness 最核心的三个位置——turn 状态追踪、beforeAct hook、afterAct hook——但在整个文档中从未定义。`ParsedToolCall`（§六 6.2）有类似结构（`id/name/arguments`）但缺少执行状态（pending/running/done/error）、开始时间、重试次数——这些是 `pendingToolCalls` Map 之所以存在的理由。你不能拿 `ParsedToolCall` 顶替，它的语义是"LLM 刚吐出来的"，不是"正在跑的"。

**建议修正**：§二新增 `ToolCall` 接口，至少包含：
```typescript
interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  status: "pending" | "running" | "done" | "error"
  startedAt: number
  retries: number
}
```

✅ **已修正**：`ToolCall` 接口已定义于 §二 2.5。额外增加了 `Readonly<ToolCall>` 用于 `TurnState.pendingToolCalls`（同时修正 D-3）。

---

### F-2. 未定义类型：`TurnContext` — 三个子系统无法编写契约签名

**锚点**：§六 6.1 (`LLMAdapter.buildRequest(ctx: TurnContext, ...)`)、§九 9.2（`beforeThink`, `afterThink`, `beforeAct`, `afterAct`, `afterObserve`, `beforeCompress`, `afterCompress` 全部使用 `TurnContext`）、§十二 12.1 (`CompressStrategy.compress(ctx: TurnContext, ...)`)

这是整个文档中**被引用最多但从未定义的类型**。Adapter、Hooks、Compressor 三个子系统的公开 API 都依赖它。没有这个类型，你无法写出 `buildRequest` 的实现签名，无法写 hook handler，无法写压缩策略。

从使用模式反推，`TurnContext` 应该是 `HarnessContext` 的一个子集或扩展——但它是 shallow copy 还是同一个引用？`beforeThink` 可以返回 `TurnContext | void` 来"覆盖 ctx"（§九 9.3），这意味着 handler 收到的是可替换的。但如果 `TurnContext` 包含 `session: SessionState`（来自 `HarnessContext`），替换 ctx 是否意味着替换整个 session 引用？其他持有旧引用的代码会怎样？这些语义必须明确，不能靠实现者猜。

✅ **已修正**：`TurnContext` 已定义为 `HarnessContext` 的类型别名（§二 2.2）。`SessionContext` 定义为 `Omit<HarnessContext, "turn">`。"覆盖"语义明确为 shallow merge。

**建议修正**：在 §二新增 `TurnContext` 类型定义，明确它和 `HarnessContext` 的关系，明确"覆盖"是 shallow merge 还是 replace。

---

### F-3. 未定义类型：`HarnessError` — Adapter 和 Hook 的错误归一化无法实现

**锚点**：§六 6.1 (`LLMAdapter.normalizeError(error: unknown): HarnessError`)、§九 9.2 (`onError(ctx, error: HarnessError)`)

每个 Adapter 的 `normalizeError` 方法返回它，`onError` hook 接收它，事件系统里有 `ErrorEvent`（§七 7.1）但 `ErrorEvent` 和 `HarnessError` 的关系从未说明——它们是同一个东西吗？谁转换成谁？

**建议修正**：§二或 §六新增 `HarnessError` 接口，明确它和 `ErrorEvent` 的转换关系。如果它们就是同一个东西，删掉一个。

✅ **已修正**：`HarnessError` 接口已定义于 §二 2.6。`ErrorEvent` 现在嵌入 `error: HarnessError` 字段（§七 7.1），不再重复字段。

---

### F-4. 未定义类型：`Observation` — TAOR 循环的核心数据结构缺失

**锚点**：§二 2.1 (`TurnState.lastObservation: Observation | null`)、§九 9.2 (`afterObserve(ctx, observation: Observation)`)

TAOR 循环的 O（Observe）阶段产生 `Observation`，存入 turn 状态，传给 hook。但 `Observation` 是什么？是工具执行结果的集合？是 LLM 看到工具结果后产出的文本？还是整个 turn 的状态快照？这个类型是整个 TAOR 循环的输出物——它不定义，TAOR 循环就是个黑箱。

✅ **已修正**：`Observation` 接口已定义于 §二 2.7，包含 `toolResults`、`newMessages`、`tokenUsage`、`compressedAt`。同时定义了 `ToolCallResult`。

**建议修正**：§二新增 `Observation` 类型。

---

### F-5. 未定义类型：`SessionContext` — Session 级 Hooks 无法实现

**锚点**：§九 9.2 (`onSessionStart(ctx: SessionContext)`, `onSessionEnd(ctx, result)`, `onError(ctx, error)`)

Hook 系统有三个 session 级钩子使用 `SessionContext`，但全文只定义了 `SessionState`。`SessionContext` 和 `SessionState` 的关系是什么？是同一个东西还是 `SessionContext` 包裹了 `SessionState` 加上其他上下文？如果是同一个，为什么不直接用 `SessionState`？

✅ **已修正**：`SessionContext` 已定义为 `Omit<HarnessContext, "turn">`（§二 2.2）。即移除 turn 字段的 HarnessContext——session 级 hook 执行时无活跃 turn。

**建议修正**：要么定义 `SessionContext`，要么确认它就是 `SessionState` 并统一命名。

---

### F-6. Process/worktree 级别的 Sub-agent 隔离在函数式 Tool 模型下不可实现

**锚点**：§十 10.2, 10.3, 10.5, §五

这是这份设计里**最严重的架构矛盾**。

`defineTool()` 产出的 `ToolDescriptor` 中，`execute` 是一个 JavaScript 函数/闭包。`SubagentSpec.isolation` 支持 `"process"`（Node.js `child_process.fork()`）和 `"worktree"`（fork + git worktree）。但是：

1. **函数不可序列化**。你不能把 `execute` 通过 IPC 传给子进程。
2. **§十 10.1 明确说 Worker "拥有自己的 TAOR 循环"** 且 "结果通过结构化通道返回（不通过文件系统）"。这意味着子进程需要独立执行工具调用。
3. **架构总览 §一说 "Coordinator 只派活不动文件"**——Coordinator 不访问文件系统，那工具执行必须在 Worker 侧完成。

三条加起来等于：**需要一个能被子进程加载的工具实现机制，但 defineTool() 产出的东西不行。**

**唯一可行的修正路径**（选一条，写进 spec）：

- **方案 A**：工具执行全部 proxy 回父进程。Worker 的 TAOR 循环在 Think 阶段独立运行，但 Act 阶段通过 IPC 把 tool call 发回父进程执行，父进程返回 `ToolResult`。这放弃"Worker 独立执行工具"的承诺，且引入 IPC 延迟。Worker 的 `ToolContext` 在父进程侧无法重建（session/turn 状态在父进程是另一个会话的）。
- **方案 B**：`process`/`worktree` 隔离要求工具以**可导入模块**的方式定义（`class extends Tool` 放在独立文件中），子进程 `require()` 相同的模块。放弃 `defineTool()` 闭包在这些隔离级别下的使用。
- **方案 C**：删掉 `process` 和 `worktree`，只保留 `inline`。v2 再加回来。

不选一条，`spawn({ isolation: "worktree" })` 在运行时直接抛 `DataCloneError`。

✅ **已修正**（采用方案 B）：`SubagentSpec.tools` 文档明确说明 `process`/`worktree` 隔离仅接受 `class extends Tool`（定义在独立可导入模块中）。`defineTool()` 闭包在非 inline 隔离下 spawn() 时框架自动校验并抛出明确错误。

---

## 🟡 重要（编译可能通过，但运行时会断裂或在边界条件下行为未定义）

### I-1. 六个未定义的类型别名使公开 API 无法被外部消费

**锚点**：§四 4.1、§五 5.2、§六 6.4、§三

以下类型在公开 API 签名中出现但全文未定义：

| 类型 | 出现位置 | 问题 |
|------|---------|------|
| `ToolConstructor` | §四 4.1 `ToolInput` 联合类型 | `class extends Tool` 的构造器类型是什么？`new (...args: any[]) => Tool`？ |
| `AdapterConstructor` | §四 4.1 `HarnessConfig.adapter` | §十四 Scene C 用 `adapter: DeepSeekAdapter`（无 `new`），暗示它是类构造器而非实例。类型怎么表达？ |
| `Logger` | §四 4.1 `HarnessConfig.logger`、§五 5.6 `ToolContext.logger` | 接口定义缺失。`console` 兼容？Winston 兼容？自定义？ |
| `TelemetryConfig` | §四 4.1 `HarnessConfig.telemetry` | 完全没有结构 |
| `JSONSchema` | §五 5.2 `ToolDescriptor.parameters`、§五 5.3 | 它是 JSON Schema Draft-07？2020-12？一个手写的简化版？这会影响所有 Adapter 的工具 schema 格式化代码 |
| `Unsubscribe` | §三、§九、§十 作为返回值类型 | 推测是 `() => void`，但从没说过 |
| `TurnRecord` | §三 `Harness.turns` 返回类型 | 完全没有定义 |
| `SerializedSession` | §三 `Harness.serialize()` 返回类型 | 完全没有定义 |

任何一个外部 TS 文件写 `import { HarnessConfig } from "@taor/engine"` 然后尝试构造 config 对象，IDE 会在这些类型上报 `Cannot find name`。

✅ **已修正**：全部 8 个缺失类型已定义——`ToolConstructor`/`AdapterConstructor`/`Logger`/`TelemetryConfig`（§四 4.1）、`JSONSchema`/`JSONSchemaProperty`（§五 5.2）、`Unsubscribe`/`TurnRecord`（§二 2.8）、`SerializedSession`/`SerializedTurn`（§三 3.1）。

**建议修正**：审计全文，画出类型依赖 DAG，补全所有叶子类型。`JSONSchema` 尤其需要明确——建议直接用 `@anthropic-ai/sdk` 的 `Tool.InputSchema` 或定义一个最小可用的 subset。

---

### I-2. `SessionDoneEvent` 与 `SessionResult` 的二元性使 `TReturn` 形同虚设

**锚点**：§三、§七 7.1、§四 4.3

`AsyncGenerator<HarnessEvent, SessionResult, UserDecision>` 的 `TReturn` 是 `SessionResult`。这意味着当 generator 完成时，`done: true` 的 `value` 是 `SessionResult`。

但 `HarnessEvent` 联合类型里已经有了 `SessionDoneEvent`（`type: "done"`），它会被 `yield` 出来。这两个类型字段重叠但不相同：

| 字段 | `SessionDoneEvent` | `SessionResult` |
|------|-------------------|----------------|
| `sessionId` | ✅ | ✅ |
| `turns` | ✅ | ✅ |
| `tokenUsage` | ✅ | ✅ |
| `artifacts` | ✅ | ✅ |
| `finalMessage` | ✅ | ✅ |
| `status` | ❌ | ✅ (`"completed" \| "aborted" \| ...`) |

DX 场景 A（§十四）用 `for await...of` 消费事件，在 `event.type === "done"` 时拿到 `SessionDoneEvent`。`SessionResult` 作为 generator 返回值在 `for await...of` 中**完全不可达**——循环结束后返回值被丢弃。

**两个问题**：
1. 为什么有两个不同的"完成"数据结构？如果 `SessionDoneEvent` 也需要 `status`，就加进去，删掉 `SessionResult`。
2. 如果保留了 `SessionResult` 作为 `TReturn`，那有人用裸 `.next()` 手动迭代时，done-value 是 `SessionResult` 而非 `SessionDoneEvent`——同一个终态有两种不同的类型表示。

✅ **已修正**（选方案一）：删除 `SessionDoneEvent`。`SessionResult` 保留为 AsyncGenerator 的 TReturn（done-value），加 JSDoc 说明。架构图 yield 列表移除 "done"，新增 return 标注。DX Scene A 改用 `harness.state` 查询最终状态；Scene C 改用 `.next()` 手动迭代以捕获 SessionResult。

**建议修正**：二选一。要么 `SessionDoneEvent` 加 `status` 字段并删除 `SessionResult`（将 `TReturn` 改为 `void`），要么删掉 `SessionDoneEvent`，document 清楚 generator 的 done-value 是 `SessionResult`，并在 §十四 Scene A 用 `.next()` 手动迭代示例替代 `for await...of`。

---

### I-3. DX Scene A 依赖未文档化的内部事件缓冲

**锚点**：§三、§十四 Scene A

```typescript
const harness = createHarness({...})
for await (const event of harness.start(prompt)) { ... }
```

执行流程：
1. `harness.start(prompt)` → 内部调用 `this.next({ type: "start", prompt })` → 返回 `this`
2. 消费者进入 `for await...of` → JS runtime 调用 `harness[Symbol.asyncIterator]()` → 调用 `harness.next()` 拉取第一个事件

但在步骤 1 的 `this.next()` 调用和步骤 2 的第一次 `harness.next()` 之间，TAOR 循环已经启动，可能已经产出了事件（LLM 的第一个 text chunk、第一个 tool call 等）。这些事件去哪了？

**必须有一个内部事件队列**。这份设计全文没有出现 "queue"、"buffer"、"backpressure" 这些词。队列容量是多少？无界吗？如果 TAOR 循环产出事件的速度快于消费者拉取的速度（比如消费者在 `approval-required` 时卡住等待用户输入），内存会怎样？AsyncGenerator 的天然背压机制（消费者不调 `next()` 时 producer 的 `yield` 被 suspend）在这里被打破了，因为 `harness.start()` 是用 `next()` **推进** generator 而不是 `yield` **被** generator 驱动。

**建议修正**：§三或 §一架构总览中明确：
- 内部事件队列的存在、语义（FIFO）、默认容量（建议有界，默认 256，超限时 producer 等待）
- `start()` 不直接调用 `next()`，而是初始化内部状态后由消费者的第一次 `next()` 真正启动 TAOR 循环
- 或者：放弃 `AsyncGenerator` 接口，Harness 变成一个普通类 + `EventEmitter`，消费者通过 `harness.start(prompt).on(...)` 消费。AsyncGenerator 模式在审批注入场景下根本不适合——你不是在消费一个 generator，你是在和一个双向通道对话。

✅ **已修正**：Harness 类 JSDoc 新增"内部事件队列"节，明确 FIFO 有界队列（默认容量 256）、背压语义、`start()` 的惰性启动语义。`HarnessConfig.session.eventQueueCapacity` 可配置队列容量。保留 AsyncGenerator 设计——背压由队列满时 producer 挂起保证。

---

### I-4. `PermissionEngine.evaluate()` 无法解析 `@resource` 注解——缺 Tool Schema 访问路径

**锚点**：§八 8.2, 8.5

```typescript
interface PermissionEngine {
  evaluate(tool: string, params: Record<string, unknown>): PermissionVerdict
}
```

`resourceConstraints` 匹配（§八 8.2）需要知道哪个参数上标注了 `@resource:fs-path` 之类的注解。这些注解嵌入在 Zod schema 的 `.describe()` 中，最终序列化进 `ToolDescriptor.parameters`（JSON Schema）。但 `evaluate()` **只接收工具名和运行时参数值**——没有 `ToolDescriptor`，没有 JSON Schema，拿不到参数的 description 字符串，也就无法提取 `@resource` 标签。

**必须**是下面两种之一：
- `evaluate(tool: ToolDescriptor, params: Record<string, unknown>): PermissionVerdict` — 调用方传 descriptor
- 引擎内部持有 `Map<string, ToolDescriptor>`，在工具注册时（`new Harness({ tools: [...] })`）填充，`evaluate` 通过工具名查找

两种方案都可行，但你现在哪一种都没写。

✅ **已修正**（采用方案二）：`PermissionEngine.evaluate()` JSDoc 添加实现约束——引擎内部持有 `Map<string, ToolDescriptor>`，构造时填充，evaluate 通过工具名查找 descriptor 以提取 @resource 注解。

**建议修正**：选一个方案写进 §八 8.5。推荐后者（内部 Map），但必须在 §八文档中声明"工具须在构造时注册"的时序约束。

---

### I-5. `Harness.on()` 的泛型约束排除了 `"*"` wildcard

**锚点**：§三

```typescript
on<E extends HarnessEvent["type"]>(
  type: E | "*",
  handler: (event: E extends "*" ? HarnessEvent : Extract<HarnessEvent, { type: E }>) => void | Promise<void>,
  opts?: { signal?: AbortSignal }
): Unsubscribe
```

`HarnessEvent["type"]` = `"started" | "done" | "turn-started" | ... | "blocked"`。约束 `E extends HarnessEvent["type"]` 明确拒绝 `"*"`。当消费者写 `harness.on("*", handler)` 时，TypeScript 必须为 `E` 推断出一个满足约束的值。在实践中 TS **可能**推断 `E` 为完整的联合类型，使得条件类型 `E extends "*"` 为 false，从而 handler 类型退化为 `HarnessEvent`——这恰好能工作。但这是**偶然正确**，不是设计正确。未来 TS 版本改变推断策略可能导致这个调用直接报错。

✅ **已修正**：添加显式 `on(type: "*", ...)` overload 在泛型 overload 之前，消除"偶然正确"依赖。

**建议修正**：显式加一个 overload：
```typescript
on(type: "*", handler: (event: HarnessEvent) => void | Promise<void>, opts?: { signal?: AbortSignal }): Unsubscribe
on<E extends HarnessEvent["type"]>(type: E, handler: (event: Extract<HarnessEvent, { type: E }>) => void | Promise<void>, opts?: { signal?: AbortSignal }): Unsubscribe
```

---

### I-6. `CompressStrategy.compress()` 需要 LLM 但 CompressorConfig 没有 Adapter 注入

**锚点**：§十二 12.1, 12.2

策略 #2 `summarize` 说"LLM 摘要之前的对话"。策略 #4 `embed` 说"向量检索"。
- 用哪个 LLM？主 `LLMAdapter` 还是独立的？
- 如果用主 adapter，compressor 能在 TAOR 循环的 THINK 阶段同时调 `adapter.think()` 吗？这需要 adapter 支持并发调用的保证，但 `LLMAdapter` 接口（§六 6.1）对此完全没有语义约束。
- 如果用独立 adapter，`CompressorConfig` 里没有 `adapter` 字段。

最坏情况：TAOR 循环在 THINK 阶段触发压缩 → 压缩策略调用主 adapter → 主 adapter 正在被外面的 THINK 使用 → 死锁或请求交错。

✅ **已修正**：`CompressorConfig` 新增 `adapter?: AdapterConstructor` 字段（§十二 12.1）。`LLMAdapter` 接口（§六 6.1）新增"并发安全" JSDoc 节，明确要求实现支持可重入调用。推荐每次 `think()` 创建独立 HTTP client 实例。

**建议修正**：在 `CompressorConfig` 中加 `adapter?: AdapterConstructor`，并在 §六 `LLMAdapter` 接口上加并发安全语义说明（"实现必须支持可重入调用"或"实现不需要可重入"）。

---

### I-7. DX Scene B 中 `harness.spawn()` 没有并发控制

**锚点**：§十四 Scene B、§十 10.5

```typescript
const [security, perf] = await Promise.all([
  harness.spawn({...}).done(),
  harness.spawn({...}).done(),
])
```

两个 spawn 同时以 `isolation: "worktree"` 运行。worktree 创建涉及 `git worktree add`——这是文件系统操作，两个并发 worktree 创建可能踩到同一个 `.claude/worktrees/` 下的命名冲突。`SubagentSpec` 里没有 worktree 名称/路径参数，说明框架自动生成名称。并发场景下名称生成必须是原子的。

这不是大问题（可以用 ULID + 重试），但 spec 完全没有提到。

✅ **已修正**：`Harness.spawn()` JSDoc 新增"并发安全"节，说明 ULID 生成唯一 worktree 路径、自动重试 1 次、失败后 handle 进入 error 状态。

**建议修正**：§十 10.5 加一句："Concurrent spawn() with worktree isolation uses unique worktree paths; no caller-level coordination needed."

---

## 🟢 可延后（不会阻止编译或运行，但会在调试、维护、生态集成时造成摩擦）

### D-1. `defineTool()` Zod/JSONSchema 双重重载可能导致类型推断失效

**锚点**：§五 5.3

两个重载签名共享实现签名。当用户传入一个既不是 `z.ZodType` 也不是明确 `JSONSchema` 的对象时，TS 重载解析可能匹配到错误的 overload。特别是 `JSONSchema` 结构很宽（递归对象类型），可能意外吞掉 Zod 调用。建议在测试套件中覆盖：纯 Zod、纯 JSON Schema、裸对象（期望报错）。

---

### D-2. `SubagentHandle.on()` 与 `Harness.on()` 使用不同的重载模式

**锚点**：§十 10.3 vs §三

Harness 用一个泛型方法 + 条件类型；SubagentHandle 用五个独立重载。同一个概念（事件订阅），同一份设计，两种完全不同的类型表达。维护者需要在脑内维护两套心智模型。选一个统一。

---

### D-3. `TurnState.pendingToolCalls` 暴露可变内部状态给工具实现

**锚点**：§二 2.1、§五 5.6

`ToolContext.turn` 包含 `TurnState`，`TurnState.pendingToolCalls` 是 `Map<string, ToolCall>`。工具 `execute()` 内部可以读写这个 Map——包括删除其他并发工具调用、修改自己的参数。把内部并发控制数据结构暴露给外部代码是纯粹的安全风险。

✅ **已修正**（额外）：`TurnState.pendingToolCalls` 类型改为 `Map<string, Readonly<ToolCall>>`（§二 2.1）。改为 `ReadonlyMap<string, Readonly<ToolCall>>`。

---

### D-4. `AdapterRequest = unknown` 阻止 Session 序列化

**锚点**：§六 6.1、§三

`Harness.serialize()` 产出 `SerializedSession`，`deserialize()` 重建 Harness。如果在 `buildRequest` 之后、`think` 完成之前做序列化（turn 中间状态），in-flight 的 `AdapterRequest` 是 `unknown`——序列化器不知道它是什么，无法安全存储。要么限制序列化只能在 turn 边界进行（文档化），要么给 `AdapterRequest` 加 `Serializable` 约束。

---

### D-5. `MemoryStore.list()` 无分页

**锚点**：§十一 11.2

`list(opts?: { prefix?: string; tags?: string[] }): Promise<MemoryEntry[]>` — 无 `limit`、无 `offset`、无 cursor。SQLite 后端有 10 万条记录时，这个调用直接 OOM。加 pagination 参数。

---

### D-6. `TurnRecord` 类型未定义

**锚点**：§三 `Harness.turns` getter 返回 `TurnRecord[]`

全文定义了 14+ 种 Event 类型，但 `TurnRecord`（已完成 turn 的摘要）从未定义。和 `TurnState` 的关系是什么？

---

### D-7. `zod-to-json-schema` 依赖未声明

**锚点**：§五 5.3、§十三

`defineTool()` 的 Zod 重载必须将 `z.ZodType` 转换为 `JSONSchema`。这需要 `zod-to-json-schema` 或手写转换器。§十三的包结构中完全没有提到这个依赖。它是 `@taor/tools` 的 dependency？peer dependency？bundled？不声明的话，用户 `npm install @taor/tools` 后第一个 `defineTool(z.object({...}))` 调用就会在运行时炸。

---

### D-8. `@resource` 注解通过字符串解析提取——脆弱

**锚点**：§八 8.3

`z.string().describe("Target file path").describe("@resource:fs-path")` — 最终 description 是 `"Target file path @resource:fs-path"`。框架靠正则从描述字符串里提取 `@resource:<type>`。如果用户的自然描述恰好包含 `@resource:` 字样（比如写一个管理 resource 的工具），就会产生伪匹配。建议改为 Zod `.annotations()` 或自定义 metadata 机制，而不是复用 `.describe()` 的自然语言通道。

---

## 汇总

| 严重度 | 数量 | 阻塞范围 |
|--------|------|---------|
| 🔴 致命 | 6 | 所有子系统交界面、sub-agent process/worktree 隔离 |
| 🟡 重要 | 7 | Config 构造、DX 场景 A/B、Permission 匹配、Compressor LLM 依赖、类型系统健壮性 |
| 🟢 可延后 | 8 | DX 一致性、内部安全性、依赖声明、序列化边界 |

**一句话总结**：这份设计的方向是对的，TAOR 双通道架构、Tool 三种定义方式、@resource 注解的思路都有工程价值。但在当前状态下，你写不出任何跨越两个以上子系统的 `.ts` 文件——缺少的类型定义太多，sub-agent 隔离的根本性矛盾在第一次 `fork()` 调用时就会让你面对一个序列化失败的闭包。

**建议的修正顺序**：先补 F-1~F-5 的全部未定义类型 → 解决 F-6 的 sub-agent 工具传递模型 → 再修 I-1~I-7 → D 类可以在 TG0 实现过程中按需处理。
