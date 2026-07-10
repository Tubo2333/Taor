# LangGraph Pregel vs Taor：Agent 循环引擎设计对比

> 作者：左鑫 | 日期：2026-07-08 | 项目：github.com/Tubo2333/taor

---

## 开篇：两句话讲清楚两个框架

想象你是一个包工头，要指挥一群工人盖房子。

**LangGraph 的做法（Pregel 模型）**：你把所有工人叫到工地上，说"这一轮，砌墙的砌墙，搬砖的搬砖，你们同时干。等所有人都干完了，我检查一下进度，再分配下一轮的任务。"——这就是 **Superstep（超级步）**，一轮内所有人并行，轮与轮之间统一同步。

**Taor 的做法（TAOR 模型）**：你走到砌墙工人面前说"砌这面墙"→ 看他砌完 → 检查质量 → 根据结果决定下一步。发现问题了？立刻停下来问你要不要换方案。你再走到搬砖工人面前……——这就是 **Think → Act → Observe → Repeat**，每一步串行，但每一步都有人盯着。

两种方式没有绝对的好坏，看场景。

---

## 一、循环模型对比

### LangGraph：Superstep = 批量并行

LangGraph 把一次循环叫一个 **Superstep**。每个 Superstep 分三个阶段：

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Plan        │ ──→ │  Execute     │ ──→ │  Update      │
│  决定执行哪些  │     │  所有 node    │     │  把输出写入   │
│  node         │     │  并行跑       │     │  channel 并   │
│              │     │              │     │  checkpoint  │
└──────────────┘     └──────────────┘     └──────────────┘
```

核心代码（`_algo.py` 的 `prepare_next_tasks` 函数）做的事就是 Plan 阶段：

```python
# 简化版：决定这一轮哪些 node 该执行
def prepare_next_tasks(checkpoint, pending_writes, processes, channels, ...):
    tasks = []

    # 1. 检查有没有排队的 PUSH 任务（Send 过来的）
    for task in consume_pending_tasks():
        tasks.append(task)

    # 2. 检查哪些 channel 被更新了 → 触发订阅了这些 channel 的 node
    for channel in updated_channels:
        triggered_nodes.update(trigger_to_nodes[channel])

    # 3. 为每个被触发的 node 准备执行任务
    for name in triggered_nodes:
        if task := prepare_single_task(name, ...):
            tasks.append(task)

    return tasks  # 这批 tasks 会在 Executor 里并行执行
```

**关键设计**：Engine 把所有 task 扔给 `Executor`（线程池），同一 Superstep 内的 task **全部并行执行**。只有全部完成后，才会进入下一个 Superstep。

### Taor：Turn = 串行事件流

Taor 的一次循环叫一个 **Turn**，用一个 `AsyncGenerator` 状态机来驱动：

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│  THINK   │ ──→ │   ACT    │ ──→ │ OBSERVE  │
│  调 LLM  │     │  执行工具  │     │  记录结果  │
│  API     │     │  权限检查  │     │  压缩上下文│
└──────────┘     └──────────┘     └──────────┘
     ↑                                  │
     └──────────── repeat ──────────────┘
```

核心代码（`harness.ts` 的 `runTAOR` 方法）：

```typescript
// 简化版：一个 Turn 的完整流程
private async runTAOR(): Promise<void> {
  for (let turnIndex = 0; turnIndex < maxTurns; turnIndex++) {

    // ── THINK 阶段：调 LLM，流式接收思考结果 ──
    for await (const event of this.adapter.think(request, signal)) {
      if (event.type === "text")      this.pushEvent({ type: "thought", ... })
      if (event.type === "tool_use")  this.pendingToolCalls.push(event.call)
    }

    // ── ACT 阶段：逐个执行工具（串行）──
    for (const toolCall of this.pendingToolCalls) {
      // 1. 权限检查
      const verdict = this.permissionEngine.evaluate(toolCall.name, toolCall.arguments)
      if (verdict.level === "deny") { push blocked event; continue }

      // 2. 需要审批 → 暂停，等用户决定
      if (needsApproval) {
        const decision = await this.waitForDecision()  // ← AsyncGenerator 暂停点
        if (decision.type === "deny") continue
      }

      // 3. 执行工具 + 错误恢复
      try {
        const result = await tool.execute(params, ctx)
        pushEvent({ type: "tool-result", ok: true })
      } catch (err) {
        // 五级恢复：retry → 降级 → fallback → 跳过 → 标记
        if (recovery === "retry" && retries < 3) { retries++; continue }
        if (recovery === "skip_turn") continue
        if (recovery === "abort") return
      }
    }

    // ── OBSERVE 阶段：记录、压缩、准备下一轮 ──
    this.totalTokens += turnTokens
    if (totalTokens > threshold) {
      const compressed = await this.compressorPipeline.compress(ctx)
      this.messages = compressed.messages  // 替换为压缩后的上下文
    }
  }
}
```

