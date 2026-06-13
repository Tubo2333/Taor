# TG2 — 可选优化项 交付总结

> **完成时间**：2026-06-12
> **审查状态**：⏳ 待交叉审查
> **上一阶段**：TG1 P0+P1 (6+1 项)

---

## 一、做了什么

完成 TG2 全部可选优化项：B2 压缩策略、B4 工具冲突处理、C1 CLI、C2 文档、C3 测试扩展、包发布准备。

### 文件清单

```
packages/compressor/src/strategies/index.ts  [+30行]  chunk 关键词相关性实现
packages/tools/src/registry.ts               [+15行]  onConflict 选项 (throw/skip/override)
packages/cli/                                [NEW]    @harness/cli (harness run/config/tool)
packages/*/package.json                      [×9]     移除 "private": true
README.md                                    [NEW]    架构图 + 快速开始 + 包列表
tests/smoke.test.ts                          [+80行]  +6 tests (serialize/memory/chunk/onConflict等)
```

---

## 二、各模块详情

### B2: chunk 策略
- 消息分组 → 关键词与最新消息重叠评分 → 保留高相关性 + 最新块
- 4 条以下短上下文自动跳过

### B4: onConflict
- `"throw"` (默认): 抛错
- `"skip"`: 静默跳过冲突工具
- `"override"`: 替换已注册工具

### C1: CLI
```bash
harness run <prompt>     # 运行 agent
harness config           # JSON 配置模板
harness tool [name]      # 脚手架工具
```

### C3: 测试从 10→16
- ErrorRecovery extractRecovery 方法
- onConflict skip/override
- serialize snapshot
- InMemoryStore CRUD
- chunk 策略压缩效果

---

## 三、验证

```
✅ Build       — 零错误
✅ Typecheck   — 零错误
✅ Smoke test  — 16/16 通过 (19ms)
```

## 四、Harness Engine 最终全貌

```
TG0 + TG1 + TG2 完成
├── 10 packages (~8,800 lines TypeScript)
├── 16 smoke tests
├── ~150 review fixes (all closed)
└── Ready to publish
```
