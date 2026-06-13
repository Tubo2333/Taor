# Architecture Review: Commit `4c2deb4` — TG3 20 Fixes for Production Readiness

**Review date**: 2026-06-13
**Reviewer**: External architecture auditor (zero shared context)
**Scope**: `git diff HEAD~1` — 55 files, +1758/−123, 10 packages
**Verdict**: **PASS_WITH_FIXES** — 必须修 3 CRITICAL + 5 HIGH 才能发布

---

## 总体判断

20 项修复 directionally correct。核心架构（依赖反转 + 结构接口 + 10 包分离）没有倒退。但引入了 1 个 CRITICAL（库代码里调 `process.exit()`）和 5 个 HIGH（重试信号缺失、反序列化空对象、TTL 定时器泄漏、空指针守卫不一致、接口漂移风险）。

**发布阻塞**: CRITICAL + HIGH 共 6 项必须先修。MEDIUM 8 项建议修。LOW 4 项可延后。

---

## 修改清单（按优先级）

### 🔴 CRITICAL

#### C1. `validateEnv()` 库代码内调用 `process.exit(1)` — 必须改为 throw

**文件**: `packages/core/src/env.ts:8-13`，被 `packages/engine/src/index.ts:88-92` 调用

**问题**: 框架/库代码绝对不应该杀宿主进程。`createHarness()` 在默认 adapter 且缺 key 时调 `validateEnv()`，直接 `process.exit(1)`，调用方没有任何机会优雅处理（比如弹 UI 提示、查别的 env var、fallback mock）。

**修复**:
```ts
// packages/core/src/env.ts
// 删除 process.exit(1)，改为 throw Error
export function validateEnv(): void {
  const missing: string[] = []
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY")
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
      "Copy .env.example to .env and fill in the values."
    )
  }
}
```

然后在 CLI 入口 `packages/cli/src/index.ts` 的 `main()` 函数最前面，加 try-catch 并在此处 `process.exit(1)`（只有 CLI 入口可以杀进程）。

---

#### C2. `deserialize()` 返回半初始化对象 — 必须改为参数注入

**文件**: `packages/core/src/harness.ts:1905-1941` (deserialize 方法), `packages/engine/src/index.ts:110-122` (注入点)

**问题**: `Harness.deserialize()` 用 `undefined as unknown as IAdapter` 构造 Harness，然后靠 `createHarness()` 用 `(harness as any).adapter = ...` 事后注入。若任何人直接调 `Harness.deserialize()` 不走 `createHarness()`，adapter/registry 为 undefined，TAOR loop 在 `this.adapter.think()` 处抛 `TypeError: Cannot read properties of undefined`，且无任何守卫/报错信息。

**修复**: 让 `deserialize` 直接接受 adapter 和 registry 参数，消除 post-construction 注入和 `undefined` cast：

```ts
// packages/core/src/harness.ts — deserialize 签名改为:
static deserialize(
  data: SerializedSessionData,
  config: ResolvedConfig,
  adapter: IAdapter,
  registry: IToolRegistry,
): Harness {
  const harness = new Harness(
    { ...config, session: { ...config.session, id: data.sessionId } },
    adapter,
    registry,
  )
  // ... 恢复 session state（不变）
  return harness
}
```

```ts
// packages/engine/src/index.ts — createHarness 中调用改为:
const harness = snapshot
  ? Harness.deserialize(snapshot as any, resolved, adapter as any, registry as any)
  : new Harness(resolved, adapter as any, registry as any)

// 删除 snapshot 分支的 post-construction 注入代码（原 117-122 行）
```

---

#### C3. adapter/registry 缺少空指针守卫（与其他 5 个子系统不一致）

**文件**: `packages/core/src/harness.ts` — adapter 和 registry 直接字段访问

**问题**: permission/hooks/memory/compressor/subagent 都通过 getter 访问并在未注入时抛描述性错误。唯独 adapter 和 registry 是裸字段访问，未注入时抛 `TypeError` 而非有意义的报错。

