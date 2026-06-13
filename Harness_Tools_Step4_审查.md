# @harness/tools — Adversarial Review (TG0 Step 4)

> **审查人视角**：TypeScript 框架设计专家，你刚把它写完，觉得"差不多能跑"。我的工作是证明它不能。
> **审查日期**：2026-06-11
> **审查范围**：`@harness/tools` 全部 5 个源文件 + 上游依赖（core/types、core/context、core/config）+ tsconfig.base.json + TG0_DEFERRED.md

---

## 🔴 致命问题

### F-1. `ToolRegistry.register()` 对构造器零参数调用 — `ToolConstructor` 签名是谎话 ✅

**文件**：`packages/tools/src/registry.ts:46`、`packages/tools/src/types.ts:99`

**修正内容**（方案 A）：
- `types.ts:99`：`ToolConstructor` 改为 `new () => { toDescriptor(): ToolDescriptor }` — 零参数，说实话
- `types.ts:90-110`：加完整 JSDoc 解释设计 tradeoff（结构性 vs 名义型、零参数约束的理由、替代方案）
- `registry.ts:29-30`：JSDoc 更新，明确说明 "zero-argument constructor only" 及替代方案

---

### F-2. `JSONSchema` 类型缺失 `anyOf`/`oneOf`/`allOf` — Union/Enum/Discriminated Union 全炸 ✅

**文件**：`packages/tools/src/types.ts:7-13`

**修正内容**：
- `JSONSchema.type` 改为 `type?: string | string[]`（可选——复合 schema 不要求顶层 `type`）
- 新增字段：`anyOf?: JSONSchema[]`、`oneOf?: JSONSchema[]`、`allOf?: JSONSchema[]`、`enum?: unknown[]`、`const?: unknown`、`$ref?: string`、`default?: unknown`
- `JSONSchemaProperty` 同步补全：`const?`、`anyOf?`、`oneOf?`、`allOf?`、`$ref?`、`minimum?`、`maximum?`、`minLength?`、`maxLength?`、`pattern?`
- 顶部加设计约束注释：此类型必须是 JSON Schema Draft-07 的超集，不是子集

---

### F-3. `defineTool` Zod 重载接受 `z.string()`/`z.union()` 等非 object 类型 — 转出来的东西根本不是 JSON Schema object ✅

**文件**：`packages/tools/src/descriptor.ts:25`、`:103`（实现签名）、`:122-124`

**修正内容**：
- `defineTool()` Zod 重载泛型约束：`T extends z.ZodType` → `T extends z.ZodObject<any>`
- `tool()` Zod 重载同步收紧：`T extends z.ZodType` → `T extends z.ZodObject<any>`
- JSDoc 中说明：需要 refinements/transforms 的用户使用 JSON Schema 重载
- 编译期即拒绝 `z.string()`/`z.union()`/`z.tuple()` 等非 object 类型

---

## 🟡 重要问题

### I-1. `ToolDescriptor.execute` 的 `unknown → z.infer<T>` 转换是零验证的 cast ✅

**文件**：`packages/tools/src/descriptor.ts:130`、`packages/tools/src/base.ts:106-107`

**修正内容**：
- `ToolDescriptor` JSDoc 加 `@remarks`：显式声明 TAOR 循环/Adapter 负责在调用 `execute()` 前用 `parameters`（JSON Schema）校验 params——这是强制安全边界
- `defineTool()` JSDoc 加 `**IMPORTANT — Validation boundary**` 段落
- `base.ts` `toDescriptor()` JSDoc 加 `## Validation boundary` 段落
- 所有 execute wrapper 处加 `// SAFETY:` 注释指向 TAOR 循环的校验责任

---

### I-2. `Tool.prototype` 引用比较在 `?` 方法上的类型安全性未验证 ✅

**文件**：`packages/tools/src/base.ts:118,122,134`

