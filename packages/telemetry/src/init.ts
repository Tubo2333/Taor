// @taor/telemetry — initTracer (convenience wrapper)
//
// Sets up the OTEL SDK with OTLP gRPC exporter so users don't
// need to configure SDK manually. For production use, users
// can still pass their own Tracer to createOtelHooks().

import { trace, type Tracer } from "@opentelemetry/api";

let _tracer: Tracer | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sdk: { shutdown(): Promise<void> } | any = null;

/**
 * Initialize a Tracer with OTLP gRPC exporter pointed at a Jaeger (or any
 * OTLP-compatible) collector. Call once at process start.
 *
 * After calling this, `createOtelHooks(getTracer())` injects tracing into
 * the Harness with zero additional config.
 *
 * @param serviceName — appears as the "Service" in Jaeger UI (default "taor")
 * @param endpoint   — OTLP collector gRPC endpoint (default "http://localhost:4317")
 *
 * @example
 * ```typescript
 * import { initTracer, getTracer, createOtelHooks } from "@taor/telemetry"
 *
 * initTracer("my-agent")
 * const hooks = createOtelHooks(getTracer())
 * ```
 */
export function initTracer(
  serviceName = "taor",
  endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4317",
): Tracer {
  if (_tracer) return _tracer;

  // Lazy-load SDK so @opentelemetry/sdk-node stays optional for
  // users who bring their own tracer.
  const { NodeSDK } = require("@opentelemetry/sdk-node") as typeof import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-otlp-grpc") as typeof import("@opentelemetry/exporter-otlp-grpc");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = new (NodeSDK as any)({
    serviceName,
    traceExporter: new (OTLPTraceExporter as any)({ url: endpoint }),
    instrumentations: [],
  });

  sdk.start();
  _sdk = sdk;
  _tracer = trace.getTracer(serviceName);

  // Graceful shutdown
  const shutdown = async () => {
    if (_sdk) {
      await _sdk.shutdown();
      _sdk = null;
      _tracer = null;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("beforeExit", shutdown);

  return _tracer;
}

/** Returns the tracer initialized by `initTracer()`, or a no-op tracer if not initialized. */
export function getTracer(): Tracer {
  return _tracer ?? trace.getTracer("taor-noop");
}

/** Shut down the SDK (call on clean exit). Safe to call multiple times. */
export async function shutdownTracer(): Promise<void> {
  if (_sdk) {
    await _sdk.shutdown();
    _sdk = null;
    _tracer = null;
  }
}