**修复**: 将 adapter 和 registry 改为 getter 模式：

```ts
// harness.ts — 添加 getter
get adapter(): IAdapter {
  if (!this._adapter) {
    throw new Error(
      "Harness.adapter not initialized — use createHarness() which provides AnthropicAdapter as default."
    )
  }
  return this._adapter
}

get registry(): IToolRegistry {
  if (!this._registry) {
    throw new Error(
      "Harness.registry not initialized — use createHarness() which provides ToolRegistry as default."
    )
  }
  return this._registry
}
```

构造函数内部改用 `this._adapter` / `this._registry` 私有字段，TAOR loop 内所有 `this.adapter` / `this.registry` 改为通过 getter 访问。

---

### 🟠 HIGH

#### H1. `withRetry` 退避等待期间不检查 AbortSignal

**文件**: `packages/adapters/src/anthropic.ts:395-413`

**问题**: 重试退避用 `setTimeout` 最长等 16 秒，期间即使 signal 已 abort，仍会发出下一次 HTTP 请求（然后被 SDK 抛 AbortError 截住）。浪费一次 round-trip + 最多 16s 延迟。

**修复**: 退避期间监听 signal 并提前终止：

```ts
private async withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 4,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error("Aborted")
    try {
      return await fn()
    } catch (err: any) {
      if (attempt >= maxRetries) throw err
      const status = err?.status ?? err?.response?.status
      const code = err?.code ?? err?.error?.code
      if (status === 429 || (status && status >= 500) || status === 408
          || code === "ENOTFOUND" || code === "ECONNRESET" || code === "ETIMEDOUT") {
        const delay = Math.min(1000 * Math.pow(2, attempt), 16000)
        await new Promise<void>((r, reject) => {
          const t = setTimeout(r, delay)
          signal?.addEventListener("abort", () => {
            clearTimeout(t)
            reject(new Error("Aborted"))
          }, { once: true })
        })
        continue
      }
      throw err
    }
  }
  throw new Error("Unreachable")
}
```

然后在 `think()` 中调用时传入 signal：
```ts
const stream = await this.withRetry(
  () => client.messages.create({ ...params, stream: true as const }, { signal }),
  4,
  signal,  // ← 新增
)
```

---

#### H2. TTL 清理定时器未调用 `.unref()` — 阻止进程退出

**文件**: `packages/memory/src/store.ts:343-347`

**问题**: `setInterval(..., 120_000)` 持有事件循环引用。如果用户忘记调 `close()`（异常退出、unhandled exception 等），定时器阻止 Node.js 干净退出。

**修复**: 第 347 行后加一行：
```ts
this._cleanupTimer = setInterval(() => {
  try {
    this.db?.prepare("DELETE FROM memory WHERE expires_at IS NOT NULL AND expires_at < ?").run(Date.now())
  } catch { /* best-effort */ }
}, 120_000)
this._cleanupTimer.unref()  // ← 加这一行：不阻止事件循环退出
```

---

#### H3. 结构接口漂移风险 — 缺少接口一致性自动化测试

**文件**: `packages/core/src/harness.ts` (结构接口 IAdapter, IToolRegistry, IMemoryFacade 等) vs 各子系统规范接口

**问题**: 代码中 TODO 第 81 行 `// TODO(mono-D3): Add integration smoke test — createHarness({model, tools:[]}) must not throw.` 仍未实现。本次 commit 又增加了 `backendType` 到 `IMemoryFacade` 和 `metrics` getter —— 若规范接口加字段而结构接口未同步，TypeScript 不会报错（因为 `as any` 桥接），只有运行时炸。

**修复**: 写一个类型层面的编译时检查（不需要运行）：

在 `packages/engine/src/` 下新增 `interface-conformance.test.ts`（或 `interface-conformance.check.ts`）：

