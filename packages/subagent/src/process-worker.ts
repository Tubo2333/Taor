// @harness/subagent — ProcessWorker (child_process.fork isolation)

import { fork, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import type { TokenUsage } from "@harness/core"
import type { SubagentSpec, SubagentResult } from "./types.js"
import type { SubagentHandleImpl } from "./handle.js"

// ═══════════════════════════════════════════════════════════════════
// ─── IPC Messages ───
// ═══════════════════════════════════════════════════════════════════

interface IpcStarted { type: "started" }
interface IpcHeartbeat { type: "heartbeat"; turn: number; elapsed: number; tokenUsage: TokenUsage }
interface IpcDone { type: "done"; result: SubagentResult }
interface IpcError { type: "error"; error: { code: string; message: string } }

type IpcMessage = IpcStarted | IpcHeartbeat | IpcDone | IpcError

// ═══════════════════════════════════════════════════════════════════
// ─── ProcessWorker ───
// ═══════════════════════════════════════════════════════════════════

/**
 * ProcessWorker — spawns a child process via child_process.fork().
 *
 * The child runs `remote-entry.ts` which imports the adapter + tools,
 * executes a TAOR loop, and reports results via IPC.
 *
 * Only `class extends Tool` is supported for process isolation —
 * `defineTool()` closures cannot be serialized across process boundaries.
 */
export class ProcessWorker {
  private handle: SubagentHandleImpl
  private child: ChildProcess | null = null
  private abortController = new AbortController()

  constructor(handle: SubagentHandleImpl) {
    this.handle = handle
  }

  /**
   * Spawn the child process and run the subagent.
   * Returns when the child completes (done or error).
   */
  async run(
    spec: SubagentSpec,
    adapterModulePath: string,
    toolModulePaths: string[],
  ): Promise<SubagentResult> {
    const entryPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "remote-entry.js",
    )

    return new Promise<SubagentResult>((resolve, reject) => {
      try {
        this.child = fork(entryPath, [], {
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        })
      } catch (err) {
        this.handle._onError({
          code: "startup_failed",
          message: `Failed to fork child process: ${err instanceof Error ? err.message : String(err)}`,
          subagentId: this.handle.id,
        })
        reject(err)
        return
      }

      // ── IPC listener ──
      this.child.on("message", (msg: IpcMessage) => {
        switch (msg.type) {
          case "started":
            this.handle._onStarted()
            break

          case "heartbeat":
            this.handle._onHeartbeat(msg.turn, msg.elapsed, msg.tokenUsage)
            break

          case "done":
            this.handle._onDone(msg.result)
            this.child = null
            resolve(msg.result)
            break

          case "error":
            this.handle._onError({
              code: "execution_error",
              message: msg.error.message,
              subagentId: this.handle.id,
            })
            this.child = null
            reject(new Error(msg.error.message))
            break
        }
      })

      this.child.on("exit", (code) => {
        if (code !== 0 && this.child) {
          this.handle._onError({
            code: "execution_error",
            message: `Child process exited with code ${code}`,
            subagentId: this.handle.id,
          })
          this.child = null
          reject(new Error(`Child process exited with code ${code}`))
        }
      })

      this.child.on("error", (err) => {
        this.handle._onError({
          code: "startup_failed",
          message: err.message,
          subagentId: this.handle.id,
        })
        this.child = null
        reject(err)
      })

      // ── Send init ──
      this.child.send({
        type: "init",
        spec: {
          ...spec,
          // Strip non-serializable fields
          tools: undefined,
          schema: undefined,
        },
        toolModulePaths,
        adapterModulePath,
        model: spec.model ?? "default",
      })
    }).finally(() => {
      this.kill() // ensure child is terminated regardless of outcome
    })
  }

  /**
   * Send abort signal, then force-kill after 5s if child hasn't exited.
   */
  abort(): void {
    this.abortController.abort()
    if (this.child) {
      this.child.send({ type: "abort" })
      // F-3: Force-kill after 5s grace period
      setTimeout(() => {
        if (this.child) {
          this.child.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM")
          this.child = null
        }
      }, 5000)
    }
  }

  /**
   * Force-kill the child process immediately.
   * Node.js handles platform mapping (SIGTERM → TerminateProcess on Windows).
   */
  kill(): void {
    if (this.child) {
      this.child.kill("SIGTERM")
      this.child = null
    }
  }
}
