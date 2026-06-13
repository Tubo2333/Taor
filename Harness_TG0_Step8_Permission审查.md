# Taor — TG0 Step 8 @taor/permission Adversarial Review

> **审查人视角**：独立架构审计师。审查 permission 模块实现质量、ACT phase 集成、config 校验和依赖反转桥接。
> **审查日期**：2026-06-12
> **审查范围**：`packages/permission/src/` 5 个源文件 + `harness.ts` ACT phase + `engine/index.ts` createHarness() + `config.ts` permission 段 + `unresolved.ts` 升级
> **前序审查**：67 条已闭环。本审查不重复。

---

## 🔴 致命

无。匹配算法、denylist/allowlist 优先级、boundary 降级、范围覆盖均正确。

---

## 🟡 重要

### I-1. Turn scope override 不在 turn 边界自动重置 — 跨 turn 泄露

**文件**：`packages/permission/src/engine.ts:386-388`（resetScope）、`packages/core/src/harness.ts` OBSERVE phase

`allowAll("turn")` 或 `denyAll("turn")` 设置的 turn 覆盖只在手动调用 `resetScope()` 时清除。TAOR 循环的 OBSERVE phase 不调用 `permEngine.resetScope()`。虽然 TG0 的 TAOR 循环不会通过内部路径调用 `denyAll("turn")`（只使用 `autoApproveRest` 布尔变量），但外部代码可以通过 `harness.permission.denyAll("turn")` 设置，且跨 turn 不会自动清除。交付总结 R4 已标记此问题。

**修正**：在 `harness.ts` OBSERVE phase 末尾（`turn-ended` 事件之前或之后）加：
```typescript
// Reset turn-level permission overrides at turn boundary
this.permissionEngine?.resetScope()
```
`PermissionEngine.resetScope()` 需在 structural `IPermissionEngine` 接口中声明（当前未包含在 interface 中）。两步走：先给 `IPermissionEngine` 加 `resetScope(): void` 方法签名，再在 harness.ts OBSERVE phase 调用。

✅ **已修复**：`IPermissionEngine` 接口已有 `resetScope()`（行 131）。在 `harness.ts:732` OBSERVE phase `turn-ended` 事件前添加 `this.permissionEngine?.resetScope()`。

---

### I-2. `matchRisk` 对未注册工具默认 `"medium"` — denylist 语义被软化

**文件**：`packages/permission/src/engine.ts:428-438`

```typescript
private matchRisk(rule: PermissionRule, toolRisk: RiskLevel | null): boolean {
    if (rule.risk === undefined) return true
    const allowed = Array.isArray(rule.risk) ? rule.risk : [rule.risk]
    const effectiveRisk = toolRisk ?? "medium"  // ← 未知 → medium
    return allowed.includes(effectiveRisk)
}
```

当 denylist 规则指定 `risk: "high"` 且工具未在 descriptor map 中注册时：
- `toolRisk = null` → `effectiveRisk = "medium"` → `includes("medium")` → false → 规则不命中 → 工具不被 deny

未注册到 PermissionEngine 的高风险工具**绕过 denylist**。TG0 中 `createHarness()` 同步了所有工具描述符所以不会触发，但代码路径存在。JSDoc 写的是 "match conservatively" 但 conservative 在 denylist 上下文中应该是"未知风险 = 拒绝"，当前行为正相反。

**修正**：`matchRisk` 加 `context` 参数区分调用场景：
```typescript
private matchRisk(
    rule: PermissionRule,
    toolRisk: RiskLevel | null,
    context: "denylist" | "allowlist" | "rules" = "rules",
): boolean {
    if (rule.risk === undefined) return true
    const allowed = Array.isArray(rule.risk) ? rule.risk : [rule.risk]
    const effectiveRisk = toolRisk ?? (
        context === "denylist" ? "high" :
        context === "allowlist" ? "low" :
        "medium"
    )
    return allowed.includes(effectiveRisk)
}
```
Denylist 调用点（行 162）传 `"denylist"`，allowlist 调用点（行 174）传 `"allowlist"`，规则调用点（行 191）保持默认 `"rules"`。

