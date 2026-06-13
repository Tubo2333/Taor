# Changelog

## 0.2.0 (2026-06-13) — TG4 Production Release

- **OpenAI adapter** — `OpenaiAdapter` via `OpenAICompatibleAdapter` base class. GPT-5, GPT-4.1, GPT-4.1-mini, GPT-4.1-nano models with streaming, tool use, vision, and prompt caching.
- **DeepSeek adapter** — `DeepSeekAdapter` extends same base class. deepseek-chat and deepseek-reasoner models.
- **Generic env var check** — Each adapter declares `static requiredEnvVars`. `createHarness()` validates via generic loop — no hardcoded provider names.
- **CI typecheck fix** — `tsconfig.typecheck.json` (non-composite flat typecheck) replaces `tsc --build --noEmit`. CI matrix expanded to Node 20/22/24.
- **Integration test suite** — 45 tests (16 smoke + 1 process-worker + 28 TAOR lifecycle). Enhanced MockAdapter in shared fixtures.
- **npm publish readiness** — All 10 packages have `repository`, `keywords`, `license`, `publishConfig`. `prepublish.sh` + `publish.yml` workflow.
- **OpenTelemetry tracing** — `@taor/telemetry` with `createOtelHooks()`. Zero TAOR changes. 5 span types (Session/THINK/tool/compress/error). OTLP + console exporters. Optional dependency (AD-3).
- **Circuit breaker** — `CircuitBreakerAdapter` decorator. 3-state (CLOSED→OPEN→HALF_OPEN). Sliding window failure counting. Auto-wrap via `createHarness({ circuitBreaker: {...} })`. 14 unit tests.
- **MCP consumer support** — `@taor/mcp` with `MCPToolBridge`. Stdio/SSE transport, `tools/list` + `tools/call`. Two-step async init. Process cleanup (H3 fix). 12 integration tests.
- **Code reviewer example** — `examples/code-reviewer/`. 3 tools (read_file/grep/write_file) with HITL approval. Token budget hook ($5 limit). README with 3-step verification.
- **API documentation** — 14 docs: openai-adapter, deepseek-adapter, circuit-breaker, telemetry, mcp, adapters, harness, tools, hooks, memory, compressor, permission, subagent, quickstart.

## 0.1.0 (2026-06-12)
- Initial release
- TAOR loop (Think → Act → Observe → Repeat) with AsyncGenerator protocol
- 4-tier permission engine (deny/boundary/allow/ask)
- 13-point lifecycle hook system with priority execution
- Sub-agent coordinator with inline and process isolation
- 3-layer memory (user/project/session) with InMemory/Json/Sqlite backends
- 5-layer context compressor (trim → summarize → chunk → embed → truncate)
- Anthropic API adapter with streaming support
- Error recovery: retry/skip_turn/abort/ignore
- Heartbeat-based zombie sub-agent detection
- Session serialization/deserialization
- CLI: harness run/config/tool

### Default logger changed (2026-06-13)

**BREAKING**: The default logger was changed from NOOP (silent) to CONSOLE (outputs
`[Harness:debug/info/warn/error]` prefixed messages). This means previously silent
applications will now emit log output by default. Set `logger: undefined` and
implement a custom no-op logger if silence is required.

### Architecture review fixes (2026-06-13)

- **CRITICAL**: `validateEnv()` no longer calls `process.exit()` in library code — throws instead
- **CRITICAL**: **BREAKING** `deserialize()` accepts adapter + registry as direct parameters (was 2 params, now 4) — no post-construction injection
- **CRITICAL**: adapter/registry getter guards consistently match other subsystems (permission/hooks/memory/etc.)
- **HIGH**: `withRetry()` now checks AbortSignal during backoff
- **HIGH**: SqliteStore TTL cleanup timer calls `.unref()` to not block process exit
- **HIGH**: Structural interfaces exported for compile-time conformance checking
- **HIGH**: `__modulePath` missing generates warn log instead of silent skip
- **HIGH**: AnthropicAdapter subclass detection uses `instanceof` for env check
- **MEDIUM**: ProcessWorker.kill() simplified — Node.js handles platform signal mapping
- **MEDIUM**: Child process disconnect uses exit(0) (not exit(1)) for clean PM2 integration
- **MEDIUM**: Remote entry adds active heartbeat timeout (60s) for orphan detection
- **MEDIUM**: `@types/node` added to memory, subagent, adapters devDependencies
- **MEDIUM**: CLI entry wrapped in try-catch for clean error messages
- **MEDIUM**: Examples use try-catch pattern for clean error output
- **LOW**: Dockerfile layer caching optimized
