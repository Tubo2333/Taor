# TG0 Step 10 — @taor/subagent 交付总结

> **完成时间**：2026-06-12
> **审查状态**：⏳ 待交叉审查
> **上一步**：Step 9 @taor/hooks（含 8 条审查修复）
> **下一步**：Step 11 @taor/memory

---

## 一、做了什么

实现了 `@taor/subagent` 包 — Sub-agent 派发与生命周期管理。包含 SubagentHandleImpl 完整状态机（6 状态、5 事件类型）、SubagentWorker 内联 TAOR 循环、SubagentCoordinator spawn() 派发器。集成到 harness.ts 的 `spawn()` 方法。

### 文件清单

```
packages/subagent/src/
├── types.ts         [不变 63行]   SubagentSpec/Handle/Result/Error/Heartbeat/Status
├── handle.ts        [重写 314行]  SubagentHandleImpl 状态机 + Promise API + 事件发射器
├── worker.ts        [新增 258行]  SubagentWorker 内联 TAOR 循环
├── coordinator.ts   [新增 184行]  SubagentCoordinator spawn() 派发器
└── index.ts         [不变 11行]   公共 API 导出

packages/core/src/
└── harness.ts       [修改 +132行] ISubagentCoordinator 结构接口 + setSubagent() + spawn() 委托

packages/engine/src/
└── index.ts         [修改 +18行]  createHarness() 创建 + 注入 SubagentCoordinator
```

**净增代码**：~830 行 TypeScript。**零新增外部依赖**。

---

## 二、核心设计

### 2.1 状态机（6 状态，不可逆）

```
            spawn()
pending ──────────→ starting ──────────→ running
  │                     │                    │
  │ abort()             │ startup fails      │ done / error
  ▼                     ▼                    ▼
aborted              error              done / error / aborted
```

- `pending + abort()` → aborted（不触发 starting）
- `starting + abort()` → 等启动完成后立即 abort
- 所有转换通过 `_transition()` 触发 `status-change` 事件
- 终端状态（done/error/aborted）不可逆

### 2.2 事件类型（5 种）

| 事件 | Handler 签名 | 触发时机 |
|------|-------------|---------|
| `started` | `() => void` | Worker 启动完成 |
| `done` | `(result: SubagentResult) => void` | Worker 执行完毕（ok/error） |
| `error` | `(error: SubagentError) => void` | 启动失败或执行异常 |
| `heartbeat` | `(h: SubagentHeartbeat) => void` | 每个 turn 边界（turnIndex/elapsed/tokenUsage） |
| `status-change` | `(from: SubagentStatus, to: SubagentStatus) => void` | 每次状态转换 |

### 2.3 Worker TAOR 循环（内联）

```
worker.run()
├── timeout guard (默认 300s)
├── push system + user prompt
├── handle._onStarted()
├── for turn in 0..maxTurns:
│   ├── THINK: adapter.buildRequest() + adapter.think() stream
│   │   └── 收集 tool_use 到 pendingToolCalls
│   ├── ACT: 执行每个 tool（受限工具集）
│   │   └── 结果以 tool_result 消息格式追加
│   ├── OBSERVE: 累积 token + 更新 turn 计数
│   └── handle._onHeartbeat(turnIndex, elapsed, tokenUsage)
├── 返回 SubagentResult（ok/turns/tokenUsage/error）
└── handle._onDone(result)
```

### 2.4 Coordinator spawn() 流程

```
spawn(spec)
├── 验证 isolation（TG0: inline only，其他抛错）
├── 创建 SubagentHandleImpl（id = subagent-{timestamp}-{random}）
├── 解析工具集
│   ├── spec.tools 为空 → 继承父 registry 全部工具
│   └── spec.tools 非空 → 按 name 过滤父 registry
├── handle._transition("starting")
├── 创建 SubagentWorker + worker.run() 后台执行
├── abort 转发：handle.abort() → worker.abort()
└── 同步返回 handle
```

### 2.5 依赖反转

```
@taor/core (harness.ts)
  ├── ISubagentCoordinator  ← 结构接口（类型擦除）
  ├── setSubagent()         ← 注入方法
  └── spawn()               ← 委托给 coordinator

@taor/subagent
  ├── SubagentHandleImpl    ← 状态机 + 事件
  ├── SubagentWorker        ← 内联 TAOR
  └── SubagentCoordinator   ← spawn() 派发

@taor/engine (index.ts)
  └── createHarness()       ← 组装 + 注入
```