### 大白话总结

| | LangGraph | Taor |
|---|---|---|
| **像什么** | 工地包工头，一轮让所有人同时干 | 流水线质检员，一个个检查、一个个放行 |
| **并行策略** | Superstep 内所有 node 并行 | Turn 内 tool 逐个串行，子 Agent 可并行（`child_process.fork`） |
| **暂停/恢复** | Checkpoint 序列化整个 state | AsyncGenerator 天然可暂停 + `serialize()`/`deserialize()` |
| **适合场景** | 复杂 DAG，多分支并行探索 | 需要精细权限控制、需要人工审批的 Agent 任务 |
| **一个循环叫** | Superstep | Turn |

---

## 二、任务调度对比

### LangGraph：Channel 订阅 → 自动触发

LangGraph 用 **Channel（通道）** 做消息传递。Node A 的输出写入 Channel X → 订阅了 Channel X 的 Node B 自动被触发。

```python
# 概念示意
graph.add_node("analyze", analyze_func)
graph.add_node("report", report_func)
graph.add_edge("analyze", "report")  # analyze 的输出 channel 触发 report

# 内部实现：trigger_to_nodes 映射表
# { "analyze_output_channel": ["report"], ... }
```

一个 node 的输出可能同时触发多个下游 node，它们会在**同一个 Superstep 内并行执行**。这就是 LangGraph 的"扇出"能力。

### Taor：事件流 → 显式处理

Taor 没有"自动触发"机制。LLM 在 THINK 阶段决定调用哪些 tool，ACT 阶段逐个执行。Tool 之间不自动通信——它们通过 LLM 在下一轮 THINK 时观察上一轮的结果来决定下一步。

```typescript
// Taor 的调度：LLM 决定 → 框架执行
// Step 1: LLM thinks → "我需要读文件"
//   → yield tool_use("ReadFile", { path: "/app/config.json" })
// Step 2: ACT 执行 ReadFile → 结果返回
// Step 3: LLM 观察结果 → "文件内容是 X，下一步我要..."
//   → yield tool_use("DeployAgent", { host: "..." })
```

### 大白话总结

- **LangGraph**：像多米诺骨牌——推倒一个，自动触发一串。适合预设好的多步工作流。
- **Taor**：像下棋——LLM 走一步，框架执行，LLM 看局面再决定下一步。适合需要 LLM 动态推理的场景。

---

## 三、错误恢复对比

### LangGraph：重试策略声明式配置

LangGraph 的 node 可以声明 `retry_policy`：

```python
graph.add_node("api_call", api_func, retry_policy=[
    RetryPolicy(max_attempts=3, backoff_factor=2),
])
```

失败后自动重试，最多 3 次，间隔指数递增。如果全部失败 → 抛异常，整个 graph 中断。

### Taor：五级恢复，程序员完全控制

Taor 不搞声明式——直接用 `onError` 钩子让程序员决定每一步怎么办：

```typescript
// harness.ts 中的五级恢复逻辑
catch (err) {
  const recovery = await this.hookRegistry.execute("onError", ctx, error)

  if (recovery.action === "retry" && retries < 3) {
    retries++; continue       // ① 重试
  }
  if (recovery.action === "skip_turn") {
    continue                  // ② 跳过这轮（可能下轮能过）
  }
  if (recovery.action === "abort") {
    return                    // ③ 中止整个会话
  }
  // "ignore" → push error event, keep going   // ④ 忽略
  // exhausted retries → mark as failed         // ⑤ 标记失败
}
```

### 大白话总结

- **LangGraph**：给你一个重试按钮，按三次还不行就炸了。
- **Taor**：给你五个选项——重试、跳过、降级、中止、忽略。你可以根据错误类型选择不同策略。比如"502 网络错误"重试，"JSON 解析错误"降级用默认值，"权限拒绝"直接中止。

---

## 四、权限模型对比——Taor 的最大差异化优势

### LangGraph：没有原生权限系统

LangGraph **没有内置权限引擎**。如果你想限制某个 node 不能读 `/etc/` 下的文件？你需要在 node 函数里自己写 `if` 判断。

```python
# LangGraph 里你只能这样（自己手写检查）
def read_file_node(state):
    if state["path"].startswith("/etc/"):
        raise ValueError("Access denied")
    # ... 实际读文件
```

