import { describe, it, expect } from "vitest"
import { fork } from "child_process"
import { fileURLToPath } from "url"
import { dirname, resolve } from "path"

describe("ProcessWorker IPC", () => {
  it("should receive started and done messages from child", async () => {
    const entryPath = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/subagent/dist/remote-entry.js")
    // TG2: remote-entry needs to be built first — skip if dist doesn't exist
    // Test with a minimal child that sends IPC messages

    const child = fork(resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/ipc-child.js"))

    const messages: any[] = []
    await new Promise<void>((resolve, reject) => {
      child.on("message", (msg: any) => {
        messages.push(msg)
        if (msg.type === "done") resolve()
      })
      child.on("error", reject)
      child.on("exit", (code) => { if (code !== 0) reject(new Error(`exit ${code}`)) })
      setTimeout(() => reject(new Error("timeout")), 10000)
      child.send({ type: "init", spec: { prompt: "test", maxTurns: 1 }, toolModulePaths: [], adapterModulePath: "none", model: "test" })
    })

    const started = messages.find((m: any) => m.type === "started")
    const done = messages.find((m: any) => m.type === "done")
    expect(started).toBeDefined()
    expect(done).toBeDefined()
    child.kill()
  }, 15000)
})
