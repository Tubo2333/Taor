# Harness Engine — TG0 进度总结 & 审查准备（Step 1-6）

> **用途**：粘贴到新 Claude Code 窗口，以独立专家的视角对 Step 1-6 已完成的全部工作进行 adversarial review。
> **进度**：TG0 12 步中已完成前 6 步（50%）。
> **历史审查**：Step 4 审查 11 条已修。Step 1-5 综合审查 17 条已修。累计 28 条审查意见全部闭环。

---

## 项目是什么

开源的 **Harness Engineering 框架**（TypeScript agent 框架），基于 Claude Code 泄露源码设计。

- **语言**：TypeScript（strict, verbatimModuleSyntax, isolatedModules）
- **模式**：轻量内核 + 可组合引擎（9 个独立 npm 包，workspace 协议）
- **核心**：TAOR Loop（AsyncGenerator 状态机，双向通道）
- **API 规范**：[Harness_API_Design_v2.md](Harness_API_Design_v2.md)（15 章，经独立审理修正 14 条）

---

## TG0 实现路线图

```
1-3 ✅ types → context → events                          [类型层，纯类型]
4   ✅ @harness/tools                                    [工具系统，+28条审查]
5   ✅ @harness/adapters                                 [LLM适配器层]
6   ✅ @harness/core/config.ts (validateConfig)          [配置校验 — 刚完成]
7   ⬜ @harness/core/harness.ts (TAOR 循环)              [🔑 核心引擎 — 下一步]
8   ⬜ @harness/permission
9   ⬜ @harness/hooks
10  ⬜ @harness/subagent
11  ⬜ @harness/memory
12  ⬜ @harness/compressor
E   ⬜ @harness/engine (冒烟测试)
```

---

## Step 1-3: 类型层

| 文件 | 内容 |
|------|------|
| `core/src/types.ts` | `TokenUsage`, `Artifact`, `TurnRecord`, `CompressLevel`, `SessionStatus` |
| `core/src/context.ts` | `HarnessContext`（3 层作用域）、`Message`/`MessageContent`、`ToolCall`、`Observation`、`HarnessError`（source 已补全 7 种）、`Logger` |
| `core/src/events.ts` | `HarnessEvent` 联合类型（14 变体）、`UserDecision`（5 种用户注入） |
| `core/src/session.ts` | `SessionResult`（AsyncGenerator TReturn）、`SerializedSession` |
| `core/src/unresolved.ts` | 5 个 stub 类型占位（避免循环依赖） |

---

## Step 4: @harness/tools（+ 28 条审查修复）

### 核心实现

| 文件 | 行数 | 内容 |
|------|------|------|
| `tools/src/types.ts` | ~110 | `JSONSchema`（Draft-07 超集，含 anyOf/oneOf/allOf/enum/const/$ref）、`ToolDescriptor`、`ToolResult<T>`、`ToolConstructor`（零参数，`new ()`）、`ToolInput` |
| `tools/src/descriptor.ts` | ~200 | `defineTool()` 双重重载（Zod: `T extends z.ZodObject<any>` + JSONSchema: pass-through）、`tool()` 三签名简写 |
| `tools/src/base.ts` | ~160 | `Tool` 抽象类（`TParams extends z.ZodObject<any>`）、`toDescriptor()`（原型检测钩子重写 + 名称验证入口） |
| `tools/src/registry.ts` | ~155 | `ToolRegistry`（两阶段提交、within-batch 去重、`typeof input` 三元守卫、名称验证） |
| `tools/src/validation.ts` | ~30 | 共享的 `validateToolName()` + `TOOL_NAME_RE` |
| `tools/src/index.ts` | ~8 | 全量 API 导出 |
| `tools/src/builtin/index.ts` | ~3 | TG0 placeholder |

### 关键设计决策
- 三种工具定义方式（`defineTool` / `tool()` / `class Tool`）→ 全部规格化为 `ToolDescriptor`
- `JSONSchema` 是 Draft-07 超集（不再是子集），`type` 可选（兼容 anyOf/oneOf 复合 schema）
- `ToolConstructor` 零参数（说实话），有参构造器需手动 `new X().toDescriptor()` 后传入
- 工具名正则 `/^[a-zA-Z0-9_-]{1,64}$/`，三条定义路径均在入口 fast-fail
- `ToolRegistry.register()` 两阶段提交：Phase 1 全部 validate → Phase 2 原子 commit

---

## Step 5: @harness/adapters

