# Taor — TG0 进度总结 & 审查准备

> **用途**：粘贴到新 Claude Code 窗口，以独立专家的视角对已完成工作进行 adversarial review。
> **进度**：TG0 12 步中已完成前 5 步（42%）。
> **上次审查**：Step 4 tools 模块审查发现 3🔴+4🟡+4🟢 = 11 条问题，已全部修复。

---

## 项目是什么

开源的 **Taorering 框架**（TypeScript agent 框架），基于 Claude Code 泄露源码设计。

- **语言**：TypeScript
- **模式**：轻量内核 + 可组合引擎（9 个独立 npm 包，workspace 协议）
- **核心**：TAOR Loop（AsyncGenerator 状态机，双向通道）
- **4 条设计哲学**：「先便宜后贵」「只记偏好不记代码」「运行时越笨架构越稳」「Coordinator 只派活不动文件」
- **API 规范**：`Harness_API_Design_v2.md`（15 章，经独立审理修正 14 条）

## TG0 实现路线图

```
TG0 实现顺序（按依赖拓扑）：
1-3 ✅ types → context → events                          [类型层，纯类型无逻辑]
4   ✅ @taor/tools (defineTool + ToolRegistry)         [工具系统 + 11条审查修复]
5   ✅ @taor/adapters (AnthropicAdapter 实现)          [LLM 适配器层 — 420行]
6   ⬜ @taor/core/config.ts (validateConfig)           [← 下一步]
7   ⬜ @taor/core/harness.ts (TAOR 循环 + 事件队列)    [核心引擎]
8   ⬜ @taor/permission (PermissionEngine)
9   ⬜ @taor/hooks (HookRegistry)
10  ⬜ @taor/subagent (Coordinator + Worker)
11  ⬜ @taor/memory (SQLite/JSON/InMemory stores)
12  ⬜ @taor/compressor (5-layer pipeline)
E   ⬜ @taor/engine (冒烟测试)
```

---

## Step 1-3: 类型层（已完成）

纯类型定义，无运行时逻辑。3 个文件：

| 文件 | 内容 |
|------|------|
| `packages/core/src/types.ts` | `TokenUsage`, `Artifact`, `TurnRecord`, `CompressLevel`, `Unsubscribe` |
| `packages/core/src/context.ts` | `HarnessContext`（3 层作用域: Session/Turn/SharedCache）、`Message`、`ToolCall`、`Observation`、`HarnessError`、`Logger` |
| `packages/core/src/events.ts` | `HarnessEvent` 联合类型（14 个变体：started → turn-started → thinking → thought → tool-call → tool-result → approval-required → turn-ended → compressed → subagent → heartbeat → error → blocked）、`UserDecision`（5 种用户注入） |

---

## Step 4: @taor/tools（已完成 + 11 条审查修复）

### 核心实现

| 文件 | 内容 |
|------|------|
| `packages/tools/src/types.ts` | `JSONSchema`（Draft-07 超集）、`ToolDescriptor`（内部归一化表示）、`ToolResult<T>`、`ToolContext`、`ToolConstructor`、`ToolInput` |
| `packages/tools/src/descriptor.ts` | `defineTool()` 双重重载（Zod: `z.infer<T>` 全类型推导 + JSONSchema: pass-through）、`tool()` 三签名简写 |
| `packages/tools/src/base.ts` | `Tool` 抽象类 + `toDescriptor()`（原型链检测钩子重写） |
| `packages/tools/src/registry.ts` | `ToolRegistry`（构造器/描述符规范化 + 名称冲突检测 + 名称格式验证） |

### 审查修复清单（2026-06-11，11 条全部修复）

#### 🔴 致命（3 条）
| ID | 问题 | 修复 |
|----|------|------|
| F-1 | `ToolConstructor` 类型声明 `new (...args: any[])` 但 `register()` 零参数调用 | 改为 `new ()` — 说实话 |
| F-2 | `JSONSchema` 缺 `anyOf`/`oneOf`/`allOf`/`enum`/`const`/`$ref` | 补全为 Draft-07 超集；`type` 改为可选；`JSONSchemaProperty` 同步补全 |
| F-3 | `defineTool<T extends z.ZodType>` 接受 `z.string()` 等非 object 类型 | 改为 `T extends z.ZodObject<any>`（defineTool + tool 同步收紧） |

