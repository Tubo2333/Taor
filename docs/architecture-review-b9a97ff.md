# Architecture Review: Commit `b9a97ff` — 修复 Review #1 的 20 项问题

**Review date**: 2026-06-13
**Reviewer**: 同一外部审查者（与修复 agent 无共享上下文）
**Scope**: `git diff 4c2deb4..b9a97ff` — 18 files, +782/−163
**Verdict**: **PASS_WITH_FIXES** — 所有 CRITICAL/HIGH 已消除，2 MEDIUM 建议修

---

## 修复完成度

| ID | Issue | 状态 |
|----|-------|------|
| C1 | `process.exit()` in library | ✅ throw Error + CLI try-catch |
| C2 | deserialize 半初始化 | ✅ 参数注入，删除 `as any` 后门 |
| C3 | adapter/registry 空指针 | ✅ getter/setter 守卫 |
| H1 | withRetry AbortSignal | ✅ 退避期间监听 abort |
| H2 | TTL timer unref | ✅ `.unref()` |
| H3 | 接口一致性检查 | ✅ 3/7 接口覆盖 |
| H4 | __modulePath warn | ✅ warn 日志 |
| H5 | adapter 子类检测 | ✅ `prototype instanceof` |
| M1 | SIGKILL/SIGTERM | ✅ 统一 `"SIGTERM"` |
| M2 | CLI try-catch | ✅ switch 全包裹 |
| M3 | @types/node | ✅ 仅加 3 个需要的包 |
| M4 | 心跳超时 | ✅ 60s/10s |
| M5 | CHANGELOG | ✅ |
| M6 | disconnect exit(0) | ✅ |
| M7 | exit code 冲突 | ✅ |
| M8 | real.ts try-catch | ✅ |
| L1 | EchoAdapter | ⏭️ 延后（示例代码） |
| L2 | Dockerfile | ✅ 层缓存优化 |
| L3 | _tools 参数 | ✅ 加注释 |
| L4 | better-sqlite3 链 | ⏭️ 延后（文档） |

**总完成率**: 18/20。2 个 LOW 延后，0 个遗漏。

---

## 本次修改清单（2 MEDIUM + 3 LOW）

### 🟡 MEDIUM

#### M-NEW-1. adapter/registry 有 public setter，与其他 5 个子系统不一致

**文件**: `packages/core/src/harness.ts:289-310`

**问题**: `get adapter()` / `set adapter()` 允许外部任意替换内部 adapter。对比 permission/hooks/memory/compressor 都是只读 getter（无 setter）。TAOR loop 运行中替换 adapter 会导致未定义行为。

当前 7 子系统对比：
```
permission:  getter ✅   setter ❌ (只读)
hooks:       getter ✅   setter ❌
memory:      getter ✅   setter ❌
compressor:  getter ✅   setter ❌
subagent:    spawn() ✅  无 setter
adapter:     getter ✅   setter ⚠️ (可写!) ← 不一致
registry:    getter ✅   setter ⚠️ (可写!) ← 不一致
```

**修复**: 删除 `set adapter()` 和 `set registry()`。构造函数和 `setAdapter()`/`setRegistry()` 方法（如需要保留）内部直接赋值 `this._adapter` / `this._registry`。与 `setPermission()`/`setHooks()` 等方法保持一致的注入模式。

```ts
// 删除这两行：
set adapter(a: IAdapter) { this._adapter = a }
set registry(r: IToolRegistry) { this._registry = r }
```

`createHarness()` 内部已经通过构造函数传 adapter/registry（C2 修复后），不需要 setter。

---

#### M-NEW-2. IToolRegistry 未被 interface-conformance 覆盖

**文件**: `packages/engine/src/interface-conformance.check.ts:28-32`

**问题**: 文件注释说 IToolRegistry "intentionally omitted"。但 `get()` 和 `list()` 方法不依赖 `ToolDef` vs `ToolDescriptor` 的内部差异——这两个方法的返回值形状在赋值层面是兼容的。IToolRegistry 是 TAOR loop ACT 阶段的关键接口，仅次于 IAdapter。

当前覆盖：IAdapter, IMemoryFacade, ICompressorPipeline（3/7）
应覆盖：加 IToolRegistry（4/7）

**修复**: 在 `interface-conformance.check.ts` 末尾加：

```ts
import type { IToolRegistry } from "@taor/core"
import { ToolRegistry } from "@taor/tools"

// ToolRegistry.get()/list()/register() must stay compatible with IToolRegistry
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _reg: IToolRegistry = undefined as unknown as ToolRegistry
```

这检查的是注册表级别方法签名（`register`/`get`/`list`/`size`/`remove`/`clear`），不涉及 ToolDef vs ToolDescriptor 内部差异。如果 ToolRegistry 加了必填方法而 IToolRegistry 没同步 → `npm run typecheck` 会挂。

---

### 🟢 LOW

#### L-NEW-1. `deserialize()` 签名破坏性变更未在 CHANGELOG 标 BREAKING

**文件**: `CHANGELOG.md:22`

旧: `Harness.deserialize(data, config)` (2 参数)
新: `Harness.deserialize(data, config, adapter, registry)` (4 参数)

CHANGELOG 描述正确但没有 `**BREAKING**` 前缀。

**修复**: 在 CHANGELOG 对应行前加 `**BREAKING**`。

---

#### L-NEW-2. `validateEnv()` 框架内部无调用点，注释过期

**文件**: `packages/core/src/env.ts:1-8`

`createHarness()` 现在做内联 env 检查（不再调 `validateEnv()`）。CLI 也不调它。函数仍被 export 供外部使用（合理），但注释 "Call at entry point before creating any adapter or engine instance" 应补充说明 `createHarness()` 已做此检查。

**修复**: 更新注释：
```ts
/**
 * Validate required environment variables.
 * Throws instead of process.exit() — library code must never kill the host process.
 *
 * NOTE: createHarness() already validates ANTHROPIC_API_KEY internally.
 * Call this directly only if you construct AnthropicAdapter without using createHarness().
 */
```

---

#### L-NEW-3. CLI `main()` 去掉了外层 `.catch(console.error)` 安全网

**文件**: `packages/cli/src/index.ts:95`

旧: `main().catch(console.error)` — 任何逃逸的未处理 rejection 被兜底
新: `main()` — try-catch 涵盖所有代码路径，无外层兜底

当前 try-catch 确实包裹了全部逻辑，不是实际缺陷。但外层 `.catch()` 是零成本防御，建议恢复。

**修复**: 最后一行改回 `main().catch(console.error)`。

---

## 修改顺序

无依赖关系，一次性修完：

1. **M-NEW-1** — 删除 adapter/registry public setter
2. **M-NEW-2** — 加 IToolRegistry 到 interface-conformance
3. **L-NEW-1** — CHANGELOG 加 BREAKING 标记
4. **L-NEW-2** — validateEnv 注释更新
5. **L-NEW-3** — CLI 恢复 `.catch(console.error)`

## 验证清单

- [ ] `npm run typecheck` 零错误（含新增 IToolRegistry 检查）
- [ ] `npm run build` 全部 10 包通过
- [ ] `npm run test` 17 tests 通过
- [ ] `harness.adapter` 外部可读不可写（TypeScript 报错才算通过）
- [ ] CHANGELOG 有 `**BREAKING**` 标记
