# Harness Engine — Monorepo 工程化审查

> **审查人视角**：未参与设计讨论的 npm monorepo 工程化专家（8 年+，20+ 包 TS monorepo）。只关心 `npm install && npm run build` 能不能跑通。
> **审查日期**：2026-06-11
> **审查方法**：读所有 package.json / tsconfig / 源码 import → 构建依赖 DAG → 交叉验证 references、exports、dependencies → 跑实际 `tsc --noEmit` 验证。

---

## 编译器实测结果

```
npm run build  (root):
  error TS5083: Cannot read file 'D:/C-file/Harness_Engineer/tsconfig.json'.

tsc --noEmit (core):
  TS1287 ×3  (verbatimModuleSyntax + CJS)
  TS1295 ×3  (import/export in CJS)
  TS2416 ×2  (AsyncGenerator interface mismatch)
  TS2459 ×1  (CompressLevel not exported)

tsc --noEmit (hooks):
  TS1295 ×1  (import/export in CJS)
  TS1287 ×1  (verbatimModuleSyntax + CJS)
  TS2307 ×8  (cannot find @harness/* modules)

tsc --noEmit (subagent):
  TS1287 ×3  + TS1295 ×2  + TS2307 ×3
```

**一句话**：整个 monorepo 里没有一行 TypeScript 能通过编译。不是某个包的问题——是基础设施层的三个全局配置错误同时存在。

---

## 🔴 致命（不修正无法编译任何包）

### F-1. 根目录缺少 `tsconfig.json` — `npm run build` 直接报错

**文件**：`d:/C-file/Harness_Engineer/package.json` (scripts.build = `tsc --build`)

`tsc --build` 在当前目录查找 `tsconfig.json`。项目根目录只有 `tsconfig.base.json`（被各子包 extends），没有根 `tsconfig.json`。构建命令直接报 `TS5083: Cannot read file tsconfig.json`。

没有根 tsconfig.json，TypeScript 无法获知有哪些 packages 需要构建，也无法按拓扑序编排构建。每个包的 `tsc --build` 需要自己找到所有被引用的项目——但子包的 tsconfig.json 只声明了自己的 references，TypeScript 需要从根开始遍历整个项目引用图。

**修正**：创建 `d:/C-file/Harness_Engineer/tsconfig.json`：
```json
{
  "files": [],
  "references": [
    { "path": "packages/core" },
    { "path": "packages/tools" },
    { "path": "packages/adapters" },
    { "path": "packages/permission" },
    { "path": "packages/hooks" },
    { "path": "packages/subagent" },
    { "path": "packages/memory" },
    { "path": "packages/compressor" },
    { "path": "packages/engine" }
  ]
}
```

---

### F-2.

✅ **已修正**：创建 `tsconfig.json`（`files: []` + 9 个 `references` 按拓扑序排列）。

---

### F-2. 所有包的 `package.json` 缺少 `"type": "module"` — `verbatimModuleSyntax` + CommonJS = 不可编译

**文件**：`d:/C-file/Harness_Engineer/tsconfig.base.json` + 全部 9 个 `packages/*/package.json`

`tsconfig.base.json` 设置了：
```json
{
  "module": "NodeNext",
  "moduleResolution": "NodeNext",
  "verbatimModuleSyntax": true
}
```

`module: "NodeNext"` 意味着 TypeScript 从**最近的 `package.json` 的 `type` 字段**决定文件是 ESM 还是 CJS。全部 9 个 package.json 都没有 `"type"` 字段 → 默认 CJS。

但全部 `.ts` 文件使用 `import`/`export` 语法。`verbatimModuleSyntax: true` 在 CJS 模式下不允许 `import`/`export`——TS1287 和 TS1295 错误覆盖了每个包。

这是三个互相矛盾的配置：
- `module: "NodeNext"` → 看 package.json 的 type
- 没有 `"type": "module"` → CJS
- `verbatimModuleSyntax: true` → CJS 只能用 `import ... = require(...)`，不能用 `import ... from ...`

**修正**：给**全部 9 个 package.json** 加 `"type": "module"`：
```json
{
  "name": "@harness/core",
  "type": "module",
  ...
}
```
或者在根 package.json 只设一次（但每个 package 独立时需要各自的 type 字段）。推荐在每个子包 package.json 中显式声明——保持独立可构建性。

✅ **已修正**：全部 9 个 `packages/*/package.json` 添加 `"type": "module"`。

---

### F-3. `@harness/hooks/tsconfig.json` 的 `references` 数组不完整 — 缺少 `adapters` 和 `tools`

**文件**：`d:/C-file/Harness_Engineer/packages/hooks/tsconfig.json`

