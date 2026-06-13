# Harness Engine — 完整交接文件

> **生成日期**：2026-06-11
> **状态**：TG0 12 步已完成 7 步（58%）。TAOR 核心引擎就绪。
> **累计审查**：63 条意见全部闭环（13 致命 + 24 重要 + 21 建议 + 5 TAOR 阻碍）。
> **代码量**：18 个源文件，~3100 行 TypeScript。

---

## 一、项目是什么

开源的 **Harness Engineering 框架** — TypeScript AI agent 运行时，基于 Claude Code 泄露源码设计。

- **语言**：TypeScript（strict, verbatimModuleSyntax, isolatedModules, composite project references）
- **包管理**：npm workspaces（9 个独立包）
- **核心**：TAOR Loop（AsyncGenerator 状态机，THINK→ACT→OBSERVE，双向通道）
- **4 条设计哲学**：「先便宜后贵」「只记偏好不记代码」「运行时越笨架构越稳」「Coordinator 只派活不动文件」
- **环境**：Windows 11 + Git Bash + Node.js 20+

| 项目根 | `d:/C-file/Harness_Engineer/` |
| API 规范 | `Harness_API_Design_v2.md`（15 章，经独立审理修正 14 条） |
| 延后清单 | `TG0_DEFERRED.md` |
| 审查记录 | `Harness_Tools_Step4_审查.md` / `Harness_TG0_Step1-5_综合审查.md` / `Harness_TG0_Step1-6_综合审查.md` / `Harness_TG0_Step7_TAOR审查.md` |

---

## 二、TG0 完整进度

```
1-3 ✅ types → context → events                          [类型层，纯类型]
4   ✅ @harness/tools                                    [工具系统，+28条审查]
5   ✅ @harness/adapters                                 [LLM适配器层，650行]
6   ✅ @harness/core/config.ts                           [配置校验，5 NaN guards]
7   ✅ @harness/core/harness.ts (TAOR 循环)              [核心引擎，~1080行]
8   ⬜ @harness/permission                               [← 下一步]
9   ⬜ @harness/hooks
10  ⬜ @harness/subagent
11  ⬜ @harness/memory
12  ⬜ @harness/compressor
E   ⬜ @harness/engine (冒烟测试)
```

---

## 三、完成步骤详解

### Step 1-3：类型层（@harness/core）

| 文件 | 路径 | 内容 |
|------|------|------|
| types.ts | `packages/core/src/types.ts` | `TokenUsage`, `Artifact`, `TurnRecord`, `CompressLevel`, `SessionStatus`(`"running"\|"paused"\|"completed"\|"aborted"\|"error"`), `Unsubscribe` |
| context.ts | `packages/core/src/context.ts` | `HarnessContext`（3 层: Session/Turn/SharedCache）、`Message`(role: `"system"\|"user"\|"assistant"\|"tool"`)、`MessageContent`(text/tool_use/tool_result/image)、`ToolCall`、`Observation`、`HarnessError`(source 含全部 7 种子系统)、`ToolCallResult`、`SessionState`、`TurnState`、`SharedCacheState`、`Logger` |
| events.ts | `packages/core/src/events.ts` | `HarnessEvent` 联合(14 变体: started→turn-started→thinking→thought→tool-call→tool-result→approval-required→turn-ended→compressed→subagent-spawned→subagent-result→heartbeat→error→blocked)、`UserDecision`(5 种: approve/deny/approve-all/interject/start) |
| session.ts | `packages/core/src/session.ts` | `SessionResult`(AsyncGenerator TReturn)、`SerializedSession`、`SerializedTurn` |
| unresolved.ts | `packages/core/src/unresolved.ts` | 5 个 stub 类型占位（避免循环依赖: AdapterConstructor/ToolInput/PermissionConfig/HookInput/SubagentConfig/MemoryConfig/CompressorConfig） |

### Step 4：@harness/tools（+ 28 条审查修复）

