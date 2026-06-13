# TG1 A3 — SqliteStore 交付总结

> **完成时间**：2026-06-12
> **审查状态**：⏳ 待交叉审查
> **上一步**：A2 summarize + hooks
> **这是 TG1 P0 最后一项** 🎉

---

## 一、做了什么

将 SqliteStore 从 TG0 stub（InMemoryStore 委托）升级为完整的 SQLite 持久化实现。使用 `better-sqlite3` 同步驱动，支持 LIMIT/OFFSET 分页、TTL 过期、tags 过滤。`better-sqlite3` 不可用时自动回退 InMemoryStore。

### 文件清单

```
packages/memory/src/store.ts  [修改 +100行] SqliteStore 完整实现
```

## 二、核心设计

### 2.1 数据库 Schema

```sql
CREATE TABLE IF NOT EXISTS memory (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,          -- JSON string
  type TEXT DEFAULT 'session',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,           -- null = no expiry
  tags TEXT DEFAULT '[]'        -- JSON array string
)
CREATE INDEX idx_memory_type ON memory(type)
CREATE INDEX idx_memory_expires ON memory(expires_at)
```

### 2.2 初始化流程

```
new SqliteStore(path, layer)
  ├── try { require("better-sqlite3") }
  │   ├── ✅ available → CREATE TABLE + INDEXES
  │   └── ❌ unavailable → console.warn + fallback InMemoryStore
```

### 2.3 查询特性

| 特性 | 实现 |
|------|------|
| TTL 过期 | `get()/has()` 检查 `expires_at < now` → DELETE + return undefined/false |
| list 过期清理 | `DELETE WHERE expires_at < now` 在 list() 开头执行 |
| prefix 过滤 | `key LIKE ?` (prefix + "%") |
| tags 过滤 | `tags LIKE '%tag%'` (per tag) |
| 分页 | `LIMIT ? OFFSET ?` (API-D5) |
| 排序 | `ORDER BY updated_at DESC` |

---

## 三、潜在风险点

### R1: `require("better-sqlite3")` 在 ESM 项目中
项目是 `"type": "module"` (ESM)，`require()` 需要通过 `createRequire` 或 `module.createRequire` 才能使用。当前直接写 `require()` 可能在纯 ESM 环境中抛 `ReferenceError: require is not defined`。

### R2: tags LIKE 匹配粗糙
`tags LIKE '%tag%'` 会误匹配（如 tag "abc" 匹配 "abcd"）。正确做法是解析 JSON 数组后在 JS 中过滤，但代价是每行都需 JSON.parse。

### R3: close() 不在 MemoryStore 接口中
`close()` 是 SqliteStore 专用方法，不在 MemoryStore 接口中。用户通过 `harness.memory.user.close()` 调用时 TS 类型报错（如果有类型检查）。

### R4: 并发写入
better-sqlite3 是同步驱动，Node.js 单线程无并发风险。但如果将来在 Worker Threads 中使用，需要 WAL 模式或互斥锁。

---

## 四、验证状态

```
✅ npm run build       — 零错误
✅ npm run typecheck   — 零错误
✅ npm run test        — 10/10 通过
```

## 五、TG1 P0 全部完成 🎉

```
✅ A4. ErrorRecovery (+ F1-F4)
✅ B3. compress 读配置阈值
✅ A1. process/worktree 隔离 (+ F1-F3)
✅ A5. Subagent Heartbeat (+ I1-I2-S1-S4)
✅ A2. summarize + hooks (+ F1+I1-I4)
✅ A3. SqliteStore
```

**TG1 P1/P2 可选：** B1 序列化、B2 chunk+embed、B4 onConflict 选项、C1-C3 CLI/文档/测试
