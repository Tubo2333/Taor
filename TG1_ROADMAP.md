# Harness Engine — TG1 路线图

> **起点**：TG0 (6,100 行, 9 包, 113 审查闭环)
> **目标**：生产可用的 AI Agent 运行时
> **审查**：架构审查通过（4 批准条件 + 10 修改建议已应用）

---

## 阶段 A：补齐核心功能（阻断生产）

### A4. ErrorRecovery 执行 ← P0 第一位

| 现状 | 目标 |
|------|------|
| onError 收集 recovery action 但丢弃 | retry/skip_turn/abort/ignore 全部生效 |
| harness.ts catch 块返回 fixed error state | 根据 recovery action 分支：retry → 重试当前 turn；skip_turn → 跳过；abort → 终止；ignore → 记录继续 |

**工作量**：~200 行。修改 `harness.ts runTAOR()` catch 块逻辑 + `HookRegistry.execute()` 返回值处理。

**依赖**：无（纯 harness 内部逻辑）。

---

### A1. Subagent: process + worktree 隔离

| 现状 | 目标 |
|------|------|
| inline only | child_process.fork() + IPC |
| defineTool() 闭包不可序列化 | class Tool 工具通过 IPC 传递 |

**工作量**：~800 行。新增 `ProcessWorker` + `WorktreeWorker` + IPC 序列化层 + zombie 进程清理 + Windows git worktree 路径处理。

**依赖**：TG0 SubagentHandleImpl 状态机（✅ 就绪）。

---

### A5. Subagent Heartbeat 机制 ← P0 新增

| 现状 | 目标 |
|------|------|
| Worker `_onHeartbeat` 只在 turn 边界触发 | 加定时器心跳（每 N 秒），超时无心跳 → 判定 zombie → 自动 abort |

**工作量**：~150 行。`SubagentWorker` 加 `setInterval` 心跳 + Coordinator 加心跳超时检测。

**依赖**：A1（process/worktree 隔离下更需要心跳检测僵尸进程）。

---

### A2. Compressor: summarize 实现 + beforeCompress/afterCompress hooks

| 现状 | 目标 |
|------|------|
| summarize stub 返回 identity | LLM 调用 summarize，实际减少 50%+ token |
| beforeCompress/afterCompress hooks 已定义但 TAOR 未调用 | compress() 前后触发 hooks |

**工作量**：~400 行。summarize 策略实现（LLM prompt 工程 + reentrancy 安全）+ TAOR 循环中 beforeCompress/afterCompress hook 调用点。

**依赖**：adapter 的 reentrant think() 支持（AnthropicAdapter 已满足：每次 think() 创建新 HTTP client）。

---

### A3. Memory: SqliteStore

| 现状 | 目标 |
|------|------|
| InMemory fallback | better-sqlite3 持久化（主方案） |
| 无备选方案 | sql.js (纯 JS/WASM, 无 native 编译依赖) 作为备选 |

**工作量**：~250 行。引入 better-sqlite3 依赖 + LIMIT/OFFSET 分页。若 CI 中 native 编译不可用，降级为 sql.js（零依赖，性能略低但可接受）。

**依赖**：MemoryStore 接口（✅ 就绪）。

---

### B3. Compress 自动触发读 config 阈值 ← 从 B 升 P0

| 现状 | 目标 |
|------|------|
| TG0 硬编码 100k | 读 `CompressorPipeline.triggerThreshold` |

**工作量**：~20 行。`harness.ts` 中 `100_000` → `this.compressorPipeline` 的属性读取。

**依赖**：CompressorPipeline（✅ 就绪）。

---

## 阶段 B：质量提升

### B1. 序列化 (serialize/deserialize)

支持跨会话恢复。TG0 已定义 `SerializedSession` 类型。

**工作量**：~300 行。实现 `harness.serialize()` + `Harness.deserialize()`。

**依赖**：TG0 `SerializedSession` / `SerializedTurn` 类型（✅ 就绪）。

### B2. Compressor: chunk + embed

| 层 | 需求 |
|------|------|
| chunk | 语义分块 + 相关性排序 |
| embed | 向量化 + 检索 |

需引入 embedding model。工作量：~400 行。

### B3. API-D8: @resource Zod annotations

TG0 用 regex 解析 `@resource:fs-path` → 迁移到 Zod `.annotations()` 或 JSONSchemaProperty 自定义字段。

**工作量**：~100 行。

### B4. API-S4: ToolRegistry onConflict 选项

`register()` 加 `onConflict?: "throw" | "skip" | "override"`。

**工作量**：~50 行。

---

## 阶段 C：生态与工具

### C1. CLI 工具
- `harness run` — 运行 agent session
- `harness config` — 生成配置模板
- `harness tool` — 脚手架生成工具

**工作量**：~300 行。新增 `@harness/cli` 包。

### C2. 文档
- API 参考（TypeDoc 自动生成）
- 快速入门指南
- 部署指南

### C3. 测试覆盖
- Permission engine 单元测试（API-D1）
- API-D2: SubagentHandle.on() 泛型统一 + 测试
- Hook 执行顺序测试
- Subagent 隔离测试
- Memory 后端一致性测试

**工作量**：~400 行。

---

## 延后清单回顾

| ID | 描述 | 阶段 | 状态 |
|------|------|------|------|
| API-D1 | defineTool() Zod/JSONSchema 重载单元测试 | C3 | ⬜ |
| API-S4 | ToolRegistry onConflict 选项 | B4 | ⬜ |
| API-D4 | serialize() mid-THINK guard | B1 | ⬜ |
| API-D8 | @resource 注解 Zod annotations | B3 | ⬜ |
| API-D2 | SubagentHandle.on() 泛型统一 | C3 | ⬜ |
| API-D5 | SqliteStore.list() LIMIT/OFFSET | A3 | ⬜ |
| mono-D3 | 集成冒烟测试 | ✅ TG0 | ✅ |
| I1-I6 | 结构接口对齐 | ✅ TG0.1 | ✅ |

---

## 优先级排序

```
P0 (TG1 必须交付):
  A4. ErrorRecovery 执行        ← 最高优先级，无外部依赖
  A1. process/worktree 隔离     ← IPC + 序列化
  A5. Subagent Heartbeat        ← 僵尸进程检测
  B3. compress 读配置阈值       ← 1 行改动，立即生效
  A2. summarize + hooks         ← LLM 调用 + beforeCompress/afterCompress
  A3. SqliteStore               ← 持久化（含 sql.js 备选）

P1 (TG1 建议交付):
  B1. 序列化
  B2. chunk + embed
  B4. onConflict 选项
  B3*. @resource Zod annotations

P2 (TG1 可选):
  C1-C3. CLI/文档/测试
```

---

## 预估

| 阶段 | 工作量 | 代码增量 |
|------|--------|---------|
| A (核心) | ~1,820 行 | +3 包 (process-worker, cli, sqlite) |
| B (质量) | ~850 行 | 增量修改 |
| C (生态) | ~700 行 | +CLI 包 + 文档 + 测试 |
| **总计** | **~3,370 行** | **TG0 6,100 → TG1 ~9,500** |
