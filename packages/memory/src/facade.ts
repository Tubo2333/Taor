// @harness/memory — MemoryFacade (harness.memory)

import type { MemoryConfig, MemoryStore, MemoryStoreConfig } from "./types.js"
import { InMemoryStore, JsonStore, SqliteStore } from "./store.js"

// ═══════════════════════════════════════════════════════════════════
// ─── Defaults ───
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_STORE_CONFIG: MemoryStoreConfig = {
  backend: "memory",
}

// ═══════════════════════════════════════════════════════════════════
// ─── MemoryFacade ───
// ═══════════════════════════════════════════════════════════════════

/**
 * MemoryFacade — three-layer memory (user → project → session).
 *
 * Exposed as `harness.memory`:
 * - `harness.memory.user` — cross-session user preferences
 * - `harness.memory.project` — per-project knowledge
 * - `harness.memory.session` — ephemeral session-only data
 *
 * Each layer is a MemoryStore. Backend is determined by MemoryConfig:
 * - `"memory"` → InMemoryStore (default, ephemeral)
 * - `"json"` → JsonStore (file-backed, persistent)
 * - `"sqlite"` → SqliteStore (TG0 stub, falls back to InMemoryStore)
 */
export class MemoryFacade {
  readonly user: MemoryStore
  readonly project: MemoryStore
  readonly session: MemoryStore

  /** Runtime backend type for each memory layer. */
  get backendType(): { user: string; project: string; session: string } {
    const detect = (s: MemoryStore): string => {
      if (s instanceof SqliteStore) return "sqlite"
      if (s instanceof JsonStore) return "json"
      return "inmemory"
    }
    return {
      user: detect(this.user),
      project: detect(this.project),
      session: detect(this.session),
    }
  }

  constructor(config: Partial<MemoryConfig> = {}) {
    this.user = this.createStore(config.user ?? DEFAULT_STORE_CONFIG, "user")
    this.project = this.createStore(config.project ?? DEFAULT_STORE_CONFIG, "project")
    this.session = this.createStore(config.session ?? DEFAULT_STORE_CONFIG, "session")
  }

  private createStore(
    cfg: MemoryStoreConfig,
    layer: "user" | "project" | "session",
  ): MemoryStore {
    const defaultTtl = cfg.defaultTtl
    switch (cfg.backend) {
      case "json":
        return new JsonStore(
          cfg.path ?? `./data/memory/${layer}.json`,
          layer,
          defaultTtl,
        )
      case "sqlite":
        return new SqliteStore(
          cfg.path ?? `./data/memory/${layer}.sqlite`,
          layer,
          defaultTtl,
        )
      case "memory":
      default:
        return new InMemoryStore(layer, defaultTtl)
    }
  }
}