✅ **已修复**：`matchRisk` 增加 `context` 参数（denylist→"high", allowlist→"low", rules→"medium"）。`toolDesc` 定义提前到 denylist 循环之前。三个调用点均已更新：(1) denylist: `matchRisk(rule, toolDesc?.risk ?? null, "denylist")`, (2) allowlist: `matchRisk(rule, toolDesc?.risk ?? null, "allowlist")`, (3) rules: `matchRisk(rule, toolDesc?.risk ?? null, "rules")`。同时修复了 S-4（denylist/allowlist 现在使用真实 toolDesc 而非 null）。

---

### I-3. `extractResourceAnnotations` 的 regex 可能在自然语言描述中误匹配

**文件**：`packages/permission/src/resource.ts:19`

```typescript
const RESOURCE_RE = /@resource:(fs-path|url|shell-command|env-var)/
```

在 `z.string().describe("A file path pointing to @resource:fs-path storage")` 中，`A file path pointing to @resource:fs-path storage` 包含字面量 `@resource:fs-path`——regex 误匹配并将此参数错误标记为文件系统资源。交付总结 R1/API-D8 已标记。

**修正**（TG0 最小改动）：将 regex 改为要求 `@resource:` 前是行首或空格——减少嵌入到自然语言中的概率：
```typescript
const RESOURCE_RE = /(?:^|\s)(@resource:(?:fs-path|url|shell-command|env-var))/
```
并相应调整 `match[0]` 提取逻辑（match[0] 现在可能含前导空格，改用 match[1]）。

✅ **已修复**：RESOURCE_RE 改为 `/(?:^|\s)(@resource:(?:fs-path|url|shell-command|env-var))/`。提取逻辑从 `match[0]` 改为 `match[1]`（group 1 不含前导空格）。注释更新说明剩余风险。

---

### I-4. `validateConfig()` 不校验 `permission.mode` 字段

**文件**：`packages/core/src/config.ts:188-214`

`validateConfig()` 校验了 `defaultLevel` 和 `approvalTimeout`，但没有校验 `mode`。如果用户传入 `mode: "offline"`，`PermissionEngine` 构造时 `this.mode = config.mode ?? DEFAULTS.mode` 静默接受非法值，后续 `isInteractive` 行为错误。

**修正**：在 config.ts permission 段加：
```typescript
const VALID_PERMISSION_MODES = new Set(["interactive", "non-interactive", "custom"])
if (raw.permission?.mode !== undefined && !VALID_PERMISSION_MODES.has(raw.permission.mode)) {
    throw new Error(
        `HarnessConfig: permission.mode must be one of ` +
        `[${[...VALID_PERMISSION_MODES].join(", ")}], got "${raw.permission.mode}".`
    )
}
```

✅ **已修复**：`config.ts` 添加 `VALID_PERMISSION_MODES` 常量和 `permission.mode` 校验（紧接 `defaultLevel` 校验之后）。

---

### I-5. `boundary` 规则返回的 level 对消费者不透明 — 资源边界检查信息在审批提示中不可见

**文件**：`packages/permission/src/engine.ts:260-266`、`packages/core/src/harness.ts:557-559`

```typescript
// engine.ts — boundary 通过后返回 level: "boundary"，reason 含 "(resource check passed)"
// harness.ts ACT phase:
const needsApproval =
    builtinNeedsApproval &&
    permVerdict?.level !== "allow"   // "boundary" !== "allow" → true → 走审批
```

当工具是 high risk 且 boundary 规则已通过资源检查时：用户看到的审批原因是 "High-risk tool"（来自 `risk === "high"` 分支），而非包含资源边界信息。资源边界检查的事实被用户界面丢弃。

**修正**：TG0 不改（交付总结 R3 已分析，语义正确只是非直觉）。在 harness.ts ACT phase permission check 段加注释：
```typescript
// TG0: When permVerdict.level === "boundary" and the tool is high-risk,
// the approval reason defaults to "High-risk tool" — resource boundary
// status (permVerdict.reason) is available but not surfaced in the prompt.
// TG1: Surface boundary status explicitly in the approval-required reason.
```

✅ **已修复**：在 `harness.ts:561-564` ACT phase `needsApproval` 块添加边界透明度注释，标记为 TG1 改进项。

---

## 🟢 建议优化

### S-1. `IPermissionEngine` structural interface 缺少 `resetScope()` 方法

**文件**：`packages/core/src/harness.ts:115-117`

