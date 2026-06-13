# TG0.1 修复指令

> 基于 TG0 全 12 步系统性交叉审查（2026-06-12），P0/P1 优先级修复清单。
> **执行方式**：逐项阅读 → 修改代码 → 每改完一项标注 `[x]`。

---

## P0 — 致命（1 项）

### [ ] F1. fireOnError 传递 broken context 导致 onError handler 必然崩溃

**文件**：`packages/hooks/src/registry.ts` 第 319 行

**问题**：`fireOnError` 内部调用 `entry.handler({ session: null, turn: null, shared: null }, errors[0])`。
任何 onError handler 访问 `ctx.session.id` 都会抛 TypeError。由于外层 catch 吞了异常，崩溃是静默的。

**修复**：将 `fireOnError` 的方法签名改为接收`SessionContext`参数。
1. `fireOnError(errors: HarnessError[])` → `fireOnError(errors: HarnessError[], sessionCtx?: SessionContext)`
2. 第 319 行改为：`await entry.handler(sessionCtx ?? { session: null as any, shared: { projectRoot: "", projectConfig: null, loadedResources: new Map() } }, errors[0]!)`
3. 在 `execute()` 中调用 `fireOnError` 时（第 225 行），如果第一个 hook 参数是 SessionContext，传递它。

**改完后验证**：`cd d:/C-file/Harness_Engineer && npm run typecheck`

---

## P1 — 重要（5 项）

### [ ] I10. TAOR 循环添加 compress() 自动触发

**文件**：`packages/core/src/harness.ts`，在 `runTAOR()` 的 OBSERVE 阶段后（约第 1015 行 turn-ended 事件前）

**问题**：CompressorPipeline 已实现 trim+truncate，但 TAOR 循环从不调用 compress()。消息无限增长。

**修复**：在 turn-ended 事件推送前插入以下代码：
```typescript
// ── Compressor: check token budget at turn boundary ──
if (this.compressorPipeline) {
  const totalTokens = this.totalTokens.total
  // TG0: simple threshold check. TG1: use CompressorPipeline.triggerThreshold.
  if (totalTokens > 100_000) {
    const compressed = await this.compressorPipeline.compress(ctx)
    this.pushEvent({
      type: "compressed",
      turnId,
      level: compressed.level as CompressLevel,
      beforeTokens: totalTokens,
      afterTokens: compressed.tokenCount,
      savingsPercent: Math.round((1 - compressed.tokenCount / totalTokens) * 100),
      strategy: compressed.strategy,
      timestamp: Date.now(),
    })
  }
}
```

**注意**：需要在文件顶部 import `CompressLevel`（已在 types.ts 中，确认 harness.ts 已导入或新增导入）。

**改完后验证**：`cd d:/C-file/Harness_Engineer && npm run typecheck`

---

### [ ] I11. JsonStore 添加 process.on('exit') 自动 flush

**文件**：`packages/memory/src/store.ts`，在 `JsonStore` 类的 `constructor` 末尾

**问题**：JsonStore dirty 数据只有手动调用 `flush()` 才会持久化。进程退出时数据丢失。

**修复**：在 constructor 末尾注册：
```typescript
// Auto-flush on process exit to prevent data loss
// TG0: synchronous flush on exit. TG1: async on beforeExit.
const flushOnExit = () => { if (this.dirty) this.save() }
process.on("exit", flushOnExit)
```

并在类中添加清理方法（可选）：
```typescript
/** Remove process exit listeners. Call before explicit dispose. */
dispose(): void {
  process.removeListener("exit", flushOnExit)
}
```

**注意**：`process.on("exit")` 只支持同步操作，而 `save()` 是同步的（writeFileSync），所以安全。

**改完后验证**：`cd d:/C-file/Harness_Engineer && npm run typecheck`

---

### [ ] I7. SubagentCoordinator 添加 onError hook 调用

**文件**：`packages/subagent/src/coordinator.ts`，第 193-198 行的 `.catch()` 块

**问题**：Worker 异常只调用 `handle._onError()`，不触发 onError hook。与 harness.ts 的 adapter 错误处理不一致。