这就像你家门上没有锁，你每次进门前都要自己检查"有没有坏人跟进来了"。

### Taor：4 级权限引擎 + @resource 边界约束

Taor 有独立的 `PermissionEngine` 类，不嵌入任何业务代码中：

```typescript
// 声明权限规则（放在配置里）
const rules = [{
  level: "boundary",           // 边界级：只在越界时拦截
  pattern: "ReadFile",         // 匹配 ReadFile 工具
  resourceConstraints: {
    paramAnnotation: "file",   // 检查标注了 @resource file 的参数
    denylist: ["/etc/**", "/root/**", "**/secrets**", "**/.env**"],
    allowlist: ["/app/**", "/home/**", "/tmp/**"],
  },
}]

// 工具声明（在工具定义上加 @resource 注解）
// "Read a file from the filesystem. @resource file"
```

四个权限级别：

| 级别 | 行为 | 例子 |
|------|------|------|
| `deny` | 直接拒绝，不通知用户 | 禁止 `rm -rf /` |
| `boundary` | 只在越界时问用户 | 读 `/app/config.json` 放行，读 `/etc/secrets.env` 拦截 |
| `allow` | 直接放行 | 读 `/tmp/debug.log` |
| `ask` | 每次都问用户 | 执行任何 shell 命令前 |

### 为什么面试官会记住这个

LangChain/LangGraph 生态里 **没有人做原生权限引擎**。它们在 tool 层没有 `@resource` 注解的概念，没有 `deny/boundary/allow/ask` 四级模型。这是你完全可以拿出来说的差异化设计。

---

## 五、生命周期钩子对比

### LangGraph：有限的事件回调

LangGraph 的 node 和 graph 支持 `callbacks`，但钩子种类有限：
- `on_chain_start` / `on_chain_end`
- `on_chat_model_start` / `on_chat_model_end`
- `on_tool_start` / `on_tool_end`

本质上是 LangChain 的回调系统，不是专门为 Agent 循环设计的。

### Taor：13 点生命周期钩子，专为 Agent 循环设计

每个 Turn 从头到尾，13 个拦截点：

```typescript
// Taor 的 13 个钩子
onSessionStart      // 会话开始
  beforeThink       // LLM 思考前 → 可以修改上下文
    (THINK phase)
  afterThink        // LLM 思考后 → 可以过滤/修改 LLM 输出
    beforeAct       // 工具执行前 → 可以修改参数或取消执行
      (ACT phase)
    afterAct        // 工具执行后 → 审计日志、结果验证
  afterObserve      // 观察后 → 自定义压缩逻辑
  onError           // 任何错误 → 自定义恢复策略
  beforeCompress    // 压缩前
  afterCompress     // 压缩后
onSessionEnd        // 会话结束
```

关键设计：**插件式扩展，不修改核心代码**。Hook handler 写在外部，注入到 Harness 中：

```typescript
const hook = {
  name: "audit-logger",
  hooks: ["afterAct"],
  handler: async (ctx, toolCall, result) => {
    console.log(`[AUDIT] ${toolCall.name} → ${result.ok ? "PASS" : "FAIL"}`)
    await saveToDatabase(toolCall, result)  // 审计日志持久化
  },
}
harness.setHooks(new HookRegistry([hook]))
```

### 大白话总结

- **LangGraph**：回调系统是 LangChain 的，拼凑感强。
- **Taor**：钩子是面向 Agent 循环原生设计的，13 个拦截点覆盖了整个 THINK-ACT-OBSERVE 流程。

---

## 六、状态管理对比

### LangGraph：Checkpoint = 全量快照

每个 Superstep 结束后，自动把整个 state（所有 channel 的值、所有 node 的状态、pending writes）序列化保存：

```python
# LangGraph 的 checkpoint 内容
checkpoint = {
    "channel_values": {...},      # 所有 channel 的当前值
    "channel_versions": {...},    # 每个 channel 的版本号
    "versions_seen": {...},       # 每个 node 见过哪些版本
    "pending_sends": [...],       # 排队中的 Send
}
```

恢复时加载这个 checkpoint，从中断的地方继续。适合复杂的 DAG——你需要完整的 state 才能知道"卡在哪了"。

### Taor：轻量序列化 = 消息历史快照

Taor 不存"完整 state"，只存消息历史和 turn 记录：

```typescript
// Taor 的序列化
serialize() {
  return {
    sessionId: "...",
    model: "...",
    tokenUsage: { ... },
    turns: this.turnHistory.map(turn => ({
      messages: this._turnMessages[turn.index],  // 每轮的完整消息
      tokenUsage: turn.tokenUsage,
    })),
  }
}
```

