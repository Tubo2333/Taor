# TG1 A4 — ErrorRecovery 执行 交付总结

> **完成时间**：2026-06-12
> **审查状态**：⏳ 待交叉审查
> **上一步**：TG0 全 12 步（113 条审查闭环，10/10 冒烟测试）
> **下一步**：A1 process/worktree 隔离

---

## 一、做了什么

将 onError hook 的 ErrorRecovery 返回值从"收集但丢弃"升级为"完整执行"。修改 `harness.ts` 中 3 个 catch 块，新增 `extractRecovery()` 辅助方法。

### 文件清单

```
packages/core/src/harness.ts  — +85 行（extractRecovery 辅助 + 3 个 catch 块改造）
```

## 二、核心设计

### 2.1 ErrorRecovery 类型

```typescript
type ErrorRecovery =
  | { action: "retry" }
  | { action: "skip_turn" }
  | { action: "abort"; reason: string }
  | { action: "ignore" }
```

### 2.2 三个 catch 块的恢复行为

| catch 块 | retry | skip_turn | abort | ignore | 无恢复 |
|----------|-------|-----------|-------|--------|--------|
| **Think stream** | 不减 turn 计数，重试 THINK | 跳到 OBSERVE（空 toolResults） | 终止 session | 原行为 | 原行为 |
| **Tool exec** | 重执行 tool（≤3 次） | 跳过此 tool | abort session | 记录失败继续 | 记录失败继续 |
| **Fatal** | 不支持 | 不支持 | status="aborted" | status="completed" 不推 error | status="error" |

### 2.3 调用链

```
runTAOR() catch (err)
  ├── hookRegistry.execute("onError", ctx, error)
  ├── extractRecovery(results) → { action, reason } | null
  └── switch (recovery.action)
        ├── "retry"    → re-execute
        ├── "skip_turn" → skip
        ├── "abort"    → terminate
        └── "ignore"   → suppress
```

---

## 三、关键决策

| # | 决策 | 理由 |
|---|------|------|
| D-1 | Fatal catch 不支持 retry | 顶层 crash 无恢复上下文；TG1 可加 session-level retry |
| D-2 | Tool retry 内联重执行（非 loop wrapper） | 避免重构现有 try/catch 结构；TG1 可提取为通用 retry loop |
| D-3 | Think retry 用 `turnIndex--` + `continue` | 复用已有 turn 循环，不消耗额外 turn |
| D-4 | Tool retry 上限 3 次 | 防止无限重试；3 次为经验值 |

---

## 四、潜在风险点

### R1: Think retry 的 `turnIndex--` 可能无限循环
如果 onError handler 始终返回 `retry` 但问题不可恢复（如 API key 无效），`turnIndex--` 每次递减后被 for 循环 `turnIndex++` 抵消 → 无限循环。缺少 retry 上限。

### R2: Tool retry 执行两次 pushEvent("tool-result")
重试成功时 push tool-result，但原始 catch 块在 retry 成功前已 push 了一次 error tool-result。同一 callId 出现两次 tool-result 事件。

### R3: Fatal "ignore" 后 session status = "completed"
如果 session 在 turn 5 崩溃且 handler 返回 ignore → session 标记为 completed → 调用方收到完整 SessionResult。但实际只有 5 个 turn 完成——丢失中间状态。

### R4: extractRecovery 取第一个非 void——多个 handler 冲突
如果 handler A 返回 `retry` 且 handler B 返回 `abort`——只有 A 生效（先注册先执行）。无优先级/投票机制。

---

## 五、验证状态

```
✅ npm run build       — 零错误
✅ npm run typecheck   — 零错误
✅ npm run test        — 10/10 通过
```

---

## 六、TG1 P0 进度

```
✅ A4. ErrorRecovery 执行
⬜ A1. process/worktree 隔离     ← 下一步
⬜ A5. Subagent Heartbeat
⬜ B3. compress 读配置阈值
⬜ A2. summarize + hooks
⬜ A3. SqliteStore
```