hooks 的 package.json 声明了三个依赖：
```json
"dependencies": {
  "@harness/core": "*",
  "@harness/adapters": "*",
  "@harness/tools": "*"
}
```

但 tsconfig.json 的 references 只有：
```json
"references": [
  { "path": "../core" }
]
```

缺失 `{ "path": "../adapters" }` 和 `{ "path": "../tools" }`。

`hooks/src/types.ts` 直接从 `@harness/adapters` 和 `@harness/tools` 导入类型（`ThinkEvent`、`ToolResult`）。在 composite 模式下，TypeScript 通过 project references 解析跨包类型声明。缺少 references 意味着：
1. 构建调度器不知道 hooks 需要 adapters/tools 先构建 → 可能并行构建导致 `dist/index.d.ts` 不存在时报错
2. 单独在 hooks 目录下 `tsc --build` 会因为找不到已构建的 declaration 文件而失败

✅ **已修正**：`hooks/tsconfig.json` references 从 `["../core"]` 扩展为 `["../core", "../adapters", "../tools"]`。

**修正**：
```json
"references": [
  { "path": "../core" },
  { "path": "../adapters" },
  { "path": "../tools" }
]
```

---

### F-4. `Harness` 类未正确实现 `AsyncGenerator` 接口 — 两个 TS2416 错误

**文件**：`d:/C-file/Harness_Engineer/packages/core/src/harness.ts`

编译器输出：
```
error TS2416: Property '[Symbol.asyncIterator]' in type 'Harness' is not assignable
  to the same property in base type 'AsyncGenerator<...>'.
  Type '() => AsyncIterator<...>' is not assignable to type '() => AsyncGenerator<...>'.
  Property '[Symbol.asyncIterator]' is missing in type 'AsyncIterator<...>'
  but required in type 'AsyncGenerator<...>'.

error TS2416: Property 'return' in type 'Harness' is not assignable
  to the same property in base type 'AsyncGenerator<...>'.
  Type '(_value?: SessionResult | undefined) => ...' is not assignable
  to type '(value: SessionResult | PromiseLike<SessionResult>) => ...'.
```

**问题一**（行 36）：`[Symbol.asyncIterator]()` 声明的返回类型是 `AsyncIterator<HarnessEvent, SessionResult, UserDecision>`，但 `AsyncGenerator` 接口要求返回 `AsyncGenerator<...>`。`AsyncIterator` 没有 `[Symbol.asyncIterator]` 方法，因此不满足 `AsyncGenerator` 的结构。

**问题二**（行 44）：`return(_value?: SessionResult)` 参数标记为可选，但 `AsyncGenerator.return()` 的签名是 `return(value: SessionResult | PromiseLike<SessionResult>)`——参数不可选，且类型不兼容。

**修正**：
```typescript
[Symbol.asyncIterator](): AsyncGenerator<HarnessEvent, SessionResult, UserDecision> {
    return this
}

async return(value?: SessionResult | PromiseLike<SessionResult>): Promise<IteratorResult<HarnessEvent, SessionResult>> {
    throw new Error("Harness.return() not implemented — TG0")
}
```

---

### F-5.

✅ **已修正**：`[Symbol.asyncIterator]()` 返回类型改为 `AsyncGenerator<...>`；`return(value?: SessionResult | PromiseLike<SessionResult>)` 参数类型匹配接口定义。

---

### F-5. `session.ts` 从 `context.ts` 导入 `CompressLevel` 但它没有被 re-export

**文件**：`d:/C-file/Harness_Engineer/packages/core/src/session.ts` → `d:/C-file/Harness_Engineer/packages/core/src/context.ts`

编译器输出：
```
error TS2459: Module '"./context.js"' declares 'CompressLevel' locally, but it is not exported.
```

`session.ts` 第 5 行：
```typescript
import type { Message, CompressLevel } from "./context.js"
```

`context.ts` 中 `CompressLevel` 被 import 了（从 `./types.js`）并用于类型定义，但**从未被 export**。`verbatimModuleSyntax: true` 禁止导入模块内部的非导出符号。

`CompressLevel` 的 canonical 定义在 `types.ts` 中（`export type CompressLevel = ...`）。

**修正**：在 `session.ts` 中改为：
```typescript
import type { Message } from "./context.js"
import type { CompressLevel } from "./types.js"
```

✅ **已修正**：`session.ts` 第 5 行改为从 `"./types.js"` 导入 `CompressLevel`（其 canonical 定义所在）。

---

## 🟡 重要（编译可通过但存在工程风险）

### I-1. `@harness/core/src/unresolved.ts` 存根类型与真实类型不一致

