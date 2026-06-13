# TG4 Phase 0+1 独立第三方审计报告

**审计日期**: 2026-06-13  
**审计范围**: 4 commits, 47 files, packages/ + tests/ (+4,124/-194 lines)  
**审计方式**: git diff + 源码静态分析，零上下文信任  
**最终判定**: 🟢 **CONDITIONAL GO** — 0 CRITICAL, 1 HIGH must-fix, 5 MEDIUM should-fix

---

## 一、审查清单逐项结论

### ① AD-1: core 无 sibling import → ✅ PASS

`grep -rn 'from "@harness/(adapters|tools|permission|hooks|subagent|memory|compressor|engine|telemetry)"' packages/core/src/` 返回 **0 matches**。

`@harness/core` 只用 `import type` 从子包导入类型（编译时擦除），运行时子系统通过构造函数注入。依赖倒置严格执行，零违反。

---

### ② AD-2: adapter 接口一致性 → ⚠️ PASS（LOW — type drift）

| 方法 | AnthropicAdapter | OpenAICompatibleAdapter | LLMAdapter (canonical) | IAdapter (structural) |
|------|:---:|:---:|:---:|:---:|
| `buildRequest` | `(ctx, opts: RequestOptions) => Promise<AdapterRequest>` | 同左 | ✅ | opts 类型为 `AdapterRequestOpts`（少 3 字段） |
| `think` | `(req, sig) => AsyncGenerator<ThinkEvent>` | 同左 | ✅ | ✅ |
| `wrapToolResult` | `(callId, result, _toolName?) => Message` role=**"user"** | `(callId, result, _toolName?) => Message` role=**"tool"** | ✅ 签名一致 | ✅ 签名一致 |

**发现**: Structural interface `IAdapter.AdapterRequestOpts`（`harness.ts:91-96`）比 canonical `RequestOptions`（`adapters/types.ts:43-51`）少 3 个字段：`topP`、`stopSequences`、`thinking`。当前 `createHarness()` 只传 `maxTokens` 和 `tools`，运行时不受影响。但如果未来 TAOR loop 需传递 thinking 参数，会导致类型编译失败。

---

### ③ AD-3: optional dep 安全 → ✅ PASS（LOW — ESM bundle 风险）

- **`openai` 包**：零静态 import。`OpenAICompatibleAdapter.createClient()` 使用 `createRequire(import.meta.url)` 动态加载（`openai-compatible-base.ts:300-311`）。若包未安装，`think()` 的 try-catch 会捕获 MODULE_NOT_FOUND 并 yield error event，不会崩溃。
- **`@opentelemetry/api`**：`otel-hooks.ts:9` 有静态 import `{ trace, context }`。但 `@harness/engine` **不导入** `@harness/telemetry`（grep 确认 0 matches），完全隔离——只有用户显式 `import { createOtelHooks } from "@harness/telemetry"` 时才会加载。如彼时 `@opentelemetry/api` 未安装，Node.js 抛出 `ERR_MODULE_NOT_FOUND`——这是合理的"你用可选功能就得装依赖"行为。
- **潜在风险**: ESM bundle 场景下 `createRequire(import.meta.url)` 可能失效——见 EXTRA-3。

---

### ④ AD-4: 无 process.exit → ✅ PASS（LOW — 假阳性）

| 位置 | 行号 | 判定 |
|------|------|------|
| `packages/cli/src/index.ts` | 15, 88 | ✅ 排除（cli/ 不在审查范围） |
| `packages/subagent/src/remote-entry.ts` | 58, 68, 97 | ⚠️ 技术上违反规则但**正确** — 这是 `fork()` 的子进程入口点，`process.exit(0)` 是规范的子进程清理 |
| `packages/core/src/env.ts` | 5 | ✅ 文档注释明确 "Throws instead of process.exit()" |

`remote-entry.ts` 是 `ProcessWorker` fork 的子进程入口，不是库代码。三处 `process.exit(0)` 均在被 fork 的隔离进程中：IPC 断开退出 / 心跳超时孤儿检测 / 任务完成清理。**不会杀死宿主进程**。

---

### ⑤ AD-5: 测试匹配接口 → ⚠️ PASS（MEDIUM — 测试盲区）

91 tests 分布：
- `taor-lifecycle.test.ts`：IT-1~IT-15 + 扩展用例（35+）
- `engine.test.ts`：12 tests（createHarness 边界 + adapter env var 检查）
- `anthropic-adapter.test.ts`：Adpater 单元测试
- `smoke.test.ts` + `process-worker.test.ts`

**发现 1**: 所有集成测试使用 `MockAdapter`（返回 `role: "user"` tool result，匹配 Anthropic）。**没有测试覆盖 OpenAI `role: "tool"` 路径**——`convertMessages` 中的 `role: "user"` → tool_result block 扫描路径从未以 OpenAI adapter 测试过。