| 文件 | 路径 | 核心内容 |
|------|------|---------|
| types.ts | `packages/tools/src/types.ts` | `JSONSchema`（Draft-07 超集: anyOf/oneOf/allOf/enum/const/$ref, type 可选）、`JSONSchemaProperty`(含 minimum/maximum/pattern)、`ToolResult<T>`、`ToolDescriptor`、`ToolConstructor`(`new ()` 零参数)、`ToolInput`、`ToolContext`、`RetryPolicy`、`ApprovalPredicate` |
| descriptor.ts | `packages/tools/src/descriptor.ts` | `defineTool()` 双重重载（Zod: `T extends z.ZodObject<any>` + JSONSchema: pass-through）、`tool()` 三签名简写（Zod + JSONSchema overloads）、`validateToolName()` 在入口处 fast-fail |
| base.ts | `packages/tools/src/base.ts` | `Tool` 抽象类（`TParams extends z.ZodObject<any>`）、`toDescriptor()`（原型检测钩子重写 + `validateToolName(this.name)` 入口） |
| registry.ts | `packages/tools/src/registry.ts` | `ToolRegistry`（两阶段提交: Phase 1 全部 normalize+validate → Phase 2 原子 commit、within-batch 去重、`typeof input` 三元守卫、`remove(name)`） |
| validation.ts | `packages/tools/src/validation.ts` | 共享的 `TOOL_NAME_RE`(`/^[a-zA-Z0-9_-]{1,64}$/`) + `validateToolName()` |
| index.ts | `packages/tools/src/index.ts` | 全量 API 导出 |
| builtin/index.ts | `packages/tools/src/builtin/index.ts` | TG0 placeholder |

**三条工具定义路径**：`defineTool()` / `tool()` / `class Tool` — 全部规格化为 `ToolDescriptor`，全部在入口处验证名称。

### Step 5：@harness/adapters

| 文件 | 路径 | 核心内容 |
|------|------|---------|
| types.ts | `packages/adapters/src/types.ts` | `LLMAdapter` 接口(11 方法: getModelInfo/supports/buildRequest/think/parseToolCalls/formatToolResult/wrapToolResult/countTokens/countRequestTokens/normalizeError)、`ThinkEvent`(6 变体)、`StopReason`(含 `"unknown"`)、`AdapterRequest=unknown` |
| anthropic.ts | `packages/adapters/src/anthropic.ts` | **~650 行完整实现**：6 模型目录(getModelInfo)、`supports(feature, model?)`（按会话模型查询）、`buildRequest()`（Message→MessageParam + System 提取 + ToolDescriptor→Tool 转换(+TG0 InputSchema cast 注释)）、`think()`（streaming AsyncGenerator: text_delta→text, thinking_delta→thinking, input_json_delta→累积 tool_use JSON(并行 Map<index,acc>), message_delta→stop+usage）、`parseToolCalls()`（ContentBlock[]→ParsedToolCall[]）、`formatToolResult()`（含 truncated warning prefix）、`wrapToolResult()`（`{role:"user",content:[{type:"tool_result",...}]}` 完整 Message 封装 + runtime content typeof-string guard）、`countTokens()`(~4 chars/token + try-catch JSON.stringify 兜底)、`normalizeError()`(Anthropic.APIError→HarnessError + HTTP status map + isRecoverable)、image MIME type runtime guard(jpeg/png/gif/webp)、system 消息非 text block console.warn、stream GC 依赖 comment、message_stop fallback comment |
| openai.ts | `packages/adapters/src/openai.ts` | **抛错 stub**（构造时 throw "not implemented yet"） |
| deepseek.ts | `packages/adapters/src/deepseek.ts` | **抛错 stub**（同上） |

### Step 6：@harness/core/config.ts

| 功能 | 内容 |
|------|------|
| `ResolvedConfig` | `HarnessConfig` 所有 optional 填充后的完整类型 |
| `validateConfig(raw)` | 必填检查(model 非空/tools 是数组)、范围校验(maxTurns≥1/timeout>0/eventQueueCapacity≥1 全部含 `Number.isNaN()` guard)、枚举校验(permission.defaultLevel: deny/boundary/allow/ask)、sampleRate 0-1+NaN、默认填充(session.id 自动生成/workDir=process.cwd()/NOOP_LOGGER) |
| `DEFAULTS` | session.maxTurns=100/timeout=Infinity/eventQueueCapacity=256/permission.defaultLevel="ask"/trace=false |

**5 个 NaN 防护入口**：maxTurns、timeout、eventQueueCapacity、approvalTimeout、sampleRate — 全部 `Number.isNaN()` 检查。

### Step 7：@harness/core/harness.ts（TAOR 核心引擎，~1080 行）

**架构决策：依赖反转** — `@harness/core` 不能运行时 import `@harness/tools`/`@harness/adapters`（circular project references）。Harness 构造函数接收预实例化的 `IAdapter` + `IToolRegistry`（私有结构接口），由 `createHarness()` 在 `@harness/engine` 组装。

**核心组件**：