当前 `IPermissionEngine` 只声明了 `evaluate` 和 `addRule`。要支持 I-1 的 OBSERVE phase resetScope，需要扩增 structural interface。

**修正**：在 `IPermissionEngine` 加 `resetScope(): void`。

---

### S-2. `createHarness()` 中 `toolDescriptors` cast 是多余的 round-trip

**文件**：`packages/engine/src/index.ts:97`

```typescript
const toolDescriptors = registry.list() as unknown as ToolDescriptor[]
```

`registry` 是 `new ToolRegistry()`——真实类型，`list()` 返回 `ToolDescriptor[]`。`as unknown as ToolDescriptor[]` 是 `ToolDescriptor → unknown → ToolDescriptor` 的空转。不影响功能但可简化。

**修正**：改为 `const toolDescriptors: ToolDescriptor[] = registry.list()`。保留显式类型注解以自我文档化，去掉冗余 cast。

✅ **已修复**：`engine/index.ts:97` 的 `as unknown as ToolDescriptor[]` 替换为 `: ToolDescriptor[]` 显式类型注解。

---

### S-3. `globToRegex` 对单字符调用 `replace` — 用 O(1) map 替代

**文件**：`packages/permission/src/glob.ts:28`

```typescript
regexStr += ch.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&")
```

`ch` 是单字符，正则 replace 是 O(字符类大小) 而非 O(1)。可改为 Set lookup + 手写转义。TG0 不改——权限规则数 ≤ 100，性能无关紧要。TG1 保留或替换为 micromatch。

✅ **已修复（注释）**：`glob.ts:27-29` 添加 TG0 性能说明注释（O(n·k) 可接受，TG1 可选优化）。

---

### S-4. `PermissionEngine.evaluate()` 中 denylist/allowlist 的 `matchRisk` 调用点未传工具描述符

**文件**：`packages/permission/src/engine.ts:162,174`

```typescript
// denylist:
if (!this.matchRisk(rule, null)) continue   // ← 传 null

// allowlist:
if (!this.matchRisk(rule, null)) continue   // ← 传 null
```

Denylist/allowlist 匹配时 `toolDesc` 是已知的（在函数作用域内定义于行 184），但被传为 `null`。可以改为：
```typescript
if (!this.matchRisk(rule, toolDesc?.risk ?? null, "denylist")) continue
```
效果：denylist 规则在工具已注册时用真实 risk 值匹配。配合 I-2 的 `context` 参数修复，未注册时才用保守假设。

**修正**：I-2 修复中包含此改动——denylist/allowlist 调用点改为传 `toolDesc?.risk ?? null` + context 参数。

✅ **已修复**：随 I-2 一同完成。Denylist/allowlist 调用点现在传 `toolDesc?.risk ?? null`（`toolDesc` 已提前到 Step 1 前定义）。

---

## §四 6 个风险点验证

| 风险 | 描述 | 审查结论 |
|------|------|---------|
| R1 | @resource 伪匹配 | ✅ 已有标注。审查 I-3 提议加强 regex |
| R2 | glob 仅支持 `*` | ✅ TG0 限制已标注。TG1 引入 micromatch |
| R3 | boundary + built-in risk 交互 | ✅ 审查 I-5 分析。语义正确，注释即可 |
| R4 | turn scope 重置时机 | ❌ **存在 bug** → 审查 I-1 |
| R5 | 工具描述符快照不同步 | ✅ 已有 registerTool/unregisterTool |
| R6 | nonInteractiveDefault 断言 | ✅ `as "allow" \| "deny"` 安全 |

---

## 汇总

| 严重度 | 数量 | 核心问题 |
|--------|------|---------|
| 🔴 致命 | 0 | — |
| 🟡 重要 | 5 | turn scope 不复位、matchRisk null→medium 软化 denylist、regex 误匹配、mode 不校验、boundary 语义不透明 |
| 🟢 建议 | 4 | IPermissionEngine 缺 resetScope、多余 round-trip cast、globToRegex 复杂度、denylist matchRisk 不用已知 toolDesc |

**Permission 模块评价**：TG0 8 步中实现质量最高的一步。匹配算法与 API §8.4 完全对应，依赖反转干净，config.ts duck-typing 已消失。仅 I-1（turn scope reset）是实际 bug——其余 4 条重要问题在当前 TG0 场景下均有缓解但代码路径需要加固。
