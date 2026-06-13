# TG0 Step 9 — @taor/hooks 交付总结

> **完成时间**：2026-06-12
> **审查状态**：⏳ 待交叉审查
> **上一步**：Step 8 @taor/permission（含 9 条审查修复）
> **下一步**：Step 10 @taor/subagent

---

## 一、做了什么

实现了 `@taor/hooks` 包 — 13 个 TAOR 生命周期 Hook 点的链式注册、优先级排序执行、短路语义和错误隔离。并集成到 harness.ts 的 TAOR 核心循环中。

### 文件清单

```
packages/hooks/src/
├── types.ts         [不变 75行]   HookHandlerMap(13点) + ErrorRecovery + HookRegistration + HookInput
├── registry.ts      [重写 314行]  HookRegistry 完整实现
└── index.ts         [不变 9行]    公共 API 导出

packages/core/src/
└── harness.ts       [修改 +213行] IHookRegistry 结构接口 + setHooks() + 7 个 TAOR 集成点

packages/engine/src/
└── index.ts         [修改 +15行]  createHarness() 创建 + 注入 HookRegistry
```

**净增代码**：~540 行 TypeScript。**零新增外部依赖**。

---

## 二、核心设计

### 2.1 Hook 点（13 个）

| 类别 | Hook | 参数 | 返回值语义 |
|------|------|------|-----------|
| Session | `onSessionStart` | `SessionContext` | void |
| Session | `onSessionEnd` | `SessionContext, SessionResult` | void |
| Turn | `beforeThink` | `TurnContext` | 返回 `TurnContext` = 替换 ctx |
| Turn | `afterThink` | `TurnContext, ThinkEvent[]` | 返回 `ThinkEvent[]` = 替换 events |
| Turn | `beforeAct` | `TurnContext, ToolCall` | 返回 `ToolCall` = 修改调用；`null` = 取消 |
| Turn | `afterAct` | `TurnContext, ToolCall, ToolResult` | void |
| Turn | `afterObserve` | `TurnContext, Observation` | 返回 `Observation` = 替换 obs |
| Compress | `beforeCompress` | `TurnContext, CompressLevel` | void |
| Compress | `afterCompress` | `TurnContext, CompressedEvent` | void |
| Error | `onError` | `SessionContext, HarnessError` | 返回 `ErrorRecovery` = 恢复策略 |
| Sub-agent | `beforeSpawn` | `SubagentSpec` | 返回 `SubagentSpec` = 修改规格 |
| Sub-agent | `afterSpawnResult` | `SubagentHandle, SubagentResult` | void |

### 2.2 执行顺序

```
Priority 高 → 低依次执行
同 priority → 注册顺序
某 handler 抛异常 → 后续 handler 仍执行（独立错误收集）
所有 handler 执行完毕 → 有错误则触发 onError（防递归：onError 自身的错误不再次触发 onError）
```

### 2.3 TAOR 集成点

```
runTAOR()
├── onSessionStart(ctx)                    ← 初始 prompt 后
├── for each turn:
│   ├── beforeThink(ctx)                   ← buildRequest() 前（可修改 ctx）
│   ├── [adapter.think() stream]
│   │   └── thinkEvents[] 累积
│   ├── afterThink(ctx, thinkEvents)       ← ACT phase 前
│   ├── for each tool:
│   │   ├── beforeAct(ctx, call)           ← execute() 前（null = 取消工具）
│   │   ├── [tool.execute()]
│   │   └── afterAct(ctx, call, result)    ← execute() 后
│   └── afterObserve(ctx, observation)     ← turn-ended 前（可修改 observation）
├── onError(ctx, error)                    ← 适配器错误 / fatal 错误
└── onSessionEnd(ctx, result)              ← finally 块
```

### 2.4 依赖反转

```
@taor/core (harness.ts)
  ├── IHookRegistry       ← 结构接口（类型擦除为 unknown[] 参数/返回值）
  ├── setHooks()          ← 注入方法
  └── hooks getter        ← 返回注入的 registry（未注入时抛错）

@taor/hooks (registry.ts)
  └── HookRegistry        ← 真实实现（依赖 @taor/core + @taor/adapters + @taor/tools）

@taor/engine (index.ts)
  └── createHarness()     ← 组装：new HookRegistry(config.hooks) → harness.setHooks()
```

### 2.5 Config 语法糖（HookInput）

