# Circuit Breaker API Reference

> `CircuitBreakerAdapter` — decorator wrapping `LLMAdapter` with 3-state circuit breaker.
> Protects against cascading failures during LLM provider outages.

## Quick Start

```typescript
import { createHarness } from "@taor/engine"

// Auto-wrap via createHarness (recommended):
const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [],
  circuitBreaker: { failureThreshold: 5 },
})
```

## States

```
CLOSED ──[N failures in window]──→ OPEN
OPEN   ──[recoveryTimeout]───────→ HALF_OPEN
HALF_OPEN ──[success]────────────→ CLOSED
HALF_OPEN ──[failure]────────────→ OPEN
```

- **CLOSED**: Normal operation. Failures are counted in a sliding window.
- **OPEN**: All requests rejected immediately with `CircuitBreakerOpenError`. Lasts for `recoveryTimeout`.
- **HALF_OPEN**: Limited probing allowed (up to `halfOpenMaxRequests`). Success → CLOSED, failure → OPEN.

## Configuration

```typescript
interface CircuitBreakerConfig {
  /** Failures within windowDuration before opening. Default: 5 */
  failureThreshold?: number
  /** Milliseconds before transitioning OPEN → HALF_OPEN. Default: 30_000 */
  recoveryTimeout?: number
  /** Maximum requests allowed in HALF_OPEN state. Default: 1 */
  halfOpenMaxRequests?: number
  /** Sliding window duration in ms for failure counting. Default: 60_000 */
  windowDuration?: number
}
```

### Config Table

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `failureThreshold` | `number` | `5` | Consecutive failures in window to trip breaker |
| `recoveryTimeout` | `number` | `30000` | ms to wait before attempting HALF_OPEN |
| `halfOpenMaxRequests` | `number` | `1` | Max in-flight requests in HALF_OPEN |
| `windowDuration` | `number` | `60000` | Sliding window for failure counting (ms) |

## Constructor

```typescript
import { CircuitBreakerAdapter } from "@taor/adapters"

new CircuitBreakerAdapter(innerAdapter: LLMAdapter, config?: CircuitBreakerConfig)
```

## Usage Patterns

### Pattern 1: Auto-wrap (80% case)

```typescript
createHarness({
  model: "claude-sonnet-4-6",
  tools: [],
  circuitBreaker: { failureThreshold: 5 },  // auto-wrapped
})
```

### Pattern 2: Disable auto-wrap

```typescript
createHarness({
  model: "claude-sonnet-4-6",
  tools: [],
  circuitBreaker: false,  // explicit opt-out
})
```

### Pattern 3: Manual wrapping (full control)

```typescript
import { CircuitBreakerAdapter, AnthropicAdapter } from "@taor/adapters"

createHarness({
  model: "claude-sonnet-4-6",
  adapter: (opts) => new CircuitBreakerAdapter(
    new AnthropicAdapter(opts),
    { failureThreshold: 10, recoveryTimeout: 60_000 },
  ),
  circuitBreaker: false,  // disable auto-wrap
})
```

## Error Handling

When the breaker is OPEN, calls throw `CircuitBreakerOpenError`:

```typescript
try {
  for await (const event of harness) { /* ... */ }
} catch (err) {
  if (err instanceof CircuitBreakerOpenError) {
    console.log(`Retry after ${Math.round(err.retryAfterMs / 1000)}s`)
  }
}
```

`CircuitBreakerOpenError` has a `retryAfterMs` field with the remaining recovery time.

## Introspection (for monitoring)

```typescript
const breaker = new CircuitBreakerAdapter(inner)

breaker.getState()        // "CLOSED" | "OPEN" | "HALF_OPEN"
breaker.getFailureCount() // failures in current sliding window
breaker.getInner()        // the wrapped LLMAdapter
```

## Failure Counting

Failures are tracked in a **sliding time window** (`windowDuration`). Failures older than the window are automatically pruned on each `onFailure()`. This prevents stale failures from keeping the breaker open indefinitely.

`CircuitBreakerOpenError` itself does NOT count as a failure — this prevents infinite loops where the breaker trips itself.

## Type Exports

```typescript
import {
  CircuitBreakerAdapter,    // class implements LLMAdapter
  CircuitBreakerOpenError,  // thrown when OPEN
} from "@taor/adapters"
import type {
  CircuitBreakerConfig,     // configuration interface
  CircuitBreakerState,      // "CLOSED" | "OPEN" | "HALF_OPEN"
} from "@taor/adapters"
```

## Architecture Note

The circuit breaker is a **decorator** — it wraps any `LLMAdapter` transparently. The TAOR loop sees the same `LLMAdapter` interface. This means:
- Zero changes to Harness core
- Works with any adapter (Anthropic, OpenAI, DeepSeek, custom)
- Can be composed with other adapter decorators

See [adapters.md](./adapters.md) for the full `LLMAdapter` interface specification.