**文件**：`d:/C-file/Harness_Engineer/packages/core/src/unresolved.ts`

core 包定义了一组"占位"类型来避免循环依赖（`@harness/adapters` 依赖 core，core 的 `HarnessConfig` 又要引用 adapter 的类型）。但这些占位类型与各包的真实定义不同：

| 占位 (core) | 真实定义 | 差异 |
|---|---|---|
| `AdapterConstructor = new (...args) => unknown` | `new (...args) => LLMAdapter` (adapters) | core 版本丢失了 LLMAdapter 返回类型 |
| `ToolInput = unknown` | `ToolDescriptor \| (new (...args) => Tool)` (tools) | core 版本完全无类型安全 |
| `PermissionConfig = {}` | 包含 mode/rules/defaultLevel 等字段 (permission) | core 版本为空接口 |
| `MemoryConfig = {}` | 包含 user/project/session 三层配置 (memory) | core 版本为空接口 |

结果：`HarnessConfig` 从 `unresolved.ts` 引用这些类型 → `tools` 字段接受 `unknown[]` → 用户可以写 `tools: [42, "hello"]` 且 **零类型报错**。类型系统在配置构造阶段完全失效。

**修正**：短期——在每个占位类型上方加 JSDoc `@deprecated` 和说明；长期——考虑用类型体操（如 TypeScript 的 `interface` merging 或 `declare module`）让真实类型覆盖占位，或者接受这个 tradeoff 并文档化："HarnessConfig 不做深度类型校验，运行时由 ToolRegistry/PermissionEngine 验证"。

✅ **已修正（接受 tradeoff）**：`unresolved.ts` 每个占位类型上方添加 `@deprecated` JSDoc 标注 canonical 位置，文件头部注明"HarnessConfig 不做深度 TS 类型校验，运行时由各子系统构造函数验证"的 tradeoff 说明。

---

### I-2. `defineTool()` 和 `Tool.toDescriptor()` 将 `zod` 以 `import type` 导入，但实现代码需要运行时值

**文件**：
- `d:/C-file/Harness_Engineer/packages/tools/src/descriptor.ts` 行 3: `import type { z } from "zod"`
- `d:/C-file/Harness_Engineer/packages/tools/src/base.ts` 行 3: `import type { z } from "zod"`

目前是 TG0 存根（所有方法直接 throw），所以能编译。但一旦开始实现：

1. `defineTool()` 需要把 `z.ZodType` 转成 `JSONSchema`（调用 `zod-to-json-schema` 或 zod 的内置 `.describe()` / `.shape` 等运行时 API）
2. `Tool.toDescriptor()` 同理

`import type` 会在编译后被完全擦除——`z` 在运行时是 `undefined`。当 `defineTool(z.object({...}))` 被调用时，代码试图访问 `z.ZodType` 或 zod 的运行时方法，直接 `ReferenceError`。

**修正**：将 `import type { z } from "zod"` 改为 `import { z } from "zod"`。TG0 存根阶段就可以改——不是"到时候再说"的事，是"到时候必然忘"的事。

✅ **已修正**：`descriptor.ts` 和 `base.ts` 的 `import type { z } from "zod"` 改为 `import { z } from "zod"`（运行时值导入）。

---

### I-3. 空目录 `builtin/` 和 `strategies/` —— API 设计 §十三声明的文件不存在

**文件**：
- `d:/C-file/Harness_Engineer/packages/tools/src/builtin/` （空）
- `d:/C-file/Harness_Engineer/packages/compressor/src/strategies/` （空）

API 设计 §十三指定了 `builtin/read.ts, write.ts, edit.ts, bash.ts, glob.ts, grep.ts, index.ts` 和 `strategies/trim.ts, summarize.ts, chunk.ts, embed.ts, truncate.ts`。目录存在但无文件。

编译器不管空目录（不会报错），但 `@harness/engine` 的 index.ts 没有从 builtin 或 strategies 导入任何内容——即使用了这些目录将来有文件，也**没有任何代码路径会加载它们**。`@harness/tools/src/index.ts` 没有 `export * from "./builtin/index.js"`，`@harness/compressor/src/index.ts` 没有 `export * from "./strategies/..."`。

如果这是 "TG0 后再加" 的策略——没问题。但如果有人现在看文件树就觉得 "builtin 工具有了"——那是幻觉。

✅ **已修正**：在 `builtin/` 和 `strategies/` 各添加 `index.ts` 占位文件（`export {} // TG0 placeholder`）。`tools/src/index.ts` 和 `compressor/src/index.ts` 添加注释标注将来的 re-export 位置。

