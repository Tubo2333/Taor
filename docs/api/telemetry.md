# Telemetry API Reference

> `@taor/telemetry` — OpenTelemetry tracing via the Hook system. Zero TAOR loop changes.
> Each hook point starts/stops an OTEL span. Harness does not prescribe an exporter.

## Quick Start

```bash
npm install @taor/telemetry @opentelemetry/api @opentelemetry/sdk-trace-node
```

```typescript
import { createHarness } from "@taor/engine"
import { createOtelHooks } from "@taor/telemetry"
import { trace } from "@opentelemetry/api"

const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [],
  hooks: [...createOtelHooks(trace.getTracer("harness-agent"))],
})
```

## `createOtelHooks(tracer)`

Factory function. Creates `HookRegistration[]` for every TAOR phase boundary.

```typescript
function createOtelHooks(tracer: Tracer): HookInput[]
```

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tracer` | `Tracer` (from `@opentelemetry/api`) | Yes | User-provided tracer instance |

### Returns

`HookRegistration[]` ready for `createHarness({ hooks: [...createOtelHooks(tracer)] })`.

## Span Structure

| Span Name | Hook Points | Attributes |
|-----------|-------------|------------|
| `Session` | `onSessionStart` → `onSessionEnd` | `sessionId`, `model`, `status`, `turns`, `totalTokens` |
| `THINK` | `beforeThink` → `afterThink` | `turnIndex`, `model` |
| `tool:<name>` | `beforeAct` → `afterAct` | `tool.name`, `ok`, `duration` |
| `compress` | `beforeCompress` → `afterCompress` | `beforeTokens`, `afterTokens`, `savingsPercent` |
| `error` | `onError` | Exception details, linked to current turn span |

Spans are linked via OTEL context propagation. The Session span is the root; THINK and tool spans are children.

## Exporter Configuration

Harness does NOT prescribe an exporter. Users configure via standard OTEL environment variables:

```bash
# OTLP (gRPC) — send to OpenTelemetry Collector / Jaeger / Datadog
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
export OTEL_SERVICE_NAME=my-harness-agent

# OTLP (HTTP)
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

### Console Exporter (Dev)

```typescript
import { trace } from "@opentelemetry/api"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node"

const provider = new NodeTracerProvider()
provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()))
provider.register()

const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [],
  hooks: [...createOtelHooks(trace.getTracer("harness-agent"))],
})
```

### Sampling

```bash
# Always-on sampling (default)
export OTEL_TRACES_SAMPLER=always_on

# Probability sampling (50%)
export OTEL_TRACES_SAMPLER=traceidratio
export OTEL_TRACES_SAMPLER_ARG=0.5
```

## Architecture

Telemetry is implemented as an **observation layer** through hooks — the existing 13-point hook system fires at every TAOR phase boundary. OTEL spans map 1:1 to hook points.

### Why Hooks (not direct TAOR instrumentation)

- `runTAOR()` is already ~600 lines. Direct instrumentation would push it past 700.
- Hooks are the existing extension mechanism for phase-boundary logic.
- Hook-based span timing is ~1ms less precise than direct integration — negligible for 99% of observability use cases.

### Dependency (AD-3)

`@taor/telemetry` statically imports `@opentelemetry/api` at module level. The package declares `@opentelemetry/api` as `optionalDependencies` — npm will not fail if it's missing, but the import will throw at runtime. Install explicitly when using telemetry:

```bash
npm install @taor/telemetry @opentelemetry/api
```

If you only use `@taor/engine` without telemetry, `@opentelemetry/api` is not pulled in. Only install it alongside `@taor/telemetry`.

## Type Exports

```typescript
import { createOtelHooks } from "@taor/telemetry"
// Returns: HookInput[] (from @taor/hooks)
```

See [hooks.md](./hooks.md) for the full Hook API reference.
