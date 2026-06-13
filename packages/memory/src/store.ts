// @harness/memory — MemoryStore implementations (SQLite, JSON file, in-memory)

import { createRequire } from "node:module"
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs"
import { dirname } from "node:path"
import type { MemoryStore, MemoryEntry } from "./types.js"

// ═══════════════════════════════════════════════════════════════════
// ─── InMemoryStore ───
// ═══════════════════════════════════════════════════════════════════

export class InMemoryStore implements MemoryStore {
  private data = new Map<string, { value: unknown; metadata: MemoryEntry["metadata"] }>()
  private layer: "user" | "project" | "session"
  private defaultTtl: number | undefined

  constructor(layer: "user" | "project" | "session" = "session", defaultTtl?: number) {
    this.layer = layer
    this.defaultTtl = defaultTtl
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.data.get(key)
    if (!entry) return undefined
    if (entry.metadata.expiresAt && entry.metadata.expiresAt < Date.now()) {
      this.data.delete(key)
      return undefined
    }
    return entry.value as T
  }

  async set<T>(key: string, value: T, opts?: { ttl?: number; tags?: string[] }): Promise<void> {
    const now = Date.now()
    const existing = this.data.get(key)
    this.data.set(key, {
      value,
      metadata: {
        type: existing?.metadata.type ?? this.layer,
        createdAt: existing?.metadata.createdAt ?? now,
        updatedAt: now,
        expiresAt:
          opts?.ttl !== undefined ? now + opts.ttl :
          existing?.metadata.expiresAt ??
            (this.defaultTtl !== undefined ? now + this.defaultTtl : undefined),
        tags: opts?.tags ?? existing?.metadata.tags ?? [],
      },
    })
  }

  async delete(key: string): Promise<void> { this.data.delete(key) }
  async has(key: string): Promise<boolean> {
    const entry = this.data.get(key)
    if (!entry) return false
    if (entry.metadata.expiresAt && entry.metadata.expiresAt < Date.now()) {
      this.data.delete(key)
      return false
    }
    return true
  }

  async list(opts?: { prefix?: string; tags?: string[]; limit?: number; offset?: number }): Promise<MemoryEntry[]> {
    const now = Date.now()
    // S-1: Clean up expired entries during list() to prevent memory leak
    const expired: string[] = []
    for (const [key, entry] of this.data) {
      if (entry.metadata.expiresAt && entry.metadata.expiresAt < now) {
        expired.push(key)
      }
    }
    for (const key of expired) this.data.delete(key)

    let entries = [...this.data.entries()]
      .filter(([k]) => !opts?.prefix || k.startsWith(opts.prefix))
      .map(([key, entry]) => ({ key, value: entry.value, metadata: entry.metadata }))
    if (opts?.tags?.length) entries = entries.filter(e => opts.tags!.some(t => e.metadata.tags.includes(t)))
    const offset = opts?.offset ?? 0
    const limit = opts?.limit
    return entries.slice(offset, limit ? offset + limit : undefined)
  }

  async clear(): Promise<void> { this.data.clear() }
}

// ═══════════════════════════════════════════════════════════════════
// ─── JsonStore ───
// ═══════════════════════════════════════════════════════════════════

interface JsonFileEntry {
  key: string
  value: unknown
  metadata: MemoryEntry["metadata"]
}

/**
 * JSON file-backed store.
 *
 * Uses a dirty flag to batch writes — `set()`/`delete()`/`clear()` mark
 * dirty; `flush()` performs a single `writeFileSync`. TG1: add debounce timer
 * for automatic background flushing.
 *
 * Suitable for small-to-medium datasets (≤10k entries). For larger
 * datasets, use SqliteStore.
 */
export class JsonStore implements MemoryStore {
  private path: string
  private data = new Map<string, { value: unknown; metadata: MemoryEntry["metadata"] }>()
  private layer: "user" | "project" | "session"
  private defaultTtl: number | undefined
  private dirty = false
  private dirCreated = false
  private flushOnExit!: () => void

  constructor(path: string, layer: "user" | "project" | "session" = "session", defaultTtl?: number) {
    this.path = path
    this.layer = layer
    this.defaultTtl = defaultTtl
    this.load()

    // I-11: Auto-flush dirty data on process exit to prevent data loss.
    // process.on("exit") only supports synchronous operations, and save()
    // uses writeFileSync, so this is safe.
    this.flushOnExit = () => {
      if (this.dirty) this.save()
    }
    process.on("exit", this.flushOnExit)
  }

  /** Remove process exit listeners. Call before explicit dispose. */
  dispose(): void {
    process.removeListener("exit", this.flushOnExit)
  }