| 组件 | 行数 | 功能 |
|------|------|------|
| 结构接口 | ~80 | `IAdapter`/`IToolRegistry`/`ToolDef`/`ToolExecResult`/`ThinkEvent`(local) — 依赖反转 |
| 构造函数 | ~50 | 注入 ResolvedConfig + adapter + registry，初始化 session state/event queue/abort controller/event emitter |
| Event Queue | ~30 | `pushEvent()`: consumer 等待时直接交付，否则入队；TG0 反压: capacity 满时 drop oldest + logger.warn |
| TAOR 循环 | ~350 | `runTAOR()` 后台 async task: THINK(adapter.think() 流式消费，捕获 stopReason/cacheRead/cacheWrite) → ACT(tool 执行 + 审批注入 waitForDecision/resolveDecision) → OBSERVE(newMessages 收集 + turnRecord + cache 透传 + loop 终止条件检查 stopReason) |
| next(decision) | ~40 | decision 注入→resolve→从 queue pull→空则 pending Promise |
| EventEmitter | ~50 | `on/off/offAll` + wildcard `"*"` + typed 重载 + AbortSignal 自动解绑 |
| Control | ~100 | `start()`(double-call guard: 运行中抛错/覆盖 warn)、`abort()`(if isLoopDone return + decisionResolve unlock)、`kill()`(resolve-then-null decisionResolve)、`pause()`(turn 边界 while-loop sleep)、`resume()` |
| AsyncGenerator 协议 | ~80 | `return()`(清空 eventQueue + 解锁 decision + await loopPromise + wake consumer)、`throw()`(同上) |
| Queries | ~15 | `state`/`turns`/`tokenUsage`/`isRunning` getter |

**TAOR 循环并发安全修复（F-1~F-4）**：

| 修复 | 场景 | 方案 |
|------|------|------|
| F-1 | abort() 在审批等待时死锁 | abort() 中 resolve decisionResolve({type:"deny",callId:"__aborted__"}) |
| F-2 | return() 后 next() 返回缓冲事件 | return()/throw() 中 eventQueue.length=0 |
| F-3 | kill() 直接置 null decisionResolve | 先 resolve 再 null |
| F-4 | return/throw 不等 loopPromise | await this.loopPromise(try-catch) |

---

## 四、关键文件地图

### 必读（按依赖拓扑序）

```
Harness_API_Design_v2.md          — API 规范（15 章，架构权威参考）
TG0_DEFERRED.md                   — 延后事项清单（按阶段组织）
tsconfig.base.json                — 根 TS 配置（strict/composite/verbatimModuleSyntax）
package.json                      — monorepo 根（9 workspaces）

packages/core/src/types.ts        — 基础类型
packages/core/src/context.ts      — 3 层 Context + Message + ToolCall + HarnessError
packages/core/src/events.ts       — 14 事件变体 + 5 用户决策
packages/core/src/session.ts      — SessionResult + SerializedSession
packages/core/src/unresolved.ts   — Stub 类型（避免循环引用）
packages/core/src/config.ts       — HarnessConfig + ResolvedConfig + validateConfig
packages/core/src/harness.ts      — 🔑 TAOR 核心引擎（~1080 行）
packages/core/src/index.ts        — Core 公共 API

packages/tools/src/types.ts       — JSONSchema(Draft-07 超集) + ToolDescriptor
packages/tools/src/validation.ts  — validateToolName()
packages/tools/src/descriptor.ts  — defineTool()/tool()
packages/tools/src/base.ts        — Tool 抽象类
packages/tools/src/registry.ts    — ToolRegistry（两阶段提交）
packages/tools/src/index.ts       — Tools 公共 API

packages/adapters/src/types.ts    — LLMAdapter 接口
packages/adapters/src/anthropic.ts — AnthropicAdapter（~650 行）
packages/adapters/src/openai.ts   — OpenAI stub（抛错）
packages/adapters/src/deepseek.ts — DeepSeek stub（抛错）
packages/adapters/src/index.ts    — Adapters 公共 API

packages/engine/src/index.ts      — createHarness() + 依赖反转契约矩阵
```

### 审查文件（历史记录）

```
Harness_Tools_Step4_审查.md       — Step 4 审查：11 条（3🔴+4🟡+4🟢）
Harness_TG0_Step1-5_综合审查.md   — Step 1-5 审查：17 条（3🔴+7🟡+7🟢）
Harness_TG0_Step1-6_综合审查.md   — Step 1-6 审查：19 条（3🔴+6🟡+5🟢+5 TAOR 阻碍）
Harness_TG0_Step7_TAOR审查.md     — Step 7 TAOR 审查：16 条（4🔴+7🟡+5🟢）
```

