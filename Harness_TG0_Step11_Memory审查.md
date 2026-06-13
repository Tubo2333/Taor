# Taor — TG0 Step 11 @taor/memory Adversarial Review

> **审查人视角**：独立架构审计师。审查 3 种 store 后端 + MemoryFacade + harness.ts/engine 集成。
> **审查日期**：2026-06-12
> **审查范围**：`store.ts` (204行) + `facade.ts` (53行) + `types.ts` (35行) + harness.ts IMemoryFacade + engine/index.ts 注入
> **前序**：96 条已闭环。本审查不重复。

---

## 🔴 致命

无。三个后端逻辑正确，TTL 过期语义一致，facade 构造干净。

---

## 🟡 重要

### I-1. JsonStore `has()` 触发 `save()` — 只读操作副作用写盘

**文件**：`packages/memory/src/store.ts:123-132`

```typescript
async has(key: string): Promise<boolean> {
    const entry = this.data.get(key)
    if (!entry) return false
    if (entry.metadata.expiresAt && entry.metadata.expiresAt < Date.now()) {
        this.data.delete(key)
        this.save()    // ← 只读操作触发同步 writeFileSync，阻塞 event loop
        return false
    }
    return true
}
```

循环中 `has()` 检查 1000 个 key → 50 个过期 → 50 次 `writeFileSync`。交付总结 R3 已标记。

对比 InMemoryStore：同样 delete 路径但仅在内存操作，无 I/O。JsonStore 因持久化将只读操作变成了写操作。

**修正**（TG0 最小改动）：`has()` 和 `get()` 中删除过期 key 后不立即 `save()`——标记 `private dirty = true`。新增 `flush()` 方法在 session 结束时执行单次 `save()`。

✅ **已修复**：`store.ts` JsonStore 引入 `dirty` flag。`get()`/`has()` 只设置 `dirty = true`，不调 `save()`。`set()`/`delete()`/`clear()` 标记 dirty。新增 `flush()` 方法仅在 dirty 时执行 `save()`。

---

### I-2. JsonStore `load()` 静默吞入损坏文件 — 全部数据丢失零告警

**文件**：`packages/memory/src/store.ts:153-163`

```typescript
private load(): void {
    try {
        if (!existsSync(this.path)) return
        const raw = readFileSync(this.path, "utf-8")
        const entries: JsonFileEntry[] = JSON.parse(raw)
        for (const { key, value, metadata } of entries) {
            this.data.set(key, { value, metadata })
        }
    } catch {
        // File corrupted or unreadable — start with empty store
        //  ← 零日志、零备份、零用户通知。下次 save() 覆盖原文件 → 数据永久丢失
    }
}
```

磁盘故障/手动编辑出错/JSON 格式损坏 → `catch {}` → 空 store → `set()` → 全量覆盖 → 原数据无法恢复。交付总结 R2 已标记。

**修正**：
1. `catch` 块中 `console.error(`[JsonStore] Failed to load ${this.path}, starting with empty store: ${err.message}`)`
2. TG0 额外：损坏前将原文件 rename 为 `.bak` 备份（`renameSync(this.path, this.path + ".bak")` 在 `catch` 中），至少保留原始数据供手动恢复

✅ **已修复**：`store.ts:229-245` — `load()` catch 块新增 `console.error` 输出路径和错误信息，损坏前 `renameSync(this.path, this.path + ".bak")` 备份原文件。

---

### I-3. 所有新建 entry 的 `metadata.type` 固定为 `"session"` — 三层数据不可区分

**文件**：`packages/memory/src/store.ts:30`（InMemoryStore）、`:108`（JsonStore）

```typescript
// InMemoryStore.set() 和 JsonStore.set() — 新建 entry 时:
type: existing?.metadata.type ?? "session",
```

`MemoryFacade.createStore()` 接收 `_layer: string` 参数（"user" / "project" / "session"），但**不传给 store 构造函数**。所有新建 entry 的 type 默认 `"session"`。用户调用 `harness.memory.user.list()` 返回的 entry 中 `metadata.type === "session"`——与 user 层语义矛盾。交付总结 R5 已标记。

