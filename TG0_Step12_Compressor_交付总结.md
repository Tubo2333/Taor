# TG0 Step 12 — @taor/compressor 交付总结

> **完成时间**：2026-06-12
> **审查状态**：⏳ 待交叉审查
> **上一步**：Step 11 @taor/memory（含 9 条审查修复）
> **下一步**：Step E @taor/engine（冒烟测试）— TG0 最后一步

---

## 一、做了什么

实现了 `@taor/compressor` 包 — 5 层"先便宜后贵"压缩管道。trim + truncate 完整实现，summarize/chunk/embed TG0 stub。集成到 `harness.compressor` 访问器。

### 文件清单

```
packages/compressor/src/
├── types.ts              [不变 43行]   CompressorConfig/CompressStrategy/CompressedContext
├── strategies/index.ts   [新增 191行]  5 layers: trim✅ summarize⬜ chunk⬜ embed⬜ truncate✅
├── pipeline.ts           [新增 155行]  CompressorPipeline: trigger/target thresholds + cache
└── index.ts              [不变 5行]    公共 API 导出

packages/core/src/
└── harness.ts            [修改 +20行]  ICompressorPipeline 结构接口 + setCompressor() + getter

packages/engine/src/
└── index.ts              [修改 +12行]  createHarness() 创建 + 注入 CompressorPipeline
```

**净增代码**：~370 行。

---

## 二、核心设计

### 2.1 5 层管道（先便宜后贵）

```
trim → summarize → chunk → embed → truncate
 10%      50%        60%      70%      100%      ← 预估节省率
```

每层仅在上一层未达到 `targetThreshold` 时激活。`truncate` 始终最后执行，保证到达目标。

### 2.2 触发逻辑

```
currentTokens > triggerThreshold (100k) → 启动压缩
  每层执行后检查 tokenCount
  tokenCount ≤ targetThreshold (50k) → 停止
  maxAttempts (3) 耗尽 → 强制 truncate
```

### 2.3 缓存

`cacheResults: true`（默认）时，相同 messages 指纹 + target 的组合缓存结果，重复压缩返回缓存。

### 2.4 各层实现

| 层 | TG0 | 算法 |
|------|-----|------|
| **trim** | ✅ | 过滤 content 中所有空文本的消息 |
| **summarize** | ⬜ stub | 返回原消息不变（TG1 需 LLM adapter reentrancy） |
| **chunk** | ⬜ stub | 返回原消息不变（TG1 需 embedding model） |
| **embed** | ⬜ stub | 返回原消息不变（TG1 需 vector store） |
| **truncate** | ✅ | 从 index=1 开始逐个删除最旧消息直到 ≤ targetTokens，保留首尾消息 |

### 2.5 依赖反转

```
@taor/core (harness.ts)
  └── ICompressorPipeline  ← 结构接口（compress() → CompressedContext）

@taor/compressor
  ├── CompressorPipeline   ← 真实实现
  └── strategies/          ← 5 层策略

@taor/engine (index.ts)
  └── createHarness()      ← 组装 + 注入
```

---

## 三、关键决策

| # | 决策 | 理由 |
|---|------|------|
| D-1 | summarize/chunk/embed TG0 stubs | 各需要 LLM adapter reentrancy / embedding model / vector store，属 TG1 基础设施 |
| D-2 | truncate 保留首尾消息 | 保留首条（user prompt）和尾条（最新对话），删除中间旧消息 |
| D-3 | 缓存 key 用最后 5 条消息的文本长度指纹 | 快速去重，避免对相同上下文重复压缩 |
| D-4 | 超过 maxAttempts 后强制 truncate | 保障硬上限，防止管道在中间层无限循环 |

---

## 四、潜在风险点

### R1: truncate 的估算基于 ~4 chars/token
中英文混排、代码块、tool_use JSON 的实际 token 数差异大。可能删得过多（保守安全）或删得不够（仍超标）。

### R2: summarize/chunk/embed stubs 无日志
中间层静默返回原消息 → 用户感知为"compressor 运行了但什么都没做"。TG1 应在 stub 层加 `logger.debug` 说明跳过原因。

### R3: 缓存永不过期
`clearCache()` 存在但无自动过期。长时间 session 缓存无限增长。TG1 加 LRU eviction。

### R4: truncate 的 `messages.length > 2` 保护
如果 messages 只有 2 条（user prompt + assistant response），truncate 不删除任何消息 → 仍超标。极短上下文下无解。

### R5: 管道未在 TAOR 循环中自动触发
`harness.compressor.compress()` 可用但未被 TAOR 循环在 OBSERVE phase 后自动调用。TG0 需用户手动调用或通过 afterObserve hook。

---

## 五、验证状态

```
✅ npm run build       — 零错误
✅ npm run typecheck   — 零错误
⬜ 集成冒烟测试        — TG0 Step E
```

---

## 六、TG0 进度 — 全部 12 步完成

```
1-12 ✅ ALL (100%)
E    ⬜ @taor/engine (冒烟测试)
```
