# TG1 A5 — Subagent Heartbeat 交付总结

> **完成时间**：2026-06-12
> **审查状态**：⏳ 待交叉审查
> **上一步**：A1 process/worktree 隔离
> **下一步**：A2 summarize + hooks

---

## 一、做了什么

给子 agent 添加心跳机制——worker 侧每 5 秒发心跳，handle 侧每 15 秒检查超时（30 秒无心跳 → 判定 zombie → 自动 abort）。覆盖 inline worker 和 process worker 两种隔离模式。

### 文件清单

```
packages/subagent/src/
├── handle.ts         [修改 +35行] _lastHeartbeat + startHeartbeatWatch/stopHeartbeatWatch
├── worker.ts         [修改 +8行]  setInterval(5s) 心跳 + finally cleanup
├── remote-entry.ts   [修改 +7行]  setInterval(5s) IPC 心跳
└── coordinator.ts    [修改 +3行]  spawn() 调用 startHeartbeatWatch(30_000)
```

**净增**：~50 行。

## 二、核心设计

### 2.1 心跳流

```
Worker (inline/remote)              Handle
  │                                   │
  │ setInterval(5s)                   │
  │ ├─ _onHeartbeat(turn, elapsed,    │
  │ │   tokenUsage)                   │ _lastHeartbeat = Date.now()
  │ └─ fire("heartbeat", ...)         │
  │                                   │
  │                                   │ setInterval(15s check)
  │                                   │ if now - _lastHeartbeat > 30s
  │                                   │   → abort("Heartbeat timeout")
  │                                   │   → stopHeartbeatWatch()
  │                                   │
  │ [worker stuck/zombie]             │
  │ no heartbeat for 30s              │
  │                                   │ → auto-abort triggered
```

### 2.2 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| heartbeat interval | 5s | 发送频率 |
| check interval | min(timeoutMs/2, 5s) | 检查频率 |
| timeout threshold | 30s | 判定 zombie 的阈值 |

### 2.3 生命周期

- `startHeartbeatWatch(30_000)` — coordinator.spawn() 中调用
- `stopHeartbeatWatch()` — 自动：abort/done/error 状态时停止
- Worker 的 `clearInterval(heartbeatInterval)` — run() 的 finally 块
- 子进程的 interval — 随 process.exit() 自动清理

---

## 三、潜在风险点

### R1: 检查间隔 = min(timeout/2, 5s)，30s 超时 → 15s 检查
如果 worker 在 15s 检查点之后崩溃，可能要等 15+30=45s 才检测到。TG1 可缩短检查间隔。

### R2: inline worker 心跳在 run() 的 try 块内启动
如果 `this.handle._onStarted()` 抛异常（在 try 块内），心跳 interval 永远不会启动——无泄漏，但 handle 的 watch 已启动 → 30s 后超时 auto-abort。

### R3: 心跳 message 用 `this.totalTurns` 
inline worker 的心跳在 `setInterval` 回调中读 `this.totalTurns`——可能与 TAOR 循环并发修改（JS 单线程无并发风险，但值可能不是最新 turn）。

---

## 四、验证状态

```
✅ npm run build       — 零错误
✅ npm run typecheck   — 零错误
✅ npm run test        — 10/10 通过
```

## 五、TG1 P0 进度

```
✅ A4. ErrorRecovery (+ F1-F4)
✅ B3. compress 读配置阈值
✅ A1. process/worktree 隔离 (+ F1-F3)
✅ A5. Subagent Heartbeat
⬜ A2. summarize + hooks         ← 下一步
⬜ A3. SqliteStore
```