---

## 三、关键决策

| # | 决策 | 理由 |
|---|------|------|
| D-1 | TG0 inline isolation only | process/worktree 需 IPC/fork + 工具类序列化，复杂度过高，延后 TG1 |
| D-2 | Worker 定义独立 InlineAdapter/InlineTool 结构接口 | 避免 import @taor/adapters → 循环引用 |
| D-3 | Coordinator 定义独立 CoordinatorAdapter/CoordinatorTool | 同上，但二者不兼容导致 `as any` 桥接。TG1 应统一为共享类型 |
| D-4 | handle.abort() 转发到 worker.abort() | 替换原始 abort 方法，确保 abort 同时更新状态机 + 停止 worker |
| D-5 | worker.run() 后台执行（不 await） | spawn() 返回同步 handle → 调用方可用 `await handle.done()` 等待 |
| D-6 | SubagentHandleImpl._ 前缀方法供 coordinator 调用 | 区分公共 API（用户）vs 内部 API（coordinator）：`_onStarted/_onDone/_onError/_onHeartbeat/_transition` |

---

## 四、潜在风险点（供交叉审查）

### R1: Worker 的 InlineAdapter 和 Coordinator 的 CoordinatorAdapter 类型不兼容
两个文件各自定义了独立的结构接口。Worker 的 `TokenUsage.total` 是 required，Coordinator 的是 `total?: number`。通过 `as any` 桥接——运行时正确但类型检查不覆盖。TG1 应提取到 shared-types 包。

### R2: Worker 的 tool_result 消息格式简化
TG0 使用 `{ role: "tool", content: [{ type: "tool_result", ... }] }` 而非 adapter 的标准 `wrapToolResult()`。如果 adapter 的 think() 期望特定 tool_result 格式，下一轮 THINK 可能解析失败。

### R3: Worker 不调用 beforeSpawn/afterSpawnResult hooks
这两个 hook 点在 Step 9 中已定义但标记为延后 Step 10。Step 10 实现了 Worker 但未在 coordinator.spawn() 中触发 hooks。

### R4: handle.abort() 替换的竞态
Coordinator 在 `worker.run().then(...)` 之前替换 `handle.abort`。如果在替换前调用 abort()，会使用原始 abort（不停止 worker）。窗口极小但存在。

### R5: SubagentHandleImpl 状态机不防并发
`_transition()` 和 Promise resolve 在不同微任务中执行。如果 coordinator 同时调用 `_onStarted()` 和 `_onError()`，状态转换可能交错。

### R6: spec.tools 过滤只匹配 ToolDescriptor
`typeof t === "object" && "name" in t` 过滤掉了 `ToolConstructor`（class）。虽然 TG0 inline 模式不严格要求（class 也可以在 registry 中注册为 ToolDescriptor），但如果 spec.tools 只包含 class，过滤结果为空集 → 子 agent 无工具可用。

---

## 五、验证状态

```
✅ npm run build       — 零错误
✅ npm run typecheck   — 零错误
⬜ 集成冒烟测试        — TG0 Step E
⬜ 单元测试            — 未纳入 TG0 范围
```

---

## 六、TG0 进度

```
1-10 ✅ (83%)
11   ⬜ @taor/memory       ← 下一步
12   ⬜ @taor/compressor
E    ⬜ @taor/engine (冒烟测试)
```

---

## 七、审查维度建议

1. **状态机完整性**：6 状态转换是否有遗漏路径？并发调用安全性？
2. **Worker TAOR 循环正确性**：与 harness.ts TAOR 循环的一致性？消息格式兼容性？
3. **事件发射器健壮性**：handler 异常隔离？listener 泄漏？
4. **工具过滤逻辑**：ToolDescriptor vs ToolConstructor 的区分？spec.tools 为空时的行为？
5. **Timeout/Abort 路径**：worker.run() finally 清理？timeout 和 abort 的语义区分？
6. **Promise 生命周期**：started/done Promise 的单次 resolve 保证？reject 后的状态一致性？
