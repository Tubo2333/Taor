# TG1 A1 — process/worktree 隔离 交付总结

> **完成时间**：2026-06-12
> **审查状态**：⏳ 待交叉审查
> **上一步**：A4 ErrorRecovery + B3 compress 阈值
> **下一步**：A5 Subagent Heartbeat

---

## 一、做了什么

实现子 agent 的进程级隔离。新增 `ProcessWorker`（child_process.fork + IPC）+ `remote-entry.ts`（子进程 TAOR 循环入口）。重构 `SubagentCoordinator.spawn()` 按 isolation 类型分支。

### 文件清单

```
packages/subagent/src/
├── process-worker.ts  [NEW 155行] ProcessWorker — fork + IPC + abort/kill
├── remote-entry.ts    [NEW 160行] 子进程入口 — 动态 import + TAOR
├── coordinator.ts     [REWRITE]   按 isolation 分支 + adapterModulePath
└── index.ts           [+1行]      导出 ProcessWorker
```

**净增**：~420 行 TypeScript。

## 二、核心设计

### 2.1 IPC 协议

```
Parent                          Child
  │                               │
  ├─ fork(remote-entry.js) ──────→│
  ├─ send({type:"init",spec,...})→│
  │                               ├─ dynamic import adapter + tools
  │                               ├─ send({type:"started"})
  │                               ├─ TAOR loop
  │                               ├─ send({type:"heartbeat",...})
  │                               ├─ send({type:"done",result})
  │                               └─ process.exit(0)
  ├─ send({type:"abort"}) ──────→│ (at any point)
  └─ on("message", handler)
```

### 2.2 Coordinator 分支

```
spawn(spec)
├── beforeSpawn hook (async)
├── resolve tools
├── handle._transition("starting")
├── isolation === "process"
│   └── runProcessWorker(handle, spec, tools)
│         ├── require adapterModulePath (构造时传入)
│         ├── new ProcessWorker(handle)
│         └── procWorker.run(spec, adapterPath, toolPaths)
└── else (inline / worktree)
    └── runInlineWorker(handle, spec, tools)
          └── new SubagentWorker(...).run()
```

### 2.3 子进程 TAOR 循环

与 inline worker 相同逻辑：THINK（adapter.think stream）→ ACT（tool.execute）→ OBSERVE（累积 token + heartbeat IPC）。使用动态 import 加载 adapter + tools。

---

## 三、关键决策

| # | 决策 | 理由 |
|---|------|------|
| D-1 | worktree 暂不实现，走 inline 分支 | git worktree add + path 管理需 ~200 行，TG1 后续单独交付 |
| D-2 | `adapterModulePath` 通过 Coordinator 构造注入 | 子进程需 import adapter，但 adapter 是实例非模块路径——需额外参数 |
| D-3 | toolModulePaths 暂为空数组 | TG1 仅传递 class Tool 的模块路径，defineTool() 闭包不可序列化 |
| D-4 | 子进程通过 `setTimeout(exit, 100)` 延迟退出 | 确保 IPC done/error 消息 flush 后再退出 |

---

## 四、潜在风险点

### R1: adapterModulePath 未传时静默失败
`runProcessWorker` 检查 `adapterModulePath` 为空时调用 `handle._onError` 并 return——但 `spawn()` 已返回 handle。调用方看到 handle 但子进程从未启动，`handle.done()` 永久挂起。

### R2: 子进程 dynamic import 失败无超时
`import(msg.adapterModulePath)` 失败 → 子进程 crash → 父进程 `exit` 事件捕获。但如果 import 挂起（网络文件系统），父进程无超时检测。

### R3: 子进程 orphan 风险
父进程在子进程 exit 前 crash → 子进程成为 orphan → 持续运行消耗资源。缺少父进程心跳检测。

### R4: IPC 消息顺序
`done` 消息在 `setTimeout(exit, 100)` 前发送——如果 IPC 通道在 exit 前未 flush，父进程收不到 done。

---

## 五、验证状态

```
✅ npm run build       — 零错误
✅ npm run typecheck   — 零错误
✅ npm run test        — 10/10 通过
```

## 六、TG1 P0 进度

```
✅ A4. ErrorRecovery (+ F1-F4)
✅ B3. compress 读配置阈值
✅ A1. process/worktree 隔离
⬜ A5. Subagent Heartbeat        ← 下一步
⬜ A2. summarize + hooks
⬜ A3. SqliteStore
```
