# Taor — TG0 Step 1-5 综合 Adversarial Review

> **审查人视角**：TypeScript 框架设计专家，从头审计 types → context → events → tools → adapters 五个已完成步骤。
> **审查日期**：2026-06-11
> **审查范围**：`@taor/core` (types/context/events/config/session/unresolved/harness) + `@taor/tools` (types/descriptor/base/registry) + `@taor/adapters` (types/anthropic/index) + `tsconfig.base.json`
> **前置条件**：Step 4 已修复的 11 条问题不在本审查中重复，但修复未覆盖的路径和不到位之处会指出。

---

## 🔴 致命问题

### F-1. `ToolRegistry.register()` JSDoc 声称"无部分注册"但 for-loop 逐条提交 — 实际会残留部分状态 ✅

**文件**：`packages/tools/src/registry.ts:85-102`

JSDoc（行 76-78）声称：
> "Validation failures throw immediately — the registry is unchanged on error (no partial registration)."

实际代码：
```typescript
for (const input of inputs) {
  const descriptor = typeof input === "function" ? new input().toDescriptor() : input
  validateToolName(descriptor.name)     // ← 抛错则退出
  if (this.tools.has(descriptor.name)) throw ...  // ← 抛错则退出
  this.tools.set(descriptor.name, descriptor)     // ← 已注册的保留
}
```

5 个工具的批量注册，第 3 个 `validateToolName()` 抛错 → 工具 #1、#2 已在 Map 中。调用方拿到的 registry 处于不一致的中间态。没有事务语义、没有校验阶段、没有回滚。JSDoc 承诺是假的。

**修正内容**（方案 A）：两阶段提交。Phase 1：全部 normalize + validate names + check conflicts（含 within-batch 去重）。Phase 2：所有校验通过后原子性 `set`。另加 `TypeError` 守卫拒绝非函数/非对象的 `ToolInput`（附带 index）。JSDoc 更新为真实承诺。

---

### F-2. `AnthropicAdapter.supports()` 用 `this.model`（构造时的默认），`buildRequest()` 用 `ctx.session.model`（会话模型）——能力检测与实际调用模型不一致 ✅

**文件**：`packages/adapters/src/anthropic.ts:272 vs 308`

```typescript
// Line 252: this.model = opts?.model ?? "claude-sonnet-4-6"
// Line 272: const info = this.getModelInfo(this.model)
// Line 308: model: ctx.session.model   ← buildRequest 用另一个模型
```

场景复现：
1. 用户 `createHarness({ model: "claude-haiku-4-5", adapter: AnthropicAdapter })` — 适配器构造无 `model` 参数，`this.model` = `"claude-sonnet-4-6"`
2. TAOR 循环调用 `adapter.supports("thinking")` → 查 sonnet-4-6 → 返回 `true`（Sonnet 支持 extended thinking）
3. `buildRequest()` 用 `ctx.session.model` = `"claude-haiku-4-5"` 构造请求，包含了 `thinking: { type: "enabled" }`
4. Anthropic API 返回 400：Haiku 4.5 不支持 extended thinking

**根因**：`supports(feature: AdapterFeature): boolean` 没有 model 参数，无法按当前会话模型查询能力。而 `getModelInfo(model)` 已经支持按模型查询——能力检测也应该接受。

**修正内容**：`LLMAdapter.supports()` 签名改为 `supports(feature: AdapterFeature, model?: string): boolean`。`AnthropicAdapter.supports()` 使用 `model ?? this.model`。Stub 类无需改动（re-export AnthropicAdapter 自动继承新签名）。

---

### F-3. `Tool` 抽象类泛型约束 `TParams extends z.ZodType` 未收紧 — Step 4 F-3 修复未覆盖 class 路径 ✅

**文件**：`packages/tools/src/base.ts:45`

Step 4 F-3 将 `defineTool<T extends z.ZodType>` 收紧为 `T extends z.ZodObject<any>`。但 `Tool` 类仍然是：

```typescript
export abstract class Tool<
  TParams extends z.ZodType = z.ZodType,  // ← 没改
  TResult = unknown,
>
```

子类可以写：
```typescript
class BadTool extends Tool<typeof z.string()> { ... }
//                           ^^^^^^^^^^^ z.ZodString extends z.ZodType ✅ 编译期通过
```

→ `toDescriptor()` → `zodToJsonSchema(z.string())` → `{ type: "string" }` → 非 object schema → Anthropic API 400。

`defineTool()` 在编译期拒绝非 object Zod 类型，`Tool` 子类在编译期接受——**三条定义路径中 class 路径的守卫比 factory 路径弱**，行为分裂。

**修正内容**：`Tool` 泛型约束改为 `TParams extends z.ZodObject<any>`（与 `defineTool()`/`tool()` 一致）。三条工具定义路径现在统一要求 object schema。JSDoc 同步更新。

---

## 🟡 重要问题

### I-1. `LLMAdapter.formatToolResult()` 只格式化 content block，不格式化外层消息信封 ✅

**修正内容**：`LLMAdapter` 接口新增 `wrapToolResult(callId, result, toolName?): Message` 方法。`AnthropicAdapter.wrapToolResult()` 实现：formatToolResult → `{ role: "user", content: [block] }` 完整 Message 封装。TAOR 循环不再需要 provider 知识来包裹 tool result。

---

