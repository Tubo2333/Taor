/**
 * Token budget hook — aborts the session if estimated cost exceeds $5.00 USD.
 *
 * Demonstrates:
 * - HookRegistration[] pattern (onSessionStart + afterObserve + onError)
 * - Token usage accumulation across turns
 * - Automatic abort on budget exceeded
 *
 * Uses hardcoded pricing for claude-sonnet-4-6 ($3/$15 per 1M tokens).
 * For multi-model support with accurate pricing, pass an adapter to createBudgetHook().
 *
 * Cost estimation: $5.00 allows roughly 1.6M input or 330K output tokens on sonnet.
 */

import type { HookRegistration, HookInput } from "@harness/hooks"

// Default pricing (claude-sonnet-4-6) — used when no adapter is provided
const DEFAULT_INPUT_COST_PER_1K = 0.003
const DEFAULT_OUTPUT_COST_PER_1K = 0.015

/**
 * Create a budget enforcement hook.
 *
 * @param maxCostDollars — maximum cost in USD before abort (default $5.00)
 * @returns HookRegistration[] for createHarness({ hooks: [...] })
 */
export function createBudgetHook(maxCostDollars = 5.0): HookInput {
  let totalInputTokens = 0
  let totalOutputTokens = 0

  // Can be updated at session start if adapter with different pricing is available
  let inputCostPer1k = DEFAULT_INPUT_COST_PER_1K
  let outputCostPer1k = DEFAULT_OUTPUT_COST_PER_1K

  const hooks: HookRegistration[] = [
    {
      hook: "onSessionStart",
      priority: 100,
      name: "budget-init",
      handler: async (ctx: any) => {
        totalInputTokens = 0
        totalOutputTokens = 0
      },
    },

    {
      hook: "afterObserve",
      priority: 0,
      name: "budget-check",
      handler: async (ctx: any, observation: any) => {
        // Accumulate token counts from this turn's observation
        if (observation?.tokenUsage) {
          totalInputTokens += observation.tokenUsage.input ?? 0
          totalOutputTokens += observation.tokenUsage.output ?? 0
        }

        // Calculate estimated cost
        const inputCost = (totalInputTokens / 1000) * inputCostPer1k
        const outputCost = (totalOutputTokens / 1000) * outputCostPer1k
        const totalCost = inputCost + outputCost

        // Log budget status every turn (to stderr so it doesn't mix with event output)
        console.error(
          `[budget] Turn ${ctx.turn?.index ?? "?"}: ` +
            `${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out ` +
            `≈ $${totalCost.toFixed(3)} of $${maxCostDollars.toFixed(2)}`,
        )

        if (totalCost >= maxCostDollars) {
          console.error(
            `[budget] Budget exceeded ($${totalCost.toFixed(3)} ≥ $${maxCostDollars.toFixed(2)}). ` +
              `Aborting session.`,
          )
          throw new Error(
            `Token budget exceeded: $${totalCost.toFixed(3)} of $${maxCostDollars.toFixed(2)} budget. ` +
              `Used ${totalInputTokens.toLocaleString()} input + ${totalOutputTokens.toLocaleString()} output tokens.`,
          )
        }
      },
    },

    {
      hook: "onError",
      priority: 0,
      name: "budget-error-log",
      handler: async (_ctx: any, error: any) => {
        const msg = error?.message ?? String(error)
        if (msg.includes("budget")) {
          return { action: "abort", reason: "token budget exceeded" }
        }
        return { action: "ignore" }
      },
    },
  ]

  return hooks
}
