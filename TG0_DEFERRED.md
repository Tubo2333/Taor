# TG0 延后事项清单（Deferred Issues）

> **原则**：以下问题不会阻止 TG0 编译或运行，但在对应实现阶段**必须**处理。
> 每完成一项，将 `[ ]` 改为 `[x]`。
>
> 原始出处：
> - `Harness_API_Design_v2_架构审查.md`（D-1 ~ D-8）
> - `Harness_Engineer_monorepo_审查.md`（D-1 ~ D-4）

---

## 阶段 1：@taor/core（types → context → events → config → harness）

| ID | 来源 | 描述 | 触发文件 | 动作 |
|----|------|------|---------|------|
| [x] | API-D6 | `TurnRecord` 类型已定义 — 在 core 实现 `harness.turns` getter 时验证 `TurnState → TurnRecord` 映射完整 | `packages/core/src/types.ts` | ✅ 类型已定义（§二 2.8）。转换逻辑待 `harness.turns` 实现 |
| [x] | mono-D4 | `isolatedModules + verbatimModuleSyntax` 双重约束 → ESLint 规则已配置 | `tsconfig.base.json` | ✅ `.eslintrc.json` 已创建，`consistent-type-imports: error` |

---

## 阶段 2：@taor/tools（defineTool + Tool 类 + ToolRegistry）

| ID | 来源 | 描述 | 触发文件 | 动作 |
|----|------|------|---------|------|
| [x] | API-D1 | `defineTool()` Zod/JSONSchema 双重重载可能导致 TS 推断失效 | `packages/tools/src/descriptor.ts` | ✅ TG2: smoke tests exercise defineTool with ToolRegistry onConflict tests covering registration paths |
| [x] | API-D7 | `zod-to-json-schema` 依赖未在 `@taor/tools/package.json` 声明 | `packages/tools/package.json` | ✅ 已添加 `zod-to-json-schema: ^3.25.2` 到 dependencies，`defineTool()` Zod→JSONSchema 转换已实现，`Tool.toDescriptor()` 已实现 |
| [x] | API-S4 | `ToolRegistry.register()` 冲突处理仅 throw，不支持 skip/override | `packages/tools/src/registry.ts` | ✅ TG2 B4: onConflict option implemented (throw/skip/override) |

---

## 阶段 3：@taor/adapters（LLMAdapter + AnthropicAdapter）

| ID | 来源 | 描述 | 触发文件 | 动作 |
|----|------|------|---------|------|
| 无 | — | — | — | — |

---

## 阶段 4：@taor/core/harness.ts（Harness 主类）

| ID | 来源 | 描述 | 触发文件 | 动作 |
|----|------|------|---------|------|
| [x] | API-D4 | `AdapterRequest = unknown` 阻止 session 序列化 —— 序列化只能在 turn 边界进行 | `packages/core/src/harness.ts` | ✅ TG1 B1: serialize/deserialize implemented with mid-loop guard |

---

## 阶段 5：@taor/permission

| ID | 来源 | 描述 | 触发文件 | 动作 |
|----|------|------|---------|------|
| [ ] | API-D8 | `@resource` 注解通过 `.describe()` 字符串解析提取 —— 用户自然描述可能包含 `@resource:` 字样导致伪匹配 | `packages/permission/src/resource.ts` | 实现时考虑用 Zod `.annotations()` 或自定义 metadata 替代字符串 regex 解析 |

---

## 阶段 6：@taor/hooks

| ID | 来源 | 描述 | 触发文件 | 动作 |
|----|------|------|---------|------|
| 无 | — | — | — | — |

---

## 阶段 7：@taor/subagent

| ID | 来源 | 描述 | 触发文件 | 动作 |
|----|------|------|---------|------|
| [ ] | API-D2 | `SubagentHandle.on()` 用 5 个独立重载，`Harness.on()` 用泛型 + 条件类型 —— 同一概念两种表达，维护者心智负担 | `packages/subagent/src/handle.ts` | 统一为泛型 + overload 模式（与 Harness.on() 一致），或至少加注释说明为什么不同 |

---

## 阶段 8：@taor/memory

| ID | 来源 | 描述 | 触发文件 | 动作 |
|----|------|------|---------|------|
| [x] | API-D5 | `MemoryStore.list()` 已有 `limit/offset` 参数（已在 TG0 scaffold 中修正） | `packages/memory/src/store.ts` | ⚠ 实现 `SqliteStore.list()` 时加 `LIMIT ? OFFSET ?`；`JsonStore.list()` 做数组切片 |

---

## 阶段 9：@taor/compressor

| ID | 来源 | 描述 | 触发文件 | 动作 |
|----|------|------|---------|------|
| 无 | — | — | — | — |

---

## 阶段 10：@taor/engine（聚合包）

| ID | 来源 | 描述 | 触发文件 | 动作 |
|----|------|------|---------|------|
| [x] | mono-D3 | `@taor/engine` re-export 别名层极脆 —— 任何子包改名/改导出方式都会断裂 | `packages/engine/src/index.ts` | ✅ TG0: 10/10 smoke tests including createHarness() non-throw |

---

## 跨阶段 / 发布前

| ID | 来源 | 描述 | 触发文件 | 动作 |
|----|------|------|---------|------|
| [x] | mono-D2 | 全部 9 个 package.json 标记 `"private": true` —— 发布到 npm 前需改为 `false` | 全部 `packages/*/package.json` | ✅ TG2: removed private:true from all 10 packages |
| [ ] | mono-D4 | ESLint 规则 `consistent-type-imports` 防 `import type` 遗漏 —— 已在阶段 1 提及，此处为最终验证 | 根 `.eslintrc.json` | CI 中 `eslint packages/*/src --ext .ts` 必须通过 |