**修正内容**：
- 用 `hook && hook !== Tool.prototype.XXX` 双重检查模式替换 `!` 断言
- 先将 `this.onBeforeExecute` 捕获到局部变量 `hook` → `hook &&` 窄化掉 `undefined` → `!== Tool.prototype.XXX` 检测重写
- 新增注释解释双重检查原理（`?` 影响 TS 类型但不影响 prototype 运行时存在性）
- 避免了对编译器的 `!` 欺骗，代码意图更明确

---

### I-3. `defineTool` 的 `execute` 返回类型丢失 `data` 泛型 ✅

**文件**：`packages/tools/src/descriptor.ts:34 vs 67`

**修正内容**：
- `ToolDescriptor` JSDoc 加 `## Type erasure boundary` 段落：明确说明这是归一化层，`data` 泛型在此丢失是 accept 的 tradeoff
- 指明 typed data 应直接从 `defineTool()` 返回值获取，而非 round-tripping 通过 `ToolDescriptor`

---

### I-4. 没有工具名验证 — 空字符串、特殊字符全部静默通过 ✅

**文件**：`packages/tools/src/registry.ts:48`、`packages/tools/src/descriptor.ts`

**修正内容**：
- `descriptor.ts` 和 `registry.ts` 各加 `validateToolName()` 函数（各自独立，避免模块间依赖边）
- 正则：`/^[a-zA-Z0-9_-]{1,64}$/` — 兼容 Anthropic/OpenAI API 命名规则
- `defineTool()` 实现体入口处 fast-fail 校验
- `ToolRegistry.register()` 在规范化 descriptor 后校验
- 两个入口均抛出明确的错误消息，包含非法名称和规则说明

---

## 🟢 建议优化

### S-1. `ToolConstructor` 结构类型匹配过于宽松 ✅

**文件**：`packages/tools/src/types.ts:99`

**修正内容**：
- `ToolConstructor` JSDoc 加 `## Design tradeoff: structural vs nominal` 完整解释此 tradeoff（为什么要结构类型而非引入 `Tool` 类导入、实际危害为什么可接受、依赖反转的取舍）
- 不再隐藏此 tradeoff——未来维护者看到 JSDoc 就知道为什么这样设计

---

### S-2. `zodToJsonSchema` 输出的 `$schema` 字段透过 `as` cast 泄露 ✅

**文件**：`packages/tools/src/descriptor.ts:123`、`packages/tools/src/base.ts:99`

**修正内容**：
- `descriptor.ts`：新建 `zodToCleanJsonSchema()` 辅助函数，`delete raw.$schema` 后返回干净的 `JSONSchema`
- `base.ts` `toDescriptor()`：同样 `delete raw.$schema` 处理
- 两处转换路径现在一致：先转 JSON Schema → 删 `$schema` → 返回

---

### S-3. `tool()` 简写不支持 JSONSchema 路径 ✅

**文件**：`packages/tools/src/descriptor.ts:176-185`

**修正内容**：
- `tool()` 新增 JSONSchema 重载（三签名：Zod 重载 + JSONSchema 重载 + 实现签名）
- 泛型约束同步收紧：`T extends z.ZodObject<any>`（与 `defineTool()` 一致）
- JSDoc 完整标注两个重载的用途和示例

---

### S-4. `ToolRegistry` 不支持去重模式

**文件**：`packages/tools/src/registry.ts:48-53`

**修正**：TG0 不改。已添加到 `TG0_DEFERRED.md` 阶段 2 延后清单。

---

## 汇总

| 严重度 | 数量 | 状态 |
|--------|------|------|
| 🔴 致命 | 3 | ✅ 全部修复 |
| 🟡 重要 | 4 | ✅ 全部修复 |
| 🟢 建议 | 4 | ✅ 3 修复 + 1 延后 (S-4) |

**修复后 TG0 可 ship 状态**：全部 3 致命 + 4 重要 + 3 建议已修。S-4（去重模式）记入 `TG0_DEFERRED.md`。工具模块已准备好与 adapter 和 harness 集成。

**最终验证**：`npm run build` ✅ / `npm run typecheck` ✅
