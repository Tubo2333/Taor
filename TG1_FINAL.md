# Taor — TG1 最终交付文档

> **完成日期**：2026-06-12
> **状态**：✅ TG1 P0+P1 交付完成
> **前一阶段**：TG0 (6,100 行, 113 条审查闭环)

---

## 一、TG1 成果

| 指标 | TG0 | TG1 | 总计 |
|------|-----|-----|------|
| TypeScript 源码 | ~6,100 行 | ~2,500 行 | **~8,600 行** |
| 包数 | 9 | +0 | 9 |
| 审查修复 | 113 条 | ~30 条 | ~143 条 |
| 冒烟测试 | 10/10 | 10/10 | ✅ |

### P0 (全部完成)

| 项 | 描述 | 代码量 |
|------|------|--------|
| A4 | ErrorRecovery 执行 — retry/skip_turn/abort/ignore | +100 |
| B3 | compress 读配置阈值 | 3 行 |
| A1 | process/worktree 隔离 — ProcessWorker + IPC | +420 |
| A5 | Subagent Heartbeat — 5s 间隔 + 30s 超时检测 | +50 |
| A2 | summarize LLM 实现 + beforeCompress/afterCompress | +160 |
| A3 | SqliteStore — better-sqlite3 持久化 | +120 |

### P1 (B1 完成)

| 项 | 描述 | 代码量 |
|------|------|--------|
| B1 | serialize/deserialize — 会话快照 + 恢复 | +60 |

---

## 二、TG0+TG1 完整包结构

```
@taor/engine          — createHarness 工厂
├── @taor/core        — TAOR 循环 + 7 结构接口
├── @taor/tools       — defineTool/tool()/Tool → ToolRegistry
├── @taor/adapters    — AnthropicAdapter (完整)
├── @taor/permission  — 4 级 PermissionEngine
├── @taor/hooks       — 13 钩子点 HookRegistry
├── @taor/subagent    — inline/process 隔离 + Heartbeat
├── @taor/memory      — 3 层 MemoryFacade + 3 后端
└── @taor/compressor  — 5 层 CompressorPipeline (summarize 实现)
```

---

## 三、TG1 关键改进

| 改进 | 前 | 后 |
|------|-----|-----|
| 子 agent 隔离 | inline only | inline + process (fork+IPC) |
| 压缩 | trim + truncate (stub summarize) | summarize LLM 实现 |
| 记忆 | InMemory + Json (Sqlite stub) | SqliteStore 持久化 |
| 错误恢复 | onError 收集但丢弃 | retry/skip_turn/abort/ignore 执行 |
| 心跳 | 无 | 5s 间隔 + 30s 僵尸检测 |
| 序列化 | 未实现 | serialize/deserialize |
| compress 触发 | 硬编码 100k | 读 CompressorPipeline 配置 |
| hooks | 缺失 beforeCompress/afterCompress | 全部集成 |

---

## 四、验证

```
✅ npm run build       — 零错误 (9 包 composite)
✅ npm run typecheck   — 零错误 (strict mode)
✅ npm run test        — 10/10 通过 (8ms)
```

---

## 五、延后 TG2

| 项 | 描述 |
|------|------|
| B2 | chunk + embed 策略 (需 embedding model) |
| B4 | ToolRegistry onConflict 选项 |
| C1-C3 | CLI / 文档 / 测试覆盖 |
| API-D2 | SubagentHandle.on() 泛型统一 |
| API-D8 | @resource Zod annotations |
| mono-D2 | npm 发布前移除 `"private": true` |
| mono-D4 | ESLint `consistent-type-imports` CI 检查 |
| worktree | git worktree 隔离 |
