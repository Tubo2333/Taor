// @taor/core — unified env validation

/**
 * Validate required environment variables.
 * Throws instead of process.exit() — library code must never kill the host process.
 *
 * NOTE: createHarness() already validates ANTHROPIC_API_KEY internally.
 * Call this directly only if you construct AnthropicAdapter without using createHarness().
 */
export function validateEnv(): void {
  const missing: string[] = []
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY")
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
      "Copy .env.example to .env and fill in the values."
    )
  }
}