#### 🟡 重要（4 条）
| ID | 问题 | 修复 |
|----|------|------|
| I-1 | `unknown → z.infer<T>` 零校验 cast —— 安全边界未文档化 | 全部 3 个文件加 `// SAFETY:` 注释 → TAOR 循环负责 JSON Schema 校验 |
| I-2 | `Tool.prototype` 引用比较用 `!` 骗编译器 | 改为 `hook && hook !== Tool.prototype.XXX` 双重检查 |
| I-3 | `ToolDescriptor.execute` 返回类型丢失 `data` 泛型未说明 | JSDoc 加 "Type erasure boundary" 说明 |
| I-4 | 无工具名验证 | `validateToolName()` + regex `/^[a-zA-Z0-9_-]{1,64}$/`（双入口 fast-fail） |

#### 🟢 建议（4 条）
| ID | 问题 | 修复 |
|----|------|------|
| S-1 | `ToolConstructor` 结构匹配过宽未解释 | JSDoc 完整设计 tradeoff 文档 |
| S-2 | `zodToJsonSchema` 输出的 `$schema` 泄露 | `zodToCleanJsonSchema()` → `delete raw.$schema` |
| S-3 | `tool()` 无 JSONSchema 重载 | 新增 JSONSchema 重载（三签名模式） |
| S-4 | `ToolRegistry` 无去重模式 | 记入 `TG0_DEFERRED.md` 延后 |

---

## Step 5: @taor/adapters（刚完成）

### 实现范围

**1 个完整实现 + 2 个 stub re-export：**

| 文件 | 状态 | 行数 |
|------|------|------|
| `packages/adapters/src/anthropic.ts` | ✅ 完整实现 | 420 行 |
| `packages/adapters/src/openai.ts` | 🔴 stub（re-export AnthropicAdapter） | 2 行 |
| `packages/adapters/src/deepseek.ts` | 🔴 stub（re-export AnthropicAdapter） | 2 行 |

### AnthropicAdapter 9 个方法

| 方法 | 实现要点 |
|------|---------|
| `getModelInfo(model)` | 6 个 Claude 模型完整目录（Opus 4.8/4.5/4.1, Sonnet 4.6/4.5, Haiku 4.5），含输入/输出限制、thinking/vision/caching/tool-use 能力矩阵、每 1k token 价格 |
| `supports(feature)` | 7 种 AdapterFeature 检测（streaming/thinking/tool-use/parallel-tool-calls/vision/prompt-caching/computer-use） |
| `buildRequest(ctx, opts)` | TurnContext.messages → Anthropic.MessageParam[]（sys提取→顶层system参数）、ToolDescriptor[] → Anthropic.Tool[]（JSONSchema→InputSchema）、thinking/temperature/top_p/stop_sequences 透传 |
| `think(request, signal)` | 核心 streaming AsyncGenerator：`messages.create({stream:true})` → `for await (event)` → 6 种 event.type 归一化为 ThinkEvent（text/thinking/tool_use/stop/error）。每次调用创建新 Anthropic client（reentrant 安全） |
| `parseToolCalls(raw)` | ContentBlock[] → ParsedToolCall[]（提取 tool_use block 的 id/name/input） |
| `formatToolResult(callId, result)` | ToolResult → `{type:"tool_result", tool_use_id, content, is_error?}` |
| `countTokens(messages)` | ~4 chars/token 粗略估算（TG0；TG1+ 调用 countTokens API） |
| `countRequestTokens(request)` | 同上，对已构建的 MessageCreateParams 估算 |
| `normalizeError(error)` | Anthropic.APIError → HarnessError（HTTP 状态码映射 + isRecoverableStatus 判定） |

### 关键设计决策