**修复**：在 `handle._onError(...)` 之后添加：
```typescript
// I-7: Fire onError hook for worker errors (parity with harness.ts adapter error handling)
if (this.hookRegistry) {
  this.hookRegistry.execute("onError", {
    session: { id: `subagent-${id}`, workDir: "", model: "", startedAt: Date.now(), status: "error", tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, turnCount: 0 },
    shared: { projectRoot: "", projectConfig: null, loadedResources: new Map() },
  }, {
    code: "execution_error",
    message: err instanceof Error ? err.message : String(err),
    source: "subagent",
    recoverable: false,
    cause: err,
    timestamp: Date.now(),
  })
}
```

**改完后验证**：`cd d:/C-file/Harness_Engineer && npm run typecheck`

---

### [ ] I8. 工具执行错误添加 onError hook 调用

**文件**：`packages/core/src/harness.ts`，第 886-907 行的工具执行 catch 块

**问题**：ACT phase 工具执行异常不触发 onError hook，只有 adapter 错误触发。

**修复**：在 catch 块中（第 907 行 `}` 后，`toolResults.push` 前）插入：
```typescript
// I-8: Fire onError hook for tool execution errors (parity with adapter error handling)
if (this.hookRegistry) {
  this.hookRegistry.execute(
    "onError",
    {
      session: this.sessionState,
      shared: {
        projectRoot: this.config.session.workDir,
        projectConfig: null,
        loadedResources: new Map(),
      },
    },
    {
      code: "tool_execution_error",
      message: err instanceof Error ? err.message : String(err),
      source: "tool",
      recoverable: true,
      cause: err,
      timestamp: Date.now(),
    } as HarnessError,
  )
}
```

**改完后验证**：`cd d:/C-file/Harness_Engineer && npm run typecheck`

---

### [ ] I9. beforeSpawn/afterSpawnResult hooks 改为 await

**文件**：`packages/subagent/src/coordinator.ts`

**问题**：两个 hook 调用未 await，async handler 的 Promise rejection 被静默吞没，beforeSpawn 的 spec 修改被忽略。

**修复**：需要将 `spawn()` 方法改为 async 或至少 await hook 调用。
1. 第 128-131 行，将 `this.hookRegistry.execute("beforeSpawn", spec)` 改为 `await this.hookRegistry.execute("beforeSpawn", spec)`，并应用返回值修改 spec：
```typescript
if (this.hookRegistry) {
  const spawnResults = await this.hookRegistry.execute("beforeSpawn", spec)
  // Apply the last non-void SubagentSpec modification
  for (const r of spawnResults) {
    if (r && typeof r === "object" && "description" in (r as Record<string, unknown>)) {
      spec = { ...spec, ...(r as Partial<SubagentSpec>) }
    }
  }
}
```
2. 第 189-191 行，将 `this.hookRegistry.execute("afterSpawnResult", handle, result)` 改为 `await this.hookRegistry.execute("afterSpawnResult", handle, result)`
3. spawn() 方法签名改为 `async spawn(spec: SubagentSpec): Promise<SubagentHandle>`
4. 更新 harness.ts 中 ISubagentCoordinator 的 spawn 签名和 harness.spawn() 方法签名也为 async

**改完后验证**：`cd d:/C-file/Harness_Engineer && npm run typecheck`

---

## 全局验证

全部修改完成后执行：

```bash
cd d:/C-file/Harness_Engineer && npm run build && npm run typecheck
```

必须零错误通过。

---

## 修改记录

| # | 优先级 | 编号 | 文件 | 状态 |
|---|--------|------|------|------|
| 1 | P0 | F1 | packages/hooks/src/registry.ts | [x] |
| 2 | P1 | I10 | packages/core/src/harness.ts | [x] |
| 3 | P1 | I11 | packages/memory/src/store.ts | [x] |
| 4 | P1 | I7 | packages/subagent/src/coordinator.ts | [x] |
| 5 | P1 | I8 | packages/core/src/harness.ts | [x] |
| 6 | P1 | I9 | packages/subagent/src/coordinator.ts + packages/core/src/harness.ts | [x] |