---

## 五、架构关键决策（不可随意推翻）

| # | 决策 | 理由 |
|---|------|------|
| 1 | **依赖反转** — core 不 import tools/adapters | 避免 TypeScript composite project reference 环 |
| 2 | **Harness 构造函数接收预实例化对象** | 由 createHarness() 在 engine 层组装 |
| 3 | **TAOR 循环是后台 async task** | 事件通过 bounded queue 传递；consumer 通过 AsyncGenerator 协议 pull |
| 4 | **审批通道是 Promise resolver** | `approval-required` yield → `waitForDecision()` await → consumer `next(decision)` resolve |
| 5 | **三次工具定义路径行为一致** | defineTool/tool()/class Tool 全部在入口处 validateToolName + 全部要求 ZodObject<any> |
| 6 | **JSONSchema 是 Draft-07 超集（非子集）** | type 可选、含 anyOf/oneOf/allOf/enum/const/$ref |
| 7 | **ToolConstructor 零参数** | 有参构造器需手动实例化后传 descriptor |
| 8 | **Adapter default 在 createHarness 层** | AnthropicAdapter 是 TG0 唯一实现，默认值不在 core 层 |
| 9 | **validateConfig 全部数值入口含 NaN guard** | maxTurns/timeout/eventQueueCapacity/approvalTimeout/sampleRate — 5 处全覆盖 |
| 10 | **kill/abort/return/throw 全部解锁 decisionResolve** | 避免 TAOR 循环在审批等待时死锁 |

---

## 六、依赖反转契约矩阵

`@harness/core` 使用私有结构接口 → `@harness/engine` 用 `as any` 桥接到真实类型。**变更任一 canonical 接口时必须同步更新对应 structural 接口。**

```
┌──────────────────────┬─────────────────────────────────┐
│ Harness (structural) │ Real (canonical)                │
├──────────────────────┼─────────────────────────────────┤
│ IAdapter             │ LLMAdapter (@harness/adapters)  │
│ IToolRegistry        │ ToolRegistry (@harness/tools)   │
│ ToolDef              │ ToolDescriptor (@harness/tools) │
│ ToolExecResult       │ ToolResult (@harness/tools)     │
│ ThinkEvent (local)   │ ThinkEvent (@harness/adapters)  │
└──────────────────────┴─────────────────────────────────┘
```

**Checklist when changing any canonical interface:**
1. Update corresponding structural interface in `harness.ts`
2. Run `npm run typecheck` — the `as any` cast won't catch mismatches
3. Run `npm run build` — engine package must compile
4. Run engine integration smoke test

---

## 七、延后事项（TG0_DEFERRED.md）

| 阶段 | ID | 描述 | 状态 |
|------|-----|------|------|
| 2 (tools) | API-D1 | defineTool() Zod/JSONSchema 重载单元测试 | ⬜ |
| 2 (tools) | API-S4 | ToolRegistry onConflict 选项 | ⬜ |
| 4 (harness) | API-D4 | serialize() mid-THINK/ACT/OBSERVE guard | ⬜ |
| 5 (permission) | API-D8 | @resource 注解解析用 Zod annotations 替代 regex | ⬜ |
| 7 (subagent) | API-D2 | SubagentHandle.on() 统一为泛型+overload | ⬜ |
| 8 (memory) | API-D5 | SqliteStore.list() LIMIT/OFFSET 分页 | ⬜ |
| 10 (engine) | mono-D3 | 集成冒烟测试 createHarness() | ⬜ |

---

## 八、启动命令

```bash
cd d:/C-file/Harness_Engineer
npm run build        # 全量编译
npm run typecheck    # 全量类型检查
npm run test         # vitest（暂无测试）
```

---

## 九、下一步：TG0 Step 8 — @harness/permission

实现 `PermissionEngine`：
- 4 级权限模型：deny / boundary / allow / ask
- Denylist / Allowlist 规则匹配
- `@resource` 注解解析（从 ToolDescriptor.parameters JSONSchema 的 description 提取）
- 非交互模式 fallback（nonInteractiveDefault）
- 与 Harness TAOR 循环集成：ACT phase 调用 `permission.check(tool, params, ctx) → PermissionVerdict`

现有骨架：
- `packages/permission/src/types.ts` — 类型定义
- `packages/permission/src/engine.ts` — PermissionEngine 全部 TODO
- `packages/permission/src/resource.ts` — @resource 解析（regex-based, TODO API-D8）
