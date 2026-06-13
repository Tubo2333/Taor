module.exports = {
  apps: [{
    name: "harness-agent",
    script: "./examples/real.js",
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    max_restarts: 5,
  }]
}