**发现 2**: 测试的 `collectEvents()` helper 用 `for await (const event of harness)` 消费事件流，正确匹配 `Harness[Symbol.asyncIterator]` 行为。

**发现 3**: `interface-conformance.check.ts:59` 的"类型守卫"实际上用 `as unknown as AnthropicAdapter` 绕过检查——见 EXTRA-1。

---

### ⑥ GAP-2 关键: OpenAI stream tool_calls index 追踪 → ⚠️ PASS（MEDIUM — 丢事件）

`openai-compatible-base.ts:491-540` 的 index 追踪逻辑：

```typescript
for (const tc of delta.tool_calls) {
  const index = tc.index                          // ✅ 用 index 做 key
  const acc = toolBlocks.get(index) ?? { id: tc.id ?? "", name: tc.function?.name ?? "", json: "" }
  if (tc.id) acc.id = tc.id                       // ✅ id 增量更新
  if (tc.function?.name) acc.name = tc.function.name  // ✅ name 增量更新
  acc.json += tc.function?.arguments ?? ""        // ✅ JSON 片段累积拼接
  toolBlocks.set(index, acc)
}
```

✅ index 追踪、id/name 增量更新、arguments 累积拼接 —— **全部正确**。

**但是**: 已累积的 tool_use 事件只在 `finish_reason` 非空时 yield（L508-558）。如果流因网络问题提前结束且 `finish_reason` 为 null/undefined：
- `hasYieldedStop` = false → 进入 L562 fallback stop event
- **fallback 不会 yield 已累积的 tool_use 事件** — `toolBlocks` 中的内容被静默丢弃

---

### ⑦ GAP-2 关键: wrapToolResult role 兼容性 → ✅ PASS

TAOR loop 在 `harness.ts:1036` 调用 `this.adapter.wrapToolResult()` 获取 `Message`，直接 push 到 `this.messages`。harness 自身不检查 `Message.role`。

**关键设计**: 每个 adapter 的 `convertMessages()` 按 **content block 类型** 而非 message role 判断 tool results：
- **AnthropicAdapter**: `convertMessages()`（`anthropic.ts:162-210`）将所有非 system 消息按 `msg.role as "user" | "assistant"` 原样传递
- **OpenAICompatibleAdapter**: `convertMessages()`（`openai-compatible-base.ts:114-195`）在处理 `role: "user"` 消息时扫描 content blocks，将 `tool_result` block 转换为 `role: "tool"` 独立消息

**所以**: 即使收到 Anthropic 风格的 `{role:"user", content:[tool_result]}` 消息，OpenAI adapter 也能正确转换。跨 adapter 互操作安全。

---

### ⑧ GAP-3 关键: MockAdapter.wrapToolResult role='user' → ⚠️ PASS（MEDIUM — 设计限制）

`MockAdapter.wrapToolResult`（`mock-adapter.ts:177-189`）返回 `role: "user"`，与 `AnthropicAdapter` 一致，与 `OpenaiAdapter`（`role: "tool"`）矛盾。

**判定**: 这是**设计选择**而非 bug。MockAdapter 模拟适配器通用行为，`role: "user"` 是 Anthropic 规范。由于两个真实 adapter 的 `convertMessages` 都能处理这种格式（见 ⑦），mock 使用 Anthropic 规范不会导致测试误判。

**但是**: OpenAI `role: "tool"` 路径在集成测试中**零覆盖**。如果有 bug 藏在 `convertMessages` 处理 `role: "tool"` 消息的路径中（例如 tool_call_id 提取错误），当前测试套件无法发现。

---

### ⑨ GAP-5 关键: otel-hooks.ts spans 内存泄漏 → ✅ PASS（LOW — 极微量）

`otel-hooks.ts:37-171` 中 5 对 set/delete 逐对验证：

| Span Key | set 位置 | delete 位置 | 配对 |
|----------|---------|------------|:---:|
| `"session"` | L52 onSessionStart | L64 onSessionEnd | ✅ |
| `ctx.turn.id` | L83 beforeThink | L94 afterThink | ✅ |
| `call.id` | L109 beforeAct | L121 afterAct | ✅ |
| `"compress"` | L154 beforeCompress | L167 afterCompress | ✅ |
| error span | L139 onError | N/A — 立即 span.end()，不入 Map | ✅ |

**极微量泄漏场景**: `beforeThink` 触发但 `afterThink` 因异常未触发时，turn span 残留 Map。但此时 session 也会变 error 状态然后整体被 GC——实践中不会累积。

**`onError` handler 安全性**: L133 使用 `spans.get(ctx.turn?.id ?? "")`。若 `ctx.turn` 为 null，fallback `""`。`Map.get("")` 在从未 `set("")` 时返回 undefined，安全。

---