```ts
// 编译时结构接口一致性检查
// 如果规范接口加了必填字段而结构接口没加，下面的赋值会报编译错误
import type { IAdapter } from "../harness.js" // 实际上 structural 类型在 harness.ts 里不是 export 的
// 做法：把 harness.ts 中的结构接口 export 出来，然后做编译时赋值检查
```

或者在 `harness.ts` 中把所有结构接口加上 `export` 关键字，在 engine 中写：
```ts
import type { IAdapter as StructuralAdapter } from "@taor/core"
import type { LLMAdapter } from "@taor/adapters"
const _check1: StructuralAdapter = null as unknown as LLMAdapter
const _check2: LLMAdapter = null as unknown as StructuralAdapter
```
这两行赋值如果不兼容会报编译错误 → CI 里的 `npm run typecheck` 就能拦住。

---

#### H4. P2-17 `__modulePath` 工具缺少路径时静默跳过

**文件**: `packages/subagent/src/coordinator.ts:218-225`

**问题**: 用户指定 `isolation: "process"` 但 tool class 忘了设 `static __modulePath` → 工具被静默跳过 → 子进程里找不到工具 → 神秘报错。

**修复**: 加 warn 日志：
```ts
const toolModulePaths: string[] = []
if (spec.tools) {
  for (const t of spec.tools) {
    const path = (t as any).__modulePath as string | undefined
    if (path) {
      toolModulePaths.push(path)
    } else {
      this.logger.warn(
        `[SubagentCoordinator] Tool "${(t as any).name ?? 'unknown'}" has no __modulePath — ` +
        `cannot use in process isolation. Set static __modulePath = import.meta.url on the tool class.`
      )
    }
  }
}
```

---

#### H5. `createHarness` 环境检查对 AnthropicAdapter 子类误判

**文件**: `packages/engine/src/index.ts:88-92`

**问题**: `config.adapter === AnthropicAdapter` 用引用相等判断。若用户写 `class MyAdapter extends AnthropicAdapter { constructor() { super({apiKey: "hardcoded"}) } }`，引用不相等 → 环境检查跳过（正确但有隐患）。反例：若用户写 `class MyAdapter extends AnthropicAdapter {}` 不覆盖构造函数 → 引用不相等 → 环境检查跳过 → 构造时 key 为空 → 抛错。虽然抛错信息清晰，但 `validateEnv()` 的提前检查被绕过了。

**修复**: 用 `instanceof` 或检查 adapter 实例的 `provider` 属性：
```ts
// 更稳健的检查：尝试实例化后检查，或检查 prototype chain
const AdapterCtor = (resolved.adapter ?? AnthropicAdapter) as typeof AnthropicAdapter
const needsKey = AdapterCtor === AnthropicAdapter || AdapterCtor.prototype instanceof AnthropicAdapter
if (needsKey && !process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    "ANTHROPIC_API_KEY environment variable is required. " +
    "Get your key at https://console.anthropic.com/ and set it."
  )
}
```
注意：如果用 `instanceof`，需先 import `AnthropicAdapter` 的值而不仅是 type。

---

### 🟡 MEDIUM

#### M1. `ProcessWorker.kill()` 的 SIGKILL/SIGTERM 注释和三元表达式都误导

**文件**: `packages/subagent/src/process-worker.ts:158-168`

问题：注释说 "SIGTERM is not available on Windows"，但实际上 `SIGKILL` 在 Windows 上也不是真正的信号。Node.js 在 Windows 上把两个都映射到 `TerminateProcess`。三元表达式没有实际意义。

**修复**: 直接用 `"SIGTERM"`（Node.js 自动处理跨平台）并修正注释：
```ts
kill(): void {
  if (this.child) {
    this.child.kill("SIGTERM")  // Node.js handles platform mapping internally
    this.child = null
  }
}
```

---

#### M2. `validateEnv` 在 `createHarness` 中的调用应改为 throw + 在 CLI 入口处 catch