| 文件 | 行数 | 内容 |
|------|------|------|
| `adapters/src/types.ts` | ~100 | `LLMAdapter` 接口（11 方法）、`ThinkEvent`（6 变体）、`StopReason`（含 `"unknown"`）、`AdapterRequest = unknown` |
| `adapters/src/anthropic.ts` | ~650 | **完整实现**：模型目录（6 个 Claude 模型）、`supports(feature, model?)`（能力检测按会话模型）、`buildRequest()`（Message→MessageParam + System 提取 + ToolDescriptor→Tool 转换）、`think()`（streaming AsyncGenerator，6 种 SSE 事件→ThinkEvent，并行 tool call 累积）、`parseToolCalls()`、`formatToolResult()`（含 truncated warning）、`wrapToolResult()`（完整 Message 信封）、`countTokens()`（4 chars/token + try-catch 兜底）、`normalizeError()`（HTTP 状态码映射 + isRecoverable） |
| `adapters/src/openai.ts` | ~2 | stub re-export |
| `adapters/src/deepseek.ts` | ~2 | stub re-export |

### 关键设计决策
- 每次 `think()` 创建新 Anthropic client（reentrant 安全，Compressor 可并发）
- `AdapterRequest = unknown` — 内部用 `Anthropic.MessageCreateParams`，对外不透明
- 并行 tool call 通过 `Map<contentBlockIndex, {id, name, accumulatedJson}>` 追踪
- System 消息提取：所有 role=system → 合并为顶层 `system` 字符串参数
- Image MIME type runtime guard（`image/jpeg|png|gif|webp`）
- `StopReason` 含 `"unknown"` 兜底 + `console.warn`
- `wrapToolResult()` 封装完整 Message（`{role:"user", content:[block]}`），TAOR 循环无需 provider 知识

---

## Step 6: @harness/core/config.ts（刚完成）

### 实现

| 功能 | 内容 |
|------|------|
| `ResolvedConfig` 类型 | `HarnessConfig` 全部 optional 填充后的完整类型 |
| `validateConfig(raw): ResolvedConfig` | 必填检查（model 非空、tools 是数组）、范围校验（maxTurns≥1、timeout>0、eventQueueCapacity≥1）、枚举校验（permission.defaultLevel）、sampleRate 0-1、默认填充（session.id 自动生成、workDir 默认 process.cwd()、NOOP_LOGGER 默认 logger） |
| `NOOP_LOGGER` | 静默 logger fallback |
| `DEFAULTS` | session.maxTurns=100、timeout=Infinity、eventQueueCapacity=256、permission.defaultLevel="ask" |

---

## 累计审查修复（28 条闭环）

| 轮次 | 致命 | 重要 | 建议 | 总计 |
|------|------|------|------|------|
| Step 4 审查 | F-1~F-3 | I-1~I-4 | S-1~S-4 | 11 |
| Step 1-5 综合审查 | F-1~F-3 | I-1~I-7 | S-1~S-7 | 17 |

---

## 审查命令（粘贴到新窗口）