### ⑩ GAP-8 关键: 覆盖率 → ⚠️ PASS（MEDIUM — 盲区大）

当前 `coverage/coverage-final.json` 实际数据：

| 文件 | 已覆盖/总语句 | 覆盖率 | 目标文件? |
|------|------------|--------|:---:|
| `adapters/src/anthropic.ts` | 384/628 | **61.1%** | ✅ |
| `adapters/src/openai-compatible-base.ts` | 77/591 | **13.0%** 🔴 | 是（实际） |
| `core/src/config.ts` | 106/138 | **76.8%** | ✅ |
| `core/src/harness.ts` | 912/1326 | **68.8%** | ✅ |
| `engine/src/index.ts` | 115/115 | **100.0%** | ✅ |

**5 文件平均**: (61.1 + 13.0 + 76.8 + 68.8 + 100) / 5 = **63.9%**

**harness.ts 未覆盖行分析（414 条未覆盖语句）**:
- `resolveDecision()` 中的 interject/approve/deny 分支
- 压缩逻辑（`beforeCompress`/`afterCompress` 路径）
- `pause()`/`resume()` 状态转换
- `return()` 的 F-2/F-3/F-4 清理路径
- 错误恢复路径（`onError` hook + retry/skip_turn/abort）
- 这些**不是** import/export 声明——harness.ts 只有 1 个 import block（~25 行）

**openai-compatible-base.ts 13.0% 是最大盲区**: 591 条语句中仅 77 条覆盖——几乎所有流处理（`think()`）、错误规范化（`normalizeError`）、token 计数（`countTokens`/`countRequestTokens`）、消息转换（`convertMessages`）都未被测试。

---

## 二、额外发现（审查过程中发现的非清单项问题）

### EXTRA-1 🔴 [HIGH] `interface-conformance.check.ts` 是假类型守卫

**文件**: `packages/engine/src/interface-conformance.check.ts:59`

```typescript
const _adapter: IAdapter = undefined as unknown as AnthropicAdapter
```

**问题**: `as unknown as AnthropicAdapter` 完全绕过了 TypeScript 类型检查。这行代码**永远不会**因为接口漂移而编译失败——它把 `undefined` 先转成 `unknown` 再转成 `AnthropicAdapter`，然后再赋值给 `IAdapter`。文件注释声称"如果 canonical class 添加了 required method/field 且 structural interface 缺少，此行会编译失败"——**这个声称是错误的**。

**影响**: 虚假的安全感。如果未来有人在 `LLMAdapter` 中添加必须方法（如 `estimateCost`）但忘记同步更新 `IAdapter`，typecheck 不会报错，运行时才会炸。

**修复**:
```typescript
// 直接赋值——不加 as unknown as
const _adapter: IAdapter = null! as AnthropicAdapter
const _memory: IMemoryFacade = null! as MemoryFacade
const _cmpr: ICompressorPipeline = null! as CompressorPipeline
const _reg: IToolRegistry = null! as ToolRegistry
```
或更彻底——将 4 个 conformance check 改为 vitest 测试，运行时验证实例满足接口：
```typescript
it("AnthropicAdapter should satisfy IAdapter structurally", () => {
  const adapter = new AnthropicAdapter({ apiKey: "test" })
  const iface: IAdapter = adapter  // 真正的编译时检查
  expect(iface.provider).toBe("anthropic")
})
```

---

### EXTRA-2 🟡 [MEDIUM] `AnthropicAdapter.convertMessages` 对 role="tool" 消息处理不安全

**文件**: `packages/adapters/src/anthropic.ts:199-202`

```typescript
anthropicMessages.push({
  role: msg.role as "user" | "assistant",              // ← "tool" 被强制转为 "user"|"assistant"
  content: msg.content as Anthropic.ContentBlockParam[], // ← tool_result block 被强制 cast
})
```

**问题**: 如果 `msg.role === "tool"` 且 content 包含 `tool_result` block，该 block 被 `as Anthropic.ContentBlockParam[]` 强制转换。但 Anthropic SDK 的 `ContentBlockParam` 类型**不包含** `tool_result`——tool results 在 Anthropic API 中必须是独立的 `ToolResultBlockParam` 类型，包含在 `{role: "user", content: [toolResultBlock]}` 信封中。当前架构保证不会发生（同一 adapter 生产和消费兼容格式），但如果将来出现跨 adapter 场景（如子进程用 OpenAI adapter 返回 tool result 给主进程的 Anthropic adapter），会产生畸形的 API 请求。

**修复**: 添加对 `role: "tool"` 消息的显式处理：
```typescript
} else if (msg.role === "tool") {
  // Role="tool" messages (OpenAI style) contain tool_result blocks.
  // Rewrap as user-role for Anthropic API compatibility.
  const toolBlocks = msg.content.filter(b => b.type === "tool_result")
  if (toolBlocks.length > 0) {
    anthropicMessages.push({ role: "user", content: toolBlocks as any })
  }
}
```

