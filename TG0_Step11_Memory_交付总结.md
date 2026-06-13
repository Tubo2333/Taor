# TG0 Step 11 — @harness/memory 交付总结

> **完成时间**：2026-06-12
> **审查状态**：⏳ 待交叉审查
> **上一步**：Step 10 @harness/subagent（含 12 条审查修复）
> **下一步**：Step 12 @harness/compressor

---

## 一、做了什么

实现了 `@harness/memory` 包 — 三层记忆系统（user → project → session），3 种后端（InMemory/Json/Sqlite），集成到 harness.ts 的 `harness.memory` 访问器。

### 文件清单

```
packages/memory/src/
├── types.ts         [不变 35行]   MemoryStore/MemoryConfig/MemoryEntry
├── store.ts         [重写 204行]  InMemoryStore + JsonStore + SqliteStore
├── facade.ts        [重写 53行]   MemoryFacade (3层 store 构造)
└── index.ts         [不变 4行]    公共 API 导出

packages/core/src/
└── harness.ts       [修改 +50行]  IMemoryFacade 结构接口 + setMemory() + getter

packages/engine/src/
└── index.ts         [修改 +15行]  createHarness() 创建 + 注入 MemoryFacade
```

**净增代码**：~270 行 TypeScript。

---

## 二、核心设计

### 2.1 三层记忆

| 层 | 用途 | 生命周期 | 默认后端 |
|------|------|---------|---------|
| `user` | 跨 session 用户偏好 | 进程/文件持久化 | InMemoryStore |
| `project` | 项目知识 | 进程/文件持久化 | InMemoryStore |
| `session` | Session 内临时数据 | Session 结束即销毁 | InMemoryStore |

### 2.2 3 种后端

| 后端 | 实现状态 | 说明 |
|------|---------|------|
| InMemoryStore | ✅ 完整 | TTL 过期、prefix/tags 过滤、limit/offset 分页 |
| JsonStore | ✅ 完整 | JSON 文件读写，每次 mutation 全量写盘，适合 ≤10k 条目 |
| SqliteStore | ⬜ TG0 stub | 委托 InMemoryStore，TG1 需 better-sqlite3 |

### 2.3 MemoryFacade 构造

```typescript
new MemoryFacade({
  user:    { backend: "json", path: "./data/memory/user.json" },
  project: { backend: "memory" },
  session: { backend: "memory" },
})
// → user: JsonStore, project: InMemoryStore, session: InMemoryStore
```

### 2.4 依赖反转

```
@harness/core (harness.ts)
  ├── IMemoryFacade   ← 结构接口（user/project/session 各含 6 个方法）
  ├── setMemory()     ← 注入方法
  └── memory getter   ← 返回注入的 facade

@harness/memory
  ├── MemoryFacade    ← 真实实现
  └── store.ts        ← 3 种后端

@harness/engine (index.ts)
  └── createHarness() ← 组装 + 注入
```

---

## 三、关键决策

| # | 决策 | 理由 |
|---|------|------|
| D-1 | SqliteStore TG0 stub → InMemoryStore | 避免引入 better-sqlite3 编译依赖，TG1 替换 |
| D-2 | JsonStore 每 mutation 全量写盘 | TG0 简单实现，≤10k 条目可接受。TG1 加增量写入或 LRU 缓存 |
| D-3 | `set()` 保留已有 metadata.type/createdAt | 更新语义：覆盖 value 和 tags/TTL，保留首次写入的 type 和时间 |
| D-4 | InMemoryStore `list()` 过滤已过期条目 | 保持与其他后端一致性，避免调用方感知过期数据 |

---

## 四、潜在风险点

### R1: JsonStore 全量写盘性能
每次 `set()`/`delete()` 触发 `writeFileSync`。1000 次 set → 1000 次磁盘写入。TG1 应加 debounce/batch write。

### R2: JsonStore 文件损坏恢复
`load()` 中 JSON.parse 失败 → 静默返回空 store。原有数据全部丢失，无任何日志。TG1 加 logger + backup。

### R3: `has()` 中 TTL 检查修改 store
`has()` 检测到过期 key 时调用 `delete()` → 触发 `save()`。只读操作触发写盘，不符合语义预期。

### R4: SqliteStore 完全无 SQLite 功能
继承 InMemoryStore 的所有行为，零持久化。`path` 参数被忽略，用户配置 `backend: "sqlite"` 但数据在进程重启后丢失。

### R5: MemoryFacade.createStore 不传 layer type
所有 entry 的 `metadata.type` 固定为 `"session"`，无法区分 user/project/session 层的数据来源。

---

## 五、验证状态

```
✅ npm run build       — 零错误
✅ npm run typecheck   — 零错误
⬜ 集成冒烟测试        — TG0 Step E
```

---

## 六、TG0 进度

```
1-11 ✅ (92%)
12   ⬜ @harness/compressor    ← 下一步（最后一步）
E    ⬜ @harness/engine (冒烟测试)
```