| 决策 | 理由 |
|------|------|
| 每次 `think()` 创建新 client | 并发安全——Compressor 可能同时调用 summarize，独立 HTTP 连接 |
| `AdapterRequest = unknown` | 内部用 `MessageCreateParams`，对外不透明——上层无需关心 provider 格式 |
| 并行 tool call 追踪 | `Map<contentBlockIndex, {id, name, accumulatedJson}>` —— 多 tool 并行时各自独立累积 |
| ToolDescriptor.parameters → Tool.InputSchema | `JSONSchema`（Draft-07 超集，含 anyOf/oneOf/$ref）直接 cast 到 `InputSchema`（`[k: string]: unknown`） |
| System 消息提取 | 所有 role=system 的 Message content 合并为顶层 `system` 字符串参数 |
| Token 计数粗略估算 | TG0 避免 API 调用依赖，4 chars/token 启发式 |

### 潜在风险点（供审查者重点关注）

1. **Streaming 事件处理**：`RawMessageStreamEvent` 的 6 种变体是否正确覆盖？`citations_delta` 和 `signature_delta` 被静默忽略——是否会导致漏掉关键信息？
2. **`MessageCreateParams` 类型**：该类型是 `MessageCreateParamsNonStreaming | MessageCreateParamsStreaming` 的联合。`buildRequest()` 构建的对象不包含 `stream: true`，但 `think()` 中通过 spread `{...params, stream: true as const}` 添加——TypeScript 是否将此正确解析为 streaming 重载？
3. **Tool.UseBlock.input 类型**：`ToolUseBlock.input` 在 SDK 中是 `unknown`（非 streaming）或 `{}`（streaming start），实际 tool_use 参数通过 `input_json_delta` 增量累积。`parseToolCalls()` 中 `block.input as Record<string, unknown>` —— 非 streaming 响应中此值是什么结构？
4. **`cache_creation_input_tokens` / `cache_read_input_tokens`**：这两个字段在 `Usage` 中是 `number | null`，在 `MessageDeltaUsage` 中也是 `number | null`。代码用 `?? 0` 处理 null —— 是对的，但需确认 Anthropic 实际返回 null vs 0 的语义差异。
5. **OpenAI/DeepSeek stub**：直接 `export { AnthropicAdapter as OpenaiAdapter }` —— 类型兼容但功能完全错误（API 格式完全不同）。是否应该在 `buildRequest()` 中抛错而非静默接受？

---

## 下一步：TG0 Step 6 — `@taor/core/config.ts`

需要实现 `validateConfig()` 函数，对 `HarnessConfig` 做运行时校验：
- 必填字段检查（`model`、`tools`）
- `session.maxTurns > 0`、`session.timeout > 0`
- `permission.defaultLevel` 枚举值检查
- `eventQueueCapacity` 合理范围
- 工具名称格式校验（复用 tools 包的 regex）

---

## 审查命令（粘贴到新窗口）

