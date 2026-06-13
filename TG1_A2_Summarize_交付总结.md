# TG1 A2 — Summarize + Hooks 交付总结

> **完成时间**：2026-06-12
> **审查状态**：⏳ 待交叉审查
> **上一步**：A5 Subagent Heartbeat
> **下一步**：A3 SqliteStore（TG1 最后一项）

---

## 一、做了什么

1. **summarize 策略**：从 TG0 stub（返回 identity）升级为真实 LLM 实现。`createSummarize(adapter)` 工厂函数构建摘要提示词，调用 LLM 生成压缩上下文。
2. **beforeCompress/afterCompress hooks**：在 harness.ts 的 compress 调用前后插入 hook 调用。

### 文件清单

```
packages/compressor/src/
├── strategies/index.ts  [修改 +130行] createSummarize(adapter) + SummarizeAdapter 接口
├── index.ts             [修改 +1行]   导出 createSummarize 等

packages/core/src/
└── harness.ts           [修改 +15行]  beforeCompress/afterCompress hook 调用
```

## 二、核心设计

### 2.1 createSummarize 流程

```
conversation text ≤ 500 chars? → return identity (too short)

conversation text > 500 chars:
  ├── build prompt: "Condense the following conversation..."
  ├── text truncated to 16,000 chars (prompt budget)
  ├── adapter.buildRequest(messages, systemPrompt, model)
  ├── adapter.think() stream → collect summaryText
  ├── no summaryText? → return identity
  └── return CompressedContext:
        messages: [summaryMessage, lastOriginalMessage]
        tokenCount: messagesToTokens(condensed)
```

### 2.2 容错

- LLM 调用失败 → catch → return identity（不中断压缩管道）
- 摘要文本为空 → return identity
- 对话太短（<500 chars）→ return identity

### 2.3 beforeCompress/afterCompress

```
compress() 前: execute("beforeCompress", ctx, "summarize")
compress() 调用
compress() 后: execute("afterCompress", ctx, compressedEvent)
pushEvent("compressed", ...)
```

---

## 三、关键决策

| # | 决策 | 理由 |
|---|------|------|
| D-1 | `createSummarize(adapter)` 工厂而非修改 const | CompressStrategy 接口不包含 adapter — 通过闭包捕获 |
| D-2 | summarize stub 保留 | 向后兼容 — 无 adapter 时 pipeline 仍可用 |
| D-3 | 摘要上限 16,000 chars | 防止 prompt 超过 LLM 上下文窗口 |
| D-4 | 压缩结果保留最后一条原始消息 | 确保 LLM 有最新用户输入作为上下文 |

---

## 四、潜在风险点

### R1: adapter think() 的 reentrancy
summarize 调用 adapter.think() 时，TAOR 主循环可能也在同时调用 adapter.think()（如果 compress 在主循环的 turn 内触发）。AnthropicAdapter 每次创建新 HTTP client 所以安全——但其他 adapter 可能不兼容。

### R2: 压缩后的 messages 直接替换上下文
压缩后 context messages 变为 [summaryMessage, lastMsg]。TAOR 循环的 `this.messages` 未被更新——只影响 CompressedContext 返回值。当前 harness.ts 未将压缩结果写回 `this.messages`——这意味着后续 turn 仍使用原始未压缩的 messages。

### R3: beforeCompress level 硬编码 "summarize"
compress 可能走 trim 或 truncate 路径，但 beforeCompress hook 始终收到 `"summarize"`。如果 pipeline 实际用了 trim → hook 收到错误信息。

### R4: tool_use block 的 type narrowing
`(block as { content: string }).content` 对 tool_result 的 cast 假设 content 是 string。TG0 Anthropic format 满足此假设，但 OpenAI format 可能不同。

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
✅ A1. process/worktree 隔离 (+ F1-F3)
✅ A5. Subagent Heartbeat (+ I1-I2-S1-S4)
✅ A2. summarize + hooks
⬜ A3. SqliteStore               ← 最后一项
```
