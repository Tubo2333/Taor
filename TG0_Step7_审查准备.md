# Taor — TG0 Step 7 审查准备（TAOR 核心引擎）

> **用途**：粘贴到新 Claude Code 窗口，以独立专家视角对 TAOR 核心引擎做最严苛的 adversarial review。
> **进度**：TG0 12 步中已完成前 7 步（58%）。**Step 7 是整个框架的心脏。**
> **历史审查**：累计 28 + 19 = 47 条审查意见全部闭环。

---

## 项目是什么

开源的 **Taorering 框架**（TypeScript agent 框架），基于 Claude Code 泄露源码设计。

- **语言**：TypeScript（strict, verbatimModuleSyntax, isolatedModules, composite project references）
- **模式**：轻量内核 + 可组合引擎（9 个独立 npm 包，workspace 协议）
- **核心**：TAOR Loop（AsyncGenerator 状态机，双向通道）
- **API 规范**：[Harness_API_Design_v2.md](Harness_API_Design_v2.md)（15 章）
- **4 条设计哲学**：「先便宜后贵」「只记偏好不记代码」「运行时越笨架构越稳」「Coordinator 只派活不动文件」

---

## TG0 实现路线图

```
1-3 ✅ types → context → events                          [类型层，纯类型]
4   ✅ @taor/tools                                    [工具系统，+28条审查]
5   ✅ @taor/adapters                                 [LLM适配器层，650行]
6   ✅ @taor/core/config.ts                           [配置校验，NaN全覆盖]
7   ✅ @taor/core/harness.ts (TAOR 循环)              [🔑 核心引擎 — 1033行]
8   ⬜ @taor/permission                               [下一步]
9   ⬜ @taor/hooks
10  ⬜ @taor/subagent
11  ⬜ @taor/memory
12  ⬜ @taor/compressor
E   ⬜ @taor/engine (冒烟测试)
```

---

## Step 7: TAOR 核心引擎 — 完整架构

### Harness 主类（1033 行）

`packages/core/src/harness.ts` — 实现了 `AsyncGenerator<HarnessEvent, SessionResult, UserDecision>`

### 架构总图

```
                         ┌──────────────────────────────────┐
                         │         createHarness()           │
                         │       (@taor/engine)           │
                         │  validateConfig → new Harness()   │
                         └──────────────┬───────────────────┘
                                        │
                         ┌──────────────▼───────────────────┐
                         │           Harness                 │
                         │                                  │
                         │  ┌────────────────────────────┐  │
                         │  │     TAOR Loop (内部)        │  │
                         │  │                            │  │
                         │  │  THINK ────→ ACT ────→ OBS │  │
                         │  │    │           │        │   │  │
                         │  │    ▼           ▼        ▼   │  │
                         │  │ IAdapter   IToolReg  format │  │
                         │  └──────────┬─────────────────┘  │
                         │             │ pushEvent()         │
                         │  ┌──────────▼─────────────────┐  │
                         │  │   Bounded FIFO Queue        │  │
                         │  │  (capacity: eventQueueCap)  │  │
                         │  └──────────┬─────────────────┘  │
                         │             │ next() pull         │
                         │  ┌──────────▼─────────────────┐  │
                         │  │  AsyncGenerator Protocol    │  │
                         │  │  + EventEmitter (side)      │  │
                         │  └────────────────────────────┘  │
                         └──────────────────────────────────┘
```

### 依赖反转（关键架构决策）

`@taor/core` 不能运行时 import `@taor/tools` 或 `@taor/adapters`（TypeScript composite project references 形成 DAG 环）。解决方案：

| 组件 | 真实定义 | core 中使用 | 如何桥接 |
|------|---------|------------|---------|
| Adapter | `LLMAdapter` in `@taor/adapters` | `IAdapter` 结构接口（私有） | `createHarness()` 传入 `AnthropicAdapter` 实例 → `as any` cast |
| ToolRegistry | `ToolRegistry` in `@taor/tools` | `IToolRegistry` 结构接口（私有） | `createHarness()` 创建实例 + register → `as any` cast |
| ToolDescriptor | `ToolDescriptor` in `@taor/tools` | `ToolDef` 结构接口（私有） | 结构兼容 |
| ToolResult | `ToolResult<T>` in `@taor/tools` | `ToolExecResult` 结构接口（私有） | 结构兼容 |
| ThinkEvent | `ThinkEvent` in `@taor/adapters` | 本地 `ThinkEvent` 联合类型（私有） | 结构兼容 |