```typescript
// 方式 1: Partial<HookHandlerMap> — 简单场景
hooks: [{
  beforeThink: async (ctx) => { /* inject context */ },
  afterAct: async (ctx, call, result) => { /* audit log */ },
}]

// 方式 2: HookRegistration[] — 需要 priority/once/name
hooks: [[
  { hook: "beforeThink", handler: injectContext, priority: 100, name: "inject-ctx" },
  { hook: "afterAct", handler: auditLog, name: "audit" },
]]
```

---

## 三、关键决策

| # | 决策 | 理由 |
|---|------|------|
| D-1 | `execute()` 返回 `Promise<unknown[]>` | 不同 hook 点返回值类型不同（void/TurnContext/ToolCall/Observation/ErrorRecovery 等），统一擦除为 unknown[]，调用方按 hook 语义解释 |
| D-2 | beforeAct 取消通过检查 `results.some(r => r === null)` | 避免引入额外的 CancellationToken — 利用现有返回值语义 |
| D-3 | onError 不递归触发 | `execute("onError", ...)` 内部跳过 onError 连锁调用，防止无限递归 |
| D-4 | once handler 在 `execute()` 后批量移除 | 避免在迭代中修改 handler 数组（先收集 toRemove，再统一删除） |
| D-5 | thinkEvents[] 在流式消费期间累积 | `afterThink` 需要完整事件列表，但 think stream 是流式的 — 引入 `thinkEvents` 数组在 for-await 中 push |

---

## 四、潜在风险点（供交叉审查）

### R1: `beforeThink` ctx 合并策略
修改 ctx 通过 `{ ...ctx, ...(r as Record<string, unknown>) }` 浅合并。如果 handler 返回的是 `TurnContext`，嵌套对象（如 `session`, `turn`, `shared`）会被整体替换而非深度合并。这是预期的还是应该深度合并？

### R2: `afterThink` 返回值未使用
`afterThink` handler 可以返回修改后的 `ThinkEvent[]`，但 TG0 代码中 `execute("afterThink", ctx, thinkEvents)` 的返回值被丢弃（未赋值）。Handler 只能通过副作用修改 thinkEvents 数组（引用传递）。是否符合 API 规范 §9.3 "返回值覆盖 events"？

### R3: `IHookRegistry` 结构接口过于宽泛
类型擦除为 `execute(hook: string, ...args: unknown[]): Promise<unknown[]>` — 调用方传错参数类型时编译器不会报错。Step 8 的 `IPermissionEngine` 保留了 `PermissionVerdict` 类型，但 Step 9 的 `IHookRegistry` 更激进地擦除了类型。

### R4: `onError` Hook 的 SessionContext
`fireOnError()` 中传 `{ session: null, turn: null, shared: null }` 作为 SessionContext。真实调用发生在 `harness.ts` 的 catch 块中（有完整的 session state）。但在 `registry.ts` 的 `execute()` 内部错误收集触发的 `fireOnError()` 中没有真实的 context 可用。

### R5: `beforeCompress` / `afterCompress` / `beforeSpawn` / `afterSpawnResult` 未集成
这 4 个 hook 点已在 `HookHandlerMap` 中定义，但 TAOR 循环中未调用（compressor 和 subagent 是 TG0 Step 10/12，尚未实现）。这是故意的延后还是遗漏？

### R6: `afterThink` events 修改无法影响已发射的 HarnessEvent
ThinkEvent 在流式消费时已经通过 `pushEvent()` 发射给消费者。`afterThink` handler 返回的修改后 events 不能撤销已发射的事件。如果 handler 过滤了某些 tool_use，ACT phase 仍会使用原始的 `pendingToolCalls` 而非修改后的。

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
1-9 ✅ (75%)
10  ⬜ @taor/subagent     ← 下一步
11  ⬜ @taor/memory
12  ⬜ @taor/compressor
E   ⬜ @taor/engine (冒烟测试)
```

---

## 七、审查维度建议

1. **Hook 执行顺序与 API 规范一致性**：逐点对比 §9.2-9.4
2. **短路语义正确性**：beforeAct null 取消、beforeThink/afterObserve 返回值覆盖
3. **错误隔离边界**：handler 异常 → 继续 → onError 触发 → 不递归
4. **once/signal 生命周期**：once 在 execute() 后移除（非立即）、signal 在 abort 时移除（立即）— 是否合理？
5. **thinkEvents 累积与 afterThink 之间的竞态**：无（单线程 async），但需标注
6. **缺失的 4 个 Hook 集成点**：是否为延后（TG0 Step 10/12）还是遗漏
