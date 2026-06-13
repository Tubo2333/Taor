// @taor/memory — type definitions

export interface MemoryStoreConfig {
  backend: "sqlite" | "json" | "memory"
  path?: string
  defaultTtl?: number
  maxEntries?: number
}

export interface MemoryConfig {
  user: MemoryStoreConfig
  project: MemoryStoreConfig
  session: MemoryStoreConfig
}

export interface MemoryEntry {
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

export interface MemoryStore {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T, opts?: { ttl?: number; tags?: string[] }): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>
  list(opts?: { prefix?: string; tags?: string[]; limit?: number; offset?: number }): Promise<MemoryEntry[]>
  clear(): Promise<void>
  close?(): void
}