**修正**：要么删除空目录（YAGNI），要么加一个 `index.ts` 占位文件（`export {} // TG0`），让 import 路径在将来可工作。

---

## 🟢 可延后（不影响编译，但会在后续阶段造成摩擦）

### D-1. `@harness/subagent` 对 `zod` 的 phantom dependency

**文件**：`d:/C-file/Harness_Engineer/packages/subagent/src/types.ts` 行 5: `import type { z } from "zod"`

`@harness/subagent/package.json` 的 `dependencies` 和 `devDependencies` 都没有 `zod`。`zod` 可用纯粹因为 npm workspaces 的 hoisting——它在根 `node_modules` 中作为 `@harness/tools` 的依赖被安装。

如果将来：
- 切换到 pnpm（strict isolation，未声明的依赖不可访问）
- 把 `@harness/subagent` 提取为独立仓库
- 有人 `npm install` 时用了 `--legacy-peer-deps` 导致 hoisting 行为变化

→ `zod` 类型解析失败，`SubagentSpec.schema` 的类型变成 `any`。

**修正**：`@harness/subagent/package.json` 加：
```json
"devDependencies": {
  "zod": "^3.23.0",
  "typescript": "^5.7.0"
}
```

✅ **已修正**：`@harness/subagent/package.json` devDependencies 添加 `"zod": "^3.23.0"`。
或者如果 schema 功能确实需要 runtime zod，放 `"dependencies"`。

---

### D-2. 所有包标记为 `"private": true` —— 未来发布需逐一移除

**文件**：全部 9 个 `packages/*/package.json`

根 package.json `"private": true` 对于 monorepo 是正确的。但每个子包也设了 `"private": true`。如果要发布 `@harness/core` 到 npm，需要改为 `false` 或删除该字段。这不是 bug，但值得在发布 checklist 中记录。

---

### D-3. `@harness/engine` 的 re-export 有致命时炸弹

**文件**：`d:/C-file/Harness_Engineer/packages/engine/src/index.ts`

```typescript
export { Harness } from "@harness/core"
```

如果将来 `@harness/core` 的 `Harness` 类改为 `export default` 或改名，engine 包的 re-export 会直接断裂。engine 作为聚合包，本质上是所有子系统的"别名层"——它引入了一个额外的断裂点却没有额外的封装价值（用户完全可以直接 `import { Harness } from "@harness/core"`）。

**修正**：至少在 engine 的 index.ts 中加集成测试（一个简单的 `createHarness` 冒烟测试），防止 re-export 断裂。

---

### D-4. `tsconfig.base.json` 中 `isolatedModules: true` + `verbatimModuleSyntax: true` 双重约束

**文件**：`d:/C-file/Harness_Engineer/tsconfig.base.json`

这两个 flag 同时开启意味着：
- 每个文件必须能被独立编译（`isolatedModules`）——禁止 `const enum`、禁止纯类型导出重导出
- 每个 `import` 如果是纯类型必须写 `import type`（`verbatimModuleSyntax`）

目前代码严格遵守了这两条（所有跨包导入都是 `import type`，所有同包导入都是 `import type`），但这对新贡献者是高频翻车点。没配 ESLint rule（`@typescript-eslint/consistent-type-imports`）来自动补 `type` 关键字 → 每次遗漏都是手动修。

**修正**：在 root devDependencies 已有 `@typescript-eslint/eslint-plugin` 和 `parser`，加一条 ESLint config：
```json
"rules": {
  "@typescript-eslint/consistent-type-imports": ["error", { "prefer": "type-imports" }]
}
```

---

## 汇总

| 严重度 | 数量 | 阻塞范围 |
|--------|------|---------|
| 🔴 致命 | 5 | 整棵依赖树无法编译。根 tsconfig 缺失 + "type": "module" 缺失 = 整个 monorepo 零文件可编译。hooks references 不完整 = 构建拓扑错。AsyncGenerator 接口实现错 + CompressLevel 导入错 = core 包独立不可编译。 |
| 🟡 重要 | 3 | unresolved.ts 类型安全问题、import type zod 将导致运行时炸、空目录是幻觉 |
| 🟢 可延后 | 4 | phantom dependency、private 标记、engine 别名层脆性、ESLint 规则缺失 |

**修正顺序**：
1. 所有 package.json 加 `"type": "module"`（9 处）
2. 创建根 `tsconfig.json`（`files: []` + 9 个 references）
3. 修 `hooks/tsconfig.json` 加 references
4. 修 `harness.ts` 两个 TS2416 错误 + `session.ts` CompressLevel 导入路径
5. 修 `defineTool` / `Tool` 的 `import type { z }` → `import { z }`
6. D 类按需处理