```
你是一位 TypeScript 运行时框架专家，曾在 Node.js TSC / Deno / Bun 级别的团队做过核心 API 设计审查。我现在有一个开源的 AI agent 框架项目在 d:/C-file/Harness_Engineer/。按 TG0 路线图从零实现了 6/12 步（types → context → events → tools → adapters → config），下一步是实现核心引擎 TAOR 循环。

请你从头审查所有已完成代码，以最严苛的 adversarial review 视角，找出：
1. 类型安全漏洞（any 逃逸路径、类型收缩不完整、verbatimModuleSyntax 违规）
2. 运行时边界条件（空/null/undefined 输入、并发冲突、异常吞没）
3. 模块间集成裂缝（上下游接口契约不一致、promise vs callback 模型冲突）
4. 设计逻辑漏洞（错误的抽象、遗漏的状态转换、不可达代码路径）
5. 对下一步 TAOR 循环实现的阻碍（哪些假设 TAOR 循环做不到、哪些接口缺少必要方法）

必读文件（按依赖拓扑序）：
- d:/C-file/Harness_Engineer/tsconfig.base.json
- d:/C-file/Harness_Engineer/package.json
- d:/C-file/Harness_Engineer/packages/core/src/types.ts
- d:/C-file/Harness_Engineer/packages/core/src/context.ts
- d:/C-file/Harness_Engineer/packages/core/src/events.ts
- d:/C-file/Harness_Engineer/packages/core/src/config.ts
- d:/C-file/Harness_Engineer/packages/core/src/session.ts
- d:/C-file/Harness_Engineer/packages/core/src/unresolved.ts
- d:/C-file/Harness_Engineer/packages/core/src/harness.ts
- d:/C-file/Harness_Engineer/packages/core/src/index.ts
- d:/C-file/Harness_Engineer/packages/tools/src/types.ts
- d:/C-file/Harness_Engineer/packages/tools/src/descriptor.ts
- d:/C-file/Harness_Engineer/packages/tools/src/base.ts
- d:/C-file/Harness_Engineer/packages/tools/src/registry.ts
- d:/C-file/Harness_Engineer/packages/tools/src/validation.ts
- d:/C-file/Harness_Engineer/packages/tools/src/index.ts
- d:/C-file/Harness_Engineer/packages/adapters/src/types.ts
- d:/C-file/Harness_Engineer/packages/adapters/src/anthropic.ts
- d:/C-file/Harness_Engineer/packages/adapters/src/index.ts
- d:/C-file/Harness_Engineer/Harness_API_Design_v2.md（第 1-7 章：架构→Config→Tool→Adapter→Event→TAOR 循环）
- d:/C-file/Harness_Engineer/TG0_DEFERRED.md
- d:/C-file/Harness_Engineer/Harness_Tools_Step4_审查.md（11 条已修复）
- d:/C-file/Harness_Engineer/Harness_TG0_Step1-5_综合审查.md（17 条已修复）
- d:/C-file/Harness_Engineer/TG0_Step5_审查准备.md（前序总结）

审查维度（按严重度：🔴致命 / 🟡重要 / 🟢建议）：

**维度 1：类型系统**
- 所有 `as` / `any` / `unknown` cast 是否必要且不可替代？
- `verbatimModuleSyntax` 下 type-only import 是否正确？
- 泛型约束是否覆盖所有非法输入路径？
- `ResolvedConfig` 和 `HarnessConfig` 的差异是否正确？是否有遗漏的字段？

**维度 2：运行时行为**
- `validateConfig()` — 所有边界条件（空 tools 数组、1e6 maxTurns、NaN timeout）是否处理？
- `ToolRegistry.register()` — 两阶段提交是否正确？空数组输入、10000 工具批量注册的性能？
- `AnthropicAdapter.think()` — `signal.aborted` 是否在所有路径上被检查？streaming 中断后是否有资源泄漏？
- `formatToolResult()` + `wrapToolResult()` — truncated/is_error/content 格式是否正确？

**维度 3：跨模块集成**
- `HarnessConfig.tools: ToolInput[]` → `ToolRegistry.register()` — `ToolInput` 类型在 `unresolved.ts` 中是 `unknown`，在 `tools/types.ts` 中是 `ToolDescriptor | ToolConstructor` — 这个类型鸿沟何时弥合？`validateConfig()` 不做深类型校验（工具合法性由 ToolRegistry 负责）— 是否有漏掉的校验？
- `LLMAdapter` 接口的 `wrapToolResult()` vs `formatToolResult()` — TAOR 循环应该调哪一个？两者是否都可能被调用？
- `TurnContext.messages` 的类型 `Message[]` 和 Anthropic 的 `MessageParam[]` 转换 — 是否覆盖全部 `MessageContent` 变体（text/tool_use/tool_result/image）？

**维度 4：TAOR 循环就绪度**
- `HarnessEvent` 的 14 个变体 — 每个在 TAOR 循环中由哪个阶段（THINK/ACT/OBSERVE）yield？
- `UserDecision` 的 5 种注入 — `harness.next(decision)` 的消费逻辑是否正确？
- `HarnessConfig` 通过 `validateConfig()` 产出 `ResolvedConfig` → Harness 构造函数 — 是否缺少方法让 Harness 动态调整配置？
- `SessionResult`（TReturn）— TAOR 循环结束时是否所有 state 都能从 Harness 实例获取？

**维度 5：前序审查修复回检**
- Step 4 的 11 条 + Step 1-5 的 17 条 = 28 条已修复问题 — 逐条抽查修复是否真正消除了根因，修复是否引入了新问题
- 特别关注：F-1（registry 两阶段提交是否正确）、F-2（supports model 参数是否在所有调用点传递）、F-3（Tool/ZodObject 约束是否三条路径一致）

请输出：🔴致命 / 🟡重要 / 🟢建议，每条附文件:行号和具体修复方向。不要重复已修复的 28 条问题，但如果修复不到位或引入了新问题，请指出。
```
