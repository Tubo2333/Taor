process.on("message", (msg) => {
  if (msg.type === "init") {
    process.send({ type: "started" })
    process.send({ type: "done", result: { ok: true, turns: 1, tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
    process.exit(0)
  }
})