**修正**：InMemoryStore 和 JsonStore 构造函数加 `layer?: "user" | "project" | "session"` 参数。`set()` 中 type 默认值改为 `layer ?? "session"`。`MemoryFacade.createStore()` 传 `_layer as "user" | "project" | "session"`。

✅ **已修复**：`store.ts` InMemoryStore/JsonStore 构造函数新增 `layer` 参数，`set()` 的新建 entry 的 `type` 使用 `this.layer`。`facade.ts:47-51` `createStore()` 传 `layer` 参数。

---

### I-4. JsonStore `save()` 写失败静默吞入 — 内存与磁盘数据背离

**文件**：`packages/memory/src/store.ts:166-178`

```typescript
private save(): void {
    try {
        // ...
        writeFileSync(this.path, JSON.stringify(entries, null, 2), "utf-8")
    } catch {
        // Write failure is non-fatal for TG0 — log would go through logger,
        // but JsonStore doesn't have one. TG1: inject logger.
    }
}
```

磁盘满/权限不足 → `writeFileSync` 抛异常 → 静默捕获。内存数据已更新，磁盘是旧版本。下次 `load()` 回退——用户感知为"数据随机消失"。注释说"JsonStore doesn't have logger"——正确，但应至少有 `console.error`。

**修正**：`catch (err)` 改为 `catch (err) { console.error(`[JsonStore] Failed to write ${this.path}: ${err instanceof Error ? err.message : String(err)}`) }`。

✅ **已修复**：`store.ts:252-255` — `save()` catch 块新增 `console.error` 输出路径和错误信息，提示内存与磁盘可能不同步。

---

### I-5. JsonStore 每次 mutation 全量 `writeFileSync` — 阻塞 event loop

**文件**：`packages/memory/src/store.ts:115, 120, 128, 148`

每条 `set()`/`delete()`/过期的 `has()`/`clear()` 都触发同步全量 `writeFileSync`。1000 次 set = 1000 次阻塞 I/O。交付总结 R1 已标记。

**修正**（TG0 最小改动与其 I-1 联动）：引入 `private dirty = false` 脏标记。`set()`/`delete()` 标记 `dirty = true`。加 `async flush(): Promise<void>` 方法，仅当 dirty 时执行 `save()` 并清除 dirty。

✅ **已修复**（与 I-1 联动）：`store.ts` JsonStore 引入 `dirty` flag + `flush()` 方法。`get()`/`has()` 只设 dirty，`set()`/`delete()`/`clear()` 设 dirty。`flush()` 仅当 dirty 时写盘。

---

## 🟢 建议优化

### S-1. `InMemoryStore.list()` 过期条目只过滤不删除 — 内存泄漏

**文件**：`packages/memory/src/store.ts:53`

```typescript
let entries = [...this.data.entries()]
    .filter(([, entry]) => !entry.metadata.expiresAt || entry.metadata.expiresAt >= now)
    // ← 隐藏但不删除。过期条目在 Map 中累积，永久泄漏
```

**修正**：`list()` 遍历时同步删除过期条目（`this.data.delete(key)`），与 `get()`/`has()` 行为统一。

✅ **已修复**：`store.ts:64-70` InMemoryStore 和 JsonStore 的 `list()` 在遍历时删除过期条目，防止内存泄漏。

---

### S-2. `MemoryStoreConfig.defaultTtl` 和 `maxEntries` 从未被读取

**文件**：`packages/memory/src/types.ts:6,8`

```typescript
export interface MemoryStoreConfig {
    backend: "sqlite" | "json" | "memory"
    path?: string
    defaultTtl?: number       // ← 零实现
    maxEntries?: number       // ← 零实现
}
```

用户配置 `defaultTtl: 3600` → 不生效，静默忽略。

