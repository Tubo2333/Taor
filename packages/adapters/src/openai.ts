// @taor/adapters — OpenaiAdapter (TG4 — extends OpenAICompatibleBase)
//
// Thin subclass. All shared logic is in openai-compatible-base.ts.
// This file only defines: provider, requiredEnvVars, model catalog, defaults.

import type { ModelInfo } from "./types.js"
import { OpenAICompatibleAdapter } from "./openai-compatible-base.js"

// ═══════════════════════════════════════════════════════════════════
// ─── Model Catalog ───
// ═══════════════════════════════════════════════════════════════════

/**
 * Known OpenAI models with capabilities.
 *
 * Costs are per 1k tokens (USD, list price as of 2026-06).
 * Approximate — update from https://platform.openai.com/docs/pricing.
 */
const MODEL_CATALOG: Record<string, ModelInfo> = {
  "gpt-5": {
    id: "gpt-5",
    provider: "openai",
    maxInputTokens: 200_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCaching: true,
    supportsToolUse: true,
    costPer1kInput: 0.00125,
    costPer1kOutput: 0.01,
  },
  "gpt-4.1": {
    id: "gpt-4.1",
    provider: "openai",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 32_000,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCaching: true,
    supportsToolUse: true,
    costPer1kInput: 0.002,
    costPer1kOutput: 0.008,
  },
  "gpt-4.1-mini": {
    id: "gpt-4.1-mini",
    provider: "openai",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 16_000,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCaching: true,
    supportsToolUse: true,
    costPer1kInput: 0.0004,
    costPer1kOutput: 0.0016,
  },
  "gpt-4.1-nano": {
    id: "gpt-4.1-nano",
    provider: "openai",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 16_000,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCaching: true,
    supportsToolUse: true,
    costPer1kInput: 0.0001,
    costPer1kOutput: 0.0004,
  },
}

// ═══════════════════════════════════════════════════════════════════
// ─── OpenaiAdapter ───
// ═══════════════════════════════════════════════════════════════════

export class OpenaiAdapter extends OpenAICompatibleAdapter {
  static readonly requiredEnvVars = ["OPENAI_API_KEY"]
  readonly provider = "openai"

  // eslint-disable-next-line @typescript-eslint/naming-convention
  protected MODEL_CATALOG = MODEL_CATALOG

  constructor(opts?: {
    apiKey?: string
    baseURL?: string
    model?: string
  }) {
    super({
      apiKey: opts?.apiKey ?? process.env["OPENAI_API_KEY"] ?? "",
      baseURL: opts?.baseURL ?? "https://api.openai.com/v1",
      model: opts?.model ?? "gpt-4.1",
      providerName: "openai",
    })
  }
}