```
你是一位 TypeScript 框架设计专家，曾在 Vercel/Deno/Prisma 级别的团队主导过开源 SDK 的架构设计。我现在有一个开源的 AI agent 框架项目在 d:/C-file/Harness_Engineer/。我正在按 TG0 路线图从零实现它（12 步，已完成前 5 步：types → context → events → tools → adapters）。

请你从头审查我已完成的所有实现代码，以最严苛的 adversarial review 视角，找出：
1. 类型安全漏洞（any 逃逸、泛型约束过松、type vs value import 混用）
2. 运行时边界条件（空输入、并发冲突、异常处理遗漏）
3. 模块间集成裂缝（A 模块的假设 B 模块没兑现、接口契约不一致）
4. 设计层面的逻辑漏洞（错误的抽象、遗漏的状态转换、不可达的代码路径）

必读文件（按依赖拓扑序）：
- d:/C-file/Harness_Engineer/tsconfig.base.json
- d:/C-file/Harness_Engineer/package.json
- d:/C-file/Harness_Engineer/packages/core/src/types.ts
- d:/C-file/Harness_Engineer/packages/core/src/context.ts
- d:/C-file/Harness_Engineer/packages/core/src/events.ts
- d:/C-file/Harness_Engineer/packages/core/src/config.ts
- d:/C-file/Harness_Engineer/packages/core/src/session.ts
- d:/C-file/Harness_Engineer/packages/core/src/unresolved.ts
- d:/C-file/Harness_Engineer/packages/core/src/index.ts
- d:/C-file/Harness_Engineer/packages/tools/src/types.ts
- d:/C-file/Harness_Engineer/packages/tools/src/descriptor.ts
- d:/C-file/Harness_Engineer/packages/tools/src/base.ts
- d:/C-file/Harness_Engineer/packages/tools/src/registry.ts
- d:/C-file/Harness_Engineer/packages/tools/src/index.ts
- d:/C-file/Harness_Engineer/packages/adapters/src/types.ts
- d:/C-file/Harness_Engineer/packages/adapters/src/anthropic.ts
- d:/C-file/Harness_Engineer/packages/adapters/src/index.ts
- d:/C-file/Harness_Engineer/Harness_API_Design_v2.md（第 1-6 章：架构→Adapter 接口）
- d:/C-file/Harness_Engineer/TG0_DEFERRED.md
- d:/C-file/Harness_Engineer/Harness_Tools_Step4_审查.md（已修复的 11 条问题，检查修复是否真正到位）

审查维度（每个维度按严重度分级：🔴 致命 / 🟡 重要 / 🟢 建议）：

**维度 1：类型系统完整性**
- 每个 `any` / `as` / `unknown` cast 是否必要？有没有更安全的替代方案？
- `verbatimModuleSyntax` 下所有 `import type` 是否正确分类？
- 泛型约束是否足够狭窄以防止非法输入（如 F-3 修复的 `T extends z.ZodObject<any>`）？
- 联合类型和 discriminated union 的穷尽性检查（switch 是否覆盖所有分支）？

**维度 2：运行时边界条件**
- 空数组 / 空字符串 / null / undefined 输入 → 行为是什么？抛错还是静默？
- `ToolRegistry.register()` 的 2 阶段验证是否正确（先验证名字再注册，失败时不残留状态）？
- `AnthropicAdapter.think()` 的 `for await` 循环中 `signal.aborted` 检查是否覆盖所有中断路径？
- streaming JSON 累积（`acc.json += delta.partial_json`）——是否处理了不完整/非法 JSON？

**维度 3：跨模块集成**
- `@taor/core` 的 `Message` vs `@taor/adapters` 的 `Anthropic.MessageParam` —— 转换是否完全覆盖所有 MessageContent 变体？
- `ToolDescriptor.parameters`（JSONSchema Draft-07 超集）→ `Anthropic.Tool.InputSchema`（`[k: string]: unknown`）——运行时是否会因为多余的 `$ref`/`anyOf` 字段导致 Anthropic API 拒绝？
- `Config.unresolved.ts` 中的 stub 类型（`ToolInput = unknown`）与实际 `@taor/tools` 的 `ToolInput = ToolDescriptor | ToolConstructor` —— 类型鸿沟何时消除？
- `AdapterRequest = unknown` 这个 design pattern 是否正确？有没有漏掉的序列化需求？

**维度 4：设计一致性**
- 3 种工具定义方式（defineTool / tool() / class Tool）是否在所有路径上行为一致（名称验证、schema 转换、钩子包装）？
- TAOR 循环的"THINK → ACT → OBSERVE → loop"状态机在 events.ts 中是否完整建模？
- `HarnessError.source` 枚举值（"adapter" | "tool" | "harness" | "subagent" | "compressor"）——是否与现有模块一一对应？有没有遗漏？
- 已修复的 11 条 Step 4 审查问题——每条修复是否正确解决了根因而非症状？

请给出：🔴 致命 / 🟡 重要 / 🟢 建议，每条附文件:行号和具体修复方向。不要重复 Step 4 审查中已修复的问题，但如果修复不到位或引入了新问题，请指出。
```