  // ═══════════════════════════════════════════════════════════════
  // ── Public API ──
  // ═══════════════════════════════════════════════════════════════

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.data.get(key)
    if (!entry) return undefined
    if (entry.metadata.expiresAt && entry.metadata.expiresAt < Date.now()) {
      this.data.delete(key)
      this.dirty = true  // I-1: mark dirty, don't save immediately
      return undefined
    }
    return entry.value as T
  }

  async set<T>(key: string, value: T, opts?: { ttl?: number; tags?: string[] }): Promise<void> {
    const now = Date.now()
    const existing = this.data.get(key)
    this.data.set(key, {
      value,
      metadata: {
        type: existing?.metadata.type ?? this.layer,
        createdAt: existing?.metadata.createdAt ?? now,
        updatedAt: now,
        expiresAt:
          opts?.ttl !== undefined ? now + opts.ttl :
          existing?.metadata.expiresAt ??
            (this.defaultTtl !== undefined ? now + this.defaultTtl : undefined),
        tags: opts?.tags ?? existing?.metadata.tags ?? [],
      },
    })
    this.dirty = true
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key)
    this.dirty = true
  }

  async has(key: string): Promise<boolean> {
    const entry = this.data.get(key)
    if (!entry) return false
    if (entry.metadata.expiresAt && entry.metadata.expiresAt < Date.now()) {
      this.data.delete(key)
      this.dirty = true  // I-1: mark dirty, don't save immediately
      return false
    }
    return true
  }

  async list(opts?: { prefix?: string; tags?: string[]; limit?: number; offset?: number }): Promise<MemoryEntry[]> {
    const now = Date.now()
    // Clean up expired entries during list()
    const expired: string[] = []
    for (const [key, entry] of this.data) {
      if (entry.metadata.expiresAt && entry.metadata.expiresAt < now) {
        expired.push(key)
      }
    }
    if (expired.length > 0) {
      for (const key of expired) this.data.delete(key)
      this.dirty = true
    }

    let entries = [...this.data.entries()]
      .filter(([k]) => !opts?.prefix || k.startsWith(opts.prefix))
      .map(([key, entry]) => ({ key, value: entry.value, metadata: entry.metadata }))
    if (opts?.tags?.length) entries = entries.filter(e => opts.tags!.some(t => e.metadata.tags.includes(t)))
    const offset = opts?.offset ?? 0
    const limit = opts?.limit
    return entries.slice(offset, limit ? offset + limit : undefined)
  }

  async clear(): Promise<void> {
    this.data.clear()
    this.dirty = true
  }

  /**
   * Persist dirty state to disk. Call at session end or before process exit.
   * TG0: no-op if not dirty. TG1: add debounce timer for automatic flush.
   */
  async flush(): Promise<void> {
    if (!this.dirty) return
    this.save()
    this.dirty = false
  }

  // ═══════════════════════════════════════════════════════════════
  // ── File I/O ──
  // ═══════════════════════════════════════════════════════════════

  private load(): void {
    try {
      if (!existsSync(this.path)) return
      const raw = readFileSync(this.path, "utf-8")
      const entries: JsonFileEntry[] = JSON.parse(raw)
      for (const { key, value, metadata } of entries) {
        this.data.set(key, { value, metadata })
      }
    } catch (err) {
      // I-2: Log corruption and backup the original file before overwriting
      const msg = err instanceof Error ? err.message : String(err)
      console.error(
        `[JsonStore] Failed to load ${this.path}: ${msg}. ` +
          `Starting with empty store.`,
      )
      try {
        if (existsSync(this.path)) {
          renameSync(this.path, this.path + ".bak")
        }
      } catch {
        // Backup failed — original file may not exist or permission denied
      }
    }
  }

  private save(): void {
    try {
      // S-4: Only check/create directory once
      if (!this.dirCreated) {
        const dir = dirname(this.path)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        this.dirCreated = true
      }
      const entries: JsonFileEntry[] = [...this.data.entries()].map(
        ([key, { value, metadata }]) => ({ key, value, metadata }),
      )
      writeFileSync(this.path, JSON.stringify(entries, null, 2), "utf-8")
    } catch (err) {
      // I-4: At minimum, log the failure so operators know data is at risk
      const msg = err instanceof Error ? err.message : String(err)
      console.error(
        `[JsonStore] Failed to write ${this.path}: ${msg}. ` +
          `Memory and disk may be out of sync.`,
      )
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// ─── SqliteStore ───
// ═══════════════════════════════════════════════════════════════════

interface SqliteDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number }
    get(...params: unknown[]): Row | undefined
    all(...params: unknown[]): Row[]
  }
  exec(sql: string): void
  close(): void
}

interface Row {
  key: string
  value: string
  type: string
  created_at: number
  updated_at: number
  expires_at: number | null
  tags: string
}

/**
 * SQLite-backed persistent store.
 *
 * Uses better-sqlite3 for synchronous SQLite access. Falls back to
 * InMemoryStore if better-sqlite3 is not installed. Supports LIMIT/OFFSET
 * pagination (API-D5) and TTL-based expiration.
 */
