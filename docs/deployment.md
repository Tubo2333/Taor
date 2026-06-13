# Deployment Guide

## Requirements

- Node.js 22+
- npm 10+

## Docker (Recommended)

```bash
docker build -t harness-agent .
docker run -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY harness-agent
```

## PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 logs harness-agent
pm2 stop harness-agent
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|---------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | - | Anthropic API key |
| `ANTHROPIC_BASE_URL` | No | `api.anthropic.com` | API base URL (for proxies/custom endpoints) |

## Running the CLI

```bash
# After build
node packages/cli/dist/index.js run "Your prompt here"
```
