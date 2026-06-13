# TG0 Step 8 — @taor/permission 交付总结

> **完成时间**：2026-06-12
> **审查状态**：⏳ 待独立审查
> **上一步**：Step 7 TAOR 循环（63 条审查闭环）
> **下一步**：Step 9 @taor/hooks

---

## 一、做了什么

实现了 `@taor/permission` 包 — Taor 的 4 级权限系统，并集成到 TAOR 核心循环的 ACT phase。

### 文件清单

```
packages/permission/src/
├── glob.ts          [NEW 43行]  简易 glob→RegExp（* 通配符），零外部依赖
├── resource.ts      [NEW 107行] @resource 注解提取 + allowlist/denylist 约束匹配
├── engine.ts        [NEW 439行] PermissionEngine 完整实现（匹配算法 + 规则管理 + 范围覆盖）
├── types.ts         [保持 35行]  PermissionLevel / PermissionRule / PermissionConfig / PermissionVerdict
└── index.ts         [更新 10行]  全量 API 导出

packages/core/src/
├── harness.ts       [修改 +70行] IPermissionEngine/IPermissionVerdict 结构接口 + setPermission() + ACT phase 集成
├── config.ts        [修改 -9/+7] 移除 duck-type cast，改用直接属性访问
└── unresolved.ts    [修改 +7行]  PermissionConfig 从 {} 升级为带字段的结构

packages/engine/src/
└── index.ts         [修改 +15行] createHarness() 创建 + 注入 PermissionEngine
```

**净增代码**：~680 行 TypeScript。**零新增外部依赖**。

---

## 二、核心设计

### 2.1 4 级权限模型

| 级别 | 行为 | 场景 |
|------|------|------|
| `deny` | 拒绝执行，不提示用户 | 危险命令、明确禁用的工具 |
| `boundary` | 工具触碰资源边界时询问（需 @resource 注解） | 限定目录的 WriteFile、限定域名的 WebFetch |
| `allow` | 直接执行，不询问 | 安全的只读工具 |
| `ask` | 总是询问用户 | 默认行为 |

### 2.2 匹配算法（API §8.4）

```
1. 范围覆盖检查：session/turn allowAll/denyAll → 立即 allow/deny
2. Denylist 优先：工具名 glob 匹配 → 命中即 DENY
3. Allowlist 次之：工具名 glob 匹配 → 命中即 ALLOW
4. Rules 顺序匹配（首条命中停止）：
   a. pattern glob 匹配工具名
   b. risk 过滤器（如设置）
   c. boundary 级别 → 提取 @resource 注解 → resourceConstraints 匹配
      - 工具无 @resource 注解 → 降级为 ask（无法强制执行边界）
      - 参数不是 string → deny
      - denylist/allowlist glob 匹配参数值
   d. 应用规则级别
5. 无规则命中 → defaultLevel
```

### 2.3 依赖反转

```
@taor/core (harness.ts)
  ├── IPermissionEngine    ← 结构接口（避免循环引用）
  ├── IPermissionVerdict   ← 结构接口
  └── setPermission()      ← 注入方法

@taor/permission (engine.ts)
  └── PermissionEngine     ← 真实实现（依赖 @taor/core + @taor/tools）

@taor/engine (index.ts)
  └── createHarness()      ← 组装层：创建 PermissionEngine → 注入 Harness
      as any 桥接结构接口 ↔ 真实类型（与 IAdapter/IToolRegistry 同模式）
```

### 2.4 ACT phase 双层权限

ACT phase 中权限检查分两层：

1. **PermissionEngine.evaluate()**（规则层）— 可 deny（阻断）/ allow（跳过审批）/ defer（继续到第二层）
2. **内置 risk + requiresApproval**（工具层）— 开发者直接控制的权限逻辑

两层并行存在：PermissionEngine 是「组织策略」，工具级 risk/requiresApproval 是「工具自我声明」。

---

## 三、关键决策

| # | 决策 | 理由 |
|---|------|------|
| D-1 | 结构接口 IPermissionEngine 而非 import | 避免 @taor/core → @taor/permission 循环引用（与 IAdapter/IToolRegistry 同模式） |
| D-2 | 双层权限（PermissionEngine → 内置 risk） | 组织策略和工具自我声明是正交维度，不应相互取代 |
| D-3 | 构造函数注入 ToolDescriptor[] | createHarness() 从 ToolRegistry.list() 同步，用于 @resource 注解查找 |
| D-4 | boundary 规则遇无 @resource 注解工具 → 降级 ask | 按 API §8.2 规范：无法强制执行边界时，宁可询问也不阻断 |
| D-5 | @resource 用 regex 解析 description（API-D8 TODO） | TG0 快速实现，TG1 迁移到 Zod annotations 或自定义 metadata 字段 |