### Harness 构造函数

```typescript
constructor(config: ResolvedConfig, adapter: IAdapter, registry: IToolRegistry)
```

- `config` — 通过 `validateConfig()` 填充默认值的完整配置
- `adapter` — 预实例化的 LLM adapter（满足 `IAdapter` 结构接口）
- `registry` — 预注册好的工具注册表（满足 `IToolRegistry` 结构接口）
- 初始化 session state、event queue、abort controller、event emitter

### TAOR 循环（`runTAOR()` — 内部 async task）

```
for turnIndex in 0..maxTurns:
  ┌─ Turn Setup ──────────────────────────────────────
  │ 创建 TurnState，推送 turn-started 事件
  │
  ├─ THINK ───────────────────────────────────────────
  │ adapter.buildRequest(ctx, {tools}) → request
  │ for await (thinkEvent of adapter.think(request, signal)):
  │   text_delta    → push thought(kind:"text")
  │   thinking_delta → push thought(kind:"thinking")
  │   tool_use      → 记录到 pendingToolCalls[]
  │   stop          → 记录 tokenUsage
  │   error         → push error 事件，abort loop
  │
  ├─ ACT ─────────────────────────────────────────────
  │ for each pendingToolCall:
  │   ├─ 查 registry.get(tc.name)
  │   ├─ 权限检查 (risk + requiresApproval)
  │   ├─ 如需审批：
  │   │   push approval-required 事件
  │   │   await waitForDecision()  ← 双向通道，consumer 通过 next(decision) 注入
  │   │   deny → push blocked，continue
  │   │   approve → 继续执行
  │   │   approve-all → autoApproveRest = true
  │   ├─ 执行 tool.execute(params, ctx)
  │   ├─ push tool-call 事件
  │   └─ push tool-result 事件
  │
  ├─ OBSERVE ─────────────────────────────────────────
  │ 累计 tokenUsage
  │ adapter.wrapToolResult() → Message[] 追加到 messages
  │ 记录 TurnRecord → turnHistory
  │ push turn-ended 事件
  │
  └─ 终止条件：pendingToolCalls.length === 0（模型没再调工具）
```

### Event Queue 机制

```
TAOR loop pushEvent(event):
  if resolveNext 存在 → 直接交付给等待的 consumer
  else → eventQueue.push(event)

Consumer next(decision?):
  1. 如有 decision → resolveDecision(decision) 唤醒 TAOR
  2. eventQueue 有内容 → shift + return {done:false, value:event}
  3. isLoopDone → return {done:true, value:sessionResult}
  4. 否则 → return new Promise(resolve => resolveNext = resolve)  ← 挂起等待
```

### 双向通道（审批注入）

```
TAOR: yield approval-required → await waitForDecision()
Consumer: harness.next({type:"approve", callId:"xxx"})
         → resolveDecision({type:"approve",...})
         → TAOR 的 await 解除 → 继续执行工具
```

### EventEmitter（旁路多播）

- `on("*", handler)` — 监听所有事件
- `on("tool-call", handler)` — 类型窄化监听
- `off(type, handler)` / `offAll(type?)` — 解绑
- `{signal}` option — AbortSignal 自动解绑
- Handler 抛错不 crash 主循环（try-catch 包裹）

### 控制方法

| 方法 | 行为 |
|------|------|
| `start(prompt)` | 设置初始提示词，返回 this。循环不启动直到第一个 next() |
| `abort(reason?)` | AbortController.abort()，wake consumer，推送 abort 结果 |
| `kill()` | abort + clear queues + clear listeners + clear resolvers |
| `pause()` | session.status → "paused" |
| `resume()` | session.status → "running"（如果 paused） |

### 关键并发安全

| 场景 | 处理 |
|------|------|
| TAOR 循环中 consumer 调 `next(decision)` | decision 通过 Promise resolver 注入，两线程通过闭包通信 |
| TAOR 循环 push + consumer pull 同时 | 先检查 resolveNext（consumer 等待），再入队（无等待者） |
| `abort()` 在 streaming 中途调用 | signal.aborted 在 for-await 循环中多次检查，catch 块判断 signal.aborted 不 yield error |
| 多个 side-channel handler 并发 fire | 同步 forEach + try-catch 包裹，不影响主循环 |

