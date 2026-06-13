# Memory API Reference

> 3-layer memory (user/project/session) with InMemory, JSON, and SQLite backends.

## Access

```typescript
// Via harness instance
await harness.memory.user.set("preference", { theme: "dark" })
const pref = await harness.memory.user.get("preference")

await harness.memory.project.set("config", { maxTurns: 50 })
await harness.memory.session.set("temp", "ephemeral data", { ttl: 300_000 })
```

---

## Configuration

```typescript
const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [],
  memory: {
    user: { backend: "sqlite", path: "./data/memory/user.sqlite", defaultTtl: 86400_000 },
    project: { backend: "json", path: "./data/memory/project.json" },
    session: { backend: "memory" },
  },
})
```

---

## Backend Types

| Backend | Persistence | Max Size | Use Case |
|---------|-------------|----------|----------|
| `"memory"` | None (ephemeral) | RAM-limited | Session data, caches |
| `"json"` | File-backed | ≤10k entries | Project config, preferences |
| `"sqlite"` | SQLite-backed | Unlimited | Large data, cross-session |

---

## `MemoryStore` Interface

```typescript
interface MemoryStore {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T, opts?: {
    ttl?: number      // Time-to-live in ms
    tags?: string[]   // Searchable tags
  }): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>
  list(opts?: {
    prefix?: string   // Key prefix filter
    tags?: string[]   // Tag filter
    limit?: number    // Pagination limit
    offset?: number   // Pagination offset
  }): Promise<MemoryEntry[]>
  clear(): Promise<void>
}
```

---

## TTL (Time-to-Live)

- Set per-entry via `opts.ttl` (milliseconds)
- Falls back to store-level `defaultTtl`
- SqliteStore: periodic cleanup every 120s
- JsonStore/InMemoryStore: cleanup on `get()`, `has()`, and `list()`

---

## `backendType` Getter

```typescript
const types = harness.memory.backendType
// { user: "sqlite", project: "json", session: "inmemory" }
```

---

## `MemoryEntry` Type

```typescript
interface MemoryEntry {
  key: string
  value: unknown
  metadata: {
    type: "user" | "project" | "session"
    createdAt: number
    updatedAt: number
    expiresAt?: number
    tags: string[]
  }
}
```