export class SqliteStore implements MemoryStore {
  private db: SqliteDatabase | null = null
  private fallback: InMemoryStore | null = null
  private layer: "user" | "project" | "session"
  private defaultTtl: number | undefined
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(path: string, layer: "user" | "project" | "session" = "session", defaultTtl?: number) {
    this.layer = layer
    this.defaultTtl = defaultTtl

    try {
      // Dynamic require — better-sqlite3 is an optional dependency
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      // F-1: Use createRequire for ESM compatibility
      const _require = createRequire(import.meta.url)
      const Database = _require("better-sqlite3") as new (p: string) => SqliteDatabase
      this.db = new Database(path)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'session',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER,
          tags TEXT NOT NULL DEFAULT '[]'
        )
      `)
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type)`)
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_expires ON memory(expires_at)`)

      // Periodic cleanup: every 120s, remove expired entries
      this._cleanupTimer = setInterval(() => {
        try {
          this.db?.prepare("DELETE FROM memory WHERE expires_at IS NOT NULL AND expires_at < ?").run(Date.now())
        } catch { /* best-effort */ }
      }, 120_000)
      this._cleanupTimer.unref()
    } catch (err) {
      console.error(
        `[SqliteStore] better-sqlite3 not available for "${path}". ` +
        `Falling back to in-memory storage — data will NOT persist across restarts. ` +
        `To fix: npm install better-sqlite3. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`
      )
      this.fallback = new InMemoryStore(layer)
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (this.fallback) return this.fallback.get<T>(key)
    const row = this.db!.prepare("SELECT value, expires_at FROM memory WHERE key = ?").get(key)
    if (!row) return undefined
    if (row.expires_at && row.expires_at < Date.now()) {
      this.db!.prepare("DELETE FROM memory WHERE key = ?").run(key)
      return undefined
    }
    return JSON.parse(row.value) as T
  }

  async set<T>(key: string, value: T, opts?: { ttl?: number; tags?: string[] }): Promise<void> {
    if (this.fallback) return this.fallback.set(key, value, opts)
    const now = Date.now()
    const existing = this.db!.prepare("SELECT created_at, expires_at, tags FROM memory WHERE key = ?").get(key) as Row | undefined
    const tags = JSON.stringify(opts?.tags ?? (existing ? JSON.parse(existing.tags) as string[] : []))
    // I-2: defaultTtl fallback chain: opts.ttl → existing.expiresAt → constructor defaultTtl → null
    const expiresAt = opts?.ttl !== undefined ? now + opts.ttl
      : existing?.expires_at
      ?? (this.defaultTtl !== undefined ? now + this.defaultTtl : null)
    this.db!.prepare(`
      INSERT OR REPLACE INTO memory (key, value, type, created_at, updated_at, expires_at, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      key,
      JSON.stringify(value),
      this.layer,
      existing?.created_at ?? now,
      now,
      expiresAt,
      tags,
    )
  }

  async delete(key: string): Promise<void> {
    if (this.fallback) return this.fallback.delete(key)
    this.db!.prepare("DELETE FROM memory WHERE key = ?").run(key)
  }

  async has(key: string): Promise<boolean> {
    if (this.fallback) return this.fallback.has(key)
    const row = this.db!.prepare("SELECT expires_at FROM memory WHERE key = ?").get(key) as Row | undefined
    if (!row) return false
    if (row.expires_at && row.expires_at < Date.now()) {
      this.db!.prepare("DELETE FROM memory WHERE key = ?").run(key)
      return false
    }
    return true
  }

  // I-3: throttle cleanup to at most once per 60s
  private _lastCleanup = 0

  async list(opts?: { prefix?: string; tags?: string[]; limit?: number; offset?: number }): Promise<MemoryEntry[]> {
    if (this.fallback) return this.fallback.list(opts)

    // I-3: Clean up expired entries with 60s throttle
    const now = Date.now()
    if (now - this._lastCleanup > 60_000) {
      this.db!.prepare("DELETE FROM memory WHERE expires_at IS NOT NULL AND expires_at < ?").run(now)
      this._lastCleanup = now
    }

    let sql = "SELECT key, value, type, created_at, updated_at, expires_at, tags FROM memory WHERE 1=1"
    const params: unknown[] = []

    if (opts?.prefix) {
      sql += " AND key LIKE ?"
      params.push(opts.prefix + "%")
    }
    if (opts?.tags?.length) {
      // I-1: Use JSON-quoted exact match to avoid substring collisions
      for (const tag of opts.tags) {
        sql += " AND tags LIKE ?"
        params.push(`%"${tag}"%`)
      }
    }
    sql += " ORDER BY updated_at DESC"

    // API-D5: LIMIT/OFFSET pagination
    if (opts?.limit !== undefined) {
      sql += " LIMIT ?"
      params.push(opts.limit)
    }
    if (opts?.offset !== undefined) {
      sql += " OFFSET ?"
      params.push(opts.offset)
    }

    const rows = this.db!.prepare(sql).all(...params) as Row[]
    return rows.map((row) => ({
      key: row.key,
      value: JSON.parse(row.value),
      metadata: {
        type: row.type as "user" | "project" | "session",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at ?? undefined,
        tags: JSON.parse(row.tags) as string[],
      },
    }))
  }

  async clear(): Promise<void> {
    if (this.fallback) return this.fallback.clear()
    this.db!.prepare("DELETE FROM memory").run()
  }

  /** Close the database connection. Call before process exit. */
  close(): void {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer)
      this._cleanupTimer = null
    }
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}
