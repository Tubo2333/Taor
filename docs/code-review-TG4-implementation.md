# Code Review: TG4 Implementation — `184f68e` + working tree fixes

**Review date**: 2026-06-13
**Reviewer**: 第三方代码审查（只看代码，不信文档）
**Scope**: OpenAI adapter 实现 + requiredEnvVars 通用化 + ESM require 修复
**Verdict**: **PASS** — 0 阻塞，1 个 nitpick

---

## 审查结果

### CRITICAL — `require("openai")` 在 ESM 上下文崩溃 ✅ 已修

**文件**: `packages/adapters/src/openai-compatible-base.ts:305`

`require("openai")` 在 `"type": "module"` 的包中运行时会抛 `ReferenceError: require is not defined`。

**修复**（working tree 已改）:

```typescript
// 文件顶部
import { createRequire } from "node:module"

// createClient() 方法内
const _require = createRequire(import.meta.url)
const { default: OpenAIClient } = _require("openai")
```

与 `memory/src/store.ts:324-326` 的 SqliteStore 模式一致。编译产物验证通过：
- `dist/openai-compatible-base.js:10` → `import { createRequire } from "node:module";` (ESM import)
- `dist/openai-compatible-base.js:225` → `const _require = createRequire(import.meta.url);`
- `dist/openai-compatible-base.js:226` → `const { default: OpenAIClient } = _require("openai");`

---

### AD-1 ~ AD-5 协议一致性 — 全部通过

| AD | 检查项 | 源码证据 | 结果 |
|----|--------|---------|------|
| AD-1 | core 不 import sibling | `harness.ts:1-26` 全部 import 自 `./` | ✅ |
| AD-2 | adapter 接口一致 | Anthropic + OpenAI + DeepSeek 均有 `requiredEnvVars` + `withRetry` + `think` | ✅ |
| AD-3 | optional dep 用 createRequire | `openai-compatible-base.ts:305` | ✅ |
| AD-4 | 库代码无 process.exit | 全项目 grep 无新增 | ✅ |
| AD-5 | test infra | 17 tests pass | ✅ 但缺 OpenAI adapter test |

---

### `wrapToolResult` role 差异 — 已安全

| Adapter | role | 源码 |
|---------|------|------|
| Anthropic | `"user"` | `anthropic.ts:679` |
| OpenAI | `"tool"` | `openai-compatible-base.ts:662` |

`Message.role` 类型已包含 `"tool"`（`context.ts:8`）。TAOR loop 不直接使用 role——只做 `wrapToolResult → messages[] → buildRequest → convertMessages` 传递，每个 adapter 读写自己的 role。单一 adapter 场景安全。

---

### OpenAI streaming tool_calls 追踪 — 正确

`openai-compatible-base.ts:489-538`: `tc.index` 做 Map key→并行 tool call 分离，`tc.id`/`tc.name` 增量更新，finish_reason 时 emit tool_use + `toolBlocks.clear()`，JSON.parse 有 try-catch。

---

## Nitpick（不阻塞）

**N1. `createClient()` 在 `think()` 的 try-catch 之外**

`openai-compatible-base.ts:448` 调 `createClient()`，但 try block 从 line 462 才开始。Anthropic 同模式安全（静态 import），但 OpenAI 用动态 `_require()`——若 `openai` 未安装，错误在 try 之前逃逸。TAOR loop 会捕获（不崩溃），但错误信息是原始 `MODULE_NOT_FOUND` 非友好提示。

**修复**（可选）: `_require("openai")` 包裹 try-catch 抛友好错误。不阻塞 v0.2.0。

---

## 验证

| 命令 | 结果 |
|------|------|
| `npm run build` | ✅ 零错误 |
| `npm run typecheck` | ✅ 零错误 |
| `npm run test` | ✅ 17 passed |

---

## 下一步

当前 working tree 需 commit（3 个修复 + TG4 代码）。然后进入 GAP-3 集成测试套件（TG4 Phase 0 最耗时任务，8-10h）。

### Commit 指令

```bash
cd d:/C-file/Harness_Engineer
git add packages/adapters/src/openai-compatible-base.ts packages/adapters/src/index.ts
git add packages/adapters/src/anthropic.ts packages/adapters/src/openai.ts packages/adapters/src/deepseek.ts
git add packages/adapters/package.json packages/engine/src/index.ts packages/core/src/harness.ts
git add package.json package-lock.json .github/workflows/ci.yml
git commit -m "feat: TG4 — OpenAI + DeepSeek adapters, generic requiredEnvVars, ESM createRequire fix"
```