**文件**: `packages/engine/src/index.ts:88-92` + `packages/cli/src/index.ts`

这是 C1 修复的延伸：`createHarness` 中不再调 `validateEnv()`（它应该只 throw），而是直接做内联检查并 throw。CLI 入口在 `main()` 最前面 try-catch 所有 `createHarness` 调用。

```ts
// engine/src/index.ts — 替换原来的 validateEnv() 调用：
if (!config.adapter || (config.adapter as unknown) === AnthropicAdapter) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required. " +
      "Get your key at https://console.anthropic.com/ and set it:\n" +
      "  export ANTHROPIC_API_KEY=sk-ant-...\n" +
      "Or copy .env.example to .env and fill in the value."
    )
  }
}
```

```ts
// cli/src/index.ts — main() 中：
async function main() {
  try {
    const harness = createHarness({ ... })
    // ...
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
```

---

#### M3. 7 个包缺少 `@types/node` devDependency

使用 Node.js API（`setInterval`、`createRequire`、`fileURLToPath`、`child_process`、`process.env`）的包依赖根目录 hoisting。单独发布到 npm 后，非 workspace 消费者可能缺类型。

**受影响包**: `memory`, `subagent`, `engine`, `adapters`, `cli`, `compressor`, `hooks`

**修复**: 在以下包的 `devDependencies` 中加 `"@types/node": "^22.0.0"`:
- `packages/memory/package.json`
- `packages/subagent/package.json`
- `packages/engine/package.json` (已有，检查)
- `packages/adapters/package.json`
- `packages/compressor/package.json`
- `packages/hooks/package.json`

---

#### M4. `remote-entry.ts` 子进程孤儿检测缺主动心跳超时

**文件**: `packages/subagent/src/remote-entry.ts:55-57`

当前 `process.on("disconnect", () => process.exit(1))` 只能检测 IPC 断开（父进程崩溃）。父进程 JS 线程卡死（infinite loop）时 IPC 不断开，子进程变孤儿。

**修复**: 加心跳超时主动检测：
```ts
let lastHeartbeat = Date.now()
const HEARTBEAT_TIMEOUT = 60_000  // 60s

process.on("message", (msg) => {
  lastHeartbeat = Date.now()
  // ... existing message handling
})

const heartbeatCheck = setInterval(() => {
  if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT) {
    process.exit(1)
  }
}, 10_000)
```

---

#### M5. 默认 Logger 从 NOOP 改为 CONSOLE — CHANGELOG 未记录

**文件**: `packages/core/src/config.ts:119-124`

行为变更：之前框架默认静默，现在默认输出 `[Harness:info]` 等日志。可能污染生产环境 stdout。

**修复**: 在 CHANGELOG 中明确记录此变更。可选：加 `verbose` 配置项控制默认 logger 的输出级别。

---

#### M6. 子进程 `disconnect` handler 用 `process.exit(1)` 但退出码不应为 1

**文件**: `packages/subagent/src/remote-entry.ts:55-57`

父进程主动断开 IPC 时子进程 `process.exit(1)` 表示异常退出，会让 PM2 等进程管理器误判为 crash 并触发 restart。

**修复**: 使用 `process.exit(0)`—— 正常终止：
```ts
process.on("disconnect", () => {
  process.exit(0)
})
```

---

#### M7. 子进程 `disconnect` 后 `process.exit` 可能和 `finally` 中 `kill()` 冲突

**文件**: `packages/subagent/src/process-worker.ts:136` + `remote-entry.ts:55-57`

`process-worker.ts` `run()` 的 `.finally(() => { this.kill() })` 和 `remote-entry.ts` 的 `process.on("disconnect", () => process.exit(1))` 可能同时触发——`finally` 在 Promise resolve/reject 后执行，而 `disconnect` 可能在 `finally` 执行前/中/后触发。虽然 Node.js 处理重复终止是幂等的，但退出码冲突需统一。