**修正**：TG0——在 `set()` 方法中当 `opts?.ttl` 为 undefined 时 fallback 到 `this.defaultTtl`。构造时从 `MemoryStoreConfig` 传入。`maxEntries` 延后 TG1。

✅ **已修复**：`store.ts` InMemoryStore/JsonStore 构造函数新增 `defaultTtl` 参数。`set()` 中 `expiresAt` 计算链：`opts.ttl → existing.expiresAt → constructor defaultTtl → undefined`。`facade.ts` `createStore()` 传 `cfg.defaultTtl`。

---

### S-3. `SqliteStore` 构造时不发出任何 stub 状态警告

**文件**：`packages/memory/src/store.ts:194-196`

```typescript
constructor(_path: string) {
    this.fallback = new InMemoryStore()
    // 用户配置 backend: "sqlite" → 静默获得 in-memory，进程重启数据丢失
}
```

**修正**：构造时 `console.warn("[SqliteStore] TG0 stub — data is stored in-memory and will be lost on process restart. TG1 replaces with better-sqlite3.")`。

✅ **已修复**：`store.ts:273-276` — SqliteStore 构造函数新增 `console.warn` 警告 TG0 stub 行为。

---

### S-4. `JsonStore.save()` 每次写盘都 `existsSync(dir)` + `mkdirSync`

**文件**：`packages/memory/src/store.ts:168-169`

```typescript
const dir = dirname(this.path)
if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
```

目录在首次 save 后已存在。后续 999 次 save 做无意义的系统调用。

**修正**：加 `private dirCreated = false` flag，首次创建后设为 true，跳过后续检查。

✅ **已修复**：`store.ts:110` JsonStore 新增 `dirCreated` flag。`save():247-250` 仅在首次检查/创建目录，后续 `flush()` 跳过。

---

## §四 5 个风险点验证

| 风险 | 描述 | 审查结论 |
|------|------|---------|
| R1 | JsonStore 全量写盘性能 | ❌ **I-5** — 阻塞 event loop |
| R2 | JsonStore 文件损坏恢复 | ❌ **I-2** — 数据永久丢失零告警 |
| R3 | `has()` 中 TTL 检查修改 store | ❌ **I-1** — 只读操作触发写盘 |
| R4 | SqliteStore 零持久化 | ✅ **S-3** — TG0 stub，加警告 |
| R5 | metadata.type 固定 "session" | ❌ **I-3** — 三层数据不可区分 |

5 条风险 4 条落在代码中为实质问题。R4 是 TG0 设计决策。

---

## 质量排位（TG0 11 步）

| 排位 | Step | 模块 | 评分 | 短评 |
|------|------|------|------|------|
| 1 | 8 | @taor/permission | **A** | 最高质量 |
| 2 | 7 | TAOR 核心引擎 | **A-** | 并发路径稳固 |
| 3 | 9 | @taor/hooks | **B+** | 泛型优雅 |
| 4 | 5 | @taor/adapters | **A-** | 完整 650 行实现 |
| 5 | 6 | config.ts | **B+** | NaN 全覆盖 |
| **6** | **11** | **@taor/memory** | **B+** | 三层架构干净，TTL/logic 正确。JsonStore I/O 行为 (I-1/I-2/I-4/I-5) 是主要拖分项——逻辑无 bug 但在生产环境中会因磁盘故障静默丢数据。修完 4 条重要 + S-2(defaultTtl) 可升 A- |
| 7 | 4 | @taor/tools | **B+** | 11 条修复稳固 |
| 8 | 10 | @taor/subagent | **B** | 3 致命已修待验证 |

---

## 汇总

| 严重度 | 数量 | 核心问题 |
|--------|------|---------|
| 🔴 致命 | 0 | — |
| 🟡 重要 | 5 | has() 触发 save()、损坏文件静默丢失、type 固定 session、save() 写失败静默、每 mutation sync write |
| 🟢 建议 | 4 | list() 过期不清理、defaultTtl/maxEntries 未使用、SqliteStub 无警告、existsSync 重复检查 |