---

## 四、潜在风险点（供审查）

### R1：@resource 伪匹配（API-D8）
当前通过 regex `/@resource:(fs-path|url|shell-command|env-var)/` 解析 `description` 字符串。如果用户写 `"The file path to the @resource:fs-path directory"` 会误触发。
**TG1 修复**：Zod `.annotations()` 或 JSONSchemaProperty 增加 `resourceType?: ResourceType` 字段。

### R2：glob 匹配仅支持 `*`
不支持 `?` `[...]` `{...}` `**`。当前工具名匹配场景足够（`Write*` / `*File` / `*`），但 allowlist/denylist 资源路径可能不够用（如 `src/**/*.ts`）。
**TG1 替代**：引入 `micromatch` 或 `picomatch`。

### R3：PermissionEngine 与 ACT phase 内置 check 的交互
如果 PermissionEngine 返回 `boundary` 且资源约束通过，用户看到的是「允许执行」——但内置 risk check 仍可能触发审批（如果 `risk === "high"` 或 `requiresApproval === true`）。这可能让用户困惑：资源约束通过了，为什么还要审批？
**缓解**：当前 `permVerdict.level === "allow"` 才跳过内置审批，`boundary` 不跳过。行为符合语义但可能非直觉。

### R4：turn scope override 重置时机
`resetScope()` 清除 turn 覆盖但 ACT phase 不会自动调用它。Turn 边界清理应该在 OBSERVE 阶段末尾。
**当前状态**：turn 覆盖需外部调用 `resetScope()`（或 `createHarness()` 层在 turn 结束时调用）。TG0 未自动化。

### R5：PermissionEngine 构造时工具描述符快照
`createHarness()` 在构造 PermissionEngine 时传入 `ToolDescriptor[]`。如果运行时通过 `ToolRegistry.register()` 添加新工具，PermissionEngine 的 `toolDescriptors` map 不会自动同步。
**缓解**：暴露了 `registerTool()` / `unregisterTool()` 方法，调用方需手动同步。

### R6：nonInteractiveDefault 类型断言
`engine.ts:95` 使用 `as "allow" | "deny"` 类型断言，因为 TS strict 模式在 Partial<> 下无法通过 `??` 或三元运算符推断 discriminated union 的消去。
**风险**：低 — 断言值与实际运行时值一致（`??` 保证）。

---

## 五、验证状态

```
✅ npm run build       — 零错误
✅ npm run typecheck   — 零错误
⬜ 集成冒烟测试        — TG0 Step E（engine 集成测试）
⬜ 单元测试            — 未纳入 TG0 范围
```

---

## 六、TG0 进度

```
1-3 ⬜✅ types → context → events     [类型层]
4   ✅ @taor/tools                  [工具系统]
5   ✅ @taor/adapters               [LLM适配器]
6   ✅ @taor/core/config.ts         [配置校验]
7   ✅ @taor/core/harness.ts        [TAOR 循环]
8   ✅ @taor/permission             [← 本次完成]
9   ⬜ @taor/hooks                  [下一步]
10  ⬜ @taor/subagent
11  ⬜ @taor/memory
12  ⬜ @taor/compressor
E   ⬜ @taor/engine (冒烟测试)
```

完成度：7/12 → **8/12（67%）**

---

## 七、审查指南

如果你要在新窗口中审查此工作，建议关注以下维度：

1. **类型安全**：`as any` 桥接（harness.ts L89, engine/index.ts L89/94/99）是否所有结构接口与真实类型兼容？
2. **匹配算法正确性**：denylist→allowlist→rules→default 顺序是否与 API §8.4 逐条对应？
3. **边界情况**：工具未注册、参数非 string、空 allowlist/denylist、同时 allowAll+denyAll 的处理
4. **并发安全**：`addRule()` / `evaluate()` 是否可能竞态？TAOR 循环在单线程 async 中运行，规则管理来自同步的 harness.next() 注入 —— TG0 无并发风险但需标注
5. **资源约束语义**：boundary 降级 ask vs 直接 deny 的选择是否符合产品预期？