**修复**: 与 M6 一起修——子进程 disconnect → exit(0)，父进程 kill() → 发 SIGTERM 后子进程优雅退出。

---

#### M8. `examples/real.ts` 没有错误处理

**文件**: `examples/real.ts:11-18`

若 API key 缺失 → `createHarness` throw Error（修复 C1 后）→ 未捕获的 Promise rejection → Node.js 打印丑陋的堆栈。

**修复**: 在 `real.ts` 加 try-catch，和 `basic.ts` 一样的 `main().catch(console.error)` 模式。

---

### 🟢 LOW

#### L1. `EchoAdapter` mock 的 `buildRequest` 返回类型不完整

**文件**: `examples/basic.ts:12`

`async buildRequest() { return {} }` 返回 `{}`，IAdapter.buildRequest 期望 `Promise<unknown>`。运行时因 `as any` 能跑，但 typed context 下报错。可忽略（mock 仅用于示例）。

---

#### L2. Dockerfile 层缓存不优化

**文件**: `Dockerfile:3-6`

`COPY packages/ ./packages/` 在 `npm ci` 之前 → 源码变动使 `npm ci` 层失效。标准做法：先 `COPY packages/*/package.json` → `npm ci` → 再 `COPY packages/ ./packages/`。

**修复**:
```dockerfile
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/*/package.json ./packages/
RUN npm ci
COPY packages/ ./packages/
RUN npm run build
```

---

#### L3. `_tools` 参数在 `runProcessWorker` 中未使用

**文件**: `packages/subagent/src/coordinator.ts:204`

`_tools` 前缀表明有意忽略，但标注为 `CoordinatorTool[]` 类型却从未使用，容易让维护者困惑——工具通过 modulePath 在子进程中加载，不是通过参数传递。

**修复**: 删除该参数，或加注释说明为何不在此处使用。

---

#### L4. `package-lock.json` 中 better-sqlite3 的 optional 依赖链过长

better-sqlite3 → prebuild-install → tar-fs → ... 引入 20+ optional 包。`npm install --omit=optional` 可裁剪，但需在文档中说明。

---

## 修改顺序建议

按依赖关系分 3 批：

### Batch 1（无依赖，立即修）
1. **C1** — `validateEnv()` 改 throw
2. **C3** — adapter/registry getter 守卫
3. **H2** — TTL 定时器 `.unref()`
4. **M1** — ProcessWorker kill 信号统一
5. **M6** — disconnect exit(0)
6. **M7** — 子进程退出码冲突

### Batch 2（依赖 Batch 1）
7. **C2** — deserialize 参数注入（需先有 C3 的 getter 守卫）
8. **H1** — withRetry signal 检查
9. **H4** — __modulePath warn 日志
10. **H5** — AnthropicAdapter 子类检测

### Batch 3（收尾）
11. **H3** — 接口一致性编译检查
12. **M2** — CLI try-catch
13. **M3** — @types/node 补齐
14. **M4** — 子进程心跳超时
15. **M5** — CHANGELOG 更新
16. **M8** — example try-catch
17. **L1–L4** — 低优先级

---

## 验证清单

修完后逐项验证：

- [ ] `npm run build` 全部 10 包通过
- [ ] `npm run typecheck` 零错误
- [ ] `npm run test` 全部通过（含新增 IPC test）
- [ ] `node examples/basic.js` 正常运行（不需要 API key）
- [ ] 不设 `ANTHROPIC_API_KEY` 时 `node examples/real.js` 打印清晰的错误信息（不打印裸堆栈）
- [ ] 设 `ANTHROPIC_API_KEY` 后 `node examples/real.js` 正常调用 Anthropic API
- [ ] 新增 `interface-conformance` 类型检查能跑通
- [ ] `CHANGELOG.md` 记录了 logger 默认值变更
- [ ] 所有 `.npmignore` 文件不变（已正确）
