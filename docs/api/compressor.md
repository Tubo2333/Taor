# Compressor API Reference

> 5-layer context compression pipeline (trim → summarize → chunk → embed → truncate).

## Pipeline Layers

| Layer | Strategy | Cost | When |
|-------|----------|------|------|
| 1. Trim | Remove whitespace, deduplicate | Free | Always first |
| 2. Summarize | LLM-powered summarization | High | Large contexts |
| 3. Chunk | Split into overlapping chunks | Low | Tool-heavy sessions |
| 4. Embed | Semantic similarity pruning | Medium | Knowledge-heavy |
| 5. Truncate | FIFO message truncation | Free | Last resort |

---

## Configuration

```typescript
const harness = createHarness({
  model: "claude-sonnet-4-6",
  tools: [],
  compressor: {
    triggerThreshold: 100_000,    // Token count to trigger compression
    targetThreshold: 50_000,      // Target token count after compression
    strategies: ["trim", "summarize", "truncate"],
  },
})
```

---

## Trigger

The compressor checks `harness.tokenUsage.total` at each turn boundary. When it exceeds `triggerThreshold`, the pipeline runs.

After compression:
- `this.messages` is replaced with the compressed result
- A `compressed` event is pushed to the event stream
- `beforeCompress` / `afterCompress` hooks fire

---

## Custom Strategies

```typescript
class MyStrategy implements CompressStrategy {
  name = "my-strategy"
  async compress(messages: Message[]): Promise<Message[]> {
    // Custom compression logic
    return messages.slice(-50)
  }
}

const pipeline = new CompressorPipeline({
  triggerThreshold: 50_000,
  strategies: [new MyStrategy()],
})
```

---

## API

```typescript
interface ICompressorPipeline {
  readonly triggerThreshold?: number

  compress(ctx: TurnContext): Promise<{
    messages: Message[]
    tokenCount: number
    level: string
    strategy: string
  }>

  clearCache(): void
}
```