### I-2. `convertMessages()` 的 `msg.content as Anthropic.ContentBlockParam[]` 在 image MIME type 上类型裂缝 ✅

**修正内容**：`convertMessages()` 中加 `SUPPORTED_IMAGE_TYPES` Set + runtime guard。非 Anthropic 支持的 image MIME type 抛明确错误（含支持列表）。长期收紧 `media_type` 类型延后到 TG1。

---

### I-3. `mapStopReason()` 静默吞掉未知 stop reason ✅

**修正内容**：`StopReason` 联合类型加 `"unknown"` 成员。`default` 分支改为 `console.warn(...)` + 返回 `"unknown"`。

---

### I-4. `formatToolResult()` 忽略 `ToolResultMeta.truncated` ✅

**修正内容**：`formatToolResult()` 检查 `result.meta?.truncated`，为 `true` 时在 content 前加 `"[Warning: tool output was truncated]\n"` 前缀。

---

### I-5. `defineTool()` 在构造时验证名称，`Tool.toDescriptor()` 只在 register 后验证 — 两条路径不一致 ✅

**修正内容**：`Tool.toDescriptor()` 入口加 `validateToolName(this.name)`（fast-fail before schema conversion）。三条工具定义路径（defineTool/tool/Tool.toDescriptor）现在全部在入口处验证名称。

---

### I-6. `ToolRegistry.register()` 对非法 `ToolInput` 的错误消息不友好 ✅

**修正内容**：在两阶段提交的 Phase 1 中加 `typeof input` 三元守卫：function → 构造器、object（非 null）→ descriptor、其他 → `TypeError`（附带 index `i` 和实际 `typeof` 值）。

---

### I-7. `countTokens()` 返回整数但 4-char 启发式在某些消息类型上失效 ✅

**修正内容**：`countTokens()` 中 `JSON.stringify(block.input)` 加 try-catch，fallback 返回 100 字符估算。JSDoc 标注 TG0 近似 + TG1 计划调用 countTokens API。

---

## 🟢 建议优化

### S-1. InputSchema cast 未经验证 ✅

**修正内容**：`convertTool()` 加 TG0 注释说明 cast 兼容性 + TG1 集成测试计划。

### S-2. `validateToolName()` 重复定义 ✅

**修正内容**：提取到 `packages/tools/src/validation.ts`。`descriptor.ts`、`base.ts`、`registry.ts` 全部单向 import 此文件。`index.ts` 导出。

### S-3. `MODEL_CATALOG` 硬编码

TG0 不改。JSDoc 已有价格页链接和 "approximate" 说明。TG1 提取为独立文件或动态获取。

### S-4. `countTokens()` 命名

TG0 不改（与 `LLMAdapter` 接口一致）。JSDoc 已标注 "TG0: approximate. TG1+: call countTokens API"。

### S-5. `HarnessError.source` 缺少 `"hooks"` 和 `"memory"` ✅

**修正内容**：`context.ts` 中 `source` 联合类型加 `| "hooks" | "memory"`。非 breaking change。

### S-6. `message_stop` fallback 用 `output: 0` ✅

**修正内容**：加 `// TG0: if message_delta was skipped (network edge case), output tokens are unknown — reported as 0.` 注释。

### S-7. `defineTool()` 实现签名 `result: any` ✅

**修正内容**：`result: any` → `result: ToolResult`（两个重载一致，不需要 any）。

---

## Step 4 审查修复回检

| 原问题 | 修复状态 | 备注 |
|--------|---------|------|
| F-1: `ToolConstructor` 零参数 | ✅ 完成 | `new ()` 签名正确 |
| F-2: `JSONSchema` 缺字段 | ✅ 完成 | anyOf/oneOf/allOf/enum 已补，type 改为可选 |
| F-3: `defineTool` Zod 约束 | ✅ 已完成（本轮） | `Tool` 类 `TParams extends z.ZodType` → `TParams extends z.ZodObject<any>`。三条路径一致。 |
| I-1: 零校验 cast 未文档化 | ✅ 完成 | SAFETY 注释覆盖 3 处 |
| I-2: prototype 比较 + `!` | ✅ 完成 | 双重检查模式正确 |
| I-3: execute 返回类型丢失泛型 | ✅ 完成 | JSDoc Type erasure boundary 已说明 |
| I-4: 无工具名验证 | ✅ 完成 | validateToolName + regex，两个入口 |
| S-1: ToolConstructor 匹配过宽 | ✅ 完成 | JSDoc tradeoff 文档完整 |
| S-2: $schema 泄露 | ✅ 完成 | zodToCleanJsonSchema helper |
| S-3: tool() 无 JSONSchema | ✅ 完成 | 三签名模式已加 |
| S-4: registry 无去重模式 | ✅ 延后 | 记入 TG0_DEFERRED.md |

---

## 汇总

| 严重度 | 数量 | 状态 |
|--------|------|------|
| 🔴 致命 | 3 | ✅ 全部修复 |
| 🟡 重要 | 7 | ✅ 全部修复 |
| 🟢 建议 | 7 | ✅ 5 修复 + 2 延后 (S-3 TG1, S-4 TG1) |

**修复后 TG0 可 ship 状态**：全部 3 致命 + 7 重要 + 5 建议已修。S-3（MODEL_CATALOG 动态获取）和 S-4（countTokens 精确化）记入 TG1 计划。

**最终验证**：`npm run build` ✅ / `npm run typecheck` ✅