---

### EXTRA-3 🟢 [LOW] `createRequire(import.meta.url)` ESM bundle 风险

**文件**: `packages/adapters/src/openai-compatible-base.ts:305`

```typescript
const _require = createRequire(import.meta.url)
const { default: OpenAIClient } = _require("openai") as { ... }
```

**问题**: 在打包工具（esbuild/webpack/tsup）处理 ESM 输出时，`import.meta.url` 可能被重写为 `undefined` 或 bundle 内部路径，导致 `createRequire` 失败。这是已知的 Node.js ESM + CJS interop 陷阱。

**当前影响**: 无——项目只用 tsc 编译，未使用 bundler。但如果未来引入 ESM bundler，这里会崩溃。

**建议修复**: 改用动态 `import()`:
```typescript
const OpenAIModule = await import("openai")
const OpenAIClient = OpenAIModule.default
```
但这需要 `createClient()` 变为 async，需评估对调用链的影响。

---

### EXTRA-4 🟡 [MEDIUM] `remote-entry.ts` 硬编码 role="tool"

**文件**: `packages/subagent/src/remote-entry.ts:199-202`

```typescript
messages.push({
  role: "tool",   // ← 硬编码 OpenAI 风格
  content: [{ type: "tool_result", tool_use_id: tc.id, content: content as string }],
})
```

**问题**: 子进程 worker 硬编码 `role: "tool"`（OpenAI 风格），不使用 adapter 的 `wrapToolResult()` 方法。如果父进程使用 `AnthropicAdapter` 而子进程使用此远程入口，消息格式与主 adapter 不兼容（结合 EXTRA-2 的 AnthropicAdapter 对 role="tool" 的处理缺陷）。

**修复**: 在 `RemoteAdapter` interface 中添加 `wrapToolResult` 方法，用其替代硬编码构造。

---

## 三、修复优先级与执行清单

### 🔴 必须修复（阻塞合并）

| ID | 严重度 | 发现 | 文件:行号 | 修复动作 |
|----|--------|------|-----------|----------|
| **F1** | HIGH | 假类型守卫 — `as unknown as` 绕过所有检查 | `packages/engine/src/interface-conformance.check.ts:59` | 去掉 `as unknown as`，改为 `null! as AnthropicAdapter` |

### 🟡 强烈建议（下个 phase 优先，不阻塞合并）

| ID | 严重度 | 发现 | 文件:行号 | 修复动作 |
|----|--------|------|-----------|----------|
| **F2** | MEDIUM | stream 提前结束时丢 tool_use | `packages/adapters/src/openai-compatible-base.ts:562-574` | fallback stop 前 yield 已累积的 tool_use |
| **F3** | MEDIUM | Anthropic convertMessages 对 role="tool" 不安全 | `packages/adapters/src/anthropic.ts:199-202` | 添加 role="tool" 消息的显式处理分支 |
| **F4** | MEDIUM | remote-entry 硬编码 role="tool" | `packages/subagent/src/remote-entry.ts:199-202` | 在 RemoteAdapter 接口添加 wrapToolResult，替代硬编码 |
| **F5** | MEDIUM | openai-compatible-base.ts 覆盖率 13% | `packages/adapters/src/openai-compatible-base.ts` | 添加至少 convertMessages/think 主流程/normalizeError 的测试 |
| **F6** | MEDIUM | 无 role="tool" 路径集成测试 | `tests/fixtures/mock-adapter.ts:182-183` | 添加 `wrapToolResultRole` 配置项 + 至少 1 个 role="tool" 集成测试 |

### 🟢 可延后（不阻塞，技术债务跟踪）

| ID | 严重度 | 发现 | 文件:行号 | 修复动作 |
|----|--------|------|-----------|----------|
| **F7** | LOW | IAdapter.AdapterRequestOpts type drift | `packages/core/src/harness.ts:91-96` | 补充 topP/stopSequences/thinking 字段 |
| **F8** | LOW | createRequire ESM bundle 风险 | `packages/adapters/src/openai-compatible-base.ts:305` | 评估将 `createRequire` 改为 `await import()` |

---

## 四、验证命令

每修复一项后运行：
```bash
cd /d/C-file/Harness_Engineer
npm run typecheck && npm run test
```

全部修复完成后运行：
```bash
cd /d/C-file/Harness_Engineer
npm run typecheck && npm run test && npm run coverage
```
确认：typecheck 通过 + 所有 test 通过 + 5 文件覆盖率平均 ≥70%。

---

*审计人员: 独立第三方（Claude Code Agent）*  
*报告版本: v2.0 — 全量审查*  
*前一版本: v1.0 — 仅 GAP-5 otel-hooks.ts 专项审查（已废弃，内容整合至本章 ⑨）*