---

## 前序步骤概要

| Step | 包 | 关键文件 | 行数 |
|------|-----|---------|------|
| 1-3 | core | types.ts, context.ts, events.ts, session.ts, unresolved.ts | ~250 |
| 4 | tools | types.ts, descriptor.ts, base.ts, registry.ts, validation.ts | ~660 |
| 5 | adapters | types.ts, anthropic.ts (650行) | ~770 |
| 6 | core | config.ts (validateConfig + ResolvedConfig) | ~190 |
| 7 | core | harness.ts (TAOR 核心引擎) | ~1033 |
| **合计** | | 18 文件 | ~2900 行 |

---

## 审查命令（粘贴到新窗口）

```
你是一位 TypeScript 并发系统专家，曾在 Deno / Bun / Vercel AI SDK 级别的团队做过异步运行时和 streaming 系统的核心设计审查。我现在有一个开源的 AI agent 框架项目在 d:/C-file/Harness_Engineer/。刚刚完成了 TG0 第 7 步——TAOR 核心引擎（AsyncGenerator 状态机，1033 行），这是整个框架的心脏。

请你从头审查所有已完成代码（Step 1-7），以最严苛的 adversarial review 视角，特别聚焦于 TAOR 循环的并发正确性、AsyncGenerator 协议实现、事件队列的正确性、以及模块间的类型鸿沟。

必读文件（按依赖拓扑序）：
- d:/C-file/Harness_Engineer/tsconfig.base.json
- d:/C-file/Harness_Engineer/package.json
- d:/C-file/Harness_Engineer/packages/core/src/types.ts
- d:/C-file/Harness_Engineer/packages/core/src/context.ts
- d:/C-file/Harness_Engineer/packages/core/src/events.ts
- d:/C-file/Harness_Engineer/packages/core/src/config.ts
- d:/C-file/Harness_Engineer/packages/core/src/session.ts
- d:/C-file/Harness_Engineer/packages/core/src/unresolved.ts
- d:/C-file/Harness_Engineer/packages/core/src/harness.ts          ← 本次重点
- d:/C-file/Harness_Engineer/packages/core/src/index.ts
- d:/C-file/Harness_Engineer/packages/tools/src/types.ts
- d:/C-file/Harness_Engineer/packages/tools/src/descriptor.ts
- d:/C-file/Harness_Engineer/packages/tools/src/base.ts
- d:/C-file/Harness_Engineer/packages/tools/src/registry.ts
- d:/C-file/Harness_Engineer/packages/tools/src/validation.ts
- d:/C-file/Harness_Engineer/packages/adapters/src/types.ts
- d:/C-file/Harness_Engineer/packages/adapters/src/anthropic.ts
- d:/C-file/Harness_Engineer/packages/engine/src/index.ts
- d:/C-file/Harness_Engineer/Harness_API_Design_v2.md（全文：架构→TAOR→Event→Adapter→Tool→Config）
- d:/C-file/Harness_Engineer/TG0_DEFERRED.md
- d:/C-file/Harness_Engineer/Harness_Tools_Step4_审查.md（11条已修复）
- d:/C-file/Harness_Engineer/Harness_TG0_Step1-5_综合审查.md（17条已修复）
- d:/C-file/Harness_Engineer/Harness_TG0_Step1-6_综合审查.md（19条已修复）
- d:/C-file/Harness_Engineer/TG0_Step6_审查准备.md（前序总结）

审查维度（按严重度：🔴致命 / 🟡重要 / 🟢建议）：

**维度 1：AsyncGenerator 协议正确性**
- `next()` / `return()` / `throw()` 三方法的实现是否完全符合 ECMAScript AsyncGenerator 语义？
- `return()` 调用后 `next()` 是否仍可能返回未消费的事件？
- `throw()` 注入的错误是否正确传播到 TAOR 循环？
- `[Symbol.asyncIterator]()` 返回 `this` — 多次 `for await` 是否会导致状态混乱？

**维度 2：TAOR 循环并发安全**
- `pushEvent()` 和 `next()` 之间的竞态条件：consumer 在 `next()` 中等待的同时，TAOR 循环 `pushEvent()` 修改 `resolveNext` —— 是否有丢失唤醒的风险？
- `abort()` 在 TAOR 循环的不同阶段（THINK/ACT/OBSERVE/审批等待中）调用 —— 每个路径是否正确处理？
- `waitForDecision()` 的 Promise resolver —— 如果 consumer 在 TAOR 循环 await 之前调 `next(decision)`，decision 是否会丢失？
- TAOR 循环是 `async runTAOR()` 后台运行，如果在 `start()` 后立即 `abort()`（runTAOR 尚未启动），行为是什么？

**维度 3：事件完整性**
- 是否所有 `HarnessEvent` 14 变体都在 TAOR 循环的对应阶段被 yield？
- THINK phase 中 `tool_use` 事件只记录到 `pendingToolCalls` 但没有 yield 给 consumer（consumer 在 streaming 期间只看到 thought 事件）— 这是有意设计还是遗漏？
- OBSERVE phase 中 `newMessages: []` — Observation 的 messages 字段为什么始终为空？
- `message_start` / `content_block_stop` 等 Anthropic SSE 事件被映射到哪里？
- `heartbeat` 事件 — 定义了但从未被 yield。TAOR 循环是否有超时心跳机制？

**维度 4：依赖反转的类型安全**
- `IAdapter` / `IToolRegistry` / `ToolDef` / `ToolExecResult` 是私有结构接口 — 它们与 `@taor/adapters` 和 `@taor/tools` 的真实类型是否完全兼容？
- `createHarness()` 中用 `as any` 桥接结构接口 — 如果未来 adapter 或 registry 的接口增加必需字段，在哪一层会先断裂？编译期还是运行时？
- `ToolCallResult.result` 在 `context.ts` 中是 `unknown`，在 harness.ts 中被 `as ToolExecResult` 强转 — TTOR 循环如何保证运行时类型确实匹配？
- `AdapterRequest = unknown` 来回传递 — `buildRequest()` 产出和 `think()` 消费之间的类型契约完全靠约定，没有编译期保证。这是 accept 的 tradeoff 还是有更好的方案？

**维度 5：状态机完整性**
- `SessionState.status` 的状态转换图（running → paused → running, running → completed/aborted/error）是否正确？是否有非法转换（如 aborted → running）？
- `isLoopRunning` / `isLoopDone` 两个 flag 和 `sessionState.status` 三个状态源 —— 有没有可能三者不一致？
- `pendingPrompt` — 如果 `start()` 被调用两次，第二次的 prompt 是覆盖还是追加？
- 循环终止条件 `pendingToolCalls.length === 0` — 如果第一个 turn 模型就产生 tool_use 呢？这是否会过早终止？

**维度 6：对下游模块的接口契约**
- Harness constructor 的 `adapter` 和 `registry` 参数没有暴露在公共 API 中（`createHarness()` 封装了）—— 用户如何注入 mock adapter 或 mock registry 做测试？
- `spawn()` / `hooks` / `permission` / `memory` getter 全部抛错 — 这些是留给 Step 8-11 实现的，但 Harness 的核心 TAOR 循环在无这些子系统时是否能正常工作？
- `serialize()` 的 guard 检查 `isLoopRunning` — 如果 TAOR 循环在 `waitForDecision()` 中（审批等待），这是 turn 边界吗？可序列化吗？

**维度 7：前序 47 条修复抽查**
- Harness constructor 中 `if (!adapter) throw` — 但 adapter 参数类型是 `IAdapter`（非 optional），TypeScript 编译期已保证不为 undefined。运行时检查是否有其他目的？
- NaN 防御：5 个数值入口全覆盖 — 抽查 `maxTurns`/`timeout`/`eventQueueCapacity`/`approvalTimeout`/`sampleRate`
- Tool 类 `TParams extends z.ZodObject<any>` — 三条路径（defineTool/tool/class Tool）是否全部在编译期拦截 `z.string()`？
- `SessionStatus."done"` → `"completed"` 统一 — 所有引用点是否都更新？有无残留 `"done"`？

请输出：🔴致命 / 🟡重要 / 🟢建议，每条附文件:行号和具体修复方向。不要重复前序 47 条已修复问题。特别关注 TAOR 循环中的并发竞态条件和 AsyncGenerator 协议正确性——这些是单线程 JavaScript 中最容易出错的领域。
```