恢复时重放消息历史，从最后一轮继续。设计哲学：消息历史本身就是 Agent 所需的全部 state。

### 大白话总结

- **LangGraph**：像游戏存档，完整保存所有状态。适合长时间运行的复杂工作流。
- **Taor**：像聊天记录，只保存对话历史。轻量，适合 LLM Agent 的任务场景。

---

## 七、整体对比表

| 维度 | LangGraph Pregel | Taor |
|------|-----------------|------|
| **核心模型** | BSP（批量同步并行）| TAOR（串行事件流）|
| **循环单元** | Superstep | Turn |
| **执行方式** | 同一 Superstep 内 node 并行 | 同一 Turn 内 tool 串行 |
| **并行手段** | 线程池/协程自动调度 | `child_process.fork` 子 Agent |
| **任务触发** | Channel 订阅自动触发 | LLM 决定 → 框架执行 |
| **状态保存** | Checkpoint 全量快照 | 消息序列化 |
| **暂停/恢复** | 加载 checkpoint | AsyncGenerator 暂停 + deserialize |
| **权限系统** | ❌ 无原生支持 | ✅ 4 级权限引擎 + @resource 约束 |
| **错误恢复** | 声明式 retry_policy | ✅ 五级恢复（重试/跳过/降级/中止/忽略）|
| **生命周期钩子** | LangChain 回调（有限）| ✅ 13 点专为 Agent 循环设计 |
| **上下文压缩** | 依赖外部工具 | ✅ 5 层内置压缩 pipeline |
| **OpenTelemetry** | 需手动集成 | ✅ 内置 otel-hooks |
| **最小运行** | ~50 行 Python | ~30 行 TypeScript |

---

## 八、LangGraph 做得比 Taor 好的地方

1. **Checkpoint 机制更成熟**。LangGraph 的 checkpoint 是多年打磨的产物，支持 SQLite/Postgres 多种后端，支持增量快照和跨会话恢复。Taor 的序列化目前还比较基础。

2. **并行执行模型更适合复杂 DAG**。如果你的工作流是"先同时从 5 个 API 取数据 → 汇总分析 → 同时生成 3 份报告"，LangGraph 的 Superstep 并行模式天然适合，Taor 需要手动 spawn 子 Agent。

3. **生态和社区**。LangGraph 背靠 LangChain，有 10 万+ GitHub star。Taor 是你一个人做的，生态差距是致命的。但好消息是——企业用 LangGraph 的过程中，最痛的恰好就是 Taor 解决的三个问题（权限、上下文污染、子 Agent 隔离）。

## 九、Taor 做得比 LangGraph 好的地方

1. **原生权限引擎**。LangGraph/LangChain 生态里没有人做这个。对 AI for Science、金融、医疗等需要审计和权限控制的场景，这是硬需求。

2. **更轻量的状态机模型**。AsyncGenerator 让 Agent 循环天然可暂停、可恢复，不需要理解 BSP 和 channel 语义。30 行代码就能跑起来，LangGraph 至少要 50-80 行。

3. **面向错误恢复的设计**。五级恢复不是"更好的重试"，而是让你根据错误类型选择策略——这是生产环境 Agent 的真实需求，LangGraph 的 `retry_policy` 太粗糙了。

---

## 十、如果重新设计 Taor，我会改什么

1. **加一个"扇出"模式**。当前 Taor 的 tool 全部串行执行，如果 LLM 说"同时查这 5 篇文献"，应该支持一个 `parallel` 模式在 Turn 内并行执行，而不是每次都得 spawn 子 Agent。

2. **Checkpoint 机制引入增量保存**。目前 Taor 的序列化是全量保存消息历史，消息多了会很慢。LangGraph 那种 channel 级别的增量版本号机制值得借鉴。

3. **多 LLM Provider 的适配层再抽象一层**。目前 Taor 的 adapter 层直接对接各家 SDK，每个 adapter 重复了大量 boilerplate。应该参考 LangChain 的 `BaseChatModel` 设计，把共用的 token counting、tool formatting 抽到基类里。

4. **权限引擎可以做到更细粒度**。目前是 tool 级别的权限控制，未来可以做到参数级别的——比如"WriteFile 可以写 `/app/` 但不能超过 1MB"。

---

> **后记**：这篇对比不是为了证明谁更好。LangGraph 是一个优秀的框架，背后有世界级的工程团队。Taor 是一个研究生在几个月里写的——但它证明了：**理解一个系统的核心设计，和亲手实现它，是完全不同的两件事。** 前者让你成为"会用的人"，后者让你成为"会设计的人"。
