// @harness/adapters — DeepSeekAdapter (TG4 — extends OpenAICompatibleBase)
//
// Thin subclass. All shared logic is in openai-compatible-base.ts.
// DeepSeek uses the OpenAI-compatible API shape (chat/completions).

import type { ModelInfo } from "./types.js"
import { OpenAICompatibleAdapter } from "./openai-compatible-base.js"

// ═══════════════════════════════════════════════════════════════════
// ─── Model Catalog ───
// ═══════════════════════════════════════════════════════════════════

const MODEL_CATALOG: Record<string, ModelInfo> = {
  "deepseek-chat": {
    id: "deepseek-chat",
    provider: "deepseek",
    maxInputTokens: 128_000,
    maxOutputTokens: 8_000,
    supportsThinking: false,
    supportsVision: false,
    supportsPromptCaching: false,
    supportsToolUse: true,
    costPer1kInput: 0.00027,
    costPer1kOutput: 0.0011,
  },
  "deepseek-reasoner": {
    id: "deepseek-reasoner",
    provider: "deepseek",
    maxInputTokens: 128_000,
    maxOutputTokens: 32_000,
    supportsThinking: true,
    supportsVision: false,
    supportsPromptCaching: false,
    supportsToolUse: false,
    costPer1kInput: 0.00055,
    costPer1kOutput: 0.00219,
  },
}

// ═══════════════════════════════════════════════════════════════════
// ─── DeepSeekAdapter ───
// ═══════════════════════════════════════════════════════════════════

export class DeepSeekAdapter extends OpenAICompatibleAdapter {
  static readonly requiredEnvVars = ["DEEPSEEK_API_KEY"]
  readonly provider = "deepseek"

  // eslint-disable-next-line @typescript-eslint/naming-convention
  protected MODEL_CATALOG = MODEL_CATALOG

  constructor(opts?: {
    apiKey?: string
    baseURL?: string
    model?: string
  }) {
    super({
      apiKey: opts?.apiKey ?? process.env["DEEPSEEK_API_KEY"] ?? "",
      baseURL: opts?.baseURL ?? "https://api.deepseek.com/v1",
      model: opts?.model ?? "deepseek-chat",
      providerName: "deepseek",
    })
  }
}
