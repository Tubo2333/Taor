# Harness Engine — Developer API Design v2

> **状态**：审理修正后定稿。3 致命 + 3 重要问题已修正。
> **前一版**：`d:/C-file/Harness_Engineer_Resume_Prompt.md`
> **审理记录**：见 §九"审理修正清单"

---

## 目录

- [一、架构总览](#一架构总览)
- [二、核心类型](#二核心类型)
- [三、Harness 主类（双通道）](#三harness-主类双通道)
- [四、Config 与会话](#四config-与会话)
- [五、Tool 系统（defineTool + ToolDescriptor）](#五tool-系统-definetool--tooldescriptor)
- [六、Adapter 接口（完整生命周期）](#六adapter-接口完整生命周期)
- [七、Event 系统](#七event-系统)
- [八、Permission 系统（@resource 注解）](#八permission-系统resource-注解)
- [九、Hooks 系统（HookRegistry 链式注册）](#九hooks-系统hookregistry-链式注册)
- [十、Sub-agent 系统（完整生命周期状态）](#十sub-agent-系统完整生命周期状态)
- [十一、Memory 系统](#十一memory-系统)
- [十二、Compressor 系统](#十二compressor-系统)
- [十三、模块树与包结构](#十三模块树与包结构)
- [十四、DX 场景](#十四dx-场景)
- [十五、审理修正清单](#十五审理修正清单)

---

## 一、架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                     HarnessConfig                            │
│  (schema + defaults + validation)                            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                       Harness                                │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │             AsyncGenerator<HarnessEvent>              │   │
│  │                                                      │   │
│  │  yield: started | turn-started | thinking | thought |        │   │
│  │         tool-call | tool-result | approval-required │   │
│  │         compressed | subagent | error | blocked |    │   │
│  │         heartbeat                             │   │
│  │                                                      │   │
│  │  inject: harness.next(userDecision)
  │  │                                                      │   │
  │  │  return: SessionResult (TReturn, via {done:true})   ← 审批注入     │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  EventEmitter（旁路多播）                             │   │
│  │                                                      │   │
│  │  .on("tool-call", log)     ← 日志                    │   │
│  │  .on("tool-result", audit) ← 审计                    │   │
│  │  .on("compressed", metric) ← 可观测性                │   │
│  │  .on("*", debug)           ← 调试                    │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                   TAOR 核心循环                       │   │
│  │                                                      │   │
│  │  THINK ──→ ACT ──→ OBSERVE ──→ loop                 │   │
│  │    │         │         │                             │   │
│  │    │    ┌────┴────┐    │                             │   │
│  │    │    │ tools   │    │                             │   │
│  │    │    │ sub-    │    │                             │   │
│  │    │    │ agents  │    │                             │   │
│  │    │    └─────────┘    │                             │   │
│  │    ▼                   ▼                             │   │
│  │  LLMAdapter        Observation                      │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  子系统层（6 个独立 @harness/* 包）：                        │
│  ┌────────┬──────────┬──────────┬─────────┬─────────┬────┐ │
│  │ Memory │Compressor│Permission│Sub-agent│  Tool   │Hooks│ │
│  │ (3层)  │ (5层)    │ (4层)    │(Coord/  │Registry │     │ │
│  │        │          │          │ Worker) │ (冲突)  │     │ │
│  └────────┴──────────┴──────────┴─────────┴─────────┴────┘ │
└─────────────────────────────────────────────────────────────┘
```

**关键设计原则**（不变）：
- **先便宜后贵**：Compressor 5 层逐级上膛，Memory 三层只在命中时读
- **只记偏好不记代码**：Memory 存用户决策模式，不存项目代码
- **运行时越笨架构越稳**：AsyncGenerator 不含调度逻辑，仅 push/pull
- **Coordinator 只派活不动文件**：Sub-agent Coordinator 不访问文件系统

---

## 二、核心类型

### 2.1 HarnessContext（3 层作用域）

```typescript
interface HarnessContext {
  session: SessionState       // 跨 turn 不变：id、workDir、startedAt、tokenUsage
  turn: TurnState             // 每轮重建：messages、toolCalls、observation
  shared: SharedCacheState    // sub-agent fork 时共享：project 元信息、昂贵加载结果
}

interface SessionState {
  id: string
  workDir: string
  model: string
  startedAt: number
  status: SessionStatus       // "running" | "paused" | "done" | "aborted" | "error"
  tokenUsage: TokenUsage
  turnCount: number
}

type SessionStatus = "running" | "paused" | "done" | "aborted" | "error"

interface TurnState {
  id: string
  index: number
  messages: Message[]
  pendingToolCalls: Map<string, Readonly<ToolCall>>   // 工具实现不可直接修改（见 D-3）
  lastObservation: Observation | null
  compressedAt: CompressLevel | null
}

interface SharedCacheState {
  projectRoot: string
  projectConfig: Record<string, unknown> | null    // CLAUDE.md 解析结果等
  loadedResources: Map<string, unknown>            // 大文件内容等，避免重复加载
}
```

### 2.2 上下文别名（Hook/Adapter 子系统使用）

```typescript
/**
 * SessionContext — Session 级 Hook 的上下文视图。
 * 等价于 HarnessContext 去掉 turn（session 级钩子执行时无活跃 turn）。
 */
type SessionContext = Omit<HarnessContext, "turn">

/**
 * TurnContext — Turn 级 Hook / Adapter / Compressor 的上下文视图。
 * 等价于 HarnessContext——在 turn 执行期间，session + turn + shared 均可访问。
 * beforeThink hook 返回 TurnContext | void 时，返回值与当前 ctx 做 shallow merge。
 */
type TurnContext = HarnessContext
```

### 2.3 TokenUsage

```typescript
interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}
```

### 2.4 CompressLevel

```typescript
type CompressLevel = "none" | "trim" | "summarize" | "chunk" | "embed" | "truncate"
```

### 2.5 ToolCall（工具调用运行时表示）

```typescript
/**
 * 与 ParsedToolCall（LLM 产出的静态 tool_use 块）不同，
 * ToolCall 是引擎内部的运行时追踪结构，包含执行状态和重试计数。
 */
interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  status: "pending" | "running" | "done" | "error"
  startedAt: number
  retries: number
}
```

### 2.6 HarnessError（归一化错误）

```typescript
/**
 * 所有子系统（Adapter、Tool、Harness、Sub-agent、Compressor）产出的错误
 * 通过 normalizeError() 归一化为此类型。ErrorEvent 通过 `.error` 字段引用它。
 */
interface HarnessError {
  code: string
  message: string
  source: "adapter" | "tool" | "harness" | "subagent" | "compressor"
  recoverable: boolean
  cause?: unknown
  timestamp: number
}
```

### 2.7 Observation（TAOR O-阶段产出）

```typescript
/**
 * OBSERVE 阶段产出：工具执行结果 + LLM 响应 → 整合为 Observation，
 * 存入 TurnState.lastObservation，传给 afterObserve hook，
 * 其 newMessages 追加到 TurnState.messages 供下一轮 THINK 使用。
 */
interface Observation {
  turnId: string
  /** 本轮完成的工具调用及其结果 */
  toolResults: ToolCallResult[]
  /** 追加到对话历史的消息（tool_result 块） */
  newMessages: Message[]
  /** 本轮 token 消耗增量 */
  tokenUsage: TokenUsage
  /** OBSERVE 阶段是否触发了上下文压缩 */
  compressedAt: CompressLevel | null
}

interface ToolCallResult {
  call: ToolCall
  result: ToolResult
}
```

### 2.8 通用工具类型

```typescript
/** 取消监听函数 */
type Unsubscribe = () => void

/** 已完成 turn 的摘要记录（Harness.turns getter 返回） */
interface TurnRecord {
  id: string
  index: number
  status: "completed" | "error" | "compressed" | "aborted"
  tokenUsage: TokenUsage
  toolCalls: number
  duration: number
  compressedAt: CompressLevel | null
}
```

---

## 三、Harness 主类（双通道）

```typescript
/**
 * Harness — 双向 AsyncGenerator + 多播 EventEmitter
 *
 * 主通道（拉取）：
 *   for await (const event of harness) { ... }
 *   用于驱动审批循环。每个 yield 挂起等待 .next(decision)。
 *
 * 旁路通道（推送）：
 *   harness.on("tool-call", (e) => { ... })
 *   用于日志、审计、指标。不参与控制流。
 *
 * ## 内部事件队列
 *
 * TAOR 循环在内部微任务中运行，产出的事件推入一个有界 FIFO 队列（默认容量 256）。
 * 消费者通过 for await 拉取事件时从队列中取出。旁路监听器在事件入队时同步触发。
 *
 * - **背压**：队列满时 TAOR 循环挂起等待消费者拉取，保证 AsyncGenerator 的天然背压。
 * - **start() 语义**：`harness.start(prompt)` 仅设置初始 prompt 并返回 this，
 *   实际的 TAOR 循环在消费者第一次调用 `.next()`（即 for await 隐式调用）时启动。
 * - **队列容量**：可通过 `HarnessConfig.session.eventQueueCapacity` 配置，默认 256。
 */
class Harness implements AsyncGenerator<HarnessEvent, SessionResult, UserDecision> {
  // ─── 构造函数 ───
  constructor(config: HarnessConfig)

  // ============ AsyncGenerator 协议（主通道） ============
  [Symbol.asyncIterator](): AsyncIterator<HarnessEvent, SessionResult, UserDecision>
  next(decision?: UserDecision): Promise<IteratorResult<HarnessEvent, SessionResult>>
  return(value?: SessionResult): Promise<IteratorResult<HarnessEvent, SessionResult>>
  throw(e: Error): Promise<IteratorResult<HarnessEvent, SessionResult>>

  // ============ EventEmitter 协议（旁路多播） ============
  /**
   * 注册旁路监听器。不影响主通道迭代。
   *
   * @param type 事件类型，或 "*" 监听所有事件
   * @param handler 事件处理器（同步/异步）
   * @param opts.signal AbortSignal 用于取消监听
   * @returns 取消函数
   */
  // 显式 overload：wildcard "*" 监听所有事件（TS 泛型约束 E extends "started"|... 拒绝 "*"）
  on(type: "*", handler: (event: HarnessEvent) => void | Promise<void>, opts?: { signal?: AbortSignal }): Unsubscribe
  // 泛型 overload：按事件类型窄化 handler 参数
  on<E extends HarnessEvent["type"]>(
    type: E,
    handler: (event: Extract<HarnessEvent, { type: E }>) => void | Promise<void>,
    opts?: { signal?: AbortSignal }
  ): Unsubscribe

  /** 取消单个监听器 */
  off(type: HarnessEvent["type"] | "*", handler: Function): void

  /** 取消某类型所有监听器 */
  offAll(type?: HarnessEvent["type"] | "*"): void

  // ============ 便捷方法 ============
  /** 设置初始 prompt 并启动。等价于 .next({ type: "start", prompt }) */
  start(prompt: string): this

  // ============ 查询（不改变状态） ============
  get state(): SessionState
  get turns(): TurnRecord[]       // 所有已完成 turn 的摘要
  get tokenUsage(): TokenUsage
  get isRunning(): boolean

  // ============ 控制 ============
  abort(reason?: string): void     // 优雅中断：完成当前工具调用后停止
  kill(): void                     // 立即终止：不等当前工具
  pause(): void                    // 完成当前 turn 后挂起
  resume(): void                   // 从挂起恢复

  // ============ Sub-agent（见 §十） ============
  spawn(spec: SubagentSpec): SubagentHandle

  // ============ 类型化访问子系统 ============
  readonly hooks: HookRegistry
  readonly permission: PermissionEngine
  readonly memory: MemoryFacade

  // ============ 序列化（v2） ============
  serialize(): SerializedSession
  static deserialize(data: SerializedSession, config: HarnessConfig): Harness
}
```

### 3.1 SerializedSession（可持久化快照）

```typescript
/**
 * 可持久化的会话快照。
 * 仅在 turn 边界可序列化——不支持在 THINK/ACT/OBSERVE 中间状态序列化。
 * Adapter、Tool 实例等不可序列化部分通过 deserialize() 的 config 参数重新注入。
 */
interface SerializedSession {
  version: number                          // schema 版本号
  sessionId: string
  model: string
  workDir: string
  startedAt: number
  tokenUsage: TokenUsage
  turnCount: number
  turns: SerializedTurn[]
  memorySnapshots: {
    user: Record<string, unknown>
    project: Record<string, unknown>
  }
}

interface SerializedTurn {
  id: string
  index: number
  messages: Message[]
  tokenUsage: TokenUsage
  compressedAt: CompressLevel | null
}
```

---

## 四、Config 与会话

### 4.1 HarnessConfig

```typescript
interface HarnessConfig {
  // ── 必填 ──
  model: string
  tools: ToolInput[]                        // Tool 类 或 defineTool() 产物

  // ── 会话 ──
  session?: {
    id?: string                             // 自动生成 ULID
    workDir?: string                        // 默认 process.cwd()
    resumeFrom?: string                     // session id，跨会话恢复
    maxTurns?: number                       // 默认 100，安全上限
    timeout?: number                        // 会话超时（毫秒），默认 Infinity
    eventQueueCapacity?: number             // 内部事件队列容量，默认 256。超限时 TAOR 循环背压挂起
  }

  // ── LLM Adapter ──
  adapter?: AdapterConstructor              // 默认 AnthropicAdapter

  // ── 子系统 partial override ──
  memory?: Partial<MemoryConfig>
  compressor?: Partial<CompressorConfig>
  permission?: Partial<PermissionConfig>
  subagent?: Partial<SubagentConfig>
  hooks?: HookInput[]                       // 见 §九

  // ── 可观测性 ──
  logger?: Logger                           // 实现 Logger 接口
  trace?: boolean                           // 开启后 event 附带 traceId + spanId
  telemetry?: TelemetryConfig
}

/**
 * ToolInput — 接受 class、defineTool() 产物、或元组简写
 */
type ToolInput =
  | ToolDescriptor                          // defineTool() / tool() 产出
  | ToolConstructor                         // class extends Tool

/** Tool 类构造器类型（class extends Tool） */
type ToolConstructor = new (...args: any[]) => Tool

/** LLM Adapter 构造器类型 */
type AdapterConstructor = new (opts?: Record<string, unknown>) => LLMAdapter

/** 日志接口。内置兼容 console，也可接入 Winston/Pino 等 */
interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** 遥测配置（OpenTelemetry 兼容子集） */
interface TelemetryConfig {
  enabled: boolean
  /** OTLP endpoint，默认 http://localhost:4318/v1/traces */
  endpoint?: string
  /** 采样率 0-1，默认 1.0 */
  sampleRate?: number
  /** 额外 resource attributes */
  attributes?: Record<string, string>
}
```

### 4.2 工厂函数

```typescript
/**
 * 推荐入口。等价于 new Harness(config)。
 */
function createHarness(config: HarnessConfig): Harness
```

### 4.3 SessionResult

```typescript
/**
 * SessionResult — AsyncGenerator 的 TReturn（done-value）。
 * 当 generator 完成时，{ done: true, value: SessionResult }。
 * 使用 for await...of 时 done-value 不可达；使用裸 .next() 手动迭代时可获取。
 */
interface SessionResult {
  sessionId: string
  status: "completed" | "aborted" | "error" | "blocked" | "timeout"
  turns: number
  tokenUsage: TokenUsage
  finalMessage: string
  artifacts: Artifact[]                       // 递归包含 sub-agent 产出
}

interface Artifact {
  path: string                                // 相对于 workDir
  source: "main" | "subagent"                 // 来源
  subagentId?: string
  tool: string
  size: number
  hash: string                                // SHA-256
}
```

---

## 五、Tool 系统（defineTool + ToolDescriptor）

### 5.1 设计决策

三种方式定义工具，底层全部规范化为 `ToolDescriptor`：

| 方式 | 适用场景 | DX 特点 |
|------|---------|---------|
| `defineTool({...})` | **90% 场景**：无生命周期钩子的简单工具 | 类型推断，Zod/JSON Schema 双接受 |
| `tool(name, desc, schema, fn)` | 极简场景：单函数 | 最简短，适合内置工具 |
| `class extends Tool` | 复杂工具：有钩子、有状态、需要扩展 | 完整 OOP，适合生态插件 |

### 5.2 JSONSchema 类型约定

```typescript
/**
 * JSON Schema 最小可用子集（Draft-07 兼容）。
 * defineTool() 的 Zod 重载通过 zod-to-json-schema 自动转换到此类型；
 * 纯 JSON Schema 重载直接接受此类型。
 * 对应 @anthropic-ai/sdk 的 Tool.InputSchema 结构子集。
 */
interface JSONSchema {
  type: "object"
  properties?: Record<string, JSONSchemaProperty>
  required?: string[]
  additionalProperties?: boolean
  description?: string
}

interface JSONSchemaProperty {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  items?: JSONSchemaProperty
  properties?: Record<string, JSONSchemaProperty>
  required?: string[]
  default?: unknown
}
```

### 5.3 ToolDescriptor（内部规范表示）

```typescript
interface ToolDescriptor {
  name: string
  description: string
  parameters: JSONSchema                        // 运行时统一为 JSON Schema
  execute: (params: unknown, ctx: ToolContext) => Promise<ToolResult>
  permissions?: PermissionHint[]
  risk?: RiskLevel
  timeout?: number
  retry?: RetryPolicy
  requiresApproval?: boolean | ApprovalPredicate
  // ── 生命周期（可选，defineTool 也可传入） ──
  onBeforeExecute?: (params: unknown, ctx: ToolContext) => Promise<void>
  onAfterExecute?: (params: unknown, result: ToolResult, ctx: ToolContext) => Promise<void>
  onError?: (params: unknown, error: Error, ctx: ToolContext) => Promise<ToolResult<never>>
}
```

### 5.3 defineTool() 工厂

```typescript
/**
 * 推荐方式。Zod schema → JSON Schema 自动转换。
 * params 类型自动推导，execute 参数有完整类型。
 */
function defineTool<T extends z.ZodType>(def: {
  name: string
  description: string
  parameters: T                               // Zod schema
  permissions?: PermissionHint[]
  risk?: RiskLevel
  timeout?: number
  retry?: RetryPolicy
  requiresApproval?: boolean | ApprovalPredicate
  execute: (params: z.infer<T>, ctx: ToolContext) => Promise<ToolResult>
  // 生命周期钩子（可选）
  onBeforeExecute?: (params: z.infer<T>, ctx: ToolContext) => Promise<void>
  onAfterExecute?: (params: z.infer<T>, result: ToolResult, ctx: ToolContext) => Promise<void>
  onError?: (params: z.infer<T>, error: Error, ctx: ToolContext) => Promise<ToolResult<never>>
}): ToolDescriptor

/**
 * 也接受纯 JSON Schema（不依赖 Zod 时）
 */
function defineTool(def: {
  name: string
  description: string
  parameters: JSONSchema                      // 纯 JSON Schema 对象
  permissions?: PermissionHint[]
  risk?: RiskLevel
  timeout?: number
  retry?: RetryPolicy
  requiresApproval?: boolean | ApprovalPredicate
  execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}): ToolDescriptor
```

### 5.4 tool() 超简写

```typescript
/**
 * 最简函数式定义。4 个位置参数。
 */
function tool<T extends z.ZodType>(
  name: string,
  description: string,
  parameters: T,
  execute: (params: z.infer<T>, ctx: ToolContext) => Promise<ToolResult>,
  opts?: Pick<ToolDescriptor, "permissions" | "risk" | "timeout" | "retry" | "requiresApproval">
): ToolDescriptor
```

### 5.5 Tool 抽象类（保持向后兼容）

```typescript
abstract class Tool<TParams extends z.ZodType = z.ZodType, TResult = unknown> {
  abstract name: string
  abstract description: string
  abstract parameters: TParams

  permissions?: PermissionHint[]
  risk?: RiskLevel
  timeout?: number
  retry?: RetryPolicy
  requiresApproval?: boolean | ApprovalPredicate

  abstract execute(params: z.infer<TParams>, ctx: ToolContext): Promise<ToolResult<TResult>>

  onBeforeExecute?(params: z.infer<TParams>, ctx: ToolContext): Promise<void>
  onAfterExecute?(params: z.infer<TParams>, result: ToolResult<TResult>, ctx: ToolContext): Promise<void>
  onError?(params: z.infer<TParams>, error: Error, ctx: ToolContext): Promise<ToolResult<never>>

  /** 内部序列化为 ToolDescriptor */
  toDescriptor(): ToolDescriptor
}
```

### 5.6 相关类型

```typescript
type PermissionHint = "fs-read" | "fs-write" | "network" | "shell" | "subprocess"

type RiskLevel = "low" | "medium" | "high"

interface RetryPolicy {
  maxRetries: number
  backoff: "fixed" | "exponential" | "linear"
  baseDelayMs: number
  maxDelayMs?: number
}

type ApprovalPredicate = (params: unknown, ctx: ToolContext) => boolean

type ToolResult<T = unknown> =
  | { ok: true; data: T; meta?: ToolResultMeta }
  | { ok: false; error: string; code: ToolErrorCode; recoverable: boolean }

interface ToolResultMeta {
  duration: number
  tokensUsed?: number
  artifacts?: string[]
  truncated?: boolean
}

type ToolErrorCode =
  | "timeout"
  | "permission_denied"
  | "invalid_params"
  | "execution_failed"
  | "aborted"
  | "unknown"

interface ToolContext {
  session: SessionState
  turn: TurnState
  signal: AbortSignal
  logger: Logger
}
```

### 5.7 使用示例

```typescript
// 方式一：defineTool（推荐，90% 场景）
const readFile = defineTool({
  name: "ReadFile",
  description: "Read a file from the local filesystem",
  parameters: z.object({
    file_path: z.string().describe("Absolute path to the file").describe("@resource:fs-path"),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  permissions: ["fs-read"],
  risk: "low",
  async execute({ file_path, offset, limit }, ctx) {
    const content = await fs.readFile(file_path, "utf-8")
    const lines = content.split("\n")
    const sliced = offset || limit ? lines.slice(offset ?? 0, limit ? (offset ?? 0) + limit : undefined) : lines
    return {
      ok: true,
      data: { path: file_path, content: sliced.join("\n"), totalLines: lines.length },
    }
  },
})

// 方式二：tool() 超简写
const grep = tool(
  "Grep",
  "Search with ripgrep",
  z.object({ pattern: z.string(), path: z.string().optional().describe("@resource:fs-path") }),
  async ({ pattern, path }, ctx) => {
    const result = await execRipgrep(pattern, path ?? ctx.session.workDir)
    return { ok: true, data: result }
  },
  { risk: "low", permissions: ["fs-read"] }
)

// 方式三：class（复杂工具）
class DatabaseQueryTool extends Tool<typeof DBQueryParams, QueryResult> {
  name = "DatabaseQuery"
  description = "Execute a read-only SQL query"
  parameters = DBQueryParams
  permissions = ["network"]
  risk = "medium"

  async onBeforeExecute(params: z.infer<typeof DBQueryParams>, ctx: ToolContext) {
    await this.ensureConnection()
  }

  async execute(params, ctx) {
    const rows = await this.pool.query(params.sql, params.bindings)
    return { ok: true, data: { rows, rowCount: rows.length } }
  }

  async onError(params, error, ctx) {
    return { ok: false, error: `Query failed: ${error.message}`, code: "execution_failed", recoverable: true }
  }
}
```

---

## 六、Adapter 接口（完整生命周期）

### 6.1 LLMAdapter

```typescript
/**
 * LLM Adapter 接口。
 * TAOR 循环在 THINK 阶段通过此接口与具体 provider 交互。
 * Adapter 负责所有 provider 特定的格式转换，上层只操作统一类型。
 */
/**
 * LLM Adapter 接口。
 * TAOR 循环在 THINK 阶段通过此接口与具体 provider 交互。
 * Adapter 负责所有 provider 特定的格式转换，上层只操作统一类型。
 *
 * ## 并发安全
 *
 * 如果 Compressor 复用主 adapter（默认行为），则 adapter 的 think() 可能在
 * TAOR 主循环的 THINK 阶段与 Compressor 的 summarize 策略中并发调用。
 * 实现必须支持可重入（reentrant）调用——即多个独立的 AsyncGenerator 可以同时活跃。
 * 最简单的实现方式：每次 think() 调用创建独立的 HTTP client 实例。
 * 如果 provider 不支持并发（如某些 API key 有并发限制），应通过 CompressorConfig.adapter
 * 传入独立 adapter 或使用信号量限流。
 */
interface LLMAdapter {
  // ── 元数据 ──
  readonly provider: string                      // "anthropic" | "openai" | "deepseek" | ...
  readonly version: string
  getModelInfo(model: string): ModelInfo
  supports(feature: AdapterFeature): boolean

  // ── 核心生命周期 ──
  /**
   * 组装请求体。一次调用产出 provider-specific 的完整请求。
   * 内部处理：消息格式转换、工具 schema 格式化、缓存头注入、
   * thinking/tool_choice 等 provider 特有参数。
   */
  buildRequest(ctx: TurnContext, opts: RequestOptions): Promise<AdapterRequest>

  /**
   * 执行推理。返回 AsyncGenerator<ThinkEvent>。
   * 内部处理 streaming/non-streaming 差异——上层始终以统一事件流消费。
   * signal 用于中断（用户 abort 或 timeout）。
   */
  think(request: AdapterRequest, signal: AbortSignal): AsyncGenerator<ThinkEvent>

  /**
   * 从 provider 原始响应中提取标准化的 ToolCall 列表。
   * 不同 provider 的 tool_use 结构完全不同——adapter 在此归一化。
   */
  parseToolCalls(rawResponse: unknown): ParsedToolCall[]

  /**
   * 格式化工具执行结果回传给 provider。
   * Anthropic: { type: "tool_result", tool_use_id, content }
   * OpenAI:   { role: "tool", tool_call_id, content }
   */
  formatToolResult(callId: string, result: ToolResult): unknown

  // ── Token 计数 ──
  countTokens(messages: Message[]): number
  countRequestTokens(request: AdapterRequest): number

  // ── 错误归一化 ──
  normalizeError(error: unknown): HarnessError
}
```

### 6.2 统一事件类型

```typescript
/** ThinkEvent — 所有 provider 归一化后的推理输出 */
type ThinkEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }       // extended thinking（DeepSeek/Claude）
  | { type: "tool_use"; call: ParsedToolCall }
  | { type: "stop"; reason: StopReason; usage: TokenUsage }
  | { type: "error"; error: HarnessError }

type StopReason = "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "refusal"

interface ParsedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}
```

### 6.3 辅助类型

```typescript
type AdapterFeature =
  | "streaming"
  | "thinking"
  | "tool-use"
  | "parallel-tool-calls"
  | "vision"
  | "prompt-caching"
  | "computer-use"

interface ModelInfo {
  id: string
  provider: string
  maxInputTokens: number
  maxOutputTokens: number
  supportsThinking: boolean
  supportsVision: boolean
  supportsPromptCaching: boolean
  supportsToolUse: boolean
  costPer1kInput: number
  costPer1kOutput: number
}

interface RequestOptions {
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  thinking?: { budgetTokens: number }
  tools?: ToolDescriptor[]
}

/** Adapter 产生的 provider-specific 请求（上层不解析其内部结构） */
type AdapterRequest = unknown

interface Message {
  role: "system" | "user" | "assistant"
  content: MessageContent[]
}

type MessageContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
```

### 6.4 内置 Adapter 实现

```typescript
class AnthropicAdapter implements LLMAdapter {
  readonly provider = "anthropic"
  readonly version = "2025-01-01"

  constructor(opts?: { apiKey?: string; baseUrl?: string; beta?: string[] })

  getModelInfo(model: string): ModelInfo
  supports(feature: AdapterFeature): boolean
  buildRequest(ctx: TurnContext, opts: RequestOptions): Promise<AdapterRequest>
  think(request: AdapterRequest, signal: AbortSignal): AsyncGenerator<ThinkEvent>
  parseToolCalls(raw: unknown): ParsedToolCall[]
  formatToolResult(callId: string, result: ToolResult): unknown
  countTokens(messages: Message[]): number
  countRequestTokens(request: AdapterRequest): number
  normalizeError(error: unknown): HarnessError
}

class OpenaiAdapter implements LLMAdapter { /* 同上 */ }
class DeepSeekAdapter implements LLMAdapter { /* 同上 */ }
```

---

## 七、Event 系统

### 7.1 HarnessEvent（完整联合类型）

```typescript
type HarnessEvent =
  | SessionStartedEvent
  | TurnStartedEvent
  | ThinkingEvent
  | ThoughtEvent
  | ToolCallEvent
  | ToolResultEvent
  | ApprovalRequiredEvent
  | TurnEndedEvent
  | CompressedEvent
  | SubagentSpawnedEvent
  | SubagentResultEvent
  | HeartbeatEvent
  | ErrorEvent
  | BlockedEvent
  // 注意：SessionResult 作为 AsyncGenerator 的 TReturn（done-value），
  // 通过 generator 的 { done: true, value: SessionResult } 返回，
  // 不在 HarnessEvent union 中 yield

// ── Session 级 ──
interface SessionStartedEvent {
  type: "started"
  sessionId: string
  model: string
  workDir: string
  tools: string[]                               // tool names
  timestamp: number
}

// ── Turn 级 ──
interface TurnStartedEvent {
  type: "turn-started"
  turnId: string
  turnIndex: number
  timestamp: number
}

interface ThinkingEvent {
  type: "thinking"
  turnId: string
  model: string
  timestamp: number
}

interface ThoughtEvent {
  type: "thought"
  turnId: string
  content: string                               // text 块
  kind: "text" | "thinking"
  timestamp: number
}

interface ToolCallEvent {
  type: "tool-call"
  turnId: string
  callId: string
  tool: string
  params: Record<string, unknown>
  risk: RiskLevel
  timestamp: number
}

interface ToolResultEvent {
  type: "tool-result"
  turnId: string
  callId: string
  tool: string
  ok: boolean
  duration: number
  truncated?: boolean
  timestamp: number
}

interface ApprovalRequiredEvent {
  type: "approval-required"
  turnId: string
  callId: string
  tool: string
  params: Record<string, unknown>
  risk: RiskLevel
  reason: string                                // 为什么触发审批（匹配的规则描述）
  ttl: number                                   // 超时自动拒绝（秒），0 = 永不超时
  timestamp: number
}

interface TurnEndedEvent {
  type: "turn-ended"
  turnId: string
  turnIndex: number
  tokenUsage: TokenUsage
  duration: number
  compressed: boolean
}

// ── 系统事件 ──
interface CompressedEvent {
  type: "compressed"
  turnId: string
  level: CompressLevel
  beforeTokens: number
  afterTokens: number
  savingsPercent: number
  strategy: string
  timestamp: number
}

interface SubagentSpawnedEvent {
  type: "subagent-spawned"
  parentTurnId: string
  subagentId: string
  description: string
  isolation: "inline" | "process" | "worktree"
  timestamp: number
}

interface SubagentResultEvent {
  type: "subagent-result"
  parentTurnId: string
  subagentId: string
  ok: boolean
  turns: number
  tokenUsage: TokenUsage
  timestamp: number
}

interface HeartbeatEvent {
  type: "heartbeat"
  turnId: string
  elapsed: number                               // 当前 turn 已运行秒数
  toolRunning?: string                          // 当前正执行的工具名
  timestamp: number
}

interface ErrorEvent {
  type: "error"
  turnId?: string
  /** 归一化错误体。Engine 内部通过 adapter.normalizeError() 或 tool onError() 产出 */
  error: HarnessError
}

interface BlockedEvent {
  type: "blocked"
  turnId: string
  callId: string
  tool: string
  level: PermissionLevel
  reason: string
  timestamp: number
}
```

### 7.2 UserDecision（注入）

```typescript
type UserDecision =
  | { type: "approve"; callId: string }
  | { type: "deny"; callId: string; reason?: string }
  | { type: "approve-all"; scope: "turn" | "session" }
  | { type: "interject"; message: string }       // 用户插话
  | { type: "start"; prompt: string }            // 内部使用
```

---

## 八、Permission 系统（@resource 注解）

### 8.1 PermissionConfig

```typescript
interface PermissionConfig {
  mode: "interactive" | "non-interactive" | "custom"

  rules: PermissionRule[]
  defaultLevel: PermissionLevel                  // 默认 "ask"

  allowlist?: PermissionRule[]
  denylist?: PermissionRule[]

  /** 非交互模式下的默认行为 */
  nonInteractiveDefault?: "allow" | "deny"
  /** 审批超时自动拒绝（秒），默认 120 */
  approvalTimeout: number
}

type PermissionLevel = "deny" | "boundary" | "allow" | "ask"
```

### 8.2 PermissionRule（增强：resourceConstraints）

```typescript
interface PermissionRule {
  level: PermissionLevel
  /** 匹配 tool name，支持 glob： "Write*", "ReadFile", "*" */
  pattern: string

  /**
   * 资源约束。只有在 tool 参数中用 .describe("@resource:<tag>") 标记了
   * 对应注解参数时才生效。未标记 @resource 的工具，boundary 规则降级为 ask。
   */
  resourceConstraints?: {
    /** 参数注解标签，如 "@resource:fs-path", "@resource:url" */
    paramAnnotation: string
    /** 允许的值/路径白名单 */
    allowlist?: string[]
    /** 禁止的值/路径黑名单 */
    denylist?: string[]
  }

  /** 匹配风险等级（默认不限制） */
  risk?: RiskLevel | RiskLevel[]
  /** 记录为什么设这条规则 */
  reason?: string
}
```

### 8.3 @resource 注解规范

Tool 参数通过 Zod `.describe()` 声明其"资源语义"：

```typescript
// 注解格式： @resource:<resource-type>
const writeFile = defineTool({
  name: "WriteFile",
  parameters: z.object({
    file_path: z.string().describe("Target file path").describe("@resource:fs-path"),
    content:   z.string().describe("File content"),
  }),
  // ...
})

const fetchUrl = defineTool({
  name: "WebFetch",
  parameters: z.object({
    url: z.string().describe("URL to fetch").describe("@resource:url"),
  }),
  // ...
})
```

**标准资源类型**：

| 注解 | 含义 | Permission 检查方式 |
|------|------|-------------------|
| `@resource:fs-path` | 文件系统路径 | 路径匹配（glob） |
| `@resource:url` | 网络 URL | URL 模式匹配（host + path glob） |
| `@resource:shell-command` | Shell 命令 | 命令模式匹配 |
| `@resource:env-var` | 环境变量名 | 变量名白名单 |

### 8.4 PermissionRule 匹配逻辑

```
1. denylist 先匹配 → 命中则直接 DENY
2. allowlist 后匹配 → 命中则直接 ALLOW
3. rules 按顺序匹配（第一条命中即停止）：
   a. pattern 匹配 tool name → 继续
   b. risk 条件匹配（如果设置了）→ 继续
   c. resourceConstraints 匹配（如果 rule.level 是 boundary）→ 继续
   d. 命中 → 应用 rule.level
4. 无规则命中 → defaultLevel
```

### 8.5 PermissionEngine（Harness.permission 暴露的查询 API）

```typescript
interface PermissionEngine {
  /**
   * 检查一个工具调用是否需要审批，以及为什么。
   *
   * **实现约束**：引擎内部持有 `Map<string, ToolDescriptor>`（构造时从 HarnessConfig.tools 填充）。
   * evaluate() 通过工具名查找对应的 ToolDescriptor，从中提取 @resource 注解以完成 resourceConstraints 匹配。
   * 工具必须在构造时注册——运行时动态添加的工具通过 addRule() 而非 evaluate() 的内部查找。
   */
  evaluate(tool: string, params: Record<string, unknown>): PermissionVerdict

  /** 动态添加/移除规则 */
  addRule(rule: PermissionRule): void
  removeRule(pattern: string): void

  /** 会话级 allow-all / deny-all 覆盖 */
  allowAll(scope: "turn" | "session"): void
  denyAll(scope: "turn" | "session"): void
  resetScope(): void
}

interface PermissionVerdict {
  level: PermissionLevel
  reason: string                                // 匹配的规则描述
  rule?: PermissionRule                         // 命中的规则
}
```

---

## 九、Hooks 系统（HookRegistry 链式注册）

### 9.1 HookRegistry

```typescript
/**
 * HookRegistry — 链式注册，支持多 handler、优先级、短路。
 *
 * 用法：
 *   harness.hooks
 *     .on("beforeThink", injectContext, { priority: 100 })
 *     .on("afterAct", auditLog, { name: "audit" })
 */
interface HookRegistry {
  /**
   * 注册一个 hook handler。
   * @param hook hook 点名称
   * @param handler 处理器函数
   * @param opts.priority 优先级（默认 0），越大越先执行
   * @param opts.once 执行一次后自动注销
   * @param opts.name 名称（用于调试和 .off()）
   * @param opts.signal AbortSignal 用于取消
   * @returns 取消函数
   */
  on<K extends HookName>(
    hook: K,
    handler: HookHandlerMap[K],
    opts?: { priority?: number; once?: boolean; name?: string; signal?: AbortSignal }
  ): Unsubscribe

  /** 按名称移除 */
  off(hook: HookName, name: string): void
  /** 移除某 hook 点所有 handler */
  offAll(hook: HookName): void
}
```

### 9.2 Hook 点定义

```typescript
type HookName = keyof HookHandlerMap

interface HookHandlerMap {
  // ── Session ──
  onSessionStart: (ctx: SessionContext) => Promise<void>
  onSessionEnd: (ctx: SessionContext, result: SessionResult) => Promise<void>

  // ── Turn ──
  beforeThink: (ctx: TurnContext) => Promise<TurnContext | void>
  afterThink: (ctx: TurnContext, events: ThinkEvent[]) => Promise<ThinkEvent[] | void>
  beforeAct: (ctx: TurnContext, call: ToolCall) => Promise<ToolCall | void>
  afterAct: (ctx: TurnContext, call: ToolCall, result: ToolResult) => Promise<void>
  afterObserve: (ctx: TurnContext, observation: Observation) => Promise<Observation | void>

  // ── Compress ──
  beforeCompress: (ctx: TurnContext, level: CompressLevel) => Promise<void>
  afterCompress: (ctx: TurnContext, event: CompressedEvent) => Promise<void>

  // ── Error ──
  onError: (ctx: SessionContext, error: HarnessError) => Promise<ErrorRecovery | void>

  // ── Sub-agent ──
  beforeSpawn: (spec: SubagentSpec) => Promise<SubagentSpec | void>
  afterSpawnResult: (handle: SubagentHandle, result: SubagentResult) => Promise<void>
}
```

### 9.3 短路语义

```typescript
type ErrorRecovery =
  | { action: "retry" }
  | { action: "skip_turn" }
  | { action: "abort"; reason: string }
  | { action: "ignore" }
```

- `beforeThink`：返回值覆盖 ctx；返回 `void` = 不修改。
- `afterThink`：返回值覆盖 events；返回 `void` = 不修改。
- `beforeAct`：返回值覆盖 call；返回 `void` = 不修改。返回 `null` = **取消此工具调用**。
- `onError`：返回 ErrorRecovery 决定恢复策略；返回 `void` = 默认（非可恢复错误 abort）。

### 9.4 执行顺序

```
Priority 高 → 低依次执行。
同一 priority → 注册顺序。
某 handler 抛出异常 → 后续同 hook handler 仍执行（独立错误收集）。
所有 handler 执行完毕后统一检查错误 → 有错误则触发 onError hook。
```

### 9.5 HookInput（Config 语法糖）

```typescript
/**
 * HarnessConfig.hooks 接受 Partial<HookHandlerMap> 或 HookRegistration[]。
 * 传入 Partial 时，所有 handler 默认为 priority=0, once=false。
 */
type HookInput = Partial<HookHandlerMap> | HookRegistration[]

interface HookRegistration {
  hook: HookName
  handler: HookHandlerMap[HookName]
  priority?: number
  once?: boolean
  name?: string
}
```

---

## 十、Sub-agent 系统（完整生命周期状态）

### 10.1 设计原则

```
Coordinator（父 agent 内）—— 只派活：
  - 接收 SubagentSpec
  - 决定 isolation 策略
  - 创建 SubagentHandle
  - 轮询/等待结果
  - 不直接访问文件系统

Worker（独立上下文）—— 全隔离：
  - 拥有自己的 TAOR 循环
  - 受限的工具集（Coordinator 指定）
  - 独立的 token 预算
  - 结果通过结构化通道返回（不通过文件系统）
```

### 10.2 SubagentSpec

```typescript
interface SubagentSpec {
  /** 3-5 词描述，用于日志和进度显示 */
  description: string
  /** Worker 的系统 prompt（定义子 agent 的角色和任务） */
  prompt: string
  /**
   * 可用工具。不传 = 继承父 agent 的全部工具（排除标记了 subagent:deny 的）。
   *
   * **隔离级别限制**：
   * - `inline`：接受 defineTool() / tool() / class Tool 全部三种方式
   * - `process` / `worktree`：仅接受 **class extends Tool 定义在独立可导入模块中** 的工具。
   *   defineTool() 闭包无法通过 IPC 序列化，会在 spawn() 时抛出 `DataCloneError`。
   *   框架在 spawn() 时自动校验——如果 isolation != "inline" 且存在非 class Tool，立即 reject。
   */
  tools?: ToolInput[]
  /** 模型覆盖。不传 = 继承父 */
  model?: string
  /** 隔离级别 */
  isolation?: "inline" | "process" | "worktree"
  /** 强制 structured output（可选） */
  schema?: z.ZodType
  /** 最大 turn 数（默认 20） */
  maxTurns?: number
  /** 超时（毫秒，默认 300_000 = 5 分钟） */
  timeout?: number
}
```

### 10.3 SubagentHandle（完整生命周期状态）

```typescript
interface SubagentHandle {
  readonly id: string
  readonly description: string
  status: SubagentStatus

  /**
   * 等待子 agent 真正启动（worktree 创建、进程 fork 等）。
   * 对于 isolation: "inline"，立即 resolve。
   * 调用方不关心启动时机时可直接 await handle.done()。
   *
   * @throws 如果启动失败（worktree 创建失败等）
   */
  started(): Promise<void>

  /**
   * 等待子 agent 完成（内部会先 await started()）。
   * @returns 结构化结果（有 schema 时类型安全）
   */
  done(): Promise<SubagentResult>

  /** 终止子 agent。pending 时取消启动，running 时发送 abort。 */
  abort(reason?: string): void

  /** 事件监听（旁路） */
  on(event: "started", handler: () => void): Unsubscribe
  on(event: "done", handler: (result: SubagentResult) => void): Unsubscribe
  on(event: "error", handler: (error: SubagentError) => void): Unsubscribe
  on(event: "heartbeat", handler: (h: SubagentHeartbeat) => void): Unsubscribe
  on(event: "status-change", handler: (from: SubagentStatus, to: SubagentStatus) => void): Unsubscribe
}

type SubagentStatus = "pending" | "starting" | "running" | "done" | "error" | "aborted"

interface SubagentResult {
  ok: boolean
  data?: unknown                                // 有 schema 时类型安全
  turns: number
  tokenUsage: TokenUsage
  artifacts?: Artifact[]
  error?: string
}

interface SubagentError {
  code: "startup_failed" | "timeout" | "max_turns" | "execution_error" | "aborted"
  message: string
  subagentId: string
}

interface SubagentHeartbeat {
  subagentId: string
  turnIndex: number
  elapsed: number
  tokenUsage: TokenUsage
}
```

### 10.4 状态转换

```
            spawn()
  pending ──────────→ starting ──────────→ running
    │                     │                    │
    │ abort()             │ startup fails      │ done / error
    ▼                     ▼                    ▼
  aborted              error              done / error / aborted

  状态是不可逆的。
  pending + abort() → aborted（不触发 starting）
  starting + abort() → 等启动完成后立即 abort（或启动失败直接 error）
```

### 10.5 Harness.spawn()

```typescript
class Harness {
  /**
   * 派发子 agent。返回同步句柄。
   * @returns SubagentHandle（status 初始为 "pending"）
   *
   * 行为：
   * - inline:    在当前进程中创建独立 TAOR 循环
   * - process:   fork 子进程，通过 IPC 通信
   * - worktree:  git worktree add → fork 子进程在新的 worktree 中运行
   *
   * **并发安全**：多个并发 spawn() 使用 ULID 生成唯一 worktree 路径（`.claude/worktrees/<ulid>/`），
   * 无需调用方协调。worktree 创建失败时自动重试 1 次（不同路径名），两次均失败则 handle 进入 error 状态。
   */
  spawn(spec: SubagentSpec): SubagentHandle
}
```

---

## 十一、Memory 系统

### 11.1 MemoryConfig

```typescript
interface MemoryConfig {
  /** 用户层存储配置 */
  user: MemoryStoreConfig
  /** 项目层存储配置 */
  project: MemoryStoreConfig
  /** 会话层存储配置 */
  session: MemoryStoreConfig
}

interface MemoryStoreConfig {
  /** 存储后端 */
  backend: "sqlite" | "json" | "memory"
  /** 路径（sqlite/json 时有效） */
  path?: string
  /** 默认 TTL */
  defaultTtl?: number
  /** 最大条目数 */
  maxEntries?: number
}
```

### 11.2 MemoryStore

```typescript
interface MemoryStore {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T, opts?: { ttl?: number; tags?: string[] }): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>
  list(opts?: { prefix?: string; tags?: string[] }): Promise<MemoryEntry[]>
  clear(): Promise<void>
}

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

### 11.3 MemoryFacade（Harness.memory 暴露）

```typescript
interface MemoryFacade {
  user: MemoryStore
  project: MemoryStore
  session: MemoryStore
}
```

### 11.4 默认实现

```
user:    ~/.harness/memory/       → SQLite
project: <workDir>/.harness/memory/ → JSON 文件
session: 内存 Map                 → 进程内
```

---

## 十二、Compressor 系统

### 12.1 CompressorConfig

```typescript
interface CompressorConfig {
  /** 压缩策略优先级（从便宜到贵） */
  pipeline: CompressStrategy[]

  /** 触发阈值：token 数超过此值开始压缩 */
  triggerThreshold: number

  /** 压缩目标：压缩到不超过此 token 数 */
  targetThreshold: number

  /** 最大压缩尝试次数（超过后硬截断） */
  maxAttempts: number

  /** 压缩结果缓存（避免重复压缩同一内容） */
  cacheResults: boolean

  /**
   * 压缩用 LLM Adapter。
   * summarize/embed 策略需要调用 LLM。
   * 不传 = 复用主 LLMAdapter（默认），但要求主 adapter 支持可重入调用。
   * 传入独立 adapter 可避免与主 THINK 阶段争用。
   */
  adapter?: AdapterConstructor
}

interface CompressStrategy {
  name: string
  level: CompressLevel
  /** 预估压缩率（0-1），用于选择策略 */
  estimatedSavings: number
  /** 执行压缩 */
  compress(ctx: TurnContext, opts: { targetTokens: number }): Promise<CompressedContext>
}
```

### 12.2 5 层默认策略（cheap-first）

```
1. trim        — 移除已完成 tool 的冗余输出（去 ANSI、截断大文本）
2. summarize   — LLM 摘要之前的对话（保留决策链，压缩叙述）
3. chunk       — 分块保留：最近 N turn 完整 + 更早 turn 仅摘要
4. embed       — 向量检索：只保留与当前任务相关的历史片段
5. truncate    — 硬截断：FIFO 移除最早的消息
```

---

## 十三、模块树与包结构

```
@harness/
├── core/                       # @harness/core
│   ├── harness.ts              #   Harness 类（主入口）
│   ├── config.ts               #   HarnessConfig 类型 + 校验 + 默认值
│   ├── context.ts              #   HarnessContext（3 层作用域）+ Session/Turn/Shared
│   ├── events.ts               #   HarnessEvent 联合类型（15 variants）
│   ├── session.ts              #   SessionResult, SessionStatus, 生命周期
│   ├── taor-loop.ts            #   TAOR 核心循环实现
│   ├── types.ts                #   共享基础类型（TokenUsage, Artifact, Unsubscribe 等）
│   └── index.ts                #   re-export 所有 public API
│
├── adapters/                   # @harness/adapters
│   ├── types.ts                #   LLMAdapter 接口 + ThinkEvent + AdapterFeature
│   ├── anthropic.ts            #   AnthropicAdapter
│   ├── openai.ts               #   OpenaiAdapter
│   ├── deepseek.ts             #   DeepSeekAdapter
│   └── index.ts
│
├── tools/                      # @harness/tools
│   ├── descriptor.ts           #   ToolDescriptor + defineTool() + tool()
│   ├── base.ts                 #   Tool 抽象类
│   ├── context.ts              #   ToolContext + ToolResult + ToolErrorCode
│   ├── registry.ts             #   ToolRegistry（注册 + 冲突检测）
│   ├── builtin/                #   内置工具
│   │   ├── read.ts
│   │   ├── write.ts
│   │   ├── edit.ts
│   │   ├── bash.ts
│   │   ├── glob.ts
│   │   ├── grep.ts
│   │   └── index.ts
│   └── index.ts
│
├── permission/                 # @harness/permission
│   ├── engine.ts               #   PermissionEngine
│   ├── types.ts                #   PermissionConfig, PermissionRule, PermissionVerdict
│   ├── resource.ts             #   @resource 注解解析 + 约束匹配
│   └── index.ts
│
├── hooks/                      # @harness/hooks
│   ├── registry.ts             #   HookRegistry（链式注册 + 优先级 + 短路）
│   ├── types.ts                #   HookHandlerMap, HookName, HookRegistration
│   └── index.ts
│
├── subagent/                   # @harness/subagent
│   ├── coordinator.ts          #   SubagentCoordinator（spawn 实现）
│   ├── worker.ts               #   SubagentWorker（独立 TAOR 循环）
│   ├── handle.ts               #   SubagentHandle（生命周期状态机）
│   ├── types.ts                #   SubagentSpec, SubagentResult, SubagentStatus
│   └── index.ts
│
├── memory/                     # @harness/memory
│   ├── facade.ts               #   MemoryFacade
│   ├── store.ts                #   MemoryStore 接口 + 3 种后端实现
│   ├── types.ts                #   MemoryConfig, MemoryEntry
│   └── index.ts
│
├── compressor/                 # @harness/compressor
│   ├── pipeline.ts             #   5 层 cheap-first pipeline
│   ├── strategies/             #   各策略实现
│   │   ├── trim.ts
│   │   ├── summarize.ts
│   │   ├── chunk.ts
│   │   ├── embed.ts
│   │   └── truncate.ts
│   ├── types.ts                #   CompressorConfig, CompressStrategy
│   └── index.ts
│
└── harness-engine/             # @harness/engine（聚合包）
    ├── index.ts                #   createHarness() + re-export 所有子系统
    └── package.json            #   dependencies: 上述所有包
```

---

## 十四、DX 场景

### 场景 A：最小 CLI Agent（12 行）

```typescript
import { createHarness, defineTool } from "@harness/engine"
import * as z from "zod"

const readFile = defineTool({
  name: "ReadFile",
  description: "Read a file",
  parameters: z.object({ file_path: z.string().describe("@resource:fs-path") }),
  permissions: ["fs-read"],
  risk: "low",
  async execute({ file_path }, ctx) {
    const c = await Deno.readTextFile(file_path)
    return { ok: true, data: { content: c } }
  },
})

const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [readFile],
  permission: { mode: "interactive" },
})

for await (const event of harness.start(prompt)) {
  if (event.type === "approval-required") {
    // 终端 UI 渲染审批 → 等用户输入 → 注入
    const userInput = await askUserInTerminal(event)
    harness.next(userInput.approved
      ? { type: "approve", callId: event.callId }
      : { type: "deny", callId: event.callId, reason: userInput.reason })
  }
  if (event.type === "thought" && event.kind === "text") {
    process.stdout.write(event.content)
  }
}
// 循环结束后，SessionResult 通过 generator done-value 返回（for await 丢弃它）。
// 如需最终结果，通过 harness.state / harness.tokenUsage 查询：
console.log(`\n✅ ${harness.state.turnCount} turns, ${harness.tokenUsage.total} tokens`)
```

### 场景 B：Code Review Bot（Sub-agent + Hooks + Permission）

```typescript
const harness = createHarness({
  model: "claude-opus-4-8",
  tools: [readFile, grep, glob, bash],
  permission: {
    mode: "custom",
    rules: [
      { level: "allow",    pattern: "Read*" },
      { level: "boundary", pattern: "Write*", resourceConstraints: { paramAnnotation: "@resource:fs-path", allowlist: ["./src/**", "./output/**"] } },
      { level: "deny",     pattern: "Bash", resourceConstraints: { paramAnnotation: "@resource:shell-command", denylist: ["rm *", "sudo *", "chmod *"] } },
    ],
    defaultLevel: "ask",
  },
})

// 审计日志：旁路监听，不影响主循环
harness.on("tool-call", (e) => auditLog.write({ type: "tool-call", ...e }))
harness.on("tool-result", (e) => auditLog.write({ type: "tool-result", ...e }))
harness.on("compressed", (e) => metrics.gauge("harness.compression.savings", e.savingsPercent))

// 注入项目上下文
harness.hooks.on("beforeThink", async (ctx) => {
  ctx.shared.loadedResources.set("claudeMd", await fs.readFile(".claude/CLAUDE.md", "utf-8"))
})

// 并行派活：两个独立审查
const [security, perf] = await Promise.all([
  harness.spawn({
    description: "Security audit",
    prompt: "Find security vulnerabilities in the diff: injection, auth bypass...",
    tools: [grep, readFile],
    isolation: "worktree",
  }).done(),
  harness.spawn({
    description: "Performance review",
    prompt: "Find perf issues in the diff: N+1 queries, missing indexes...",
    tools: [grep, readFile],
    isolation: "worktree",
  }).done(),
])
```

### 场景 C：替换 DeepSeek Adapter + 非交互模式

```typescript
const harness = createHarness({
  model: "deepseek-v4-pro",
  adapter: DeepSeekAdapter,
  tools: [/* ... */],
  permission: {
    mode: "non-interactive",
    defaultLevel: "allow",
    nonInteractiveDefault: "allow",
  },
})

// 非交互模式：无审批挂起，直接跑完
// 非交互模式：无审批挂起。使用 .next() 手动迭代以捕获 SessionResult
const result = await (async () => {
  harness.start("Run the test suite and report results")
  let done = await harness.next()
  while (!done.done) {
    const event = done.value
    if (event.type === "error") console.error(`[${event.error.code}] ${event.error.message}`)
    if (event.type === "approval-required") {
      // 非交互模式也可能触发审批（fallback）
      harness.next({ type: "approve", callId: event.callId })
    }
    done = await harness.next()
  }
  return done.value  // SessionResult
})()
```

---

## 十五、审理修正清单

| # | 严重度 | 问题 | 修正 | 影响文件 |
|---|--------|------|------|---------|
| 1 | 🔴 | AsyncGenerator 单播，无法满足日志/审计/监控等多观察者需求 | Harness 加 `on()/off()/offAll()` EventEmitter 多播旁路 | `core/harness.ts` |
| 2 | 🔴 | Tool 只有 class，拒绝函数式生态、强制 Zod 耦合 | 引入 `defineTool()` / `tool()` + 内部 `ToolDescriptor` 规范化。class 保留 | `tools/descriptor.ts`, `tools/base.ts` |
| 3 | 🔴 | Adapter 只有 3 方法，无法构建真实 provider adapter | 扩展为 7 方法 + `ThinkEvent` 联合类型 + `AdapterFeature` 能力查询 | `adapters/types.ts` |
| 4 | 🟡 | Permission 规则与 Tool 参数的耦合是隐式的 | 引入 `@resource:<type>` Zod `.describe()` 注解 + `resourceConstraints` 规则字段 | `permission/resource.ts` |
| 5 | 🟡 | Hooks 平的 interface，无多 handler、优先级、短路 | `HookRegistry` 链式注册 + `priority` + `HookInput` Config 语法糖 | `hooks/registry.ts` |
| 6 | 🟡 | SubagentHandle 无启动状态，worktree 异步创建失败时调用方无感知 | 加 `started()` promise + `pending`/`starting` 状态 + 状态机 | `subagent/handle.ts` |
| 7 | 🟡 | Tool class vs SubagentSpec literal 模式不一致 | 通过 #2 自然对齐：都是"定义→引擎消费" | 文档 |
| 8 | 🟢 | 无 Plugin/Extension 注册机制 | `harness.use(plugin)` — v2 | v2 |
| 9 | 🟢 | 无测试工具 | `MockAdapter`, `createTestHarness()` — v1 包含 | v1 |
| 10 | 🟢 | SessionResult 不含 Sub-agent artifacts 汇总 | `Artifact.source` 字段已包含，递归收集 — 规范文档中声明 | 文档 |

---

> **设计定稿时间**：2026-06-11
> **下一阶段**：按此规范进入 TG0 实现。实现顺序：core types → Tool 系统 → Adapter → Harness 主循环 → Permission → Hooks → Sub-agent → Compressor → Memory
